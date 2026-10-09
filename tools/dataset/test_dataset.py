"""Packaging, scrubbing, the timeline and the upload checks, on a small made-up series.

    python3 -m unittest discover -s tools/dataset
"""
import base64
import io
import json
import random
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import media
import package
import timeline
import upload
from scrub import Machine, Scrubber, machine_values

HERE = Path(__file__).resolve().parent
SECRET = 'sk-test-not-a-real-key-000000000000'
# Pure base64 that is not an image and happens to contain a user name.
IMAGE_DATA = 'A' * 700 + 'alice' + 'B' * 100
SERIES_ID = '20261008T140646-dfacebd1'


def picture(size, fmt, **save) -> bytes:
    """A noisy image, the hardest kind to compress."""
    from PIL import Image
    rng = random.Random(1)
    buffer = io.BytesIO()
    Image.frombytes('RGB', size, bytes(rng.randrange(256) for _ in range(size[0] * size[1] * 3))).save(buffer, fmt, **save)
    return buffer.getvalue()


# Images as the logs hold them, base64: a screenshot and a tool's PNG crop.
SCREENSHOT = base64.b64encode(picture((96, 54), 'JPEG', quality=95)).decode()
CROP = base64.b64encode(picture((40, 20), 'PNG')).decode()


def machine():
    return Machine(
        replace=sorted([('/home/alice/crusader', '<game-root>'), ('/Users/tester', '<home>'),
                        ('alice@10.1.2.3', '<game-host>'), ('10.1.2.3', '<game-host>')], key=lambda kv: -len(kv[0])),
        secrets=[SECRET],
        names=[('alice', 'user name'), ('tester', 'user name')],
    )


class FakeGit:
    def __init__(self, on_main=True):
        self.main = on_main

    def head(self):
        return 'f' * 40

    def on_main(self, commit):
        return self.main


def line(at, event):
    return json.dumps({'at': at, 'event': event}, separators=(',', ':')) + '\n'


def summary(seconds, gold, population, goods):
    return json.dumps({'run_clock': {'game_seconds_used': seconds}, 'stats': {
        'status': 'ok', 'date': 'August 1194', 'gold': gold, 'population': {'current': population, 'housing': 20},
        'popularity': {'current': 90}, 'food': {'total': 40}, 'goods': goods}})


def reading(tick, gold, population, goods):
    return {'status': 'ok', 'observation': {
        'game_time': tick, 'gold': gold, 'population': population, 'popularity': 91,
        'settlement': {'housing_cap': 20, 'total_food': 40, 'month': 9, 'year': 1194},
        'structures': {'count': 20}, 'own_troops': {'total': 0}, 'resources_by_name': goods}}


def usage(total, output=10):
    return {'input': total - output, 'output': output, 'cacheRead': 0, 'cacheWrite': 0, 'totalTokens': total}


