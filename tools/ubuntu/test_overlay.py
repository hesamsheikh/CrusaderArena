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

if __name__ == '__main__':
    unittest.main()
