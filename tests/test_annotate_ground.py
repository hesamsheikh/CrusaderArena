import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import annotate_ground as ground


class GroundTests(unittest.TestCase):
    def record(self, code=55, matches=1):
        return dict(game_tile=[432, 499], ground_sprite_file=code,
                    ground_sprite_image=177, ground_sprite_alternate=0,
                    ground_sprite_matches=matches)

    def test_live_mapping_preserves_location_without_resource_claim(self):
        result = ground.annotate(self.record())
        self.assertEqual(result['sprite_asset'], 'tile_land_macros')
        self.assertEqual(result['game_tile'], [432, 499])
        for code in (14, 56, 60):
            result = ground.annotate(self.record(code))
            for field in ('fertile', 'quarryable', 'walkable'):
                self.assertIsNone(result[field])

    def test_ambiguous_and_unmapped_are_unknown(self):
        for code, matches in [(55, 0), (55, 2), (999, 1)]:
            self.assertIsNone(ground.annotate(self.record(code, matches))['sprite_asset'])
        with self.assertRaises(ValueError):
            ground.annotate(self.record(matches=True))

    def test_reject_incomplete_capture(self):
        with self.assertRaises(ValueError):
            ground.convert(['map_tile: {}'])


if __name__ == '__main__':
    unittest.main()
