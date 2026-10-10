import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('observation_stream', Path(__file__).parents[1] / 'tools/ubuntu/observation_stream.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.stream = module.ObservationStream('test')
        self.record = {'status': 'ok', 'sequence': 0, 'capture_started_unix_ms': 1000,
                       'captured_unix_ms': 1010, 'observation': {
                           'map_token': 'a', 'map_name': 'map', 'local_player_id': 1,
                           'game_time': 10, 'paused': True,
                           'visible_messages': [{'channel': 'Message_Bar', 'text': 'Attack!'}]}}

    def test_paused_fresh_samples_do_not_repeat_messages(self):
        first = self.stream.consume(self.record, 1020)
        second = self.stream.consume(self.record, 1030)
        self.assertEqual(len(first['events']), 1)
        self.assertEqual(second['events'], [])
        self.assertEqual(second['generation'], 1)
        self.assertFalse(second['lifecycle_reset'])
        self.assertNotIn('map_token', second['observation'])

    def test_stale_or_slow_capture_never_reuses_observation(self):
        self.stream.consume(self.record, 1020)
        stale = self.stream.consume(self.record, 3000)
        self.assertEqual(stale['status'], 'stale')
        self.assertIsNone(stale['observation'])
        self.assertNotIn('valid_until_unix_ms', stale)
        self.record['capture_started_unix_ms'] = 0
        self.assertEqual(self.stream.consume(self.record, 1020)['status'], 'stale')

    def test_gap_map_player_or_time_reset_starts_generation(self):
        self.stream.consume(self.record, 1020)
        self.stream.consume({'status': 'unavailable'}, 1030)
        self.assertEqual(self.stream.consume(self.record, 1040)['generation'], 2)
        for field, value in [('map_token', 'b'), ('local_player_id', 2), ('game_time', 0)]:
            self.record['observation'][field] = value
            result = self.stream.consume(self.record, 1050)
            self.assertTrue(result['lifecycle_reset'])
            self.assertEqual(len(result['events']), 1)

    def test_message_reappearing_is_a_new_observation(self):
        self.stream.consume(self.record, 1020)
        cleared = copy.deepcopy(self.record)
        cleared['observation']['visible_messages'] = []
        self.stream.consume(cleared, 1030)
        self.record['sequence'] = 2
        result = self.stream.consume(self.record, 1040)
        self.assertEqual(len(result['events']), 1)
        self.assertIn(':2:', result['events'][0]['id'])

    def test_placement_and_camera_context_pass_through(self):
        context = {'structures': {'count': 12, 'limit': 2000},
                   'managed_heap': {'heap_bytes': 300000000, 'used_bytes': 120000000, 'collections': 40,
                                    'gc_disabled': False, 'watchdog': {'forced': 0, 'last': None}},
                   'placement': {'action': 5, 'sub_action': 32},
                   'camera': {'centre_tile_x': 200, 'centre_tile_y': 180, 'tiles_wide': 30,
                              'tiles_high': 60, 'pixels_per_unit_scale': 1.0}}
        self.record['observation'].update(copy.deepcopy(context))
        observation = self.stream.consume(self.record, 1020)['observation']
        for key, value in context.items():
            self.assertEqual(observation[key], value)
        self.record['observation'].update(placement=None, camera=None)
        observation = self.stream.consume(self.record, 1030)['observation']
        self.assertIsNone(observation['placement'])
        self.assertIsNone(observation['camera'])

    def test_storage_names_goods_and_leaves_empty_piles_without_one(self):
        self.record['observation']['storage'] = {
            'piles': [[430, 359, 2, 48, 48], [430, 362, 4, 0, 0], [433, 362, 99, 3, 48]],
            'granaries': [[430, 355, 28, 250]], 'truncated': False}
        storage = self.stream.consume(self.record, 1020)['observation']['storage']
        self.assertEqual(storage['piles'], [
            {'tile': [430, 359], 'good': 'wood_planks', 'amount': 48, 'capacity': 48},
            {'tile': [430, 362], 'good': None, 'amount': 0, 'capacity': 0},
            {'tile': [433, 362], 'good': 'good_99', 'amount': 3, 'capacity': 48}])
        self.assertEqual(storage['granaries'], [{'tile': [430, 355], 'amount': 28, 'capacity': 250}])
        self.record['observation']['storage'] = None
        self.assertIsNone(self.stream.consume(self.record, 1030)['observation']['storage'])

    def test_exit_invalidates_data(self):
        self.stream.consume(self.record, 1020)
        result = self.stream.consume({'status': 'game_exited'}, 1030)
        self.assertIsNone(result['observation'])
        self.assertEqual(result['events'], [])

    def test_validated_inventory_excludes_internal_slots(self):
        # Paused live inventory after controlled food/weapon purchases.
        self.record['observation']['resources'] = [
            0, 0, 338, 5, 62, 0, 0, 0, 0, 10, 160, 10, 5, 5, 10,
            15966, 51, 5, 5, 5, 5, 5, 5, 5, 5]
        observation = self.stream.consume(self.record, 1020)['observation']
        inventory = observation['resources_by_name']
        self.assertEqual(inventory['wood_planks'], 338)
        self.assertEqual(inventory['cheese'], 10)
        self.assertEqual(inventory['bread'], 160)
        self.assertEqual(inventory['flour'], 51)
        self.assertEqual(inventory['metal_armour'], 5)
        self.assertEqual(len(inventory), 20)
        self.assertNotIn('gold', inventory)
        self.assertNotIn('cowhides', inventory)
        self.assertNotIn('refined_pitch', inventory)

    def test_overlapping_channels_and_dismissal_preserve_each_message(self):
        self.record['observation']['visible_messages'].append(
            {'channel': 'Panel_Feedback', 'text': 'Iron mine must be built on Iron ore.'})
        first = self.stream.consume(self.record, 1020)
        self.assertEqual(len(first['events']), 2)
        self.record['sequence'] = 1
        self.record['observation']['visible_messages'].pop(0)
        self.assertEqual(self.stream.consume(self.record, 1030)['events'], [])
        self.record['sequence'] = 2
        self.record['observation']['visible_messages'].append(
            {'channel': 'Message_Bar', 'text': 'Attack!'})
        events = self.stream.consume(self.record, 1040)['events']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['channel'], 'Message_Bar')


if __name__ == '__main__':
    unittest.main()
