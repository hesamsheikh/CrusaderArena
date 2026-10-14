#!/usr/bin/env python3
"""Render a recorded run's video, then compact its recording, one run at a time on this machine.

  python3 tools/video/render-queue.py harness/runtime/runs/<run folder> [--log FILE] [--prefix TEXT]

The episode runner starts this detached once an episode is scored (harness/server/video.ts,
renderInBackground), so the next episode can start meanwhile. It waits for a lock on
harness/runtime/render.lock, so renders on this machine go one at a time across runners, then runs
render-video.py and compact-recording.py at low priority (nice 15), so they do not slow a run being
played. <run>/render.pending exists until it is done; packaging refuses the run until then
(tools/dataset/package.py). Progress lines go to stdout and, with --log, are appended to that file
(the series' runner.log) after --prefix; the last stdout line is a JSON summary.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LOCK = ROOT / 'harness' / 'runtime' / 'render.lock'
PENDING = 'render.pending'
NICE = 15


def run_step(script, run_dir):
    """One of the video tools on run_dir, at low priority: its JSON result (None on failure) and its last error line."""
    command = [sys.executable, str(HERE / script), str(run_dir), '--quiet']
    if os.name != 'nt':
        command = ['nice', '-n', str(NICE)] + command
    result = subprocess.run(command, capture_output=True, text=True)
    lines = result.stdout.strip().splitlines()
    data = None
    if result.returncode == 0 and lines:
        try:
            data = json.loads(lines[-1])
        except ValueError:
            data = None
    errors = result.stderr.strip().splitlines()
    return data, (errors[-1] if errors else f'exit {result.returncode}')


def minutes(seconds):
    """Video length as the runner logs it: 1406.4 -> '23:26'."""
    return f'{int(seconds // 60)}:{round(seconds % 60):02d}'


def process(run_dir, say, step=run_step, lock_path=LOCK):
    """Render, then compact, holding the machine-wide lock; render.pending goes once this is done."""
    summary = {'run': str(run_dir), 'video': None, 'compaction': None}
    pending = run_dir / PENDING
    pending.touch()
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            video, error = step('render-video.py', run_dir)
            if not video:
                say(f'Video render failed: {error}')
                return summary
            summary['video'] = video
            say(f"Video saved: {video['output']} ({minutes(video['seconds'])}).")
            outcome, error = step('compact-recording.py', run_dir)
            if outcome is None:
                say(f'Recording compaction failed: {error}')
                return summary
            value = next(iter(outcome.values()), None) if isinstance(outcome, dict) else None
            summary['compaction'] = value
            if isinstance(value, dict):
                say(f"Recording compacted: {value['source_bytes'] / 1e6:.0f} MB -> {value['video_bytes'] / 1e6:.0f} MB.")
            elif value:
                say(f'Recording not compacted: {value}.')
            return summary
    finally:
        pending.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('run', help='run folder (harness/runtime/runs/<folder>)')
    parser.add_argument('--log', help='a file to append progress lines to (the series runner.log)')
    parser.add_argument('--prefix', default='', help='text before each progress line, such as "Episode 1: "')
    args = parser.parse_args(argv)
    run_dir = Path(args.run)
    if not run_dir.is_dir():
        sys.exit(f'No run folder {run_dir}.')

    def say(text):
        line = f'{args.prefix}{text}'
        print(line, flush=True)
        if args.log:
            with open(args.log, 'a', encoding='utf-8') as log:
                log.write(f"[{time.strftime('%H:%M:%S', time.gmtime())}] {line}\n")

    summary = process(run_dir, say, step=run_step, lock_path=LOCK)
    print(json.dumps(summary), flush=True)
    return 0 if summary['video'] else 1


if __name__ == '__main__':
    sys.exit(main())
