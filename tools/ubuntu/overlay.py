#!/usr/bin/env python3
"""On-screen run overlay on the game machine, for people watching the game: the model, the
benchmark, the game time used and left as a progress bar, and a line of figures (net worth, gold,
population, popularity, turns, tool calls, cost).

A separate window above the game that never takes focus and lets clicks through. The agent's
screenshots and the run videos copy only the game window's own image (its compositor pixmap), so
the overlay is in neither, and the bridge sends input to the game window directly. Started by the
bridge's monitor (control-status.py) with the system Python, which has GTK; it reads the bridge's
status.json, shows itself while a run has a game clock, and exits once the bridge has been gone
for 30 seconds."""
import fcntl
import json
import os
from pathlib import Path
import time

BASE = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'crusader-arena'
WIDTH, HEIGHT = 660, 88
GONE_SECONDS = 30


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


def draw(cr, width, height, p):
    import cairo
    cr.set_operator(cairo.OPERATOR_SOURCE)
    cr.set_source_rgba(0, 0, 0, 0)
    cr.paint()
    cr.set_operator(cairo.OPERATOR_OVER)
    r = 10
    cr.new_sub_path()
    cr.arc(width - r, r, r, -1.5708, 0)
    cr.arc(width - r, height - r, r, 0, 1.5708)
    cr.arc(r, height - r, r, 1.5708, 3.1416)
    cr.arc(r, r, r, 3.1416, 4.7124)
    cr.close_path()
    cr.set_source_rgba(0.11, 0.07, 0.08, 0.84)
    cr.fill_preserve()
    cr.set_source_rgba(0.92, 0.87, 0.79, 0.35)
    cr.set_line_width(1)
    cr.stroke()
    ink = (0.93, 0.88, 0.80)
    cr.select_font_face('DejaVu Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    cr.set_font_size(15)
    cr.set_source_rgb(*ink)
    cr.move_to(16, 25)
    cr.show_text(p['title'])
    cr.select_font_face('DejaVu Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(11)
    phase = p['phase']
    extents = cr.text_extents(phase)
    cr.set_source_rgba(*ink, 0.7)
    cr.move_to(width - 16 - extents.x_advance, 24)
    cr.show_text(phase)
    x, y, w, h = 16, 35, width - 32, 18
    cr.set_source_rgba(1, 1, 1, 0.12)
    cr.rectangle(x, y, w, h)
    cr.fill()
    cr.set_source_rgba(0.80, 0.60, 0.28, 0.95)
    cr.rectangle(x, y, w * p['fraction'], h)
    cr.fill()
    cr.select_font_face('DejaVu Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    cr.set_font_size(11)
    for text, right in ((p['used'], False), (p['left'], True)):
        extents = cr.text_extents(text)
        tx = x + w - 8 - extents.x_advance if right else x + 8
        cr.set_source_rgba(0, 0, 0, 0.6)
        cr.move_to(tx + 1, y + 14)
        cr.show_text(text)
        cr.set_source_rgb(*ink)
        cr.move_to(tx, y + 13)
        cr.show_text(text)
    cr.select_font_face('DejaVu Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(11)
    cr.set_source_rgba(*ink, 0.85)
    cr.move_to(16, 74)
    cr.show_text(p['figures'])


def main():
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (BASE / 'overlay.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import GLib, Gtk
    import cairo
    # A popup is override-redirect: the window manager never gives it focus or a frame.
    win = Gtk.Window(type=Gtk.WindowType.POPUP)
    win.set_app_paintable(True)
    screen = win.get_screen()
    visual = screen.get_rgba_visual()
    if visual is not None and screen.is_composited():
        win.set_visual(visual)
    win.set_accept_focus(False)
    win.set_keep_above(True)
    win.set_default_size(WIDTH, HEIGHT)
    win.move(max(0, (screen.get_width() - WIDTH) // 2), 6)
    area = Gtk.DrawingArea()
    win.add(area)
    shown = {'panel': None}

    def paint(widget, cr):
        if shown['panel']:
            draw(cr, widget.get_allocated_width(), widget.get_allocated_height(), shown['panel'])
        return False

    def click_through(*_):
        # An empty input region: every click goes to the window below.
        win.input_shape_combine_region(cairo.Region())

    area.connect('draw', paint)
    win.connect('realize', click_through)
    seen = {'at': time.time()}

    def tick():
        now = time.time()
        status = read(BASE / 'status.json')
        if bridge_live(status, now):
            seen['at'] = now
        elif now - seen['at'] > GONE_SECONDS:
            Gtk.main_quit()
            return False
        shown['panel'] = panel(status, now)
        if shown['panel']:
            if not win.get_visible():
                win.show_all()
                click_through()
            window = win.get_window()
            if window is not None:
                window.raise_()
            area.queue_draw()
        elif win.get_visible():
            win.hide()
        return True

    GLib.timeout_add(500, tick)
    Gtk.main()


if __name__ == '__main__':
    main()
