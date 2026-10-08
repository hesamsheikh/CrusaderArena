"""Stage runs for the Hugging Face dataset. Nothing leaves this machine.

    npm run package -- <series id | run folder> ... [--submitter NAME] [--tier community|official]

For each learning series (harness/runtime/series/<id>) or independent run it:

1. checks that the runs can be published: finished on their budget, scored, recorded, made from
   committed code that is on GitHub's main branch, with a benchmark version set at that commit
   (tools/dataset/version.json), and like for like across the episodes of a series;
2. copies the files the dataset keeps into
   harness/runtime/publish/<version>/<benchmark>/<model>/<id>/episode-<n>/, scrubbed of
   secrets and machine details (scrub.py), and re-renders a video whose logs needed changes;
3. writes the tables (tables.py): series.parquet, and per episode episode.parquet and
   timeline.parquet (the game minute by minute, timeline.py); and manifest.json: each file's
   size and SHA-256, what the scrub changed, and the problems that block the upload.

A bundle with problems is still staged so it can be inspected; npm run upload refuses it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from scrub import Scrubber, machine_values

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / 'harness/runtime/runs'
SERIES = ROOT / 'harness/runtime/series'
OUT = ROOT / 'harness/runtime/publish'
VERSION_FILE = 'tools/dataset/version.json'
UNVERSIONED = 'unversioned'

REQUIRED = ['run.json', 'inputs.json', 'episode.json', 'events.jsonl', 'logs.jsonl', 'final-overview.jpg', 'video.mp4']
OPTIONAL = ['notifications.jsonl', 'memory.json', 'notebook.md', 'playbook.md']
# The video is rendered from these; text replaced in them may also be drawn in the video.
VIDEO_SOURCES = ['run.json', 'episode.json', 'events.jsonl']
# How a run whose episode.json predates `valid` must end: on its game-time budget.
BUDGET_ENDINGS = {'game_time'}
SUBMITTER = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}')
# Run settings and model settings every episode of a series must share.
LIKE_FOR_LIKE = [
    ('benchmark', lambda r: r.get('benchmarkType')),
    ('harness commit', lambda r: (r.get('harness') or {}).get('commit')),
    ('system prompt', lambda r: (r.get('harness') or {}).get('systemPromptSha256')),
    ('tools', lambda r: (r.get('harness') or {}).get('toolsSha256')),
    ('model', lambda r: {k: v for k, v in (r.get('model') or {}).items() if k not in ('id', 'name')}),
    ('run settings', lambda r: r.get('config')),
]


def slug(text: str) -> str:
    """The benchmark's rules-file name, as the host derives it (preparation.ts)."""
    return re.sub(r'[^a-z0-9]+', '-', text.lower()).strip('-')


