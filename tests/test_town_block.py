import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import verify_town_block as town


class TownBlockTests(unittest.TestCase):
    def test_precedence_and_exclusions(self):
        self.assertEqual(town.contribution(0xA0000, 0)['town_iron'], 0)
        self.assertEqual(town.contribution(0xA0000, 0)['town_stone_value'], 1)
        self.assertFalse(any(town.contribution(0x20001, -128).values()))
        with self.assertRaises(ValueError):
            town.contribution(0x1000, -128)
        self.assertEqual(town.contribution(0, 1)['town_oasis'], 1)
        self.assertEqual(town.contribution(0, 1)['town_farm'], 0)
        self.assertEqual(town.contribution(0, -128)['town_farm'], 1)

    def test_capture_coverage_and_counter_mismatch(self):
        records=[]
        for x in range(295,300):
            for y in range(365,370):
                records.append(dict(game_tile=[x,y],logic_layer=0x20000,logic2_layer=0,
                                    town_stone_value=25,town_oasis=0,town_farm=0,town_iron=0))
        def capture(rs):
            return [town.ENGINE+' MATCH']+['native_tile: '+json.dumps(r) for r in rs]+['Native block diagnostic finished.']
        self.assertTrue(town.verify(capture(records))['matches'])
        with self.assertRaises(ValueError):
            town.verify(capture(records[:-1]+[records[0]]))
        records[0]['logic_layer']=0
        self.assertFalse(town.verify(capture(records))['matches'])
        with self.assertRaises(ValueError):
            town.verify(capture(records)[:-1])


if __name__=='__main__':
    unittest.main()
