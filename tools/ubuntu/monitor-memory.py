#!/usr/bin/env python3
"""Bounded Linux game-memory diagnostics; does not load the game reader.

By default limits only stop monitoring with exit code 2. --terminate-on-limit
also sends SIGTERM to the initially discovered game through a Linux pidfd.
"""
import argparse
import json
import math
import os
from pathlib import Path
from runpy import run_path
import signal
import time


def fields(text):
    return dict(line.split(':', 1) for line in text.splitlines() if ':' in line)


def kib(value):
    parts = value.split()
    if len(parts) != 2 or parts[1] != 'kB':
        raise ValueError('Expected a /proc memory value in kB')
    number = int(parts[0])
    if number < 0:
        raise ValueError('Negative memory value')
    return number


def graphics_clients(pid, proc=Path('/proc')):
    """Optional Linux DRM fdinfo attribution, deduplicated per device/client.

    These kernel-reported allocations may overlap/shared-map other counters;
    never add them to RSS to derive a physical-memory total.
    """
    directory = proc / str(pid) / 'fdinfo'
    clients = {}
    errors = 0
    try:
        entries = list(directory.iterdir())
    except FileNotFoundError:
        return None
    except OSError:
        return {'clients': [], 'read_errors': 1}
    for entry in entries:
        try:
            data = fields(entry.read_text())
            if 'drm-client-id' not in data:
                continue
            driver = data.get('drm-driver', '').strip()
            device = data.get('drm-pdev', '').strip()
            client = data['drm-client-id'].strip()
            memory = {}
            for name, value in data.items():
                if not name.startswith(('drm-total-', 'drm-shared-', 'drm-active-',
                                        'drm-resident-', 'drm-purgeable-')):
                    continue
                parts = value.split()
                if parts == ['0']:
                    memory[name] = 0
                elif len(parts) == 2 and parts[1] == 'KiB' and int(parts[0]) >= 0:
                    memory[name] = int(parts[0])
            clients[(driver, device, client)] = dict(driver=driver, device=device,
                                                   client_id=client, memory_kib=memory)
        except (OSError, ValueError):
            errors += 1
    return {'clients': list(clients.values()), 'read_errors': errors}


def sample(pid, proc=Path('/proc')):
    status = fields((proc / str(pid) / 'status').read_text())
    # A dying process can retain /proc/<pid>/status briefly without VmRSS.
    if 'VmRSS' not in status:
        raise ProcessLookupError(pid)
    memory = fields((proc / 'meminfo').read_text())
    row = dict(pid=pid, rss_kib=kib(status['VmRSS']),
                swap_kib=kib(status['VmSwap']), threads=int(status['Threads']),
                available_kib=kib(memory['MemAvailable']))
    # Available memory can fall without game RSS growing (e.g. shared graphics
    # allocations or another process). Preserve attribution alongside the guard.
    system = {name: kib(memory[name]) for name in
              ('MemFree', 'Cached', 'Shmem', 'Unevictable', 'SwapFree') if name in memory}
    resident = {name: kib(status[name]) for name in
                ('RssAnon', 'RssFile', 'RssShmem') if name in status}
    if system: row['system_kib'] = system
    if resident: row['resident_kib'] = resident
    graphics = graphics_clients(pid, proc)
    if graphics is not None: row['graphics'] = graphics
    return row