def model_slug(model_id: str) -> str:
    """Provider model ID with "/" as "--": z-ai/glm-5.3-flash -> z-ai--glm-5.3-flash."""
    parts = [re.sub(r'[^a-z0-9.]+', '-', part.lower()).strip('-.') for part in model_id.split('/')]
    return '--'.join(p for p in parts if p) or 'unknown'


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def integer(value):
    return int(round(value)) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def number(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def total(values):
    present = [v for v in values if v is not None]
    return sum(present) if present else None


def counts(record, by_count=False) -> list[dict] | None:
    if not isinstance(record, dict):
        return None
    items = [(str(k), integer(v)) for k, v in record.items() if integer(v)]
    items.sort(key=(lambda kv: (-kv[1], kv[0])) if by_count else (lambda kv: kv[0]))
    return [{'name': k, 'count': v} for k, v in items]


def iso(ms) -> str | None:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace('+00:00', 'Z') if number(ms) else None


class Git:
    def __init__(self, root: Path = ROOT):
        self.root = root

    def _run(self, *args):
        return subprocess.run(['git', *args], cwd=self.root, capture_output=True, text=True)

    def head(self) -> str | None:
        result = self._run('rev-parse', 'HEAD')
        return result.stdout.strip() if result.returncode == 0 else None

    def on_main(self, commit: str) -> bool | None:
        """Whether the commit is on origin/main as last fetched; None when git cannot tell."""
        return {0: True, 1: False}.get(self._run('merge-base', '--is-ancestor', commit, 'origin/main').returncode)

    def version_at(self, commit: str) -> str | None:
        """The benchmark version set at that commit, or None before one was set."""
        result = self._run('show', f'{commit}:{VERSION_FILE}')
        if result.returncode:
            return None
        try:
            version = json.loads(result.stdout).get('version')
        except (ValueError, AttributeError):
            return None
        return version if isinstance(version, str) and re.fullmatch(r'v\d+', version) else None


def report_rows(dirs: list[Path]) -> dict[str, dict]:
    """What npm run report computes for these runs (harness/server/run-report.ts), by folder name."""
    with tempfile.TemporaryDirectory() as tmp:
        for d in dirs:
            os.symlink(d.resolve(), Path(tmp) / d.name)
        result = subprocess.run(
            [str(ROOT / 'node_modules/.bin/tsx'), str(ROOT / 'harness/server/run-report.ts'), '--runs', tmp, '--json'],
            cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'npm run report failed: {result.stderr.strip()}')
    return {row['folder']: row for row in json.loads(result.stdout)}


def render_video(run_dir: Path, staged: Path) -> str | None:
    """Re-render video.mp4 from the scrubbed logs and the original recording; an error or None."""
    if not (run_dir / 'recording').is_dir():
        return 'recording/ is gone, so the video cannot be re-rendered from the scrubbed logs'
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for name in VIDEO_SOURCES:
            if (staged / name).is_file():
                os.symlink((staged / name).resolve(), work / name)
        os.symlink((run_dir / 'recording').resolve(), work / 'recording')
        result = subprocess.run([sys.executable, str(ROOT / 'tools/video/render-video.py'), str(work), '--quiet'],
                                capture_output=True, text=True)
        if result.returncode or not (work / 'video.mp4').is_file():
            return 'video re-render failed: ' + ((result.stderr.strip().splitlines() or ['no video written'])[-1])
        shutil.move(str(work / 'video.mp4'), staged / 'video.mp4')
    return None


@dataclass
class Episode:
    number: int
    dir: Path | None
    error: str | None = None


@dataclass
class Group:
    kind: str  # 'series' or 'run'
    id: str
    episodes: list[Episode]
    series_dir: Path | None = None
    record: dict = field(default_factory=dict)


def run_group_id(folder: str) -> str:
    """run-20261008T134043-1f29a72b from a run folder name."""
    m = re.search(r'(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-\d{3}Z-([0-9a-f]{8})$', folder)
    return f'run-{m[1]}{m[2]}{m[3]}T{m[4]}{m[5]}{m[6]}-{m[7]}' if m else f'run-{slug(folder)[-40:]}'


def resolve(target: str, runs: Path = RUNS, series: Path = SERIES) -> Group:
    """A learning series by id, or one run by folder name or path."""
    named = re.fullmatch(r'[A-Za-z0-9._-]+', target) and target not in ('.', '..')
    record = read_json(series / target / 'series.json') if named else {}
    if record:
        results = {r.get('episode'): r for r in record.get('results', []) if isinstance(r, dict)}
        episodes = []
        for n in range(1, (integer(record.get('episodes')) or len(results)) + 1):
            r = results.get(n)
            if r is None:
                episodes.append(Episode(n, None, 'not run (the series stopped early)'))
            elif r.get('error') or not r.get('folder'):
                episodes.append(Episode(n, None, f'failed: {r.get("error") or "no run folder"}'))
            else:
                episodes.append(Episode(n, runs / r['folder']))
        return Group('series', target, episodes, series / target, record)
    run_dir = Path(target) if Path(target).is_dir() else runs / target
    if (run_dir / 'run.json').is_file():
        return Group('run', run_group_id(run_dir.resolve().name), [Episode(1, run_dir)])
    raise SystemExit(f'Not a series id (harness/runtime/series) or run folder (harness/runtime/runs): {target}')


def check_code(harness: dict, git: Git, version: str | None) -> list[str]:
    commit = harness.get('commit')
    if not commit:
        return ['the run recorded no harness commit']
    problems = []
    if harness.get('dirty') is not False:
        problems.append('the run used uncommitted code (harness.dirty is not false)')
    on_main = git.on_main(commit)
    if on_main is None:
        problems.append(f'commit {commit[:7]} or origin/main is not known here; fetch and package again')
    elif not on_main:
        problems.append(f'commit {commit[:7]} is not on origin/main, so others cannot see the code that ran')
    if version is None:
        problems.append(f'no benchmark version is set at commit {commit[:7]} ({VERSION_FILE})')
    return problems


def check_run(run_dir: Path, run: dict, row: dict | None) -> list[str]:
    if row is None:
        return ['npm run report could not read the run']
    problems = []
    if row.get('incomplete'):
        problems.append('the run is incomplete (still writing, or an unreadable log line)')
    episode = read_json(run_dir / 'episode.json')
    if not episode:
        problems.append('no episode.json: only runs started by npm run episodes are scored')
    elif isinstance(episode.get('valid'), bool):
        # npm run episodes decides whether the net worth is a full-budget score, and says why not.
        if not episode['valid']:
            reasons = [str(r) for r in episode.get('invalid') or []] or ['no reason recorded']
            problems += [f'not a full-budget score: {r}' for r in reasons]
    else:
        if run.get('status') != 'completed' or row.get('ended') not in BUDGET_ENDINGS:
            problems.append(f'the run ended with "{row.get("ended")}", not its game-time budget')
        if episode.get('source') != 'final':
            problems.append(f'the score is from "{episode.get("source")}", not a final reading')
    for name in REQUIRED:
        if name != 'episode.json' and not (run_dir / name).is_file():
            problems.append(f'no {name}' + (' (record the run: npm run episodes -- --record)' if name == 'video.mp4' else ''))
    host = urlparse(str((run.get('model') or {}).get('baseUrl') or '')).hostname or ''
    if host == 'localhost' or host.endswith(('.local', '.internal', '.lan')):
        problems.append('the model endpoint is a local address')
    return problems


def check_like_for_like(meta: dict[int, dict]) -> list[str]:
    problems = []
    for label, get in LIKE_FOR_LIKE:
        values = {json.dumps(get(run), sort_keys=True) for run in meta.values()}
        if len(values) > 1:
            problems.append(f'the episodes differ in {label}')
    return problems


def identity(run: dict, episode: dict, version, tier, submitter, series_id) -> dict:
    model, harness, config = run.get('model') or {}, run.get('harness') or {}, run.get('config') or {}
    return {
        'dataset_version': version,
        'benchmark': run.get('benchmarkType') or episode.get('benchmark'),
        'map': episode.get('map'),
        'save': episode.get('save'),
        'model_id': model.get('modelId'),
        'model_name': model.get('name'),
        'endpoint': model.get('baseUrl'),
        'reasoning': model.get('reasoning'),
        'max_tokens': integer(model.get('maxTokens')),
        'providers': [str(p) for p in model.get('providers') or []],
        'allow_fallbacks': model.get('allowFallbacks') if isinstance(model.get('allowFallbacks'), bool) else None,
        'harness_commit': harness.get('commit'),
        'prompt_sha256': harness.get('systemPromptSha256'),
        'tools_sha256': harness.get('toolsSha256'),
        'game_minutes_budget': number(config.get('gameMinutes')),
        'wall_limit_minutes': number(config.get('wallLimitMinutes')),
        'run_settings': json.dumps(config, sort_keys=True),
        'tier': tier,
        'submitted_by': submitter,
        'series_id': series_id,
    }


def image(path: Path):
    return {'bytes': path.read_bytes(), 'path': path.name} if path.is_file() else None


def episode_row(base: dict, episode_number: int, episodes: int, run: dict, episode: dict, row: dict,
                staged: Path, rel_dir: str) -> dict:
    card, tokens = row.get('scorecard') or {}, row.get('tokens') or {}
    build, anchor = row.get('build') or {}, row.get('anchor') or {}
    tools = row.get('tools')
    date = episode.get('date') or {}
    playbook = staged / 'playbook.md'
    return {
        **base,
        'run_id': run.get('id'),
        'episode': episode_number,
        'episodes': episodes,
        'started_at': iso(run.get('startedAt')),
        'ended_at': iso(run.get('endedAt')),
        'instruction': run.get('prompt'),
        'status': run.get('status'),
        'ended': row.get('ended'),
        'end_detail': row.get('endDetail'),
        'score_source': card.get('source'),
        'valid': episode['valid'] if isinstance(episode.get('valid'), bool) else card.get('valid'),
        'invalid': [str(r) for r in episode.get('invalid') or []] if isinstance(episode.get('valid'), bool) else None,
        'net_worth': integer(card.get('netWorth')),
        # What the do-nothing baseline scores on the same save and budget; growth is measured from it.
        'net_worth_baseline': integer(card.get('netWorthBaseline') if card.get('netWorthBaseline') is not None
                                      else episode.get('net_worth_baseline')),
        'net_worth_growth': integer(card.get('netWorthGrowth')),
        'goods_value': integer(episode.get('goods_value')),
        'gold': integer(card.get('gold')),
        'goods': counts(episode.get('goods')),
        'population': integer(card.get('population')),
        'housing': integer(card.get('housing')),
        'popularity': integer(card.get('popularity')),
        'total_food': integer(card.get('totalFood')),
        'structures': integer(card.get('structures')),
        'troops': integer(card.get('troops')),
        'game_year': integer(date.get('year')),
        'game_month': integer(date.get('month')),
        'game_seconds': number(row.get('gameSeconds')),
        'game_seconds_budget': number(row.get('budgetGameSeconds')),
        'wall_seconds': number(row.get('wallSeconds')),
        'inference_seconds': number(row.get('inferenceSeconds')),
        'turns': integer(row.get('turns')),
        'compactions': integer(row.get('compactions')),
        'tokens_total': integer(tokens.get('total')),
        'tokens_input': integer(tokens.get('input')),
        'tokens_cache_read': integer(tokens.get('cacheRead')),
        'tokens_cache_write': integer(tokens.get('cacheWrite')),
        'tokens_output': integer(tokens.get('output')),
        'cached_share': number(tokens.get('cachedShare')),
        'tokens_per_game_minute': number(row.get('tokensPerGameMinute')),
        'cost_usd': number(row.get('cost')),
        'tool_calls': sum(tools.values()) if isinstance(tools, dict) else None,
        'tool_calls_by_name': counts(tools, by_count=True),
        'tool_errors': integer(row.get('toolErrors')),
        'build_attempts': integer(build.get('attempts')),
        'build_placed': integer(build.get('placed')),
        'build_failed': integer(build.get('failed')),
        'build_unverified': integer(build.get('unverified')),
        'build_retries': integer(build.get('retries')),
        'build_missing': integer(build.get('missing')),
        'anchor_calls': integer(anchor.get('calls')),
        'anchor_placed': integer(anchor.get('placed')),
        'anchor_failed': integer(anchor.get('failed')),
        'anchor_partly_placed': integer(anchor.get('partlyPlaced')),
        'peak_game_rss_mib': integer((row.get('memory') or {}).get('peakGameRssMiB')),
        'playbook': playbook.read_text(encoding='utf-8') if playbook.is_file() else None,
        'final_image': None,
        'video': f'{rel_dir}/video.mp4' if (staged / 'video.mp4').is_file() else None,
        'files': rel_dir,
    }


def series_row(base: dict, rows: list[dict], episodes: int, playbook: str | None, rel_dir: str) -> dict:
    by_number = {r['episode']: r for r in rows}
    worth = [by_number.get(n, {}).get('net_worth') for n in range(1, episodes + 1)]
    valid = [by_number.get(n, {}).get('valid') for n in range(1, episodes + 1)]
    last = by_number.get(episodes, {})
    return {
        **base,
        'episodes': episodes,
        'episodes_completed': sum(1 for r in rows if r['status'] == 'completed'),
        'net_worth_by_episode': worth,
        'valid': False if False in valid else True if all(v is True for v in valid) else None,
        'valid_by_episode': valid,
        'score': worth[-1],
        'change': worth[-1] - worth[0] if worth[0] is not None and worth[-1] is not None else None,
        'cost_usd': total(r['cost_usd'] for r in rows),
        'tokens_total': total(r['tokens_total'] for r in rows),
        'game_seconds': total(r['game_seconds'] for r in rows),
        'wall_seconds': total(r['wall_seconds'] for r in rows),
        'turns': total(r['turns'] for r in rows),
        'tool_calls': total(r['tool_calls'] for r in rows),
        'playbook_final': playbook,
        'final_image': last.get('final_image'),
        'video': last.get('video'),
        'files': rel_dir,
    }


def summarize_findings(findings) -> list[str]:
    """One problem per file and kind, with how many places and the first one."""
    groups: dict[tuple[str, str], list[str]] = {}
    for f in findings:
        groups.setdefault((f.file, f.kind), []).append(f.where)
    return [f'{file}: {kind} ({len(places)} place{"s" if len(places) > 1 else ""}, first at {places[0]})'
            for (file, kind), places in groups.items()]


@dataclass
class Result:
    group: Group
    dest: Path
    rel: str
    manifest: dict


def package(group: Group, *, out: Path, scrubber: Scrubber, git: Git,
            rows_of: Callable[[list[Path]], dict[str, dict]] = report_rows,
            render: Callable[[Path, Path], str | None] = render_video,
            tier: str = 'community', submitter: str | None = None) -> Result:
    import tables  # needs the datasets library; imported here so --help works without it
    import timeline

    prices = timeline.sell_prices()
    problems: list[str] = []
    runs = {}
    for ep in group.episodes:
        if ep.error:
            problems.append(f'episode {ep.number}: {ep.error}')
        elif ep.dir is None or not (ep.dir / 'run.json').is_file():
            problems.append(f'episode {ep.number}: run folder not found')
        else:
            runs[ep.number] = ep.dir
    if not runs:
        raise SystemExit(f'{group.id}: no episode has a run folder')
    meta = {n: read_json(d / 'run.json') for n, d in runs.items()}
    rows = rows_of(list(runs.values()))
    first = meta[min(meta)]
    harness = first.get('harness') or {}
    version = git.version_at(harness['commit']) if harness.get('commit') else None
    benchmark = first.get('benchmarkType') or 'custom'
    model = first.get('model') or {}
    rel = '/'.join([version or UNVERSIONED, slug(benchmark) or 'custom', model_slug(model.get('modelId') or model.get('name') or ''), group.id])
    dest = out / rel
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    problems += check_code(harness, git, version)
    problems += check_like_for_like(meta)
    if group.kind == 'series' and group.record.get('stopped'):
        problems.append(f'the series stopped early: {group.record["stopped"]}')
    if group.kind == 'run' and isinstance(first.get('series'), dict):
        problems.append(f'this run is episode {first["series"].get("episode")} of series {first["series"].get("id")}; package the series')
    if not submitter:
        problems.append('no --submitter: the Hugging Face user name of whoever ran it')
    elif not SUBMITTER.fullmatch(submitter):
        problems.append('--submitter is not a Hugging Face user name')

    series_id = group.id if group.kind == 'series' else None
    episode_rows = []
    for n, run_dir in sorted(runs.items()):
        staged = dest / f'episode-{n}'
        problems += [f'episode {n}: {p}' for p in check_run(run_dir, meta[n], rows.get(run_dir.name))]
        for name in REQUIRED + OPTIONAL:
            if (run_dir / name).is_file():
                scrubber.file(run_dir / name, staged / name, f'episode-{n}/{name}')
        if (staged / 'video.mp4').is_file() and scrubber.replaced_in(*(f'episode-{n}/{s}' for s in VIDEO_SOURCES)):
            error = render(run_dir, staged)
            if error:
                problems.append(f'episode {n}: the logs needed scrubbing and {error}')
        run, episode = read_json(staged / 'run.json'), read_json(staged / 'episode.json')
        base = identity(run, episode, version, tier, submitter, series_id)
        row = episode_row(base, n, len(group.episodes), run, episode, rows.get(run_dir.name) or {}, staged, f'{rel}/episode-{n}')
        # The report's error text and anything else read from the logs go through the scrub too.
        row = scrubber.value(row, f'episode-{n}/episode.parquet', 'row')
        row['final_image'] = image(staged / 'final-overview.jpg')
        tables.write([row], tables.EPISODE, staged / 'episode.parquet')
        episode_rows.append(row)
        budget = (run.get('progress') or {}).get('budget') or {}
        minutes = timeline.rows(
            staged / 'events.jsonl',
            number(budget.get('gameSeconds')) or (number((run.get('config') or {}).get('gameMinutes')) or 0) * 60 or None,
            number(budget.get('usedGameSeconds')),
            prices,
            {k: row[k] for k in ('dataset_version', 'benchmark', 'model_id', 'series_id', 'run_id', 'episode')},
        ) if (staged / 'events.jsonl').is_file() else []
        if minutes:
            tables.write(minutes, tables.TIMELINE, staged / 'timeline.parquet')
        else:
            problems.append(f'episode {n}: no game readings in events.jsonl for the timeline')

    if group.kind == 'series':
        scrubber.file(group.series_dir / 'series.json', dest / 'series.json', 'series.json')
        playbook = None
        for n in range(1, len(group.episodes) + 1):
            src = group.series_dir / f'playbook-after-episode-{n}.md'
            if src.is_file():
                scrubber.file(src, dest / src.name, src.name)
                playbook = (dest / src.name).read_text(encoding='utf-8')
        last = meta[max(meta)]
        base = identity(last, read_json(dest / f'episode-{max(meta)}' / 'episode.json'), version, tier, submitter, series_id)
        row = series_row(scrubber.value(base, 'series.parquet', 'row'), episode_rows, len(group.episodes),
                         playbook, rel)
        tables.write([row], tables.SERIES, dest / 'series.parquet')

    problems += summarize_findings(scrubber.findings)
    files = sorted(p for p in dest.rglob('*') if p.is_file())
    manifest = {
        'format': 1,
        'path': rel,
        'kind': group.kind,
        'id': group.id,
        'dataset_version': version,
        'benchmark': benchmark,
        'model_id': model.get('modelId'),
        'episodes': len(group.episodes),
        'tier': tier,
        'submitted_by': submitter,
        'packaged_at': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
        'packaged_with': git.head(),
        'publishable': not problems,
        'problems': problems,
        'scrub': scrubber.summary(),
        'files': [{'path': p.relative_to(dest).as_posix(), 'bytes': p.stat().st_size, 'sha256': sha256(p)} for p in files],
    }
    (dest / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return Result(group, dest, rel, manifest)


def size(n: int) -> str:
    return f'{n / 1e6:.1f} MB' if n >= 1e5 else f'{n / 1e3:.0f} kB'


def report(result: Result) -> str:
    m = result.manifest
    dropped = ', '.join(f'{k} ×{v}' for k, v in m['scrub']['dropped_fields'].items()) or 'nothing'
    replaced = sum(m['scrub']['replaced'].values())
    lines = [
        f'Staged {m["kind"]} {m["id"]}: {m["episodes"]} episode(s), {len(m["files"])} files, '
        f'{size(sum(f["bytes"] for f in m["files"]))}',
        f'  {result.dest.relative_to(ROOT) if result.dest.is_relative_to(ROOT) else result.dest}',
        f'  Scrub: dropped {dropped}; replaced {replaced} machine-specific value(s)',
    ]
    if m['publishable']:
        lines.append('  Ready to upload: npm run upload -- ' + str(result.dest.relative_to(ROOT) if result.dest.is_relative_to(ROOT) else result.dest))
    else:
        lines.append(f'  Not publishable ({len(m["problems"])} problem(s)):')
        lines += [f'    - {p}' for p in m['problems']]
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Stage runs for the Hugging Face dataset (nothing is uploaded).')
    parser.add_argument('targets', nargs='+', help='learning series ids (harness/runtime/series/<id>) or run folders')
    parser.add_argument('--submitter', help='Hugging Face user name of whoever ran the series')
    parser.add_argument('--tier', choices=['community', 'official'], default='community',
                        help='official: run by the maintainers; community: submitted by anyone else')
    parser.add_argument('--out', default=str(OUT), help='staging folder (default harness/runtime/publish)')
    args = parser.parse_args(argv)
    machine = machine_values()
    git = Git()
    for target in args.targets:
        result = package(resolve(target), out=Path(args.out), scrubber=Scrubber(machine), git=git,
                         tier=args.tier, submitter=args.submitter)
        print(report(result))


if __name__ == '__main__':
    main()
