#!/usr/bin/env python3
"""On-screen run overlay on the game machine, for people watching the game: the model, the
benchmark, the game time used and left as a progress bar, and a line of figures (net worth, gold,
population, popularity, turns, tool calls, cost).

A separate X window above the game that never takes focus and lets clicks through. The agent's
screenshots and the run videos copy only the game window's own image (its compositor pixmap), so
the overlay is in neither, and the bridge sends input to the game window directly. Started by the
bridge's monitor (control-status.py) with the control venv's Python: Pillow draws the panel and
python-xlib shows it. It reads the bridge's status.json, shows itself while a run has a game
clock, and exits once the bridge has been gone for 30 seconds.

A round played on a version made before the overlay has a monitor that neither starts it nor
passes on a game clock. For those the runner feeds it (`overlay.py --feed`, from
harness/server/overlay-feed.ts): status lines on stdin, kept in overlay-feed.json, whose figures
replace status.json's while fresh; the feed starts the overlay when a run's clock appears."""
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import time

BASE = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'crusader-arena'
WIDTH, HEIGHT = 660, 88
GONE_SECONDS = 30
FEED_SECONDS = 4
FEED_KEYS = ('phase', 'model', 'run', 'turns', 'tokens', 'clock', 'tool_calls', 'cost', 'stats')
START_EVERY_SECONDS = 10
FEED_IDLE_SECONDS = 60
FONTS = Path('/usr/share/fonts/truetype/dejavu')
INK = (237, 224, 204)


def read(file):
    try:
        return json.loads(file.read_text())
    except (OSError, ValueError):
        return {}


def clock_text(seconds):
    minutes, rest = divmod(int(max(0, seconds)), 60)
    return f'{minutes}:{rest:02d}'


def bridge_live(status, now):
    return bool(status.get('connected')) and now - status.get('heartbeat', 0) < 4


def with_feed(status, feed, now):
    """The bridge's status with the runner's feed figures over it while the feed is fresh; the
    bridge's own fields (connected, heartbeat) still say whether it is there."""
    at = feed.get('at')
    if not isinstance(at, (int, float)) or now - at >= FEED_SECONDS:
        return status
    return {**status, **{k: feed[k] for k in FEED_KEYS if k in feed}}


def atomic(file, data):
    tmp = file.with_suffix('.tmp')
    tmp.write_text(json.dumps(data))
    tmp.chmod(0o600)
    tmp.replace(file)