def make_run(runs: Path, n: int, *, events_extra='', logs_extra='', dirty=False, video=True, version='1.0.0',
             suffix=None, attempt=1) -> str:
    suffix = suffix or f'0000000{n}'  # ends in the episode number, which the fake report reads
    folder = f'Test-Model-Oasis-by-the-Sea-construction-20261008-14{n}000Z-2026-10-08T14-{n}0-00-000Z-{suffix}'
    d = runs / folder
    d.mkdir(parents=True)
    run = {
        'id': f'{suffix}-run',
        'benchmark': {'version': version, 'fingerprint': 'b' * 64, 'guide': None}, 'name': 'Test', 'benchmarkType': 'Oasis by the Sea construction',
        'prompt': 'Grow the economy.', 'status': 'completed', 'startedAt': 1791470000000, 'endedAt': 1791470300000,
        'model': {'id': 'profile', 'name': 'Test Model', 'modelId': 'test/model-1', 'baseUrl': 'https://openrouter.ai/api/v1',
                  'reasoning': 'low', 'maxTokens': 8192, 'providers': [], 'allowFallbacks': True},
        'config': {'gameMinutes': 2, 'wallLimitMinutes': 60, 'recordVideo': video},
        'harness': {'commit': 'a' * 40, 'dirty': dirty, 'systemPromptSha256': 'p' * 64, 'toolsSha256': 't' * 64},
        'series': {'id': SERIES_ID, 'episode': n, 'episodes': 2, 'attempt': attempt},
        'progress': {'budget': {'gameSeconds': 120, 'usedGameSeconds': 120.0, 'endedBy': 'game_time'}},
    }
    (d / 'run.json').write_text(json.dumps(run, indent=2))
    (d / 'episode.json').write_text(json.dumps({
        'episode': n, 'save': 'Oasis by the Sea-1', 'benchmark': 'Oasis by the Sea construction', 'source': 'final', 'valid': True,
        'map': 'Oasis by the Sea', 'date': {'month': 9, 'year': 1194}, 'net_worth': 1500 + n, 'goods_value': 300,
        'net_worth_baseline': 1304, 'net_worth_growth': 196 + n, 'gold': 1200, 'population': 10, 'housing': 20,
        'popularity': 90, 'total_food': 40, 'goods': {'bread': 40, 'stone': 20}, 'structures_map_wide': 20, 'troops': 0}))
    (d / 'inputs.json').write_text(json.dumps({'systemPrompt': 'You play the game.'}))
    (d / 'playbook.md').write_text(f'Notes after episode {n}.\n')
    goods = {'bread': 40, 'stone': 20, 'wood_planks': 10}
    events = ''.join([
        line(1, {'type': 'preparation_reply', 'reply': {'usage': usage(100)}}),
        line(2, {'type': 'request_cost', 'kind': 'preparation', 'dollars': 0.001}),
        line(3, {'type': 'host_observation', 'message': {'role': 'user', 'content': [
            {'type': 'text', 'text': 'Timed play has started.'},
            {'type': 'text', 'text': summary(0.4, 140, 1, goods)},
            {'type': 'image', 'data': SCREENSHOT, 'mimeType': 'image/jpeg'}]}}),
        line(4, {'type': 'turn_start'}),
        line(5, {'type': 'message_update', 'delta': {'type': 'text_delta', 'delta': 'Let me look.'}}),
        line(5, {'type': 'message_update', 'delta': {'type': 'text_end'}}),
        line(5, {'type': 'message_end', 'message': {'role': 'assistant', 'usage': usage(1000, 50)}}),
        line(6, {'type': 'tool_execution_start', 'toolCallId': 'c1', 'toolName': 'observe', 'args': {}}),
        line(7, {'type': 'tool_execution_end', 'toolCallId': 'c1', 'toolName': 'observe', 'isError': False,
                 'result': {'content': [{'type': 'text', 'text': '{"ok":true}'},
                                        {'type': 'image', 'data': CROP, 'mimeType': 'image/png'}],
                            'details': {'readerStats': reading(3000 + 70 * 30, 900, 6, goods),
                                        'frame': {'data': IMAGE_DATA, 'pid': 87264, 'windowId': 85983235}}}}),
        *(line(7, {'type': kind, 'message': {'role': 'toolResult', 'toolCallId': 'c1', 'content': [
            {'type': 'image', 'data': CROP, 'mimeType': 'image/png'}]}}) for kind in ('message_start', 'message_end')),
        line(8, {'type': 'memory_sample', 'gameRssMiB': 3000, 'system': {'MemFree': 1}, 'graphics': {'driver': 'i915'}}),
        line(9, {'type': 'recording_stopped', 'frames': 10, 'directory': '/Users/tester/runs/x/recording'}),
        events_extra,
        line(10, {'type': 'final_observation', 'stats': reading(3000 + 120 * 30, 1200, 10, goods),
                  'frame': {'image': SCREENSHOT}}),
        line(11, {'type': 'reflection_usage', 'usage': usage(500)}),
    ])
    (d / 'events.jsonl').write_text(events)
    (d / 'logs.jsonl').write_text(line(1, {'kind': 'system', 'text': 'Run started.'}) + logs_extra)
    (d / 'notifications.jsonl').write_text(json.dumps({'kind': 'journal_start'}) + '\n')
    from PIL import Image
    Image.new('RGB', (16, 9), 'green').save(d / 'final-overview.jpg')
    if video:
        (d / 'video.mp4').write_bytes(b'\x00\x00\x00\x18ftypisom' + bytes(32))
        (d / 'recording').mkdir()
    return folder


