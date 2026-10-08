#!/usr/bin/env python3
"""Capture-only game-window recorder for run videos. Never captures root or sends input.

Captures the validated game window's compositor pixmap (same window checks as
game-window.py) and writes frames to stdout: one JSON header line
{"t": capture ms, "w", "h", "sw", "sh" (window size), "bytes", "ms": capture cost} followed by that many JPEG bytes.

Stdin commands, one per line: "run" captures at --fps, "hold" stops capturing,
"burst" captures at --burst-fps for --burst-seconds (the host sends it with each click or
key, so actions are recorded smoothly and idle play sparsely), "ping" keeps the process
alive, "quit" exits. Starts held. Exits at end of input or
after 20 s without input, so an orphaned SSH session cannot keep capturing.
Requires python-xlib 0.33 and Pillow (the .venv-control interpreter).
"""
import argparse
import io
import json
import os
from pathlib import Path
import select
import sys
import time
from runpy import run_path

parser = argparse.ArgumentParser()
parser.add_argument('--fps', type=float, default=4, help='idle capture rate')
parser.add_argument('--burst-fps', type=float, default=10, help='capture rate right after an input')
parser.add_argument('--burst-seconds', type=float, default=2.5)
parser.add_argument('--width', type=int, default=1440, help='downscale to this width (0 keeps the window size)')
parser.add_argument('--quality', type=int, default=78)
args = parser.parse_args()
if not (0.5 <= args.fps <= args.burst_fps <= 30 and 0 <= args.burst_seconds <= 30
        and (args.width == 0 or 320 <= args.width <= 3840) and 30 <= args.quality <= 95):
    sys.exit('Unsupported recording settings.')

game_environment = run_path(str(Path(__file__).with_name('run-proton.py')))['game_environment']
pid, game_env = game_environment()
for key in ('DISPLAY', 'XAUTHORITY'):
    if key in game_env:
        os.environ[key] = game_env[key]
if not Path(os.environ.get('XAUTHORITY', '/missing')).is_file():
    auths = list(Path(f'/run/user/{os.getuid()}').glob('.mutter-Xwaylandauth.*'))
    if len(auths) != 1:
        raise RuntimeError('Cannot identify game display authorization.')
    os.environ['XAUTHORITY'] = str(auths[0])
from Xlib import X, display
from Xlib.ext import composite  # noqa: F401  (registers composite_name_window_pixmap)
from PIL import Image

TITLE = 'Stronghold Crusader Definitive Edition'
CLASS = 'steam_app_3024040'
d = display.Display()
root = d.screen().root


def window():
    current_pid, _ = game_environment()
    if current_pid != pid:
        raise RuntimeError('Game process changed.')
    matches = []
    for w in root.query_tree().children:
        try:
            klass = w.get_wm_class() or ()
            prop = w.get_full_property(d.intern_atom('_NET_WM_PID'), X.AnyPropertyType)
            if w.get_wm_name() == TITLE and CLASS in klass and prop is not None and int(prop.value[0]) == pid:
                if w.get_attributes().map_state == X.IsViewable:
                    matches.append(w)
        except Exception:
            continue
    if len(matches) != 1:
        raise RuntimeError('Expected one visible Stronghold game window; no desktop fallback.')
    g = matches[0].get_geometry()
    if not (320 <= g.width <= 7680 and 200 <= g.height <= 4320):
        raise RuntimeError('Unsupported game window dimensions.')
    return matches[0], g


def capture(w, g):
    pixmap = w.composite_name_window_pixmap()
    try:
        raw = pixmap.get_image(0, 0, g.width, g.height, X.ZPixmap, 0xffffffff)
        if raw is None or raw.depth not in (24, 32):
            raise RuntimeError('Game capture unavailable.')
        im = Image.frombytes('RGB', (g.width, g.height), raw.data, 'raw', 'BGRX')
    finally:
        pixmap.free()
    if args.width and im.width != args.width:
        im = im.resize((args.width, round(im.height * args.width / im.width)), Image.BILINEAR)
    output = io.BytesIO()
    im.save(output, format='JPEG', quality=args.quality)
    return im.width, im.height, g.width, g.height, output.getvalue()


def emit(header, data=b''):
    sys.stdout.buffer.write((json.dumps(header) + '\n').encode() + data)
    sys.stdout.buffer.flush()


IDLE_EXIT_SECONDS = 20
REVALIDATE_SECONDS = 2
running = False
burst_until = 0.0
last_input = time.time()
buffer = b''
target = None
validated_at = 0.0
next_frame = time.monotonic()
emit({'event': 'ready', 'pid': pid, 'fps': args.fps, 'burstFps': args.burst_fps})
try:
    while True:
        if time.time() - last_input > IDLE_EXIT_SECONDS:
            break
        timeout = max(0.0, next_frame - time.monotonic()) if running else 0.5
        if select.select([sys.stdin], [], [], timeout)[0]:
            chunk = os.read(sys.stdin.fileno(), 4096)
            if not chunk:
                break
            last_input = time.time()
            buffer += chunk
            *lines, buffer = buffer.split(b'\n')
            commands = [line.strip().decode(errors='replace') for line in lines]
            if 'quit' in commands:
                break
            for command in commands:
                if command in ('run', 'hold'):
                    running = command == 'run'
                    next_frame = time.monotonic()
                    emit({'event': command, 't': int(time.time() * 1000)})
                elif command == 'burst':
                    burst_until = time.monotonic() + args.burst_seconds
                    next_frame = min(next_frame, time.monotonic() + 1 / args.burst_fps)
            continue
        if not running or time.monotonic() < next_frame:
            continue
        next_frame += 1 / (args.burst_fps if time.monotonic() < burst_until else args.fps)
        # A slow capture skips ahead instead of queueing a burst of late frames.
        next_frame = max(next_frame, time.monotonic())
        started = time.monotonic()
        try:
            if target is None or time.monotonic() - validated_at > REVALIDATE_SECONDS:
                target = window()
                validated_at = time.monotonic()
            t = int(time.time() * 1000)
            width, height, source_width, source_height, jpeg = capture(*target)
        except Exception as error:
            target = None
            emit({'event': 'error', 't': int(time.time() * 1000), 'error': str(error)[:300]})
            next_frame = time.monotonic() + 1
            continue
        emit({'t': t, 'w': width, 'h': height, 'sw': source_width, 'sh': source_height, 'bytes': len(jpeg),
              'ms': round((time.monotonic() - started) * 1000)}, jpeg)
except (BrokenPipeError, KeyboardInterrupt):
    pass