def memory_map(pid, proc=Path('/proc'), top=15):
    """Summarize /proc/<pid>/smaps: resident/anonymous totals per mapped file and
    the largest anonymous mappings, to show which region grows."""
    groups, mappings, current = {}, [], None
    for line in (proc / str(pid) / 'smaps').read_text(errors='replace').splitlines():
        parts = line.split()
        if parts and '-' in parts[0] and ':' not in parts[0]:
            name = parts[5] if len(parts) > 5 else '[anonymous]'
            start, end = (int(x, 16) for x in parts[0].split('-'))
            current = dict(range=parts[0], perms=parts[1], name=name,
                           size_kib=(end - start) // 1024, rss_kib=0, anonymous_kib=0)
            mappings.append(current)
        elif current is not None and parts[:1] in (['Rss:'], ['Anonymous:']) and len(parts) == 3:
            current['rss_kib' if parts[0] == 'Rss:' else 'anonymous_kib'] = int(parts[1])
    for m in mappings:
        group = groups.setdefault(m['name'].rsplit('/', 1)[-1], dict(count=0, rss_kib=0, anonymous_kib=0))
        group['count'] += 1; group['rss_kib'] += m['rss_kib']; group['anonymous_kib'] += m['anonymous_kib']
    ranked = sorted(groups.items(), key=lambda g: -g[1]['rss_kib'])[:top]
    largest = sorted(mappings, key=lambda m: -m['anonymous_kib'])[:top]
    return dict(mapping_count=len(mappings), groups=dict(ranked), largest_anonymous=largest)


def thread_cpu(pid, proc=Path('/proc')):
    """CPU clock ticks (user+system) and name per thread."""
    threads = {}
    for task in (proc / str(pid) / 'task').iterdir():
        try:
            stat = (task / 'stat').read_text()
            name = stat[stat.index('(') + 1:stat.rindex(')')]
            fields_after = stat[stat.rindex(')') + 2:].split()
            threads[task.name] = (name, int(fields_after[11]) + int(fields_after[12]))
        except (OSError, ValueError, IndexError):
            continue
    return threads


def busiest(before, after, top=8):
    """Threads with the most CPU ticks between two thread_cpu readings."""
    deltas = [(after[t][1] - before.get(t, (None, 0))[1], after[t][0], t) for t in after]
    return [dict(tid=t, name=n, ticks=d) for d, n, t in sorted(deltas, reverse=True)[:top] if d > 0]


def limits(row, max_rss_mib, min_available_mib):
    reasons = []
    if row['rss_kib'] > max_rss_mib * 1024:
        reasons.append('game_rss_limit')
    if row['available_kib'] < min_available_mib * 1024:
        reasons.append('system_available_limit')
    return reasons


def emit(**record):
    print(json.dumps(dict(at_unix_ms=time.time_ns() // 1_000_000, **record)), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=600)
    parser.add_argument('--interval', type=float, default=1)
    parser.add_argument('--max-rss-mib', type=int, default=8192)
    parser.add_argument('--min-available-mib', type=int, default=4096)
    parser.add_argument('--terminate-on-limit', action='store_true')
    parser.add_argument('--map-step-mib', type=int, default=0,
                        help='Record a memory-map and thread-CPU snapshot at start and after each RSS rise of this size (0 disables)')
    parser.add_argument('--max-maps', type=int, default=20)
    args = parser.parse_args()
    if not math.isfinite(args.seconds) or not 0 < args.seconds <= 86400:
        parser.error('--seconds must be finite and within (0, 86400]')
    if not math.isfinite(args.interval) or not .1 <= args.interval <= 60:
        parser.error('--interval must be finite and within [0.1, 60]')
    if args.max_rss_mib <= 0 or args.min_available_mib < 0 or args.map_step_mib < 0 or args.max_maps < 0:
        parser.error('invalid memory limits')
    discover = run_path(str(Path(__file__).with_name('run-proton.py')))['game_environment']
    pid, _ = discover()
    # Bind a process lifetime, not a recyclable numeric PID. Fail if unsupported.
    fd = os.pidfd_open(pid)
    try:
        if discover()[0] != pid:
            raise RuntimeError('Game process changed during monitor startup')
        import select
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        start = time.monotonic()
        map_rss, map_cpu, maps_taken = None, {}, 0
        emit(kind='started', pid=pid, seconds=args.seconds,
             max_rss_mib=args.max_rss_mib, min_available_mib=args.min_available_mib,
             terminate_on_limit=args.terminate_on_limit)
        while time.monotonic() - start < args.seconds:
            if poll.poll(0):
                emit(kind='game_exited', pid=pid)
                return 0
            try:
                row = sample(pid)
            except (FileNotFoundError, ProcessLookupError):
                emit(kind='game_exited', pid=pid)
                return 0
            # Do not report a replacement process if the original exited mid-read.
            if poll.poll(0):
                emit(kind='game_exited', pid=pid)
                return 0
            reasons = limits(row, args.max_rss_mib, args.min_available_mib)
            emit(kind='sample', elapsed_seconds=round(time.monotonic()-start, 3),
                 limits=reasons, **row)
            if args.map_step_mib and maps_taken < args.max_maps and (
                    map_rss is None or row['rss_kib'] - map_rss >= args.map_step_mib * 1024):
                try:
                    cpu = thread_cpu(pid)
                    emit(kind='memory_map', elapsed_seconds=round(time.monotonic()-start, 3),
                         rss_kib=row['rss_kib'], busiest_threads_since_previous=busiest(map_cpu, cpu),
                         **memory_map(pid))
                    map_rss, map_cpu = row['rss_kib'], cpu
                    maps_taken += 1
                except (OSError, ValueError) as error:
                    emit(kind='memory_map_error', error=str(error))
            if reasons:
                if args.terminate_on_limit:
                    try:
                        signal.pidfd_send_signal(fd, signal.SIGTERM)
                        emit(kind='termination_requested', pid=pid, limits=reasons)
                    except ProcessLookupError:
                        emit(kind='game_exited', pid=pid)
                return 2
            time.sleep(min(args.interval, max(0, args.seconds-(time.monotonic()-start))))
        emit(kind='completed', pid=pid)
        return 0
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, KeyError, AttributeError) as error:
        emit(kind='monitor_error', error=str(error))
        raise SystemExit(1)