def report_row(folder: str, n: int) -> dict:
    return {
        'folder': folder, 'incomplete': False, 'ended': 'game_time', 'endDetail': None,
        'gameSeconds': 120.0, 'budgetGameSeconds': 120, 'wallSeconds': 300.0, 'inferenceSeconds': 90.0,
        'turns': 1, 'compactions': 0, 'tokensPerGameMinute': 800.0, 'cost': 0.002, 'costSource': 'prices',
        'tokens': {'total': 1600, 'input': 1500, 'output': 70, 'cacheRead': 30, 'cacheWrite': 0, 'cachedShare': 0.02},
        'scorecard': {'source': 'final', 'valid': True, 'population': 10, 'housing': 20, 'popularity': 90, 'gold': 1200,
                      'netWorth': 1500 + n, 'netWorthBaseline': 1304, 'netWorthGrowth': 196 + n, 'totalFood': 40, 'structures': 20, 'troops': 0},
        'tools': {'observe': 1}, 'toolErrors': 0,
        'build': {'attempts': 0, 'placed': 0, 'failed': 0, 'unverified': 0, 'retries': 0, 'missing': 0},
        'anchor': {'calls': 0, 'placed': 0, 'failed': 0, 'partlyPlaced': 0},
        'memory': {'peakGameRssMiB': 3000},
    }


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.runs, self.series, self.out = self.tmp / 'runs', self.tmp / 'series', self.tmp / 'publish'

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def make_series(self, **kwargs):
        folders = [make_run(self.runs, n, **kwargs) for n in (1, 2)]
        d = self.series / SERIES_ID
        d.mkdir(parents=True)
        self.write_series({
            'id': SERIES_ID, 'save': 'Oasis by the Sea-1', 'benchmark': 'Oasis by the Sea construction', 'model': 'Test Model',
            'episodes': 2, 'status': 'completed',
            'results': [{'episode': n, 'attempt': 1, 'outcome': 'valid', 'folder': f, 'status': 'completed'}
                        for n, f in enumerate(folders, 1)]})
        for n in (1, 2):
            (d / f'playbook-after-episode-{n}.md').write_text(f'Playbook {n}: build farms early.\n')
        return folders

    def read_series(self):
        return json.loads((self.series / SERIES_ID / 'series.json').read_text())

    def write_series(self, record):
        (self.series / SERIES_ID / 'series.json').write_text(json.dumps(record))

    def load(self, path):
        from datasets import load_dataset, disable_progress_bars
        disable_progress_bars()
        return load_dataset('parquet', data_files={'train': str(path)}, split='train')

    def package(self, git=None, render=None, submitter='tester-hf'):
        self.renders, self.shrunk = [], []

        def fake_render(run_dir, staged):
            self.renders.append(run_dir)
            return None

        def fake_shrink(video):
            self.shrunk.append(video.relative_to(self.out))
            return None

        group = package.resolve(SERIES_ID, runs=self.runs, series=self.series)
        rows = lambda dirs: {d.name: report_row(d.name, int(d.name[-1])) for d in dirs}
        return package.package(group, out=self.out, scrubber=Scrubber(machine()), git=git or FakeGit(),
                               rows_of=rows, render=render or fake_render, shrink=fake_shrink,
                               tier='official', submitter=submitter)


