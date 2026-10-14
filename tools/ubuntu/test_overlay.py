import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('overlay', Path(__file__).with_name('overlay.py'))
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)

LIVE = dict(connected=True, heartbeat=1000.0, phase='THINKING', model='Claude Opus 5.5',
            run='Claude Opus 5.5 · Large Barren Desert construction · 20261012-113736Z',
            turns=20, tool_calls=39, cost=0.662,
            stats=dict(net_worth=6087, gold=4522, population=35, popularity=68),
            clock=dict(used=754.0, total=2000.0))

class OverlayTests(unittest.TestCase):
    def test_a_running_benchmark_shows_its_clock_and_figures(self):
        p = overlay.panel(LIVE, 1001.0)
        self.assertEqual(p['title'], 'Claude Opus 5.5 · Large Barren Desert construction')
        self.assertEqual(p['used'], '12:34 / 33:20 game time')
        self.assertEqual(p['left'], '20:46 left')
        self.assertAlmostEqual(p['fraction'], 0.377)
        self.assertEqual(p['phase'], 'thinking')
        self.assertEqual(p['figures'], 'Net worth 6,087   ·   Gold 4,522   ·   People 35   ·   Popularity 68   ·   Turns 20   ·   Tool calls 39   ·   $0.66')

    def test_nothing_shows_without_a_live_bridge_or_a_game_clock(self):
        self.assertIsNone(overlay.panel(LIVE, 1010.0), 'heartbeat older than 4 s')
        self.assertIsNone(overlay.panel(dict(LIVE, clock=None), 1001.0))
        self.assertIsNone(overlay.panel(dict(LIVE, clock=dict(used=5, total=0)), 1001.0))
        self.assertIsNone(overlay.panel(dict(LIVE, connected=False), 1001.0))

    def test_the_game_speed_shows_beside_the_phase_and_paused_while_the_game_is(self):
        self.assertEqual(overlay.panel(dict(LIVE, phase='WAITING', speed=90), 1001.0)['phase'], 'waiting  ·  speed 90')
        self.assertEqual(overlay.panel(dict(LIVE, phase='ACTING', speed=40), 1001.0)['phase'], 'acting  ·  speed 40')
        paused = dict(LIVE, speed=40, stats=dict(LIVE['stats'], paused=True))
        self.assertEqual(overlay.panel(paused, 1001.0)['phase'], 'thinking  ·  paused')
        self.assertEqual(overlay.panel(dict(LIVE, speed=None), 1001.0)['phase'], 'thinking', 'an earlier host sends no speed')

    def test_missing_figures_and_overrun_clocks_are_shown_safely(self):
        p = overlay.panel(dict(LIVE, stats={}, tool_calls=None, cost=None, clock=dict(used=2100, total=2000)), 1001.0)
        self.assertEqual(p['fraction'], 1)
        self.assertEqual(p['left'], '0:00 left')
        self.assertTrue(p['figures'].startswith('Net worth –'))
        self.assertNotIn('$', p['figures'])
        self.assertEqual(overlay.clock_text(-3), '0:00')

    def test_the_panel_is_drawn_with_see_through_corners_and_premultiplied_pixels(self):
        image = overlay.render(overlay.panel(LIVE, 1001.0))
        self.assertEqual(image.size, (overlay.WIDTH, overlay.HEIGHT))
        self.assertEqual(image.getpixel((0, 0))[3], 0, 'rounded corner')
        self.assertEqual(image.getpixel((overlay.WIDTH // 2, overlay.HEIGHT - 6))[3], 214, 'panel')
        data = overlay.pixels(image, 32)
        self.assertEqual(len(data), overlay.WIDTH * overlay.HEIGHT * 4)
        for i in range(0, len(data), 4):
            b, g, r, a = data[i:i + 4]
            self.assertLessEqual(max(b, g, r), a)
        opaque = overlay.pixels(image, 24)
        self.assertEqual(set(opaque[3::4]), {255})

    def test_the_bar_fills_with_the_game_time_used(self):
        def filled(used):
            image = overlay.render(overlay.panel(dict(LIVE, clock=dict(used=used, total=2000.0)), 1001.0))
            row = [image.getpixel((x, 37)) for x in range(16, overlay.WIDTH - 16)]
            return sum(1 for r, g, b, a in row if r > 150 and b < 120)
        self.assertEqual(filled(0), 0)
        self.assertAlmostEqual(filled(1000) / (overlay.WIDTH - 32), 0.5, delta=0.02)
        self.assertEqual(filled(2000), overlay.WIDTH - 32)

    def test_an_earlier_versions_bridge_shows_the_runners_feed_while_it_is_fresh(self):
        # A pre-overlay monitor's status: live, but with no clock or overlay figures.
        old = dict(connected=True, heartbeat=1000.0, phase='AGENT RUNNING', model='Muse Wonder', run='', turns=3,
                   stats=dict(gold=900, population=12))
        self.assertIsNone(overlay.panel(old, 1001.0))
        fed = dict(LIVE, connected=False, heartbeat=0, at=999.0, model='Muse Wonder', run='Muse Wonder · Oasis by the Sea construction · x')
        p = overlay.panel(overlay.with_feed(old, fed, 1001.0), 1001.0)
        self.assertEqual(p['title'], 'Muse Wonder · Oasis by the Sea construction')
        self.assertEqual(p['used'], '12:34 / 33:20 game time')
        self.assertIn('Tool calls 39', p['figures'])
        self.assertIsNone(overlay.panel(overlay.with_feed(old, fed, 1003.0 + overlay.FEED_SECONDS), 1001.0), 'stale feed')
        self.assertIsNone(overlay.panel(overlay.with_feed(dict(old, connected=False), fed, 1001.0), 1001.0), 'the bridge still decides')

    def test_the_feed_keeps_the_latest_line_and_starts_the_overlay_once_a_clock_appears(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(overlay, 'BASE', Path(tmp)):
            starts, seen = [], []
            def lines():
                yield json.dumps(dict(phase='IDLE', clock=None, secret='dropped')) + '\n'
                seen.append(json.loads((Path(tmp) / 'overlay-feed.json').read_text()))
                yield 'not json\n'
                yield json.dumps(dict(phase='THINKING', clock=dict(used=1, total=2000), turns=1)) + '\n'
                yield json.dumps(dict(phase='THINKING', clock=dict(used=2, total=2000), turns=2)) + '\n'
                seen.append(json.loads((Path(tmp) / 'overlay-feed.json').read_text()))
            overlay.feed(lines(), start=lambda: starts.append(1))
            self.assertEqual(seen[0]['phase'], 'IDLE')
            self.assertNotIn('secret', seen[0])
            self.assertEqual(seen[1]['turns'], 2)
            self.assertIn('at', seen[1])
            self.assertEqual(len(starts), 1, 'one start within START_EVERY_SECONDS')
            self.assertFalse((Path(tmp) / 'overlay-feed.json').exists(), 'removed when the feed ends')

    def test_a_feed_leaves_another_feeds_file_in_place(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(overlay, 'BASE', Path(tmp)):
            file = Path(tmp) / 'overlay-feed.json'
            def lines():
                yield json.dumps(dict(phase='IDLE')) + '\n'
                file.write_text(json.dumps(dict(phase='THINKING', at=1.0, feed=-1)))  # a newer feed wrote since
            overlay.feed(lines(), start=lambda: None)
            self.assertEqual(json.loads(file.read_text())['feed'], -1)

    def test_the_feed_reads_whole_lines_and_ends_when_its_runner_falls_silent(self):
        import os, threading
        read_end, write_end = os.pipe()
        def runner():
            os.write(write_end, b'{"a": 1}\n{"b"')
            time.sleep(0.05)
            os.write(write_end, b': 2}\n')
        threading.Thread(target=runner).start()
        started = time.time()
        self.assertEqual(list(overlay.stdin_lines(idle=0.3, fd=read_end)), ['{"a": 1}', '{"b": 2}'])
        self.assertLess(time.time() - started, 2, 'ended by the idle limit with the pipe still open')
        os.close(write_end)
        os.close(read_end)

if __name__ == '__main__':
    unittest.main()
