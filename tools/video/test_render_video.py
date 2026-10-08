"""Timeline editing, input overlay, summaries and a tiny end-to-end render of a synthetic recorded run.

  python3 -m unittest discover -s tools/video
"""
import argparse
import io
import json
from pathlib import Path
from runpy import run_path
import shutil
import subprocess
import tempfile
import unittest

from PIL import Image

video = run_path(str(Path(__file__).with_name('render-video.py')))
T0 = 1_000_000


def args(**overrides):
    values = dict(speed=1.0, idle_speed=8.0, max_idle=4.0, fps=10, min_think=1.5, max_think=4.0, think_rate=600,
                  outro=2.0, max_seconds=0, encoder='libx264', quiet=True)
    values.update(overrides)
    return argparse.Namespace(**values)


def write_run(directory, recording=True):
    """Three recorded segments around two turns.

    Segment 1 (0–1.51 s): the host unpauses and observes. Turn 1 thinks 10 s, then segment 2
    (11.6–30.01 s): build_structure clicks at 12.2–13.0 s, a 15 s wait with a hotkey at 29 s.
    Turn 2 replies with text; segment 3 (36.1–41.3 s) is the host's default wait.
    """
    run = {'name': 'Test · Oasis', 'model': {'name': 'Test Model'}, 'benchmarkType': 'Oasis construction',
           'prompt': 'Grow the economy.', 'config': {'gameMinutes': 10, 'defaultWaitSeconds': 5, 'recordVideo': True},
           'turns': 2, 'tokens': 300, 'startedAt': T0, 'status': 'completed'}
    (directory / 'run.json').write_text(json.dumps(run))
    placements = [{'name': 'Granary', 'x': 960, 'y': 540}]
    events = [
        (0, {'type': 'recording_state', 'state': 'run'}),
        (1000, {'type': 'host_observation', 'message': {'content': []}}),
        (1500, {'type': 'inference_pause_confirmed'}),
        (1510, {'type': 'recording_state', 'state': 'hold'}),
        (11500, {'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'toolUse',
                                                    'content': [{'type': 'thinking', 'thinking': 'Place the granary → near the keep.'},
                                                                {'type': 'text', 'text': 'Granary first.'},
                                                                {'type': 'toolCall', 'id': 'c1', 'name': 'build_structure',
                                                                 'arguments': {'placements': placements}},
                                                                {'type': 'toolCall', 'id': 'c2', 'name': 'wait_and_observe',
                                                                 'arguments': {'seconds': 15}}]}}),
        (11600, {'type': 'recording_state', 'state': 'run'}),
        (12000, {'type': 'tool_execution_start', 'toolCallId': 'c1', 'toolName': 'build_structure', 'args': {'placements': placements}}),
        (14000, {'type': 'tool_execution_end', 'toolCallId': 'c1', 'toolName': 'build_structure', 'isError': False,
                 'result': {'content': [{'type': 'text', 'text': json.dumps({'placements': [{'building': 'Granary', 'status': 'placed'}]})}]}}),
        (14100, {'type': 'tool_execution_start', 'toolCallId': 'c2', 'toolName': 'wait_and_observe', 'args': {'seconds': 15}}),
        (15000, {'type': 'plan', 'plan': [{'step': 'Granary', 'status': 'completed'}]}),
        (29500, {'type': 'tool_execution_end', 'toolCallId': 'c2', 'toolName': 'wait_and_observe', 'isError': False,
                 'result': {'content': [{'type': 'text', 'text': json.dumps({'coordinate_space': 'game-window-pixels'})}]}}),
        (29900, {'type': 'inference_pause_confirmed'}),
        (30010, {'type': 'recording_state', 'state': 'hold'}),
        (31000, {'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'error', 'content': []}}),
        (31100, {'type': 'inference_retry', 'attempt': 1}),
        (31200, {'type': 'inference_pause_confirmed'}),
        (36000, {'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': 'stop', 'content': [{'type': 'text', 'text': 'Waiting.'}]}}),
        (36100, {'type': 'recording_state', 'state': 'run'}),
        (41200, {'type': 'host_observation', 'message': {'content': []}}),
        (41300, {'type': 'recording_state', 'state': 'hold'}),
    ]
    with open(directory / 'events.jsonl', 'w') as handle:
        for at, event in events:
            handle.write(json.dumps({'at': T0 + at, 'event': event}, separators=(',', ':')) + '\n')
        handle.write(json.dumps({'at': T0, 'event': {'type': 'message_update', 'delta': {}}}, separators=(',', ':')) + '\n')
    if not recording:
        return
    folder = directory / 'recording'
    (folder / 'frames').mkdir(parents=True)
    paused = {0, 11600, 11850, 29750, 30000}
    times = [*range(0, 1510, 500), *range(11600, 30010, 250), *range(36100, 41300, 500)]
    rows = []
    for i, at in enumerate(times, 1):
        buffer = io.BytesIO()
        Image.new('RGB', (1440, 810), (40 + i % 100, 90, 60)).save(buffer, format='JPEG')
        name = f'{i:06d}.jpg'
        (folder / 'frames' / name).write_bytes(buffer.getvalue())
        # The game host's clock runs 7 s behind; delivery takes 40 ms.
        rows.append({'i': i, 'file': name, 'at': T0 + at + 40, 't': T0 + at - 7000, 'w': 1440, 'h': 810, 'sw': 1920, 'sh': 1080,
                     'stats': {'gameTime': 1000 + at * 30 // 1000, 'paused': at in paused, 'gold': 1000 - i, 'population': 4}})
    (folder / 'frames.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
    inputs = [(100, {'type': 'key', 'key': 'P'}), (11700, {'type': 'key', 'key': 'P'}),
              (12200, {'type': 'click', 'x': 840, 'y': 1040, 'button': 1}),
              (12400, {'type': 'click', 'x': 900, 'y': 1000, 'button': 1}),
              (12600, {'type': 'click', 'x': 960, 'y': 540, 'button': 1}),
              (13000, {'type': 'click', 'x': 960, 'y': 540, 'button': 3}),
              (29000, {'type': 'hotkey', 'name': 'HomeKeep'})]
    (folder / 'inputs.jsonl').write_text(''.join(json.dumps({'at': T0 + at, **i, 'width': 1920, 'height': 1080}) + '\n' for at, i in inputs))


class RenderVideoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def load(self):
        write_run(self.dir)
        frames, inputs = video['load_recording'](self.dir)
        return video['Run'](self.dir, video['load_events'](self.dir), frames, inputs)

    def test_turns_segments_and_inputs(self):
        run = self.load()
        first, second = run.turns
        self.assertEqual((first.start, first.end, first.seconds), (T0 + 1500, T0 + 11500, 10.0))
        self.assertEqual([c.summary for c in first.calls], ['Granary placed', 'fresh screenshot'])
        # The failed request is dropped and counted as a retry of the reply that followed.
        self.assertEqual((second.start, second.retries, second.text), (T0 + 31200, 1, 'Waiting.'))
        self.assertEqual(run.segments, [(T0, T0 + 1510), (T0 + 11600, T0 + 30010), (T0 + 36100, T0 + 41300)])
        # Capture times 7 s behind are aligned to the host clock by the fastest delivery.
        self.assertEqual(run.frames[0].time, T0 + 40)
        # The host's pause key is not an agent action; the terrain click names its building.
        self.assertEqual([i.at - T0 for i in run.inputs], [12200, 12400, 12600, 13000, 29000])
        self.assertEqual([i.label for i in run.inputs], ['', '', 'Granary', 'Granary', ''])
        self.assertEqual(run.inputs[2].pos, (720.0, 405.0))
        self.assertEqual(run.inputs[4].text, 'Centre on keep')

    def test_spans_play_actions_fast_forward_idle_and_cut_stale_pauses(self):
        run = self.load()
        spans = lambda segment: [(a - T0, b - T0, kind) for a, b, kind in run.spans(*segment)]
        # Paused before the host's unpause shows: cut; then idle play.
        self.assertEqual(spans(run.segments[0]), [(0, 540, 'cut'), (540, 1510, 'idle')])
        # Real speed from 0.5 s before the first click to 1.5 s after the last; the long wait is idle;
        # the paused tail stays because the hotkey's window covers it.
        self.assertEqual(spans(run.segments[1]), [(11600, 11700, 'cut'), (11700, 14500, 'action'),
                                                  (14500, 28500, 'idle'), (28500, 30010, 'action')])
        self.assertEqual(spans(run.segments[2]), [(36100, 41300, 'idle')])

    def test_timeline_has_no_intro_and_compresses_idle(self):
        run = self.load()
        clips = video['build_timeline'](run, args())
        self.assertEqual([(c.kind, c.data.get('pace')) for c in clips],
                         [('play', 'idle'), ('think', None), ('play', 'action'), ('play', 'idle'), ('play', 'action'),
                          ('think', None), ('play', 'idle'), ('outro', None)])
        self.assertEqual(clips[0].start, 0)
        self.assertAlmostEqual(clips[2].duration, 2.8)            # real time around the clicks
        self.assertAlmostEqual(clips[3].duration, 14 / 8)         # 14 s wait at 8×
        self.assertTrue(all(1.5 <= c.duration <= 4.0 for c in clips if c.kind == 'think'))
        capped = video['build_timeline'](run, args(max_idle=1, max_think=0, outro=0))
        self.assertEqual([c.kind for c in capped], ['play'] * 5)
        self.assertAlmostEqual(capped[2].duration, 1.0)           # capped: 14 s idle at 14×
        self.assertAlmostEqual(capped[2].data['speed'], 14.0)
        titles = [title for _, title in video['chapters'](run, clips)]
        self.assertEqual(titles, ['Start', 'Turn 1: build_structure, wait_and_observe', 'Turn 2: reply', 'Result'])

    def test_overlay_draws_clicks_cursor_and_keys(self):
        run = self.load()
        renderer = video['Renderer'](run, args())
        clips = video['build_timeline'](run, args())
        action, idle, tail = clips[2], clips[3], clips[4]
        at = lambda ms: (T0 + ms - action.data['start']) / 1000
        overlay = lambda clip, ms: renderer.overlay(T0 + ms, clip)
        # The two menu clicks before it are still fading out.
        self.assertEqual([item[:3] for item in overlay(action, 12600)[:2]], [('ripple', 630, 780), ('ripple', 675, 750)])
        self.assertEqual(overlay(action, 12600)[2:], (('ripple', 720, 405, False, 0.0), ('label', 720, 405, 'Granary'),
                                                      ('cursor', 720, 405, True)))
        # 100 ms before the terrain click the pointer is 60% of the way from the building button.
        self.assertEqual(overlay(action, 12500)[-1], ('cursor', 702, 543, False))
        right = [item for item in overlay(action, 13100) if item[0] == 'ripple' and item[3]]
        self.assertEqual(right, [('ripple', 720, 405, True, 2 / 12)])
        # A hotkey has no position, so this span shows the key but no pointer.
        self.assertEqual(overlay(tail, 29300), (('key', 'Centre on keep'),))
        key, build = renderer.frame(action, at(12600))
        self.assertEqual((key[3], key[6][0], key[9]), (('running', 'pending'), 'build_structure', 'Real time'))
        self.assertEqual(build().size, (1920, 1080))
        key, _ = renderer.frame(idle, 1.0)
        self.assertEqual((key[6][0], key[8], key[9]), ('wait_and_observe', (), 'Fast-forward 8×'))
        think_start, _ = renderer.frame(clips[1], 0)
        think_end, _ = renderer.frame(clips[1], clips[1].duration)
        self.assertEqual((think_start[2], think_end[2]), (0.0, 1.0))
        key, _ = renderer.frame(clips[6], 0.2)
        self.assertIn('no tool called', key[6][1])

    def test_unrecorded_runs_are_refused(self):
        write_run(self.dir, recording=False)
        with self.assertRaises(SystemExit) as stop:
            video['main']([str(self.dir), '--quiet'])
        self.assertIn('no recording', str(stop.exception))

    def test_summaries(self):
        call, result = video['summarize_call'], video['summarize_result']
        self.assertEqual(call('build_structure', {'placements': [{'name': 'Hovel', 'x': 1, 'y': 2}, {'name': 'Hovel', 'x': 3, 'y': 4}]}),
                         'Hovel at 1,2 · Hovel at 3,4')
        self.assertEqual(call('place_near', {'building': 'Hovel', 'anchor': 'keep', 'side': 'south', 'count': 2}),
                         '2× Hovel next to keep (south)')
        self.assertEqual(call('wait_and_observe', {'seconds': 30, 'until': {'amount': 'gold', 'at_least': 500}}),
                         'let 30 game s pass or until gold ≥ 500')
        rejected = json.dumps({'placements': [{'building': 'Stockpile', 'status': 'rejected', 'feedback': ['Needs to be placed adjacent to the stockpile.']}]})
        self.assertEqual(result('build_structure', [rejected], False), 'Stockpile rejected (Needs to be placed adjacent to the stockpile.)')
        self.assertEqual(result('market_trade', [json.dumps({'status': 'traded', 'good': 'wood_planks', 'units': 20, 'goldChange': -80})], False),
                         '20 wood_planks for -80 gold')
        self.assertEqual(result('expand_storage', [json.dumps({'status': 'not_placed', 'placed': [], 'stopped': 'no_more_free_spots'})], False),
                         'not placed — no more free spots')
        self.assertEqual(result('game_action', ['Click outside the game window.'], True), 'Click outside the game window.')
        self.assertEqual(video['clean']('a → b ≥ 3 🙂'), 'a -> b >= 3 ?')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'needs ffmpeg')
    def test_renders_mp4_with_chapters(self):
        run = self.load()
        output = self.dir / 'video.mp4'
        total, _ = video['render'](run, args(), output)
        probe = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-show_chapters',
                                           '-of', 'json', str(output)], capture_output=True, text=True, check=True).stdout)
        self.assertAlmostEqual(float(probe['format']['duration']), total, delta=0.2)
        self.assertEqual((probe['streams'][0]['width'], probe['streams'][0]['height']), (1920, 1080))
        self.assertEqual(len(probe['chapters']), 4)
        self.assertFalse((self.dir / 'video.partial.mp4').exists())


if __name__ == '__main__':
    unittest.main()
