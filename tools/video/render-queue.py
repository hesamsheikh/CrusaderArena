#!/usr/bin/env python3
"""Render a recorded run's video, then compact its recording, one run at a time on this machine.

  python3 tools/video/render-queue.py harness/runtime/runs/<run folder> [--log FILE] [--prefix TEXT]

The episode runner starts this detached once an episode is scored (harness/server/video.ts,
renderInBackground), so the next episode can start meanwhile. It waits for a lock on
harness/runtime/render.lock, so renders on this machine go one at a time across runners, then runs
render-video.py and compact-recording.py at low priority (nice 15), so they do not slow a run being
played. <run>/render.pending, holding this process's id, exists until it is done; packaging lists
the run as a problem until then, so it is not uploaded (tools/dataset/package.py). A stop (SIGTERM,
SIGHUP, Ctrl-C) ends the step running, removes the marker and releases the lock; a step that runs
past STEP_SECONDS is ended as hung. Progress lines go to stdout and, with --log, are appended to
that file (the series' runner.log) after --prefix; the last stdout line is a JSON summary.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LOCK = ROOT / 'harness' / 'runtime' / 'render.lock'
PENDING = 'render.pending'
NICE = 15
# Renders took 3-10 minutes and compactions 1.5-2.5 (runs of 2026-10-11 to 13): an hour is a hang.
STEP_SECONDS = 3600


def stop(process):
    """End a step: SIGTERM first, so render-video.py can end its ffmpeg itself, then SIGKILL."""
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def run_command(command, timeout=STEP_SECONDS):
    """Run one step's command: its exit code, stdout and stderr, or None and a reason when it hung."""
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            stop(process)
            process.communicate()
            return None, '', f'stopped after {timeout // 60} minutes without finishing'
        except BaseException:
            # A stop (SystemExit from the signal handler) or Ctrl-C: the child must not live on.
            stop(process)
            raise
    return process.returncode, stdout, stderr


def run_step(script, run_dir, timeout=STEP_SECONDS):
    """One of the video tools on run_dir, at low priority: its JSON result (None on failure) and its last error line."""
    command = [sys.executable, str(HERE / script), str(run_dir), '--quiet']
    if os.name != 'nt':
        command = ['nice', '-n', str(NICE)] + command
    code, stdout, stderr = run_command(command, timeout)
    if code is None:
        return None, stderr
    lines = stdout.strip().splitlines()
    data = None
    if code == 0 and lines:
        try:
            data = json.loads(lines[-1])
        except ValueError:
            data = None
    errors = stderr.strip().splitlines()
    return data, (errors[-1] if errors else f'exit {code}')


def stop_on_signals():
    """SIGTERM and SIGHUP end the queue like Ctrl-C: the finally clauses run, so the marker goes."""
    def stopped(signum, _frame):
        raise SystemExit(128 + signum)
    for name in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stopped)


def minutes(seconds):
    """Video length as the runner logs it: 1406.4 -> '23:26'."""
    return f'{int(seconds // 60)}:{round(seconds % 60):02d}'


def process(run_dir, say, step=run_step, lock_path=LOCK):
    """Render, then compact, holding the machine-wide lock; render.pending goes once this is done."""
    summary = {'run': str(run_dir), 'video': None, 'compaction': None}
    pending = run_dir / PENDING
    # This process's id: packaging tells a render still going from one stopped before its end.
    pending.write_text(str(os.getpid()))
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

    stop_on_signals()
    summary = process(run_dir, say, step=run_step, lock_path=LOCK)
    print(json.dumps(summary), flush=True)
    return 0 if summary['video'] else 1


if __name__ == '__main__':
    sys.exit(main())
