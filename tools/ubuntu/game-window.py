#!/usr/bin/env python3
"""Window-scoped JSONL transport. Never captures root or injects global input.
Requires python-xlib 0.33 and Pillow. Run as the logged-in game user over SSH.
"""
import base64
import io
import json
import os
from pathlib import Path
import sys
import time
import select
from runpy import run_path

# Discover display credentials only from the validated Steam game process.
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
from Xlib import X, XK, display, protocol
from Xlib.ext import composite
from PIL import Image

Monitor = run_path(str(Path(__file__).with_name("control-status.py")))["Monitor"]
monitor = Monitor()
local_stop_pending = False
def check_control():
    global local_stop_pending
    if monitor.control() == "stop": local_stop_pending = True

def allow_input():
    check_control()
    if monitor.state["stopped"]: raise RuntimeError("Stopped locally. Press R in the Ubuntu monitor to enable input.")

d = display.Display()
root = d.screen().root
clock_window = root.create_window(0, 0, 1, 1, 0, 0, X.InputOnly, X.CopyFromParent, event_mask=X.PropertyChangeMask)
def server_time():
    clock_window.change_property(d.intern_atom('_CRUSADER_CLOCK'), d.intern_atom('STRING'), 8, b'1')
    d.flush()
    while True:
        event = d.next_event()
        if event.type == X.PropertyNotify and event.window.id == clock_window.id:
            return event.time
