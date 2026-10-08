#!/usr/bin/env python3
"""Render one recorded agent run as an MP4: the game, the agent's reasoning and its tools.

  python3 tools/video/render-video.py harness/runtime/runs/<run folder> [-o out.mp4]

Needs a run recorded with Record video (run config recordVideo): recording/frames.jsonl
with its frames and recording/inputs.jsonl, plus run.json and events.jsonl. The footage is
edited, not shown as it passed: each paused thinking period becomes a short card that
types out the reasoning; the game plays at real speed around every click and key the
harness sent; idle play between actions is fast-forwarded; paused footage with nothing
happening is cut.

Needs Pillow and ffmpeg with libx264 on PATH. Reads the run folder; writes only the output.
"""
import argparse
import base64
import bisect
import io
import json
import math
import os
from collections import OrderedDict
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
TICKS_PER_GAME_SECOND = 30
W, H = 1920, 1080
GAME_W, GAME_H = 1440, 810
PANEL_W = W - GAME_W
STRIP_H = H - GAME_H
PAD = 24
# Real speed from just before each input until the game has visibly responded.
INPUT_LEAD_MS = 500
INPUT_TAIL_MS = 1500
# Idle shorter than this between two actions plays at real speed instead of flickering.
MIN_IDLE_MS = 1200

# The dashboard's warm ink, ivory and clay accent, set on dark for video.
BG = (22, 21, 19)
PANEL = (30, 29, 26)
RAISED = (40, 38, 34)
LINE = (62, 59, 53)
INK = (246, 243, 235)
INK2 = (206, 201, 190)
MUTED = (156, 151, 140)
FAINT = (112, 108, 100)
ACCENT = (222, 124, 90)
GOOD = (116, 178, 130)
BAD = (230, 110, 98)
WARN = (220, 168, 84)

# ---------------------------------------------------------------- text

SYMBOLS = {'→': '->', '←': '<-', '⇒': '=>', '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '✓': 'v',
           '✔': 'v', '✗': 'x', '✘': 'x', '•': '·', '…': '...', '▶': '>', '■': '#', '□': '[ ]',
           '\t': '    ', '\r': ''}


def clean(text):
    """Map symbols missing from the Latin font subset; drop other unsupported characters."""
    out = []
    for ch in str(text):
        ch = SYMBOLS.get(ch, ch)
        if len(ch) == 1 and ord(ch) > 0xFF and not (0x2000 <= ord(ch) <= 0x206F) and ch not in '€™−':
            ch = '?'
        out.append(ch)
    return ''.join(out)


_fonts = {}


def font(family, weight, size, italic=False):
    key = (family, weight, size, italic)
    if key not in _fonts:
        style = 'italic' if italic else 'normal'
        candidates = [ROOT / f'node_modules/@fontsource/{family}/files/{family}-latin-{weight}-{style}.woff',
                      ROOT / f'node_modules/@fontsource/{family}/files/{family}-latin-{weight}-normal.woff',
                      Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
                      Path('/System/Library/Fonts/Helvetica.ttc')]
        for path in candidates:
            try:
                _fonts[key] = ImageFont.truetype(str(path), size)
                break
            except OSError:
                continue
        else:
            _fonts[key] = ImageFont.load_default(size)
    return _fonts[key]


def sans(size, weight=400, italic=False):
    return font('dm-sans', weight, size, italic)


def condensed(size, weight=600):
    return font('barlow-condensed', weight, size)


_wraps = {}


def wrap(text, fnt, width):
    """Greedy word wrap by rendered width; long words are split."""
    key = (text, id(fnt), width)
    if key in _wraps:
        return _wraps[key]
    lines = []
    for paragraph in clean(text).split('\n'):
        line = ''
        for word in paragraph.split(' '):
            candidate = f'{line} {word}' if line else word
            if fnt.getlength(candidate) <= width:
                line = candidate
                continue
            if line:
                lines.append(line)
            while fnt.getlength(word) > width:
                cut = max(1, int(len(word) * width / fnt.getlength(word)))
                while cut > 1 and fnt.getlength(word[:cut]) > width:
                    cut -= 1
                lines.append(word[:cut])
                word = word[cut:]
            line = word
        lines.append(line)
    _wraps[key] = lines
    return lines


def ellipsize(text, fnt, width):
    text = clean(text).replace('\n', ' ')
    if fnt.getlength(text) <= width:
        return text
    while text and fnt.getlength(text + '…') > width:
        text = text[:-1]
    return text.rstrip() + '…'


class Lru(OrderedDict):
    """Small bounded cache: composed images are large (a 1440×810 frame is 3.5 MB)."""

    def __init__(self, size):
        super().__init__()
        self.size = size

    def get_or(self, key, build):
        if key in self:
            self.move_to_end(key)
            return self[key]
        value = self[key] = build()
        if len(self) > self.size:
            self.popitem(last=False)
        return value


def game_clock(seconds):
    seconds = max(0, int(round(seconds)))
    return f'{seconds // 60:02d}:{seconds % 60:02d}'



# ---------------------------------------------------------------- run data


def observation_stats(observation):
    """The same compact fields the live recorder stores per frame (recorder.ts frameStats)."""
    if not isinstance(observation, dict):
        return None
    settlement = observation.get('settlement') or {}
    resources = observation.get('resources_by_name') or {}
    return {'gameTime': observation.get('game_time'), 'paused': observation.get('paused'),
            'gold': observation.get('gold'), 'population': observation.get('population'),
            'popularity': observation.get('popularity'), 'housing': settlement.get('housing_cap'),
            'food': settlement.get('total_food'), 'wood': resources.get('wood_planks', observation.get('wood_planks')),
            'stone': resources.get('stone'), 'iron': resources.get('iron')}