class PackageTest(Fixture):
    def test_a_clean_series_is_staged_scrubbed_and_publishable(self):
        folders = self.make_series(logs_extra=line(2, {'kind': 'error', 'text': 'ls /home/alice/crusader/tools failed'}))
        result = self.package()
        m = result.manifest
        self.assertEqual(m['problems'], [])
        self.assertTrue(m['publishable'])
        self.assertEqual(result.rel, f'v1.0/oasis-by-the-sea-construction/test--model-1/{SERIES_ID}')
        self.assertEqual({f['path'] for f in m['files']} >= {'series.parquet', 'series.json', 'playbook-after-episode-2.md',
                                                            'episode-1/episode.parquet', 'episode-1/timeline.parquet',
                                                            'episode-1/video.mp4', 'episode-2/events.jsonl'}, True)
        self.assertFalse(any(f['path'].startswith(('episode-1/recording', 'episode-1/checkpoint')) for f in m['files']))

        staged = result.dest / 'episode-1'
        events = (staged / 'events.jsonl').read_text()
        for gone in ('"pid"', '"windowId"', '"graphics"', '"system"', '/Users/tester', '"directory"'):
            self.assertNotIn(gone, events)
        self.assertIn(IMAGE_DATA, events)  # base64 that is no image stays, user name inside it not a finding
        self.assertIn('<game-root>/tools', (staged / 'logs.jsonl').read_text())
        original = (self.runs / folders[0] / 'events.jsonl').read_text().splitlines()
        self.assertIn(original[3], events.splitlines())  # lines needing no change are copied byte for byte
        self.assertEqual(self.renders, [])  # nothing the video is drawn from was replaced
        self.assertEqual(self.shrunk, [Path(result.rel, f'episode-{n}', 'video.mp4') for n in (1, 2)])
        self.assertEqual(m['scrub']['dropped_fields'], {'directory': 2, 'graphics': 2, 'pid': 2, 'system': 2, 'windowId': 2})

    def test_images_leave_the_logs_once_each_and_token_deltas_are_dropped(self):
        from PIL import Image
        self.make_series()
        result = self.package()
        staged = result.dest / 'episode-1'
        events = [json.loads(text)['event'] for text in (staged / 'events.jsonl').read_text().splitlines()]
        self.assertNotIn('message_update', {e['type'] for e in events})
        self.assertNotIn(SCREENSHOT[:200], json.dumps(events))
        screenshot = next(e for e in events if e['type'] == 'host_observation')['message']['content'][2]
        self.assertEqual(set(screenshot), {'type', 'mimeType', 'path'})
        self.assertRegex(screenshot['path'], r'^images/[0-9a-f]{16}\.webp$')
        self.assertEqual(screenshot['mimeType'], 'image/webp')
        with Image.open(staged / screenshot['path']) as image:
            self.assertEqual(image.size, (96, 54))  # full size
        # The final frame holds the same screenshot: its path, and no second file.
        self.assertEqual(next(e for e in events if e['type'] == 'final_observation')['frame']['image'], screenshot['path'])
        crops = {c['path'] for e in events for c in ((e.get('message') or e.get('result') or {}).get('content') or [])
                 if e['type'] in ('tool_execution_end', 'message_start', 'message_end') and c['type'] == 'image'}
        self.assertEqual(len(crops), 1)  # one tool screenshot, logged three times
        self.assertEqual(sorted(p.name for p in (staged / 'images').iterdir()),
                         sorted(Path(p).name for p in crops | {screenshot['path']}))
        self.assertEqual(result.manifest['slimmed'],
                         {'image_references': 10, 'image_files': 4, 'deltas_dropped': 4, 'video_height': 720})
        self.assertIn(f'episode-1/{screenshot["path"]}', {f['path'] for f in result.manifest['files']})
        self.assertEqual(upload.verify(result.dest, self.out)[1], [])

    def test_tables_load_with_their_columns_and_image(self):
        from datasets import load_dataset, disable_progress_bars
        disable_progress_bars()
        self.make_series()
        result = self.package()
        load = lambda pattern: load_dataset('parquet', data_files={'train': str(result.dest / pattern)}, split='train')
        series = load('series.parquet')[0]
        self.assertEqual(series['net_worth_by_episode'], [1501, 1502])
        self.assertEqual((series['valid'], series['valid_by_episode']), (True, [True, True]))
        self.assertEqual((series['score'], series['change'], series['episodes_completed']), (1502, 1, 2))
        self.assertEqual(series['tier'], 'official')
        self.assertEqual(series['playbook_final'], 'Playbook 2: build farms early.\n')
        self.assertEqual(series['final_image'].size, (16, 9))
        episode = load('episode-*/episode.parquet').sort('episode')[0]
        self.assertEqual((episode['model_id'], episode['net_worth'], episode['tokens_total']), ('test/model-1', 1501, 1600))
        self.assertEqual(episode['goods'], [{'name': 'bread', 'count': 40}, {'name': 'stone', 'count': 20}])
        self.assertEqual(episode['tool_calls_by_name'], [{'name': 'observe', 'count': 1}])
        self.assertEqual(episode['video'], f'{result.rel}/episode-1/video.mp4')
        self.assertEqual(episode['game_minutes_budget'], 2.0)
        self.assertEqual((episode['net_worth_baseline'], episode['net_worth_growth']), (1304, 197))

        minutes = load('episode-1/timeline.parquet')
        self.assertEqual(minutes['game_minute'], [0, 1, 2])
        self.assertEqual(minutes['sample_source'], ['host_observation', 'host_observation', 'final_reading'])
        self.assertEqual(minutes['gold'], [140, 140, 1200])
        # Minute 2 is the final reading: 1200 gold + 40 bread × 4 + 20 stone × 7 + 10 wood × 1.
        self.assertEqual(minutes['net_worth'][2], 1200 + 160 + 140 + 10)
        # Tokens and tool calls spent by each reading; reflection tokens come after the final one.
        self.assertEqual(minutes['tokens_total'], [100, 100, 1100])
        self.assertEqual(minutes['tool_calls'], [0, 0, 1])

    def test_problems_block_the_upload_and_never_show_the_value(self):
        self.make_series(dirty=True, video=False, version=None,
                         logs_extra=line(2, {'kind': 'error', 'text': f'auth {SECRET} for alice from 192.168.1.20'}))
        m = self.package(git=FakeGit(on_main=False), submitter=None).manifest
        problems = '\n'.join(m['problems'])
        self.assertFalse(m['publishable'])
        for expected in ('uncommitted code', 'not on origin/main', 'no benchmark version', 'no --submitter',
                         'episode 1: no video.mp4', 'saved secret', 'API key', 'user name', 'IP address'):
            self.assertIn(expected, problems)
        self.assertNotIn(SECRET, json.dumps(m))
        self.assertTrue(m['path'].startswith('unversioned/'))

    def test_replaced_text_in_the_logs_the_video_is_drawn_from_re_renders_it(self):
        self.make_series(events_extra=line(9, {'type': 'tool_execution_end', 'toolCallId': 'c2', 'toolName': 'observe',
                                               'result': {'content': [{'type': 'text', 'text': 'see /Users/tester/x'}]}}))
        self.package()
        self.assertEqual(len(self.renders), 2)
        m = self.package(render=lambda run_dir, staged: 'recording/ is gone').manifest
        self.assertIn('episode 1: the logs needed scrubbing and recording/ is gone', m['problems'])

    def test_an_episode_that_is_not_a_full_budget_score_is_a_problem(self):
        folders = self.make_series()
        path = self.runs / folders[1] / 'episode.json'
        episode = json.loads(path.read_text())
        episode.update(valid=False, invalid=['ended by wall_limit', 'final pause not confirmed'])
        path.write_text(json.dumps(episode))
        result = self.package()
        self.assertIn('episode 2: not a full-budget score: ended by wall_limit', result.manifest['problems'])
        self.assertIn('episode 2: not a full-budget score: final pause not confirmed', result.manifest['problems'])
        from datasets import load_dataset, disable_progress_bars
        disable_progress_bars()
        series = load_dataset('parquet', data_files={'train': str(result.dest / 'series.parquet')}, split='train')[0]
        self.assertEqual((series['valid'], series['valid_by_episode']), (False, [True, False]))
        row = load_dataset('parquet', data_files={'train': str(result.dest / 'episode-2/episode.parquet')}, split='train')[0]
        self.assertEqual((row['valid'], row['invalid']), (False, ['ended by wall_limit', 'final pause not confirmed']))
        self.assertEqual((row['cost_usd'], row['cost_source']), (0.002, 'prices'))

    def test_patches_of_one_minor_version_compare_and_share_a_folder(self):
        folders = self.make_series()
        path = self.runs / folders[1] / 'run.json'
        run = json.loads(path.read_text())
        run['benchmark']['version'] = '1.0.3'
        path.write_text(json.dumps(run))
        result = self.package()
        self.assertEqual(result.manifest['problems'], [])
        self.assertTrue(result.rel.startswith('v1.0/'))
        run['benchmark']['version'] = '1.1.0'
        path.write_text(json.dumps(run))
        self.assertIn('the episodes differ in benchmark version', self.package().manifest['problems'])

    def test_a_failed_episode_and_episode_differences_are_problems(self):
        folders = self.make_series()
        run = json.loads((self.runs / folders[1] / 'run.json').read_text())
        run['model']['reasoning'] = 'high'
        (self.runs / folders[1] / 'run.json').write_text(json.dumps(run))
        record = self.read_series()
        record.update(episodes=3, status='paused')
        record['results'].append({'episode': 3, 'attempt': 1, 'outcome': 'infrastructure',
                                  'reason': 'Timed out waiting for the save to load.'})
        self.write_series(record)
        problems = self.package().manifest['problems']
        self.assertIn('the episodes differ in model', problems)
        self.assertIn('the series is paused, not completed; finish it before publishing', problems)
        self.assertIn('episode 3: no result yet (last attempt: infrastructure: Timed out waiting for the save to load.)', problems)

    def test_each_episode_publishes_its_counting_attempt(self):
        folders = self.make_series()
        retry = make_run(self.runs, 1, suffix='a0000001', attempt=2)
        record = self.read_series()
        record['results'] = [
            {'episode': 1, 'attempt': 1, 'outcome': 'infrastructure', 'reason': 'memory guard', 'folder': folders[0]},
            {'episode': 1, 'attempt': 2, 'outcome': 'valid', 'folder': retry},
            {'episode': 2, 'attempt': 1, 'outcome': 'stopped', 'folder': folders[1]},
            {'episode': 2, 'attempt': 2, 'outcome': 'model_failure', 'reason': 'No tool calls in 4 replies in a row',
             'folder': folders[1]},
        ]
        self.write_series(record)
        # The model ended episode 2: its scorecard says so, and it is still the episode's result.
        path = self.runs / folders[1] / 'episode.json'
        episode = json.loads(path.read_text())
        episode.update(valid=False, invalid=['run error (No tool calls in 4 replies in a row)'])
        path.write_text(json.dumps(episode))
        result = self.package()
        self.assertEqual(result.manifest['problems'], [])
        self.assertEqual(json.loads((result.dest / 'episode-1/run.json').read_text())['id'], 'a0000001-run')
        first = self.load(result.dest / 'episode-1/episode.parquet')[0]
        self.assertEqual((first['attempt'], first['outcome'], first['valid']), (2, 'valid', True))
        second = self.load(result.dest / 'episode-2/episode.parquet')[0]
        self.assertEqual((second['attempt'], second['outcome'], second['valid']), (2, 'model_failure', False))
        series = self.load(result.dest / 'series.parquet')[0]
        self.assertEqual((series['valid'], series['valid_by_episode']), (False, [True, False]))
        self.assertEqual(series['dataset_version'], '1.0.0')
        self.assertEqual(series['benchmark_fingerprint'], 'b' * 64)


