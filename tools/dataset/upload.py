"""Upload staged bundles to the Hugging Face dataset.

    npm run upload -- <bundle folder> ... [--repo ORG/NAME] [--pr] [--card] [--yes]

Without --yes it only prints what it would upload. It refuses a bundle that packaging found
problems in, one without a benchmark version, and one whose files changed after packaging
(sizes and SHA-256 must match manifest.json). It never replaces a bundle already in the
dataset. --pr opens a pull request instead of committing; anyone but the dataset's
maintainers needs it. --card also uploads the dataset card (tools/dataset/card.md).

The token comes from HF_TOKEN (environment or .env), else from `hf auth login`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path

from scrub import read_env

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'harness/runtime/publish'
CARD = Path(__file__).with_name('card.md')
IGNORED = {'.DS_Store'}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def verify(bundle: Path, out: Path = OUT) -> tuple[dict, list[str]]:
    """The bundle's manifest and every reason it cannot be uploaded."""
    manifest_file = bundle / 'manifest.json'
    if not manifest_file.is_file():
        return {}, ['no manifest.json: stage it with npm run package']
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    problems = []
    try:
        rel = bundle.resolve().relative_to(out.resolve()).as_posix()
    except ValueError:
        rel = None
        problems.append(f'the bundle is not in the staging folder {out}')
    if rel is not None and manifest.get('path') != rel:
        problems.append('manifest.json names another path; stage it again')
    if not re.fullmatch(r'v\d+', str(manifest.get('dataset_version'))):
        problems.append('the bundle has no benchmark version')
    if not manifest.get('publishable') or manifest.get('problems'):
        problems.append(f'packaging found {len(manifest.get("problems") or [])} problem(s); they are listed in manifest.json')
    listed = {f['path']: f for f in manifest.get('files', [])}
    present = {p.relative_to(bundle).as_posix() for p in bundle.rglob('*')
               if p.is_file() and p != manifest_file and p.name not in IGNORED}
    problems += [f'{path} was added after packaging' for path in sorted(present - listed.keys())]
    problems += [f'{path} is missing' for path in sorted(listed.keys() - present)]
    for path in sorted(present & listed.keys()):
        file = bundle / path
        if file.stat().st_size != listed[path]['bytes'] or sha256(file) != listed[path]['sha256']:
            problems.append(f'{path} changed after packaging')
    return manifest, problems


def card_text(repo: str) -> str:
    text = CARD.read_text(encoding='utf-8')
    if 'TODO' in text:
        raise SystemExit('tools/dataset/card.md still has TODOs (license); settle them before uploading the card.')
    return text.replace('{{repo}}', repo)


def upload(bundle: Path, manifest: dict, repo: str, *, pr: bool, card: bool, api) -> str:
    """One commit (or pull request) with the bundle's files, its manifest and optionally the card."""
    from huggingface_hub import CommitOperationAdd

    rel = manifest['path']
    if api.file_exists(repo, f'{rel}/manifest.json', repo_type='dataset'):
        raise SystemExit(f'{rel} is already in {repo}; bundles are never replaced.')
    operations = [CommitOperationAdd(path_in_repo=f'{rel}/{f["path"]}', path_or_fileobj=str(bundle / f['path']))
                  for f in manifest['files']]
    operations.append(CommitOperationAdd(path_in_repo=f'{rel}/manifest.json', path_or_fileobj=str(bundle / 'manifest.json')))
    if card:
        operations.append(CommitOperationAdd(path_in_repo='README.md', path_or_fileobj=card_text(repo).encode('utf-8')))
    info = api.create_commit(
        repo_id=repo,
        repo_type='dataset',
        operations=operations,
        commit_message=f'Add {manifest["kind"]} {manifest["id"]} ({manifest.get("model_id")}, {manifest.get("benchmark")})',
        commit_description=f'{manifest["episodes"]} episode(s), {manifest.get("tier")}, submitted by {manifest.get("submitted_by")}.',
        create_pr=pr,
    )
    return getattr(info, 'pr_url', None) or getattr(info, 'commit_url', '')


def main(argv=None, api=None):
    env = {**read_env(ROOT / '.env'), **os.environ}
    parser = argparse.ArgumentParser(description='Upload staged bundles to the Hugging Face dataset (a dry run without --yes).')
    parser.add_argument('bundles', nargs='+', help='staged folders, harness/runtime/publish/<version>/<benchmark>/<model>/<id>')
    parser.add_argument('--repo', default=env.get('HF_DATASET_REPO') or None, help='dataset repository, ORG/NAME (default HF_DATASET_REPO)')
    parser.add_argument('--pr', action='store_true', help='open a pull request instead of committing')
    parser.add_argument('--card', action='store_true', help='also upload the dataset card')
    parser.add_argument('--yes', action='store_true', help='upload; without it nothing is sent')
    parser.add_argument('--out', default=str(OUT), help='staging folder (default harness/runtime/publish)')
    args = parser.parse_args(argv)

    checked = []
    failed = False
    for bundle in map(Path, args.bundles):
        manifest, problems = verify(bundle, Path(args.out))
        if problems:
            failed = True
            print(f'{bundle}: cannot upload')
            print('\n'.join(f'  - {p}' for p in problems))
            continue
        files = manifest['files']
        print(f'{manifest["path"]}: {len(files) + 1} files, {sum(f["bytes"] for f in files) / 1e6:.1f} MB '
              f'-> {args.repo or "(no --repo)"}{" as a pull request" if args.pr else ""}')
        checked.append((bundle, manifest))
    if args.card:
        card_text(args.repo or '')
    if failed:
        raise SystemExit(1)
    if not args.yes:
        print('Dry run: nothing was uploaded. Add --yes to upload.')
        return
    if not args.repo:
        raise SystemExit('No dataset repository: pass --repo ORG/NAME or set HF_DATASET_REPO.')
    if api is None:
        from huggingface_hub import HfApi
        api = HfApi(token=env.get('HF_TOKEN') or None)
    for i, (bundle, manifest) in enumerate(checked):
        print(upload(bundle, manifest, args.repo, pr=args.pr, card=args.card and i == 0, api=api))


if __name__ == '__main__':
    main()
