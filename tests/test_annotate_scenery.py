import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('annotate', Path(__file__).resolve().parents[1] / 'tools/annotate_scenery.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SceneryTests(unittest.TestCase):
    def test_captured_tree_and_cactus(self):
        for code, expected in [(31, 'tree_chestnut'), (200, 'cactus')]:
            original = {'id': 727, 'render_map': [222, 77], 'sprite_file': code}
            result = module.annotate(original)
            self.assertEqual(result['visual_family'], expected)
            self.assertEqual(result['render_map'], original['render_map'])
            self.assertIsNone(result['harvestable'])
            self.assertNotIn('visual_family', original)

    def test_ground_and_unknown_are_not_resource_claims(self):
        for code in [14, 56, 60, -1, 9999]:
            self.assertEqual(module.annotate({'sprite_file': code})['visual_family'], 'unknown')

    def test_reject_wrong_build_partial_or_error_capture(self):
        valid = [module.ASSEMBLY_SHA256 + ' MATCH', 'scenery: {"sprite_file":31}', 'Inspection finished.']
        self.assertEqual(len(module.convert(valid)), 1)
        for lines in [valid[1:], valid[:-1], valid + ['error: sample changed']]:
            with self.assertRaises(ValueError):
                module.convert(lines)
        for code in [True, '31', None]:
            with self.assertRaises(ValueError):
                module.annotate({'sprite_file': code})


if __name__ == '__main__':
    unittest.main()