class UploadTest(Fixture):
    def staged(self):
        self.make_series()
        return self.package()

    def test_a_clean_bundle_verifies_and_changes_after_packaging_do_not(self):
        result = self.staged()
        self.assertEqual(upload.verify(result.dest, self.out)[1], [])
        (result.dest / 'episode-1' / 'logs.jsonl').write_text('edited\n')
        (result.dest / 'extra.txt').write_text('x')
        (result.dest / '.DS_Store').write_text('x')
        problems = upload.verify(result.dest, self.out)[1]
        self.assertEqual(problems, ['extra.txt was added after packaging', 'episode-1/logs.jsonl changed after packaging'])

    def test_without_yes_nothing_is_sent(self):
        result = self.staged()
        api = mock.Mock()
        out = io.StringIO()
        with redirect_stdout(out):
            upload.main([str(result.dest), '--repo', 'org/runs', '--out', str(self.out)], api=api)
        self.assertIn('Dry run: nothing was uploaded', out.getvalue())
        api.create_commit.assert_not_called()
        api.file_exists.assert_not_called()

    def test_yes_commits_the_bundle_once_and_replaces_one_only_when_asked(self):
        result = self.staged()
        api = mock.Mock()
        api.file_exists.return_value = False
        api.create_commit.return_value = mock.Mock(pr_url='https://huggingface.co/datasets/org/runs/discussions/1')
        with redirect_stdout(io.StringIO()):
            upload.main([str(result.dest), '--repo', 'org/runs', '--pr', '--yes', '--out', str(self.out)], api=api)
        kwargs = api.create_commit.call_args.kwargs
        paths = {op.path_in_repo for op in kwargs['operations']}
        self.assertTrue(kwargs['create_pr'])
        self.assertEqual(kwargs['repo_type'], 'dataset')
        self.assertIn(f'{result.rel}/manifest.json', paths)
        self.assertIn(f'{result.rel}/episode-2/video.mp4', paths)
        self.assertEqual(len(paths), len(result.manifest['files']) + 1)
        api.file_exists.return_value = True
        with self.assertRaises(SystemExit), redirect_stdout(io.StringIO()):
            upload.main([str(result.dest), '--repo', 'org/runs', '--yes', '--out', str(self.out)], api=api)
        with redirect_stdout(io.StringIO()):
            upload.main([str(result.dest), '--repo', 'org/runs', '--replace', '--yes', '--out', str(self.out)], api=api)
        kwargs = api.create_commit.call_args.kwargs
        first = kwargs['operations'][0]
        # The old folder is deleted in the same commit, before the new files are added.
        self.assertEqual((type(first).__name__, first.path_in_repo, first.is_folder),
                         ('CommitOperationDelete', f'{result.rel}/', True))
        self.assertEqual(len(kwargs['operations']), len(result.manifest['files']) + 2)
        self.assertTrue(kwargs['commit_message'].startswith(f'Replace series {SERIES_ID}'))

    def test_a_bundle_with_problems_is_refused(self):
        self.make_series(video=False)
        result = self.package()
        with self.assertRaises(SystemExit), redirect_stdout(io.StringIO()):
            upload.main([str(result.dest), '--repo', 'org/runs', '--yes', '--out', str(self.out)], api=mock.Mock())

    def test_the_card_is_refused_while_it_has_todos(self):
        if 'TODO' in upload.CARD.read_text():
            with self.assertRaises(SystemExit):
                upload.card_text('org/runs')