def overlay_running():
    with (BASE / 'overlay.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(lock, fcntl.LOCK_UN)
        return False


def stdin_lines(idle=FEED_IDLE_SECONDS, fd=0):
    """The runner's lines as they arrive, ending at end of input or after `idle` seconds without
    any: a feed whose runner went away without closing its connection still exits (one from a
    failed start outlived its runner, 2026-10-13)."""
    rest = b''
    while True:
        ready, _, _ = select.select([fd], [], [], idle)
        if not ready:
            return
        chunk = os.read(fd, 65536)
        if not chunk:
            return
        *lines, rest = (rest + chunk).split(b'\n')
        for line in lines:
            yield line.decode('utf-8', 'replace')


def feed(lines=None, start=None):
    """Keeps each status line from the runner in overlay-feed.json and starts the overlay, at most
    every START_EVERY_SECONDS, while a run has a clock and none is up. On its way out it removes
    the file only if it was the last to write it."""
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    start = start or (lambda: subprocess.Popen([sys.executable, str(Path(__file__).resolve())], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True))
    file, started, me = BASE / 'overlay-feed.json', 0.0, os.getpid()
    try:
        for line in stdin_lines() if lines is None else lines:
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            now = time.time()
            atomic(file, {**{k: data[k] for k in FEED_KEYS if k in data}, 'at': now, 'feed': me})
            if isinstance(data.get('clock'), dict) and now - started >= START_EVERY_SECONDS and not overlay_running():
                started = now
                start()
    finally:
        if read(file).get('feed') == me:
            file.unlink(missing_ok=True)


def adopt_game_display():
    """DISPLAY and XAUTHORITY from the game process, found as the bridge finds them, for an
    overlay the feed started over SSH without them."""
    from runpy import run_path
    _, env = run_path(str(Path(__file__).with_name('run-proton.py')))['game_environment']()
    for key in ('DISPLAY', 'XAUTHORITY'):
        if key in env:
            os.environ[key] = env[key]
    if not Path(os.environ.get('XAUTHORITY', '/missing')).is_file():
        auths = list(Path(f'/run/user/{os.getuid()}').glob('.mutter-Xwaylandauth.*'))
        if len(auths) == 1:
            os.environ['XAUTHORITY'] = str(auths[0])


def number(value):
    return f'{value:,}' if isinstance(value, int) and not isinstance(value, bool) else '–'


def panel(status, now):
    """What the overlay shows for a status, or None while there is no run with a game clock."""
    clock = status.get('clock')
    if not bridge_live(status, now) or not isinstance(clock, dict):
        return None
    total, used = clock.get('total'), clock.get('used')
    if not isinstance(total, (int, float)) or not isinstance(used, (int, float)) or total <= 0:
        return None
    used = min(max(used, 0), total)
    run = str(status.get('run') or '')
    parts = [p.strip() for p in run.split(' · ')]
    benchmark = parts[1] if len(parts) > 1 else ''
    model = str(status.get('model') or (parts[0] if parts else '') or 'Model')
    stats = status.get('stats') if isinstance(status.get('stats'), dict) else {}
    cost = status.get('cost')
    figures = [
        f"Net worth {number(stats.get('net_worth'))}",
        f"Gold {number(stats.get('gold'))}",
        f"People {number(stats.get('population'))}",
        f"Popularity {number(stats.get('popularity'))}",
        f"Turns {number(status.get('turns'))}",
        f"Tool calls {number(status.get('tool_calls'))}",
    ]
    if isinstance(cost, (int, float)) and not isinstance(cost, bool):
        figures.append(f'${cost:.2f}')
    return {
        'title': f'{model} · {benchmark}' if benchmark else model,
        'phase': str(status.get('phase') or '').lower(),
        'fraction': used / total,
        'used': f'{clock_text(used)} / {clock_text(total)} game time',
        'left': f'{clock_text(total - used)} left',
        'figures': '   ·   '.join(figures),
    }


def font(size, bold=False):
    from PIL import ImageFont
    try:
        return ImageFont.truetype(str(FONTS / ('DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf')), size)
    except OSError:
        return ImageFont.load_default(size)


def paint(image, colour, alpha, shape):
    """`image` with `colour` laid over it at `alpha`, through the mask `shape` draws in white."""
    from PIL import Image, ImageDraw
    mask = Image.new('L', image.size, 0)
    shape(ImageDraw.Draw(mask))
    if alpha < 255:
        mask = mask.point(lambda v: v * alpha // 255)
    top = Image.new('RGBA', image.size, colour + (0,))
    top.putalpha(mask)
    return Image.alpha_composite(image, top)


def render(p, width=WIDTH, height=HEIGHT):
    """The panel for `p` (from panel()) as an RGBA image."""
    from PIL import Image
    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    image = paint(image, (28, 18, 20), 214, lambda d: d.rounded_rectangle((0, 0, width - 1, height - 1), 10, fill=255))
    image = paint(image, (235, 222, 201), 89, lambda d: d.rounded_rectangle((0, 0, width - 1, height - 1), 10, outline=255))
    image = paint(image, INK, 255, lambda d: d.text((16, 25), p['title'], fill=255, font=font(15, True), anchor='ls'))
    image = paint(image, INK, 179, lambda d: d.text((width - 16, 24), p['phase'], fill=255, font=font(11), anchor='rs'))
    x, y, w, h = 16, 35, width - 32, 18
    image = paint(image, (255, 255, 255), 31, lambda d: d.rectangle((x, y, x + w - 1, y + h - 1), fill=255))
    done = round(w * p['fraction'])
    if done > 0:
        image = paint(image, (204, 153, 71), 242, lambda d: d.rectangle((x, y, x + done - 1, y + h - 1), fill=255))
    bold = font(11, True)
    for text, right in ((p['used'], False), (p['left'], True)):
        tx, anchor = (x + w - 8, 'rs') if right else (x + 8, 'ls')
        image = paint(image, (0, 0, 0), 153, lambda d: d.text((tx + 1, y + 14), text, fill=255, font=bold, anchor=anchor))
        image = paint(image, INK, 255, lambda d: d.text((tx, y + 13), text, fill=255, font=bold, anchor=anchor))
    image = paint(image, INK, 217, lambda d: d.text((16, 74), p['figures'], fill=255, font=font(11), anchor='ls'))
    return image


def pixels(image, depth):
    """`image` as X image data, least significant byte first (BGRA): with premultiplied alpha
    for a 32-bit window, which the compositor blends over the game; on an opaque window, over
    black."""
    from PIL import Image, ImageChops
    r, g, b, a = image.split()
    r, g, b = (ImageChops.multiply(c, a) for c in (r, g, b))
    if depth != 32:
        a = Image.new('L', image.size, 255)
    return Image.merge('RGBA', (b, g, r, a)).tobytes()


def argb_visual(screen):
    """A 32-bit true-colour visual (one with alpha) for a see-through panel, if the screen has one."""
    from Xlib import X
    for allowed in screen.allowed_depths:
        if allowed.depth == 32:
            for visual in allowed.visuals:
                if visual.visual_class == X.TrueColor:
                    return visual.visual_id
    return None


def put(window, gc, data, depth, width=WIDTH, height=HEIGHT):
    """Draws the image data into the window in strips, each well inside the largest X request."""
    from Xlib import X
    row = width * 4
    for y in range(0, height, 32):
        rows = min(32, height - y)
        window.put_image(gc, 0, y, width, rows, X.ZPixmap, depth, 0, data[y * row:(y + rows) * row])


def main():
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (BASE / 'overlay.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    if not os.environ.get('DISPLAY'):
        adopt_game_display()
    from Xlib import X, Xutil, display
    from Xlib.ext import shape
    shown = display.Display()
    screen = shown.screen()
    visual = argb_visual(screen)
    if visual is not None:
        depth, colormap = 32, screen.root.create_colormap(visual, X.AllocNone)
    else:
        visual, depth, colormap = X.CopyFromParent, screen.root_depth, X.CopyFromParent
    # Override-redirect: the window manager never frames it or gives it focus.
    window = screen.root.create_window(
        max(0, (screen.width_in_pixels - WIDTH) // 2), 6, WIDTH, HEIGHT, 0, depth, X.InputOutput, visual,
        background_pixel=0, border_pixel=0, colormap=colormap, override_redirect=True, event_mask=X.ExposureMask)
    window.set_wm_name('Crusader Arena run overlay')
    window.set_wm_hints(flags=Xutil.InputHint, input=0)
    # An empty input region: every click goes to the window below.
    window.shape_rectangles(shape.SO.Set, shape.SK.Input, X.Unsorted, 0, 0, [])
    gc = window.create_gc()
    seen, mapped, last, data = time.time(), False, None, b''
    while True:
        now = time.time()
        status = with_feed(read(BASE / 'status.json'), read(BASE / 'overlay-feed.json'), now)
        if bridge_live(status, now):
            seen = now
        elif now - seen > GONE_SECONDS:
            break
        p = panel(status, now)
        if p:
            if p != last:
                data, last = pixels(render(p), depth), p
            if not mapped:
                window.map()
                mapped = True
            window.configure(stack_mode=X.Above)
            put(window, gc, data, depth)
        elif mapped:
            window.unmap()
            mapped, last = False, None
        while shown.pending_events():
            shown.next_event()
        shown.flush()
        time.sleep(0.5)
    window.destroy()
    shown.close()


if __name__ == '__main__':
    if sys.argv[1:] == ['--feed']:
        feed()
    else:
        main()