def result_texts(result):
    content = (result or {}).get('content') or []
    return [c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text']


def json_or_none(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def read_jsonl(path):
    rows = []
    if path.is_file():
        for line in path.read_text(encoding='utf-8').splitlines():
            row = json_or_none(line)
            if isinstance(row, dict):
                rows.append(row)
    return rows


class Frame:
    def __init__(self, time, stats=None, path=None, data=None, source=(1920, 1080)):
        self.time, self.stats, self.path, self.data, self.source = time, stats, path, data, source

    def image(self):
        raw = self.path.read_bytes() if self.path else base64.b64decode(self.data)
        im = Image.open(io.BytesIO(raw)).convert('RGB')
        return im if im.size == (GAME_W, GAME_H) else im.resize((GAME_W, GAME_H), Image.BILINEAR)


HOTKEYS = {'HomeKeep': 'Centre on keep', 'Granary': 'Centre on granary', 'Market': 'Centre on marketplace',
           'Barracks': 'Centre on barracks', 'Armoury': 'Centre on armoury', 'Signpost': 'Centre on signpost',
           'EngineersGuild': "Centre on engineer's guild", 'MercPost': 'Centre on mercenary post',
           'BedouinStockade': 'Centre on Bedouin stockade', 'Lord': 'Centre on lord',
           'IncreaseEngineSpeed': 'Game speed +', 'DecreaseEngineSpeed': 'Game speed -', 'FlattenLandscape': 'Flat view'}


class Input:
    """One click, drag, scroll, key or hotkey the harness sent, in 1440 × 810 video pixels."""

    def __init__(self, row):
        self.at, self.type, self.row = row['at'], row.get('type'), row
        sx, sy = GAME_W / (row.get('width') or 1920), GAME_H / (row.get('height') or 1080)
        number = lambda *keys: all(isinstance(row.get(k), (int, float)) for k in keys)
        self.pos = (row['x'] * sx, row['y'] * sy) if number('x', 'y') else None
        self.end = (row['endX'] * sx, row['endY'] * sy) if number('endX', 'endY') else None
        self.right = row.get('button') == 3
        self.label = ''
        name = str(row.get('name', ''))
        self.text = (f"Key {row.get('key')}" if self.type == 'key'
                     else f"Scroll {row.get('direction')}" if self.type == 'scroll'
                     else f'Save view {name[-1]}' if name.startswith('SetBookmark')
                     else f'Go to view {name[-1]}' if name.startswith('GotoBookmark')
                     else HOTKEYS.get(name, name) if self.type == 'hotkey' else '')

    @property
    def host_pause(self):
        # The agent may not press P in timed runs, so a P is the host's pause toggle.
        return self.type == 'key' and self.row.get('key') == 'P'


class Turn:
    def __init__(self, start, end, message, number):
        self.start, self.end, self.number = start, end, number
        content = message.get('content') or []
        self.thinking = '\n\n'.join(c.get('thinking', '') for c in content if c.get('type') == 'thinking').strip()
        self.text = '\n\n'.join(c.get('text', '') for c in content if c.get('type') == 'text').strip()
        self.calls = [Call(c.get('id'), c.get('name', '?'), c.get('arguments') or {})
                      for c in content if c.get('type') == 'toolCall']
        self.retries = 0

    @property
    def seconds(self):
        return max(0.0, (self.end - self.start) / 1000)


class Call:
    def __init__(self, id, name, args):
        self.id, self.name, self.args = id, name, args
        self.start = self.end = None
        self.summary = ''
        self.error = False

    def status(self, at):
        if self.start is None or at < self.start:
            return 'pending'
        if self.end is None or at < self.end:
            return 'running'
        return 'error' if self.error else 'done'


def load_events(run_dir):
    events = []
    with open(run_dir / 'events.jsonl', encoding='utf-8') as handle:
        for line in handle:
            # Token deltas are the bulk of the file and carry nothing the full messages lack.
            if '"type":"message_update"' in line[:120]:
                continue
            record = json_or_none(line)
            if isinstance(record, dict) and isinstance(record.get('event'), dict):
                events.append((record.get('at', 0), record['event']))
    return events


def load_recording(run_dir):
    """Recorded frames and inputs on the dashboard host's clock."""
    folder = run_dir / 'recording'
    rows = [r for r in read_jsonl(folder / 'frames.jsonl')
            if isinstance(r.get('t'), (int, float)) and isinstance(r.get('at'), (int, float)) and r.get('file')]
    if not rows:
        return [], []
    # The game host's clock differs: align capture times with the fastest delivery.
    offset = min(r['at'] - r['t'] for r in rows)
    frames = sorted((Frame(r['t'] + offset, r.get('stats'), folder / 'frames' / r['file'],
                           source=(r.get('sw') or 1920, r.get('sh') or 1080)) for r in rows), key=lambda f: f.time)
    inputs = [Input(r) for r in read_jsonl(folder / 'inputs.jsonl') if isinstance(r.get('at'), (int, float))]
    return frames, sorted((i for i in inputs if not i.host_pause), key=lambda i: i.at)


def merge(intervals):
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


class Run:
    """Turns, tool calls, plans, frames and inputs of one recorded run on the host's ms clock."""

    def __init__(self, run_dir, events, frames, inputs):
        self.dir = run_dir
        self.meta = json.loads((run_dir / 'run.json').read_text(encoding='utf-8'))
        episode = run_dir / 'episode.json'
        self.episode = json_or_none(episode.read_text(encoding='utf-8')) if episode.is_file() else None
        config = self.meta.get('config') or {}
        self.budget = (config.get('gameMinutes') or 0) * 60
        self.default_wait = config.get('defaultWaitSeconds', 5)
        self.turns, self.plans, self.compactions, self.observations, self.marks = [], [], [], [], []
        self.final = None
        calls = {}
        pause_at = None
        retries = 0
        for at, ev in events:
            kind = ev.get('type')
            if kind == 'inference_pause_confirmed':
                pause_at = at
            elif kind == 'inference_retry':
                retries += 1
            elif kind == 'message_end' and (ev.get('message') or {}).get('role') == 'assistant':
                message = ev['message']
                if message.get('stopReason') in ('error', 'aborted', 'length'):
                    pause_at = None
                    continue
                turn = Turn(pause_at if pause_at is not None else at, at, message, len(self.turns) + 1)
                turn.retries, retries, pause_at = retries, 0, None
                self.turns.append(turn)
                calls.update({c.id: c for c in turn.calls})
            elif kind == 'tool_execution_start':
                call = calls.get(ev.get('toolCallId'))
                if call is None:
                    call = Call(ev.get('toolCallId'), ev.get('toolName', '?'), ev.get('args') or {})
                    if self.turns:
                        self.turns[-1].calls.append(call)
                    calls[call.id] = call
                call.start = at
            elif kind == 'tool_execution_end':
                call = calls.get(ev.get('toolCallId'))
                if call is not None:
                    call.end, call.error = at, bool(ev.get('isError'))
                    call.summary = summarize_result(call.name, result_texts(ev.get('result')), call.error)
            elif kind == 'host_observation':
                self.observations.append(at)
            elif kind == 'plan':
                self.plans.append((at, ev.get('plan') or []))
            elif kind == 'compaction_checkpoint':
                self.compactions.append((at, ev.get('handoff') or ''))
            elif kind == 'recording_state':
                self.marks.append((at, ev.get('state')))
            elif kind == 'final_observation':
                self.final = ev
        self.final_stats = observation_stats(((self.final or {}).get('stats') or {}).get('observation'))
        self.final_image = ((self.final or {}).get('frame') or {}).get('image')
        self.frames, self.inputs = frames, inputs
        self.frame_times = [f.time for f in frames]
        self.input_times = [i.at for i in inputs]
        self.label_build_clicks()
        self.segments = self.build_segments()
        ticks = [f.stats.get('gameTime') for f in frames if f.stats and isinstance(f.stats.get('gameTime'), (int, float))]
        self.start_tick = ticks[0] if ticks else None

    def label_build_clicks(self):
        """Name the building on a terrain click that hits a build_structure target exactly."""
        for turn in self.turns:
            for call in turn.calls:
                if call.name != 'build_structure' or call.start is None:
                    continue
                targets = {(p.get('x'), p.get('y')): p.get('name', '') for p in (call.args or {}).get('placements') or []
                           if isinstance(p, dict)}
                for i in self.inputs:
                    if i.type == 'click' and call.start <= i.at <= (call.end or math.inf):
                        i.label = targets.get((i.row.get('x'), i.row.get('y')), i.label)

    def build_segments(self):
        """Recorded periods of game activity, from the recorder's run/hold marks."""
        segments, start = [], None
        for at, state in self.marks:
            if state == 'run' and start is None:
                start = at
            elif state == 'hold' and start is not None:
                segments.append((start, at))
                start = None
        if start is not None:
            segments.append((start, self.frame_times[-1] + 250))
        if not segments and self.frames:
            segments = [(self.frame_times[0], self.frame_times[-1] + 250)]
        return [s for s in segments if s[1] > s[0]]

    def paused_intervals(self, start, end):
        """Parts of [start, end] whose frames show the game paused (reader flag at receipt)."""
        lo, hi = bisect.bisect_left(self.frame_times, start), bisect.bisect_right(self.frame_times, end)
        frames = self.frames[lo:hi]
        out = []
        for k, f in enumerate(frames):
            if f.stats and f.stats.get('paused') is True:
                out.append((start if k == 0 else f.time, frames[k + 1].time if k + 1 < len(frames) else end))
        return merge(out)

    def spans(self, start, end):
        """Split one recorded segment into (from, to, kind): action, idle or cut."""
        windows = merge([(max(start, i.at - INPUT_LEAD_MS), min(end, i.at + INPUT_TAIL_MS))
                         for i in self.inputs if start - INPUT_TAIL_MS < i.at < end + INPUT_LEAD_MS])
        paused = self.paused_intervals(start, end)
        edges = sorted({start, end, *[x for w in windows + paused for x in w if start <= x <= end]})
        spans = []
        for a, b in zip(edges, edges[1:]):
            mid = (a + b) / 2
            kind = ('action' if any(w0 <= mid < w1 for w0, w1 in windows)
                    else 'cut' if any(p0 <= mid < p1 for p0, p1 in paused) else 'idle')
            spans.append([a, b, kind])
        for k, span in enumerate(spans):
            neighbours = [spans[j][2] for j in (k - 1, k + 1) if 0 <= j < len(spans)]
            if span[2] == 'idle' and span[1] - span[0] < MIN_IDLE_MS and 'action' in neighbours:
                span[2] = 'action'
        out = []
        for a, b, kind in spans:
            if out and out[-1][2] == kind:
                out[-1] = (out[-1][0], b, kind)
            else:
                out.append((a, b, kind))
        return out

    def frame_at(self, at):
        i = bisect.bisect_right(self.frame_times, at) - 1
        return max(i, 0) if self.frames else None

    def stats_at(self, at):
        i = self.frame_at(at)
        while i is not None and i >= 0:
            if self.frames[i].stats:
                return self.frames[i].stats
            i -= 1
        return None

    def plan_index(self, at):
        """Index of the latest plan at `at`, or -1 before the first."""
        return bisect.bisect_right([when for when, _ in self.plans], at) - 1

    def plan_at(self, at):
        i = self.plan_index(at)
        return self.plans[i][1] if i >= 0 else []

    def turn_before(self, at):
        current = None
        for turn in self.turns:
            if turn.end > at:
                break
            current = turn
        return current


# ---------------------------------------------------------------- tool summaries


def placements_text(placements):
    return ' · '.join(f"{p.get('name', '?')} at {p.get('x')},{p.get('y')}" for p in placements if isinstance(p, dict))


def summarize_call(name, args):
    a = args if isinstance(args, dict) else {}
    if name == 'build_structure':
        return placements_text(a.get('placements') or [])
    if name == 'game_action':
        kind = a.get('type')
        if kind == 'key':
            return f"press {a.get('key')}"
        if kind == 'drag':
            return f"drag {a.get('x')},{a.get('y')} to {a.get('endX')},{a.get('endY')}"
        button = ' (right)' if a.get('button') == 3 else ''
        extra = f" {a.get('direction')}" if kind == 'scroll' else ''
        return f"{kind}{extra} at {a.get('x')},{a.get('y')}{button}"
    if name == 'place_near':
        side = f" ({a['side']})" if a.get('side') else ''
        return f"{a.get('count', 1)}× {a.get('building')} next to {a.get('anchor')}{side}"
    if name == 'expand_storage':
        return f"{a.get('count', 1)} more {a.get('kind')}"
    if name == 'wait_and_observe':
        until = a.get('until') or {}
        cond = f" or until {until.get('amount')} ≥ {until.get('at_least')}" if until else ''
        return f"let {a.get('seconds')} game s pass{cond}"
    if name == 'market_trade':
        return f"{a.get('action')} {a.get('lots', 1)} lot(s) of {a.get('good')}"
    if name == 'set_tax':
        return f"tax level {a.get('level')}"
    if name == 'update_plan':
        return f"{len(a.get('plan') or [])} steps"
    if name in ('notebook_write', 'notebook_edit'):
        return clean((a.get('text') or a.get('after') or ''))[:90]
    if name == 'find_sites':
        near = f" near {a['near_x']},{a['near_y']}" if 'near_x' in a else ''
        return f"{a.get('count', 1)}× {a.get('building')}{near}"
    parts = []
    for key, value in a.items():
        value = value if isinstance(value, (str, int, float, bool)) else json.dumps(value, separators=(',', ':'))
        parts.append(f'{key} {value}')
    return ', '.join(parts)


def summarize_result(name, texts, is_error):
    first = next((t for t in texts if t.strip()), '')
    if is_error:
        return first.strip()[:200] or 'failed'
    data = json_or_none(first)
    if name in ('observe', 'wait_and_observe') or (isinstance(data, dict) and 'coordinate_space' in data):
        return 'fresh screenshot'
    if name == 'update_plan':
        return 'plan updated'
    if isinstance(data, dict):
        if isinstance(data.get('placements'), list):
            parts = []
            for p in data['placements']:
                note = ''
                feedback = p.get('feedback') or []
                if p.get('status') in ('rejected', 'possibly_rejected') and feedback:
                    note = f' ({feedback[0]})'
                elif p.get('missing'):
                    note = f" (needs {', '.join(f'{k} {v}' for k, v in p['missing'].items())})" if isinstance(p['missing'], dict) else ''
                parts.append(f"{p.get('building', '?')} {str(p.get('status', '?')).replace('_', ' ')}{note}")
            return ' · '.join(parts)
        if name in ('place_near', 'expand_storage'):
            placed = data.get('placed') or []
            text = f"{len(placed)} placed" if placed else str(data.get('status', '')).replace('_', ' ')
            if data.get('stopped'):
                text += f" — {str(data['stopped']).replace('_', ' ')}"
            if data.get('feedback'):
                text += f" ({data['feedback'][0]})"
            return text
        if name == 'market_trade' and data.get('status') == 'traded':
            return f"{data.get('units')} {data.get('good')} for {data.get('goldChange'):+} gold"
        if name == 'find_sites' and isinstance(data.get('sites'), list):
            return f"{len(data['sites'])} site(s) found"
        if name == 'set_tax' and data.get('label'):
            return f"{data['label']} (popularity {data.get('popularityFactor', 0):+})"
        if name == 'inspect_building' and isinstance(data.get('building'), dict):
            b = data['building']
            workers = b.get('workers') or {}
            state = 'working' if b.get('working') else 'idle'
            return f"{b.get('name')}: {state}, workers {workers.get('have')}/{workers.get('needed')}"
        bits = [f"{k.replace('_', ' ')} {str(v).replace('_', ' ')}" for k, v in data.items()
                if k in ('status', 'building', 'anchor', 'level', 'label', 'units', 'stopped') and v not in (None, '')]
        if bits:
            return ', '.join(bits)
    line = first.strip().split('\n')[0]
    return line[:160]



# ---------------------------------------------------------------- timeline


class Clip:
    def __init__(self, kind, duration, **data):
        self.kind, self.duration, self.data = kind, duration, data
        self.start = 0.0


def build_timeline(run, args):
    """Video clips in order: a card per thinking pause, then that segment's footage spans."""
    clips = []
    turn_index = 0
    compactions = list(run.compactions)
    for start, end in run.segments:
        if args.max_think > 0:
            while compactions and compactions[0][0] <= start:
                at, handoff = compactions.pop(0)
                clips.append(Clip('compaction', min(2.5, args.max_think), at=at, handoff=handoff))
        while turn_index < len(run.turns) and run.turns[turn_index].end <= start:
            turn = run.turns[turn_index]
            turn_index += 1
            if args.max_think > 0:
                chars = len(turn.thinking) + len(turn.text)
                clips.append(Clip('think', min(args.max_think, args.min_think + chars / args.think_rate), turn=turn))
        for a, b, kind in run.spans(start, end):
            if kind == 'cut':
                continue
            speed = args.speed
            if kind == 'idle':
                speed = max(args.idle_speed, (b - a) / 1000 / args.max_idle if args.max_idle > 0 else 0)
            clips.append(Clip('play', (b - a) / 1000 / speed, start=a, end=b, speed=speed, pace=kind, segment=(start, end)))
    if args.max_think > 0:
        for turn in run.turns[turn_index:]:
            clips.append(Clip('think', args.min_think, turn=turn))
    if args.outro > 0:
        clips.append(Clip('outro', args.outro))
    t = 0.0
    for clip in clips:
        clip.start = t
        t += clip.duration
    return clips


def chapters(run, clips):
    rows = []
    for clip in clips:
        if clip.kind == 'think':
            turn = clip.data['turn']
            tools = ', '.join(dict.fromkeys(c.name for c in turn.calls)) or 'reply'
            rows.append((clip.start, f'Turn {turn.number}: {tools}'))
        elif clip.kind == 'compaction':
            rows.append((clip.start, 'Context compaction'))
        elif clip.kind == 'outro':
            rows.append((clip.start, 'Result'))
    if clips and (not rows or rows[0][0] > 0):
        rows.insert(0, (0.0, 'Start'))
    return rows


# ---------------------------------------------------------------- drawing


def icon(draw, kind, x, y, size=14):
    """Status glyphs drawn as shapes: the Latin font subset has no symbols."""
    s = size
    if kind == 'done':
        draw.line([(x + s * 0.12, y + s * 0.55), (x + s * 0.4, y + s * 0.82), (x + s * 0.9, y + s * 0.2)], fill=GOOD, width=max(2, s // 6))
    elif kind == 'error':
        draw.line([(x + s * 0.18, y + s * 0.18), (x + s * 0.82, y + s * 0.82)], fill=BAD, width=max(2, s // 6))
        draw.line([(x + s * 0.82, y + s * 0.18), (x + s * 0.18, y + s * 0.82)], fill=BAD, width=max(2, s // 6))
    elif kind in ('running', 'in_progress'):
        draw.polygon([(x + s * 0.2, y + s * 0.1), (x + s * 0.9, y + s * 0.5), (x + s * 0.2, y + s * 0.9)], fill=ACCENT)
    elif kind == 'completed':
        draw.ellipse([x + 1, y + 1, x + s - 1, y + s - 1], fill=GOOD)
    elif kind == 'fast':
        for dx in (0, s * 0.45):
            draw.polygon([(x + dx, y + s * 0.1), (x + dx + s * 0.5, y + s * 0.5), (x + dx, y + s * 0.9)], fill=ACCENT)
    elif kind == 'pause':
        draw.rectangle([x + s * 0.15, y + s * 0.1, x + s * 0.4, y + s * 0.9], fill=WARN)
        draw.rectangle([x + s * 0.6, y + s * 0.1, x + s * 0.85, y + s * 0.9], fill=WARN)
    else:
        draw.ellipse([x + 2, y + 2, x + s - 2, y + s - 2], outline=FAINT, width=2)


def label(draw, text, x, y, color=MUTED, size=15):
    draw.text((x, y), text.upper(), font=condensed(size, 600), fill=color)




class Renderer:
    def __init__(self, run, args):
        self.run, self.args = run, args
        self.cache = {}
        self.decoded = Lru(12)
        self.games = Lru(8)
        self.panels = Lru(24)
        meta = run.meta
        self.model = clean((meta.get('model') or {}).get('name') or meta.get('modelId') or 'Agent')
        self.subtitle = clean(meta.get('benchmarkType') or 'Stronghold Crusader')
        self.turn_ticks = []

    # -- sources

    def game_image(self, index):
        if index is None:
            return Image.new('RGB', (GAME_W, GAME_H), BG)

        def decode():
            try:
                return self.run.frames[index].image()
            except (OSError, ValueError):
                return Image.new('RGB', (GAME_W, GAME_H), BG)
        return self.decoded.get_or(index, decode)

    def backdrop(self, image):
        key = ('backdrop', id(image))
        if key not in self.cache:
            im = image.resize((W, H), Image.BILINEAR).filter(ImageFilter.GaussianBlur(14))
            self.cache[key] = ImageEnhance.Brightness(im).enhance(0.32)
        return self.cache[key]

    # -- panel

    def panel(self, turn, reveal, at, plan):
        im = Image.new('RGB', (PANEL_W, H), PANEL)
        d = ImageDraw.Draw(im)
        d.line([(0, 0), (0, H)], fill=LINE, width=2)
        x, width = PAD, PANEL_W - 2 * PAD
        d.text((x, 20), ellipsize(self.model, condensed(34), width), font=condensed(34), fill=INK)
        d.text((x, 62), ellipsize(self.subtitle, sans(15), width), font=sans(15), fill=MUTED)
        y = 96
        d.line([(x, y), (x + width, y)], fill=LINE)
        y += 14
        if turn:
            label(d, f'Turn {turn.number} of {len(self.run.turns)}', x, y, ACCENT, 17)
            note = f'thought {turn.seconds:.1f} s' + (f', {turn.retries} retr{"y" if turn.retries == 1 else "ies"}' if turn.retries else '')
            f = sans(14)
            d.text((x + width - f.getlength(note), y + 2), note, font=f, fill=MUTED)
        else:
            label(d, 'Starting', x, y, ACCENT, 17)
        y += 34
        if plan:
            label(d, 'Plan', x, y)
            y += 24
            f = sans(15)
            for step in plan[:6]:
                status = step.get('status', 'pending')
                icon(d, status, x, y + 3, 13)
                color = MUTED if status == 'completed' else INK if status == 'in_progress' else INK2
                d.text((x + 22, y), ellipsize(step.get('step', ''), f, width - 22), font=f, fill=color)
                y += 23
            y += 12
        # Tool list first (bottom), reasoning fills the space between.
        calls = turn.calls if turn else []
        tools_top = self.tool_list(d, calls, reveal, at, x, width)
        label(d, 'Reasoning', x, y)
        y += 26
        self.reasoning(d, turn, reveal, x, y, width, tools_top - 18)
        return im

    def reasoning(self, d, turn, reveal, x, top, width, bottom):
        if not turn:
            return
        thinking, text = turn.thinking, turn.text
        rows = []
        f_think, f_text = sans(16, 400, True), sans(16)
        for line in wrap(thinking, f_think, width) if thinking else []:
            rows.append((line, f_think, INK2))
        if thinking and text:
            rows.append(('', f_text, INK))
        for line in wrap(text, f_text, width) if text else []:
            rows.append((line, f_text, INK))
        if not rows:
            rows = [('(no reasoning text returned)', f_think, FAINT)]
        total = sum(len(r[0]) + 1 for r in rows)
        shown = int(total * reveal)
        visible = []
        for line, fnt, color in rows:
            if shown <= 0:
                break
            visible.append((line[:shown], fnt, color))
            shown -= len(line) + 1
        line_h = 23
        capacity = max(1, (bottom - top) // line_h)
        if len(visible) > capacity:
            visible = visible[-capacity:]
            # Fade the first line to show the text continues above.
            visible[0] = (visible[0][0], visible[0][1], FAINT)
        y = top
        for line, fnt, color in visible:
            d.text((x, y), line, font=fnt, fill=color)
            y += line_h
        if 0 < reveal < 1 and visible:
            last, fnt, _ = visible[-1]
            cx = x + fnt.getlength(last) + 2
            d.rectangle([cx, y - line_h + 4, cx + 8, y - 4], fill=ACCENT)

    def tool_list(self, d, calls, reveal, at, x, width):
        """Draw the turn's tool calls anchored to the bottom; return their top edge."""
        bottom = H - 22
        if not calls:
            return bottom
        f_name, f_args, f_res = condensed(21, 600), sans(14), sans(14)
        rows = []
        for i, call in enumerate(calls):
            status = call.status(at) if reveal >= 1 else 'pending'
            args_line = ellipsize(summarize_call(call.name, call.args), f_args, width - 24)
            result = ''
            if status in ('done', 'error') and call.summary:
                result = ellipsize(call.summary, f_res, width - 24)
            rows.append((call, status, args_line, result))
        # Keep the running call visible when the list is long: show a window of up to 7 rows.
        limit = 7
        current = next((i for i, r in enumerate(rows) if r[1] in ('running', 'pending')), len(rows) - 1)
        first = max(0, min(current - 2, len(rows) - limit))
        window = rows[first:first + limit]
        height = sum(28 + 19 + (19 if r[3] else 0) + 8 for r in window)
        top = bottom - height - 30
        d.line([(x, top - 6), (x + width, top - 6)], fill=LINE)
        count = f'{len(calls)} call{"s" if len(calls) != 1 else ""}' + (f', showing {first + 1}–{first + len(window)}' if len(rows) > limit else '')
        label(d, f'Actions · {count}', x, top + 4)
        y = top + 30
        for call, status, args_line, result in window:
            if status == 'running':
                d.rounded_rectangle([x - 8, y - 4, x + width + 8, y + 28 + 19 + (19 if result else 0) + 2], radius=6, fill=RAISED)
            icon(d, status, x, y + 6, 14)
            d.text((x + 24, y), clean(call.name), font=f_name, fill=ACCENT if status == 'running' else INK)
            d.text((x + 24, y + 28), args_line, font=f_args, fill=INK2 if status != 'pending' else MUTED)
            if result:
                d.text((x + 24, y + 47), result, font=f_res, fill=BAD if status == 'error' else GOOD)
            y += 28 + 19 + (19 if result else 0) + 8
        return top

    # -- bottom strip

    def strip(self, stats, action, detail, detail_color, progress, mode):
        im = Image.new('RGB', (GAME_W, STRIP_H), BG)
        d = ImageDraw.Draw(im)
        d.line([(0, 0), (GAME_W, 0)], fill=LINE, width=2)
        s = stats or {}
        used = None
        if self.run.start_tick is not None and isinstance(s.get('gameTime'), (int, float)):
            used = (s['gameTime'] - self.run.start_tick) / TICKS_PER_GAME_SECOND
        clock = game_clock(used) if used is not None else '--:--'
        if self.run.budget:
            clock += f' / {game_clock(self.run.budget)}'

        def value(key):
            v = s.get(key)
            return '–' if v is None else f'{v:,}' if isinstance(v, int) else str(v)
        population = value('population') + (f" / {s['housing']}" if s.get('housing') is not None else '')
        items = [('Game time', clock), ('Gold', value('gold')), ('Population', population),
                 ('Popularity', value('popularity')), ('Food', value('food')), ('Wood', value('wood')),
                 ('Stone', value('stone')), ('Iron', value('iron'))]
        x = PAD
        widths = [220, 150, 190, 150, 120, 120, 120, 120]
        for (name, text), w in zip(items, widths):
            label(d, name, x, 16, MUTED, 15)
            d.text((x, 36), text, font=condensed(36, 600), fill=INK)
            x += w
        # Game-time progress with a tick per model turn.
        bar_y, bar_x0, bar_x1 = 98, PAD, GAME_W - PAD
        d.rounded_rectangle([bar_x0, bar_y, bar_x1, bar_y + 6], radius=3, fill=RAISED)
        if progress is not None:
            d.rounded_rectangle([bar_x0, bar_y, bar_x0 + (bar_x1 - bar_x0) * min(1, progress), bar_y + 6], radius=3, fill=ACCENT)
        for tick in self.turn_ticks:
            tx = bar_x0 + (bar_x1 - bar_x0) * tick
            d.line([(tx, bar_y - 4), (tx, bar_y + 10)], fill=FAINT, width=1)
        # Current action and its outcome.
        y = 128
        icon(d, mode, PAD, y + 9, 22)
        name, rest = action
        f_name = condensed(38, 600)
        d.text((PAD + 36, y), clean(name), font=f_name, fill=WARN if mode == 'pause' else ACCENT if mode in ('running', 'fast') else INK)
        nx = PAD + 36 + f_name.getlength(clean(name)) + 16
        if rest:
            d.text((nx, y + 8), ellipsize(rest, sans(24), GAME_W - PAD - nx), font=sans(24), fill=INK)
        for i, line in enumerate(wrap(detail, sans(21), GAME_W - 2 * PAD - 36)[:3] if detail else []):
            d.text((PAD + 36, y + 56 + i * 28), line, font=sans(21), fill=detail_color)
        return im


    # -- game area

    def overlay(self, at, clip):
        """Hashable drawing list for the inputs around `at`: ripples, drags, key badges, cursor."""
        run = self.run
        items = []
        lo = bisect.bisect_left(run.input_times, at - 1200)
        hi = bisect.bisect_right(run.input_times, at)
        key_text = None
        for i in run.inputs[lo:hi]:
            age = at - i.at
            if i.type == 'click' and i.pos and age <= 600:
                items.append(('ripple', round(i.pos[0]), round(i.pos[1]), i.right, round(age / 600 * 12) / 12))
            if i.type == 'click' and i.pos and i.label and age <= 1200:
                items.append(('label', round(i.pos[0]), round(i.pos[1]), clean(i.label)))
            if i.type == 'drag' and i.pos and i.end and age <= 900:
                items.append(('drag', *map(round, i.pos), *map(round, i.end), round(min(1, age / 300) * 10) / 10))
            if i.text and age <= 900:
                key_text = clean(i.text)
        if key_text:
            items.append(('key', key_text))
        cursor = self.cursor(at, clip)
        if cursor:
            items.append(cursor)
        return tuple(items)

    def cursor(self, at, clip):
        """The pointer rests on the last target and glides to the next one just before its click."""
        if clip.data.get('pace') != 'action':
            return None
        run = self.run
        lo = bisect.bisect_left(run.input_times, clip.data['start'] - INPUT_LEAD_MS)
        hi = bisect.bisect_right(run.input_times, clip.data['end'] + INPUT_LEAD_MS)
        placed = [i for i in run.inputs[lo:hi] if i.pos]
        before = [i for i in placed if i.at <= at]
        after = [i for i in placed if i.at > at]
        prev, nxt = (before[-1] if before else None), (after[0] if after else None)
        rest = lambda i: i.end or i.pos
        pressed = False
        if prev and nxt and nxt.at - at <= 250:
            p = 1 - (nxt.at - at) / 250
            (x0, y0), (x1, y1) = rest(prev), nxt.pos
            x, y = x0 + (x1 - x0) * p, y0 + (y1 - y0) * p
        elif prev:
            x, y = rest(prev) if at - prev.at > 300 or not prev.end else prev.pos
            pressed = at - prev.at < 150
        elif nxt:
            x, y = nxt.pos
        else:
            return None
        return ('cursor', round(x), round(y), pressed)

    def game(self, index, dim=False, overlay=(), badge=None, badge_color=ACCENT, fast=False):
        return self.games.get_or((index, dim, overlay, badge, fast),
                                 lambda: self.draw_game(index, dim, overlay, badge, badge_color, fast))

    def draw_game(self, index, dim, overlay, badge, badge_color, fast):
        im = self.game_image(index).copy()
        if dim:
            im = ImageEnhance.Brightness(ImageEnhance.Color(im).enhance(0.35)).enhance(0.45)
        d = ImageDraw.Draw(im)
        for item in overlay:
            kind = item[0]
            if kind == 'ripple':
                _, x, y, right, p = item
                r, w = 10 + 34 * p, max(1, round(5 * (1 - p)))
                for color, extra in ((BG, 2), (INK if right else ACCENT, 0)):
                    d.ellipse([x - r - extra / 2, y - r - extra / 2, x + r + extra / 2, y + r + extra / 2], outline=color, width=w + extra)
            elif kind == 'drag':
                _, x0, y0, x1, y1, p = item
                xe, ye = x0 + (x1 - x0) * p, y0 + (y1 - y0) * p
                for color, width in ((BG, 7), (ACCENT, 4)):
                    d.line([(x0, y0), (xe, ye)], fill=color, width=width)
            elif kind == 'label':
                _, x, y, name = item
                f = condensed(20, 600)
                tw = f.getlength(name)
                d.rounded_rectangle([x + 26, y - 40, x + 38 + tw, y - 14], radius=4, fill=BG)
                d.text((x + 32, y - 39), name, font=f, fill=INK)
            elif kind == 'key':
                f = condensed(24, 600)
                tw = f.getlength(item[1])
                x0 = (GAME_W - tw) / 2 - 16
                d.rounded_rectangle([x0, 16, x0 + tw + 32, 54], radius=8, fill=BG, outline=ACCENT, width=2)
                d.text((x0 + 16, 19), item[1], font=f, fill=INK)
            elif kind == 'cursor':
                _, x, y, pressed = item
                arrow = [(0, 0), (0, 28), (7, 21), (12, 32), (17, 30), (12, 19), (21, 19)]
                d.polygon([(x + ax, y + ay) for ax, ay in arrow], fill=ACCENT if pressed else INK, outline=BG, width=2)
        if badge:
            f = condensed(22, 600)
            tw = f.getlength(badge)
            left = 44 if not fast else 50
            d.rounded_rectangle([16, 16, left + tw + 12, 50], radius=17, fill=BG)
            if fast:
                icon(d, 'fast', 26, 25, 18)
            else:
                d.ellipse([28, 28, 38, 38], fill=badge_color)
            d.text((left, 18), badge, font=f, fill=INK)
        return im

    # -- frames

    def frame(self, clip, local):
        """(cache key, builder) for one output frame; equal keys give identical images."""
        run = self.run
        if clip.kind == 'outro':
            return ('outro',), self.outro
        if clip.kind == 'compaction':
            at = clip.data['at']
            index, stats = run.frame_at(at), run.stats_at(at)

            def build():
                return self.compose(self.game(index, dim=True, badge='Paused · context compaction', badge_color=WARN),
                                    self.compaction_panel(clip.data['handoff']),
                                    self.strip(stats, ('Compacting context', ''), 'The agent summarised its own history into a handoff note to stay within its context budget.',
                                               MUTED, self.progress_at(stats), 'pause'))
            return ('compaction', id(clip)), build
        if clip.kind == 'think':
            turn = clip.data['turn']
            index, stats = run.frame_at(turn.start), run.stats_at(turn.start)
            typing = clip.duration * 0.8
            # Quantised so identical frames are reused.
            reveal = round((1.0 if typing <= 0 else min(1.0, local / typing)) * 120) / 120
            plan = run.plan_at(turn.end)

            def build():
                cut = f'{turn.seconds:.0f} s of thinking (game paused) shown in {clip.duration:.1f} s'
                names = ', '.join(dict.fromkeys(c.name for c in turn.calls)) or 'no tools'
                return self.compose(self.game(index, dim=True, badge='Paused · agent thinking', badge_color=WARN),
                                    self.panel(turn, reveal, turn.end, plan),
                                    self.strip(stats, ('Thinking', f'next: {names}'), cut, MUTED, self.progress_at(stats), 'pause'))
            return ('think', turn.number, reveal), build
        # play
        speed, fast = clip.data['speed'], clip.data['pace'] == 'idle'
        at = clip.data['start'] + local * 1000 * speed
        index, stats = run.frame_at(at), run.stats_at(at)
        turn = run.turn_before(clip.data['segment'][0])
        plan_i = run.plan_index(at)
        plan = run.plans[plan_i][1] if plan_i >= 0 else []
        calls = turn.calls if turn else []
        statuses = tuple(c.status(at) for c in calls)
        running = next((c for c, st in zip(calls, statuses) if st == 'running'), None)
        finished = [c for c, st in zip(calls, statuses) if st in ('done', 'error')]
        detail, color = '', MUTED
        if running:
            action, mode = (running.name, summarize_call(running.name, running.args)), 'fast' if fast else 'running'
            if len(calls) > 1:
                detail = f'call {calls.index(running) + 1} of {len(calls)}'
        elif turn and not calls and any(clip.data['segment'][0] <= o <= clip.data['segment'][1] + 500 for o in run.observations):
            action, mode = ('Game running', f'no tool called: the host lets {run.default_wait:g} game s pass, then observes'), 'fast' if fast else 'running'
        elif finished:
            last = finished[-1]
            action = (last.name, summarize_call(last.name, last.args))
            detail, color, mode = last.summary, BAD if last.error else GOOD, 'error' if last.error else 'done'
        else:
            action, mode = ('Game running', ''), 'fast' if fast else 'running'
        badge = f'Fast-forward {speed:.0f}×' if fast else 'Real time' if speed == 1 else f'{speed:g}×'
        overlay = () if fast else self.overlay(at, clip)
        stats_key = tuple(sorted((k, v) for k, v in (stats or {}).items() if k != 'paused'))
        progress = self.progress_at(stats)
        key = ('play', index, turn.number if turn else 0, statuses, plan_i, stats_key, action, detail, overlay, badge)

        def build():
            panel = self.panels.get_or((turn.number if turn else 0, statuses, plan_i), lambda: self.panel(turn, 1.0, at, plan))
            return self.compose(self.game(index, overlay=overlay, badge=badge, badge_color=GOOD, fast=fast), panel,
                                self.strip(stats, action, detail, color, progress, mode))
        return key, build


    # -- cards

    def card(self, background, title, lines, footer=None):
        im = self.backdrop(background).copy()
        d = ImageDraw.Draw(im)
        x, y, width = 160, 150, W - 320
        d.text((x, y), clean(title), font=condensed(76, 600), fill=INK)
        y += 108
        for text, fnt, color, gap in lines:
            for line in wrap(text, fnt, width) if text else ['']:
                if y > H - 140:
                    break
                d.text((x, y), line, font=fnt, fill=color)
                y += int(fnt.size * 1.35)
            y += gap
        if footer:
            d.text((x, H - 110), clean(footer), font=sans(20), fill=MUTED)
        return im


    def outro(self):
        if 'outro' not in self.cache:
            run, meta = self.run, self.run.meta
            s = dict(run.stats_at(math.inf) or {})
            s.update({k: v for k, v in (run.final_stats or {}).items() if v is not None})
            ep = run.episode or {}
            progress = meta.get('progress') or {}
            budget = progress.get('budget') or {}
            rows = []
            if ep.get('net_worth') is not None:
                growth = ep.get('net_worth_growth')
                rows.append(f"Net worth {ep['net_worth']:,}" + (f'  ({growth:+,} from start)' if isinstance(growth, (int, float)) else ''))
            pieces = [f"Gold {s['gold']:,}" if isinstance(s.get('gold'), int) else None,
                      f"Population {s.get('population')} / {s.get('housing')}" if s.get('population') is not None else None,
                      f"Popularity {s.get('popularity')}" if s.get('popularity') is not None else None,
                      f"Food {s.get('food')}" if s.get('food') is not None else None]
            rows.append('   ·   '.join(p for p in pieces if p))
            goods = ep.get('goods') or {}
            if goods:
                rows.append('Stored: ' + ', '.join(f'{k.replace("_", " ")} {v}' for k, v in goods.items()))
            used = budget.get('usedGameSeconds')
            facts = [f'{game_clock(used)} game time' if used is not None else None,
                     f"{meta.get('turns') or len(run.turns)} turns",
                     f"{meta.get('tokens'):,} tokens" if isinstance(meta.get('tokens'), int) else None,
                     f"{budget['wallUsedSeconds'] / 60:.1f} min real time" if budget.get('wallUsedSeconds') else None,
                     f"ended: {str(progress.get('stopReason') or meta.get('status', '')).replace('_', ' ')}"]
            lines = [(f'{self.model}  ·  {self.subtitle}', condensed(36, 600), ACCENT, 26)]
            lines += [(row, condensed(46, 600), INK, 14) for row in rows if row]
            lines.append(('   ·   '.join(f for f in facts if f), sans(24), INK2, 0))
            if run.final_image:
                background = Frame(0, data=run.final_image).image()
            else:
                background = self.game_image(len(run.frames) - 1 if run.frames else None)
            self.cache['outro'] = self.card(background, 'Result', lines)
        return self.cache['outro']

    # -- frames

    def compose(self, game, panel, strip):
        canvas = Image.new('RGB', (W, H), BG)
        canvas.paste(game, (0, 0))
        canvas.paste(panel, (GAME_W, 0))
        canvas.paste(strip, (0, GAME_H))
        return canvas

    def progress_at(self, stats):
        if not stats or self.run.start_tick is None or not self.run.budget or not isinstance(stats.get('gameTime'), (int, float)):
            return None
        return (stats['gameTime'] - self.run.start_tick) / TICKS_PER_GAME_SECOND / self.run.budget


    def compaction_panel(self, handoff):
        im = Image.new('RGB', (PANEL_W, H), PANEL)
        d = ImageDraw.Draw(im)
        d.line([(0, 0), (0, H)], fill=LINE, width=2)
        x, width = PAD, PANEL_W - 2 * PAD
        d.text((x, 20), ellipsize(self.model, condensed(34), width), font=condensed(34), fill=INK)
        d.text((x, 62), ellipsize(self.subtitle, sans(15), width), font=sans(15), fill=MUTED)
        d.line([(x, 96), (x + width, 96)], fill=LINE)
        label(d, 'Handoff note', x, 110, WARN, 17)
        y = 146
        for line in wrap(handoff, sans(15), width)[:38]:
            d.text((x, y), line, font=sans(15), fill=INK2)
            y += 22
        return im




# ---------------------------------------------------------------- main


def encoder_args(name):
    if name == 'libx264':
        return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22']
    return ['-c:v', name, '-b:v', '8M']


def render(run, args, output):
    clips = build_timeline(run, args)
    if not clips:
        sys.exit('Nothing to render: the recording holds no footage.')
    total = clips[-1].start + clips[-1].duration
    if args.max_seconds:
        total = min(total, args.max_seconds)
    renderer = Renderer(run, args)
    # Turn ticks on the progress bar, by the game time at each reply.
    for turn in run.turns:
        p = renderer.progress_at(run.stats_at(turn.end))
        if p is not None:
            renderer.turn_ticks.append(min(1, max(0, p)))
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        sys.exit('ffmpeg not found on PATH (macOS: brew install ffmpeg).')
    with tempfile.TemporaryDirectory() as tmp:
        metadata = Path(tmp) / 'chapters.txt'
        rows = [(start, title) for start, title in chapters(run, clips) if start < total]
        lines = [';FFMETADATA1', f"title={clean(run.meta.get('name', 'Agent run'))}"]
        for i, (start, title) in enumerate(rows):
            end = rows[i + 1][0] if i + 1 < len(rows) else total
            lines += ['[CHAPTER]', 'TIMEBASE=1/1000', f'START={int(start * 1000)}', f'END={int(end * 1000)}',
                      'title=' + title.replace('=', '\\=').replace(';', '\\;').replace('#', '\\#').replace('\n', ' ')]
        metadata.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        partial = output.with_name(output.stem + '.partial.mp4')
        command = [ffmpeg, '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                   '-r', str(args.fps), '-i', '-', '-i', str(metadata), '-map', '0:v', '-map_metadata', '1',
                   '-map_chapters', '1', *encoder_args(args.encoder), '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                   str(partial)]
        process = subprocess.Popen(command, stdin=subprocess.PIPE)
        clip_index = 0
        previous_key, previous_bytes = None, None
        try:
            for n in range(int(total * args.fps)):
                t = n / args.fps
                while clip_index + 1 < len(clips) and t >= clips[clip_index + 1].start:
                    clip_index += 1
                clip = clips[clip_index]
                key, build = renderer.frame(clip, t - clip.start)
                if key != previous_key:
                    previous_key, previous_bytes = key, build().tobytes()
                process.stdin.write(previous_bytes)
                if not args.quiet and n % (args.fps * 30) == 0:
                    print(f'  {t / 60:5.1f} / {total / 60:.1f} min', file=sys.stderr, flush=True)
            process.stdin.close()
        except BrokenPipeError:
            pass
        if process.wait() != 0:
            partial.unlink(missing_ok=True)
            sys.exit('ffmpeg failed.')
        os.replace(partial, output)
    return total, clips


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('run', help='run folder (harness/runtime/runs/<folder>), or a folder name under it')
    parser.add_argument('-o', '--output', help='default: <run>/video.mp4')
    parser.add_argument('--speed', type=float, default=1.0, help='speed around clicks and keys (default 1, real time)')
    parser.add_argument('--idle-speed', type=float, default=8.0, help='fast-forward for idle play (default 8)')
    parser.add_argument('--max-idle', type=float, default=4.0,
                        help='longest video seconds for one idle stretch; faster beyond (default 4, 0 = no limit)')
    parser.add_argument('--fps', type=int, default=15, help='output frame rate (default 15)')
    parser.add_argument('--min-think', type=float, default=1.5, help='shortest thinking card, seconds')
    parser.add_argument('--max-think', type=float, default=4.0, help='longest thinking card, seconds; 0 shows reasoning without cards')
    parser.add_argument('--think-rate', type=float, default=600, help='reasoning characters per card second')
    parser.add_argument('--outro', type=float, default=6.0, help='result card seconds (0 = none)')
    parser.add_argument('--max-seconds', type=float, default=0, help='stop after this much video (previews)')
    parser.add_argument('--encoder', default='libx264', help='ffmpeg video encoder (default libx264)')
    parser.add_argument('--quiet', action='store_true')
    args = parser.parse_args(argv)
    if not (0.1 <= args.speed <= 16 and 1 <= args.idle_speed <= 64 and args.max_idle >= 0 and 5 <= args.fps <= 60
            and (0 <= args.min_think <= args.max_think or args.max_think == 0)):
        parser.error('unsupported speed, fps or thinking-card durations')
    run_dir = Path(args.run)
    if not (run_dir / 'run.json').is_file():
        run_dir = ROOT / 'harness/runtime/runs' / args.run
    if not (run_dir / 'run.json').is_file():
        parser.error(f'no run.json in {args.run}')
    frames, inputs = load_recording(run_dir)
    if not frames:
        sys.exit('This run has no recording (Record video was off); only recorded runs can be rendered.')
    run = Run(run_dir, load_events(run_dir), frames, inputs)
    output = Path(args.output) if args.output else run_dir / 'video.mp4'
    if not args.quiet:
        print(f'{run_dir.name}: {len(run.turns)} turns, {len(run.segments)} recorded segments, '
              f'{len(frames)} frames, {len(inputs)} inputs', file=sys.stderr)
    total, clips = render(run, args, output)
    real = lambda kind: sum(c.data['end'] - c.data['start'] for c in clips if c.kind == 'play' and c.data['pace'] == kind) / 1000
    recorded = sum(b - a for a, b in run.segments) / 1000
    print(json.dumps({'output': str(output), 'seconds': round(total, 1), 'turns': len(run.turns),
                      'frames': len(frames), 'inputs': len(inputs), 'recordedSeconds': round(recorded, 1),
                      'realSpeedSeconds': round(real('action'), 1), 'fastForwardedSeconds': round(real('idle'), 1),
                      'cutSeconds': round(recorded - real('action') - real('idle'), 1),
                      'thinkingSecondsCut': round(sum(t.seconds for t in run.turns), 1)}))


if __name__ == '__main__':
    main()