TITLE = 'Stronghold Crusader Definitive Edition'
CLASS = 'steam_app_3024040'
keys = {'+':'plus', '-':'minus', 'Space':'space', 'Escape':'Escape', 'Enter':'Return', 'Tab':'Tab',
        'ArrowUp':'Up', 'ArrowDown':'Down', 'ArrowLeft':'Left', 'ArrowRight':'Right',
        'Backspace':'BackSpace', **{c:c.lower() for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'},
        **{str(n):str(n) for n in range(10)}}

# Game hotkeys the harness may trigger by action name (never agent-typed key combinations).
# Bindings come from the game's own settings.cfg ||KEYS|| section, so a rebinding is honoured.
HOTKEY_NAMES = {'HomeKeep', 'Granary', 'Market', 'Barracks', 'Armoury', 'Signpost', 'EngineersGuild',
                'MercPost', 'BedouinStockade', 'Lord', 'IncreaseEngineSpeed', 'DecreaseEngineSpeed',
                'FlattenLandscape',
                *{f'SetBookmark{n}' for n in range(10)}, *{f'GotoBookmark{n}' for n in range(10)}}
UNITY_KEYS = {**{f'Alpha{n}': str(n) for n in range(10)}, **{c: c.lower() for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'},
              'Equals': 'equal', 'Minus': 'minus', 'Space': 'space', 'Tab': 'Tab', 'Backspace': 'BackSpace',
              'KeypadPlus': 'KP_Add', 'KeypadMinus': 'KP_Subtract'}
MODIFIERS = {'ctrl': ('Control_L', X.ControlMask), 'alt': ('Alt_L', X.Mod1Mask), 'shift': ('Shift_L', X.ShiftMask)}

def settings_path():
    prefix = Path(game_env['STEAM_COMPAT_DATA_PATH']) / 'pfx'
    return (prefix / 'drive_c/users/steamuser/AppData/LocalLow/Firefly Studios'
            / 'Stronghold Crusader Definitive Edition/settings.cfg')

def hotkey_binding(name):
    """First binding of a whitelisted game action as (keysym name, [modifiers])."""
    if name not in HOTKEY_NAMES:
        raise ValueError('Unsupported game hotkey.')
    text = settings_path().read_text(encoding='utf-8', errors='replace')
    if '||KEYS||' not in text:
        raise RuntimeError('Game key bindings unavailable.')
    for line in text.split('||KEYS||')[1].splitlines():
        parts = line.strip().split(':')
        if parts[0] != name:
            continue
        # Primary and alternative bindings, e.g. "IncreaseEngineSpeed:KeypadPlus:Equals:".
        bindings = [b.split(',') for b in parts[1:] if b]
        if not bindings:
            raise RuntimeError(f'Game hotkey {name} is unbound.')
        for key, *modifiers in bindings:
            if key in UNITY_KEYS and all(m in MODIFIERS for m in modifiers):
                return UNITY_KEYS[key], modifiers
        raise RuntimeError(f'Game hotkey {name} uses an unsupported binding.')
    raise RuntimeError(f'Game hotkey {name} not found.')

def window():
    current_pid, _ = game_environment()
    if current_pid != pid:
        raise RuntimeError('Game process changed. Reconnect to bind a new session.')
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
    w = matches[0]
    g = w.get_geometry()
    if not (320 <= g.width <= 7680 and 200 <= g.height <= 4320):
        raise RuntimeError('Unsupported game window dimensions.')
    return w, g

def capture():
    w, g = window()
    # Compositor-owned backing pixmap: other windows cannot appear in this image.
    pixmap = w.composite_name_window_pixmap()
    try:
        raw = pixmap.get_image(0, 0, g.width, g.height, X.ZPixmap, 0xffffffff)
        if raw is None or raw.depth not in (24, 32):
            raise RuntimeError('Game capture unavailable.')
        im = Image.frombytes('RGB', (g.width, g.height), raw.data, 'raw', 'BGRX')
        output = io.BytesIO()
        im.save(output, format='JPEG', quality=80)
    finally:
        pixmap.free()
    return {'image':base64.b64encode(output.getvalue()).decode(), 'mimeType':'image/jpeg',
            'width':g.width, 'height':g.height, 'windowId':w.id, 'pid':pid,
            'capturedAt':int(time.time()*1000), 'scope':'game-window'}

def emit(w, event, event_mask):
    event = type(event)(**(event._data | {'time': server_time()}))
    w.send_event(event, event_mask=event_mask, propagate=False)
    d.sync()

def action(a):
    allow_input()
    monitor.state["commands"] += 1
    monitor.event("Command received: " + json.dumps(a))
    w, g = window()
    active = root.get_full_property(d.intern_atom('_NET_ACTIVE_WINDOW'), X.AnyPropertyType)
    if active is None or int(active.value[0]) != w.id:
        raise RuntimeError('Game is not the active application. Activate it locally before sending input.')
    if a.get('windowId') != w.id or a.get('width') != g.width or a.get('height') != g.height:
        raise RuntimeError('Window changed. Capture again before input.')
    # Synthetic events are delivered directly to this window, never via XTest,
    # SendInput, uinput, root event propagation, or a desktop pointer warp.
    common = dict(time=server_time(), root=root, window=w, child=X.NONE,
                  root_x=0, root_y=0, event_x=0, event_y=0, state=0, same_screen=1)
    kind = a.get('type')
    if kind == 'key':
        name = a.get('key')
        if name not in keys:
            raise ValueError('Unsupported key. OS shortcuts and modifiers are not exposed.')
        symbol = XK.string_to_keysym(keys[name])
        code = d.keysym_to_keycode(symbol)
        if not code:
            raise ValueError('Key is unavailable in this keyboard layout.')
        # Resolve shifted '+' without exposing arbitrary modifier combinations.
        if d.keycode_to_keysym(code, 0) != symbol:
            if d.keycode_to_keysym(code, 1) != symbol:
                raise ValueError('Key requires an unsupported keyboard layout level.')
            common['state'] = X.ShiftMask
        allow_input()
        emit(w, protocol.event.KeyPress(detail=code, **common), event_mask=X.KeyPressMask)
        try:
            time.sleep(0.07)
        finally:
            emit(w, protocol.event.KeyRelease(detail=code, **common), event_mask=X.KeyReleaseMask)
    elif kind == 'hotkey':
        keysym, modifiers = hotkey_binding(a.get('name'))
        code = d.keysym_to_keycode(XK.string_to_keysym(keysym))
        mods = [(d.keysym_to_keycode(XK.string_to_keysym(MODIFIERS[m][0])), MODIFIERS[m][1]) for m in modifiers]
        if not code or not all(c for c, _ in mods):
            raise ValueError('Hotkey is unavailable in this keyboard layout.')
        allow_input()
        pressed = []
        try:
            # Modifier presses first, each accumulating its state bit, as a keyboard would.
            for mod_code, mask in mods:
                emit(w, protocol.event.KeyPress(detail=mod_code, **common), event_mask=X.KeyPressMask)
                pressed.append((mod_code, mask))
                common['state'] |= mask
            emit(w, protocol.event.KeyPress(detail=code, **common), event_mask=X.KeyPressMask)
            try:
                time.sleep(0.07)
            finally:
                emit(w, protocol.event.KeyRelease(detail=code, **common), event_mask=X.KeyReleaseMask)
        finally:
            for mod_code, mask in reversed(pressed):
                emit(w, protocol.event.KeyRelease(detail=mod_code, **common), event_mask=X.KeyReleaseMask)
                common['state'] &= ~mask
    elif kind in ('click', 'drag', 'scroll'):
        x, y = a.get('x'), a.get('y')
        if not isinstance(x, int) or not isinstance(y, int) or not (0 <= x < g.width and 0 <= y < g.height):
            raise ValueError('Coordinates must be inside the game window.')
        origin = root.translate_coords(w, 0, 0)
        common.update(event_x=x, event_y=y, root_x=origin.x+x, root_y=origin.y+y)
        button = a.get('button', 1)
        if kind == 'scroll':
            button = 4 if a.get('direction') == 'up' else 5
        if button not in (1, 3, 4, 5):
            raise ValueError('Unsupported mouse button.')
        if kind == 'drag':
            ex, ey = a.get('endX'), a.get('endY')
            if not isinstance(ex, int) or not isinstance(ey, int) or not (0 <= ex < g.width and 0 <= ey < g.height):
                raise ValueError('Drag endpoint outside game window.')
        emit(w, protocol.event.MotionNotify(detail=0, **common), event_mask=X.PointerMotionMask)
        time.sleep(0.12)
        allow_input()
        emit(w, protocol.event.ButtonPress(detail=button, **common), event_mask=X.ButtonPressMask)
        d.sync()
        try:
            if kind == 'drag':
                for i in range(1, 11):
                    allow_input()
                    dx, dy = round(x+(ex-x)*i/10), round(y+(ey-y)*i/10)
                    common.update(event_x=dx, event_y=dy, root_x=origin.x+dx, root_y=origin.y+dy, state=X.Button1Mask if button == 1 else X.Button3Mask)
                    emit(w, protocol.event.MotionNotify(detail=0, **common), event_mask=X.PointerMotionMask)
                    d.sync()
                    time.sleep(0.02)
            else:
                time.sleep(0.07)
        finally:
            common['state'] = X.Button1Mask if button == 1 else X.Button3Mask if button == 3 else 0
            emit(w, protocol.event.ButtonRelease(detail=button, **common), event_mask=X.ButtonReleaseMask)
    else:
        raise ValueError('Unknown action.')
    d.sync()
    monitor.event('Input delivered to game window')
    return {'delivered':True, 'scope':'game-window', 'windowId':w.id, 'at':int(time.time()*1000)}

input_buffer = b""
# The host pings every 10 s. An SSH session whose client vanished can leave this process
# running with open pipes and the bridge lock held, so exit after 30 s without input.
IDLE_EXIT_SECONDS = 30
last_input = time.time()
try:
    while True:
        check_control()
        if time.time() - last_input > IDLE_EXIT_SECONDS:
            break
        if local_stop_pending:
            print(json.dumps({'event':'local_stop'}), flush=True)
            local_stop_pending = False
        monitor.publish()
        if b"\n" not in input_buffer:
            if not select.select([sys.stdin], [], [], 0.2)[0]:
                continue
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk: break
            last_input = time.time()
            input_buffer += chunk
            if b"\n" not in input_buffer: continue
        line, input_buffer = input_buffer.split(b"\n", 1)
        request = {}
        try:
            request = json.loads(line)
            op = request.get('op')
            if op == 'capture':
                result = capture()
            elif op == 'action':
                result = action(request['action'])
            elif op == 'status':
                monitor.update(request.get('status',{}))
                result = {'ok':True}
            elif op == 'ping':
                result = {'ok':True}
            else:
                raise ValueError('Unknown operation.')
            print(json.dumps({'id':request.get('id'), 'result':result}), flush=True)
            if op == 'capture':
                monitor.state['screenshots'] += 1
                monitor.event(f"Game screenshot sent to host: {result['width']}x{result['height']}")
        except Exception as e:
            monitor.event('Rejected / failed: '+str(e))
            print(json.dumps({'id':request.get('id'), 'error':str(e)}), flush=True)
finally:
    monitor.state['connected'] = False
    monitor.state['phase'] = 'DISCONNECTED'
    monitor.publish()