class MediaTest(unittest.TestCase):
    def test_only_images_are_decoded(self):
        raw = base64.b64decode(SCREENSHOT)
        self.assertEqual(media.decode(SCREENSHOT), raw)
        self.assertEqual(media.decode('data:image/jpeg;base64,' + SCREENSHOT), raw)
        self.assertIsNone(media.decode(IMAGE_DATA))  # base64, but not an image
        self.assertIsNone(media.decode(SCREENSHOT[:400]))  # too short to be one

    def test_an_image_webp_cannot_shrink_keeps_its_bytes(self):
        raw = picture((96, 54), 'JPEG', quality=5)
        self.assertEqual(media.compress(raw), (raw, 'jpg'))
        webp, extension = media.compress(base64.b64decode(SCREENSHOT))
        self.assertEqual((extension, media.image_type(webp)), ('webp', 'webp'))

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'needs ffmpeg')
    def test_the_video_is_scaled_to_720p_and_never_up(self):
        def height(video):
            return int(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                       'stream=height', '-of', 'csv=p=0', str(video)],
                                      capture_output=True, text=True, check=True).stdout.strip())
        with tempfile.TemporaryDirectory() as tmp:
            for size, expected in (('1920x1080', 720), ('640x360', 360)):
                video = Path(tmp) / f'{size}.mp4'
                subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc=size={size}:rate=5:duration=1',
                                '-pix_fmt', 'yuv420p', str(video)], check=True)
                self.assertIsNone(media.shrink_video(video))
                self.assertEqual(height(video), expected)
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()), ['1920x1080.mp4', '640x360.mp4'])


