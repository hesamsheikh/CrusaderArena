import importlib.util
from pathlib import Path
import unittest

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

    def test_missing_figures_and_overrun_clocks_are_shown_safely(self):
        p = overlay.panel(dict(LIVE, stats={}, tool_calls=None, cost=None, clock=dict(used=2100, total=2000)), 1001.0)
        self.assertEqual(p['fraction'], 1)
        self.assertEqual(p['left'], '0:00 left')
        self.assertTrue(p['figures'].startswith('Net worth –'))
        self.assertNotIn('$', p['figures'])
        self.assertEqual(overlay.clock_text(-3), '0:00')

if __name__ == '__main__':
    unittest.main()
