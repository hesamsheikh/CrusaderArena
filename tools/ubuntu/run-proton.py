#!/usr/bin/env python3
"""Run project diagnostics through the running game's Steam/Proton environment.

Default probe only enumerates modules and checks hashes. Watch emits JSONL at
roughly 2 Hz; expiry applies even if no next line arrives. Economy explicitly
loads our diagnostic DLL; it remains idle in the game until game exit.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from observation_stream import ObservationStream


def game_environment():
    matches = []
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            argv0 = (proc / 'cmdline').read_bytes().split(b'\0')[0].decode()
            if argv0.replace('\\', '/').split('/')[-1] != 'Stronghold Crusader Definitive Edition.exe':
                continue
            env = dict(item.decode().split('=', 1)
                       for item in (proc / 'environ').read_bytes().split(b'\0') if b'=' in item)
            matches.append((int(proc.name), env))
        except (OSError, UnicodeError):
            continue
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one running game; start it through Steam.')
    pid, env = matches[0]
    if env.get('STEAM_COMPAT_APP_ID') != '3024040':
        raise RuntimeError('Unexpected Steam application ID.')
    return pid, env


def launch_chain_tools(pid):
    """Proton and Steam runtime directories named in the game's ancestor command lines (reaper)."""
    tools, current = [], pid
    for _ in range(16):
        try:
            argv = Path(f'/proc/{current}/cmdline').read_bytes().decode(errors='replace').split('\0')
            current = int(Path(f'/proc/{current}/stat').read_text().rsplit(')', 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
        for arg in argv:
            if arg.endswith('/_v2-entry-point') or arg.endswith('/proton'):
                tools.append(Path(arg).parent.resolve())
        if current <= 1:
            break
    return list(dict.fromkeys(tools))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', nargs='?', default='probe',
                        choices=['probe', 'economy', 'test', 'watch', 'tiles', 'map', 'structures'])
    parser.add_argument('--samples', type=int, default=0, help='Watch sample count; 0 runs until game exit')
    parser.add_argument('--interval-ms', type=int, default=500, help='Watch pause between samples (50..5000 ms)')
    parser.add_argument('--region', type=int, nargs=4, metavar=('X0', 'Y0', 'W', 'H'),
                        help='Tiles mode: read native tile layers for this rectangle (read-only, external)')
    parser.add_argument('--ids', type=int, nargs=2, metavar=('FIRST', 'COUNT'),
                        help='Structures mode: raw building records from instance FIRST (diagnostic)')
    args = parser.parse_args()
    if not 0 <= args.samples <= 1000000:
        parser.error("samples must be 0..1000000")
    if not 50 <= args.interval_ms <= 5000:
        parser.error("interval-ms must be 50..5000")
    pid, game_env = game_environment()
    root = Path(__file__).resolve().parents[2]
    build = root / 'build/ubuntu-windows'
    # Deduplicate: the same tool directory can appear more than once in the list.
    tools = list(dict.fromkeys(Path(p).resolve() for p in game_env.get('STEAM_COMPAT_TOOL_PATHS', '').split(':') if p))
    if not tools:
        # Steam sometimes launches with an empty STEAM_COMPAT_TOOL_PATHS (seen on a relaunch
        # right after closing the game, 2026-09-28); the launch chain still names both tools.
        tools = launch_chain_tools(pid)
    protons = [p / 'proton' for p in tools if (p / 'proton').is_file()]
    runtimes = [p for p in tools if (p / '_v2-entry-point').is_file()]
    if len(protons) != 1 or len(runtimes) != 1:
        raise RuntimeError('Cannot identify the active Proton and Steam runtime '
                           f'(tool paths: {[str(p) for p in tools]}).')
    prefix = Path(game_env['STEAM_COMPAT_DATA_PATH']) / 'pfx'
    if not prefix.is_dir() or Path(game_env['WINEPREFIX']).resolve() != prefix.resolve():
        raise RuntimeError('Existing game prefix mismatch; refusing to initialize a prefix.')
    client = runtimes[0] / 'pressure-vessel/bin/steam-runtime-launch-client'
    env = os.environ.copy()
    env.update(DBUS_SESSION_BUS_ADDRESS=f'unix:path=/run/user/{os.getuid()}/bus',
               XDG_RUNTIME_DIR=f'/run/user/{os.getuid()}')
    keys = ['STEAM_COMPAT_APP_ID', 'SteamAppId', 'STEAM_COMPAT_CLIENT_INSTALL_PATH',
            'STEAM_COMPAT_DATA_PATH', 'STEAM_COMPAT_TOOL_PATHS']
    command = [str(client), '--alongside-steam']
    command += ['--env=' + key + '=' + game_env[key] for key in keys]
    command += ['--directory=' + str(root), '--', str(runtimes[0] / '_v2-entry-point'),
                '--verb=run', '--', str(protons[0]), 'runinprefix']
    programs = {'watch': [('crusader_launcher.exe', ['--watch', str(args.samples), str(args.interval_ms)])],
                'probe': [('crusader_probe.exe', [])],
                'tiles': [('crusader_probe.exe', ['--tile-region', *map(str, args.region or [])])],
                'map': [('crusader_probe.exe', ['--map-summary'])],
                'structures': [('crusader_probe.exe', ['--structure-bytes', *map(str, args.ids or [])])],
                'economy': [('crusader_launcher.exe', ['--economy'])],
                'test': [(name + '.exe', []) for name in
                         ['observation_test', 'render_observation_test', 'adapter_contract_test']]}
    if args.mode == 'tiles' and not args.region:
        raise RuntimeError('tiles mode needs --region X0 Y0 W H')
    for name, arguments in programs[args.mode]:
        exe = build / name
        if not exe.is_file():
            raise RuntimeError(f'Missing {exe}; run setup-dev.sh first.')
        print(json.dumps({'started_at_utc': datetime.now(timezone.utc).isoformat(),
                          'linux_game_pid': pid, 'program': name, 'mode': args.mode}), flush=True, file=sys.stderr if args.mode == 'watch' else sys.stdout)
        if args.mode == 'watch':
            stream = ObservationStream()
            child = subprocess.Popen(command + [str(exe)] + arguments, env=env,
                                     stdout=subprocess.PIPE, text=True)
            try:
                for line in child.stdout:
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        print(line.rstrip(), file=sys.stderr)
                        continue
                    print(json.dumps(stream.consume(record, int(time.time() * 1000))), flush=True)
                code = child.wait()
            finally:
                if child.poll() is None:
                    child.terminate()
                print(json.dumps(stream.consume({'status': 'stream_closed'}, int(time.time() * 1000))), flush=True)
            return code
        result = subprocess.run(command + [str(exe)] + arguments, env=env, timeout=45)
        print(json.dumps({'finished_at_utc': datetime.now(timezone.utc).isoformat(),
                          'exit_code': result.returncode}), flush=True)
        if result.returncode:
            return result.returncode
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, KeyError, subprocess.TimeoutExpired) as error:
        print(f'Proton diagnostic failed: {error}. If economy was started, restart the game before retrying.', file=sys.stderr)
        sys.exit(1)
