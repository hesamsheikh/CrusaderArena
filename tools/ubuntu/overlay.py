#!/usr/bin/env python3
"""On-screen run overlay on the game machine, for people watching the game: the model, the
benchmark, the game time used and left as a progress bar, and a line of figures (net worth, gold,
population, popularity, turns, tool calls, cost).

A separate X window above the game that never takes focus and lets clicks through. The agent's
screenshots and the run videos copy only the game window's own image (its compositor pixmap), so
the overlay is in neither, and the bridge sends input to the game window directly. Started by the
bridge's monitor (control-status.py) with the control venv's Python: Pillow draws the panel and
python-xlib shows it. It reads the bridge's status.json, shows itself while a run has a game
clock, and exits once the bridge has been gone for 30 seconds."""
import fcntl
import json
import os
from pathlib import Path
import time

BASE = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'crusader-arena'
WIDTH, HEIGHT = 660, 88
GONE_SECONDS = 30
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
        status = read(BASE / 'status.json')
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
    main()
