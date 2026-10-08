#!/usr/bin/env python3
"""Start, focus and close the Steam game for unattended episodes. Prints one JSON line.

  status    game process, window and focus
  launch    start the game through Steam (steam://rungameid) unless it runs; wait for its window
  activate  ask the window manager to focus the game window (one _NET_ACTIVE_WINDOW request)
  close     send SIGTERM to the game process and wait for it to exit

Never sends keyboard or mouse input, never saves, and touches no other window.
Run as the logged-in game user over SSH.
"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

APP_ID = '3024040'
EXE = 'Stronghold Crusader Definitive Edition.exe'
TITLE = 'Stronghold Crusader Definitive Edition'
CLASS = f'steam_app_{APP_ID}'


def games():
    """Running game processes of this user as (pid, environment)."""
    found = []
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if proc.stat().st_uid != os.getuid() or int(proc.name) == os.getpid():
                continue
            argv0 = (proc / 'cmdline').read_bytes().split(b'\0')[0].decode(errors='replace')
            if argv0.replace('\\', '/').rsplit('/', 1)[-1] != EXE:
                continue
            env = dict(item.split('=', 1) for item in
                       (proc / 'environ').read_bytes().decode(errors='replace').split('\0') if '=' in item)
            if env.get('STEAM_COMPAT_APP_ID') == APP_ID:
                found.append((int(proc.name), env))
        except (OSError, ValueError):
            continue
    return found


def x_display(env=None):
    env = env or {}
    os.environ.setdefault('DISPLAY', env.get('DISPLAY', ':0'))
    if 'XAUTHORITY' in env and Path(env['XAUTHORITY']).is_file():
        os.environ['XAUTHORITY'] = env['XAUTHORITY']
    if not Path(os.environ.get('XAUTHORITY', '/missing')).is_file():
        auths = list(Path(f'/run/user/{os.getuid()}').glob('.mutter-Xwaylandauth.*'))
        if len(auths) == 1:
            os.environ['XAUTHORITY'] = str(auths[0])
    from Xlib import X, display
    d = display.Display()
    return d, d.screen().root, X


def game_window(d, root, X, pid):
    for w in root.query_tree().children:
        try:
            prop = w.get_full_property(d.intern_atom('_NET_WM_PID'), X.AnyPropertyType)
            if (w.get_wm_name() == TITLE and CLASS in (w.get_wm_class() or ()) and prop is not None
                    and int(prop.value[0]) == pid and w.get_attributes().map_state == X.IsViewable):
                return w
        except Exception:
            continue
    return None


def status():
    running = games()
    if len(running) != 1:
        return {'running': bool(running), 'processes': len(running), 'window': False, 'active': False}
    pid, env = running[0]
    d, root, X = x_display(env)
    w = game_window(d, root, X, pid)
    active = root.get_full_property(d.intern_atom('_NET_ACTIVE_WINDOW'), X.AnyPropertyType)
    return {'running': True, 'pid': pid, 'window': w is not None,
            'active': bool(w is not None and active is not None and int(active.value[0]) == w.id)}


def launch(timeout):
    if not games():
        unit = f'crusader-game-{int(time.time())}'
        subprocess.run(['systemd-run', '--user', '--collect', f'--unit={unit}', 'steam',
                        f'steam://rungameid/{APP_ID}'], check=True, capture_output=True, timeout=30)
    deadline = time.time() + timeout
    while time.time() < deadline:
        current = status()
        if current['window']:
            return dict(current, launched=True)
        time.sleep(2)
    raise RuntimeError('The game window did not appear; check that Steam is signed in.')


def activate():
    running = games()
    if len(running) != 1:
        raise RuntimeError('Expected exactly one running game.')
    pid, env = running[0]
    d, root, X = x_display(env)
    from Xlib import protocol
    w = game_window(d, root, X, pid)
    if w is None:
        raise RuntimeError('Game window not found.')
    # Source indication 2 (pager): a user-requested activation, not focus stealing.
    root.send_event(protocol.event.ClientMessage(window=w, client_type=d.intern_atom('_NET_ACTIVE_WINDOW'),
                                                 data=(32, [2, X.CurrentTime, 0, 0, 0])),
                    event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    d.sync()
    for _ in range(20):
        time.sleep(0.1)
        active = root.get_full_property(d.intern_atom('_NET_ACTIVE_WINDOW'), X.AnyPropertyType)
        if active is not None and int(active.value[0]) == w.id:
            return {'active': True, 'pid': pid}
    raise RuntimeError('The window manager did not focus the game window.')


def close(timeout):
    running = games()
    if not running:
        return {'closed': True, 'was_running': False}
    if len(running) != 1:
        raise RuntimeError('Expected exactly one running game.')
    pid = running[0][0]
    fd = os.pidfd_open(pid)
    try:
        signal.pidfd_send_signal(fd, signal.SIGTERM)
    except ProcessLookupError:
        return {'closed': True, 'was_running': True, 'pid': pid}
    finally:
        os.close(fd)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not any(p == pid for p, _ in games()):
            return {'closed': True, 'was_running': True, 'pid': pid}
        time.sleep(0.5)
    raise RuntimeError('The game did not exit after SIGTERM.')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['status', 'launch', 'activate', 'close'])
    parser.add_argument('--timeout', type=float, default=120)
    args = parser.parse_args()
    try:
        result = {'status': status, 'activate': activate,
                  'launch': lambda: launch(args.timeout), 'close': lambda: close(args.timeout)}[args.command]()
        print(json.dumps({'ok': True, **result}), flush=True)
        return 0
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