class ScrubTest(unittest.TestCase):
    def test_machine_values_come_from_env_profiles_and_this_machine(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / '.env').write_text(f'GAME_SSH_HOST=bob@gamebox\nGAME_REMOTE_ROOT=/home/bob/arena/\n'
                                       f'OPENROUTER_API_KEY="{SECRET}"\nPORT=4317\nSHORT_TOKEN=abc\n')
            (root / 'harness/runtime/config').mkdir(parents=True)
            (root / 'harness/runtime/config/models.json').write_text(json.dumps([{'apiKey': 'k' * 40}]))
            m = machine_values(root, environ={})
        self.assertIn(('/home/bob/arena', '<game-root>'), m.replace)
        self.assertIn(('bob@gamebox', '<game-host>'), m.replace)
        # A plain-word host name is reported, not replaced: "gamebox" could be ordinary text.
        self.assertIn(('gamebox', 'host name'), m.names)
        self.assertIn(('bob', 'user name'), m.names)
        self.assertEqual(set(m.secrets) >= {SECRET, 'k' * 40}, True)
        self.assertNotIn('abc', m.secrets)

    def test_names_match_whole_words_only(self):
        s = Scrubber(Machine(names=[('bob', 'user name')]))
        s.text('bobcat and kebob', 'f', 'line 1')
        self.assertEqual(s.findings, [])
        s.text('ssh bob@host.example.com', 'f', 'line 2')
        self.assertEqual([str(f) for f in s.findings], ['f line 2: email address', 'f line 2: user name'])


class TimelineTest(unittest.TestCase):
    def test_the_clock_reads_both_formats(self):
        self.assertEqual(timeline.clock_seconds({'game_seconds_used': 13.5}), 13.5)
        self.assertEqual(timeline.clock_seconds({'game_time_used': '3 min 20 s'}), 200)
        self.assertEqual(timeline.clock_seconds({'game_time_used': '1 s'}), 1)
        self.assertEqual(timeline.clock_seconds({'game_time_used': '25 min'}), 1500)
        self.assertIsNone(timeline.clock_seconds({'game_time_used': 'soon'}))

    def test_a_final_event_without_a_reading_falls_back_to_the_scorecard(self):
        goods = {'bread': 40}
        with tempfile.TemporaryDirectory() as tmp:
            events = Path(tmp) / 'events.jsonl'
            events.write_text(''.join([
                line(1, {'type': 'host_observation', 'message': {'content': [{'type': 'text', 'text': json.dumps({
                    'run_clock': {'game_time_used': '1 s'}, 'stats': {'status': 'ok', 'gold': 430, 'goods': goods}})}]}}),
                line(2, {'type': 'tool_execution_end', 'toolName': 'observe', 'result': {
                    'content': [], 'details': {'readerStats': reading(9000 + 50 * 30, 500, 3, goods)}}}),
                line(3, {'type': 'message_end', 'message': {'role': 'assistant', 'usage': usage(900)}}),
                # Placed a fraction of a second past the budget: no extra minute, not the last row.
                line(4, {'type': 'tool_execution_end', 'toolName': 'observe', 'result': {
                    'content': [], 'details': {'readerStats': reading(9000 + 120 * 30 + 2, 1190, 10, goods)}}}),
                line(5, {'type': 'final_observation', 'stats': {'status': 'unavailable', 'observation': None}}),
                line(6, {'type': 'reflection_usage', 'usage': usage(500)}),
            ]))
            card = {'game_time': 9000 + 120 * 30, 'gold': 1200, 'population': 10, 'goods': {'bread': 40},
                    'date': {'month': 9, 'year': 1194}}
            minutes = timeline.rows(events, 120, 120.0, {'bread': 4}, {}, card)
        self.assertEqual([m['game_minute'] for m in minutes], [0, 1, 2])
        self.assertEqual([m['sample_source'] for m in minutes], ['host_observation', 'tool_result', 'final_reading'])
        self.assertEqual([m['sample_game_seconds'] for m in minutes], [1.0, 50.0, 120.0])
        self.assertEqual([m['gold'] for m in minutes], [430, 500, 1200])
        self.assertEqual(minutes[2]['net_worth'], 1200 + 160)
        self.assertEqual(minutes[2]['tokens_total'], 900)  # spent by the final reading, before the reflection

    def test_sell_prices_are_read_from_the_harness(self):
        prices = timeline.sell_prices()
        self.assertEqual(len(prices), 20)
        self.assertEqual((prices['wood_planks'], prices['stone'], prices['iron']), (1, 7, 23))


@unittest.skipUnless((package.ROOT / 'node_modules/.bin/tsx').exists(), 'needs npm install')
class ReportContractTest(Fixture):
    def test_the_report_rows_have_what_packaging_reads(self):
        folder = make_run(self.runs, 1)
        row = package.report_rows([self.runs / folder])[folder]
        expected = report_row(folder, 1)
        for key in expected:
            self.assertIn(key, row)
        for key in expected['scorecard']:
            self.assertIn(key, row['scorecard'])
        self.assertEqual(row['scorecard']['netWorth'], 1501)
        self.assertEqual(row['tokens']['total'], 1600)
        self.assertEqual(row['tools'], {'observe': 1})


if __name__ == '__main__':
    unittest.main()
