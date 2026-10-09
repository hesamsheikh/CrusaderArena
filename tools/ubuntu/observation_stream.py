"""Fail-closed stream state; never carry observations across gaps or map changes."""
import uuid

# Independently matched to nonzero in-game inventory values on 2026-09-22.
# Exclude internal/unused slots (0, 1, 5, 8); gold has its own top-level field.
RESOURCE_FIELDS = {2: 'wood_planks', 3: 'hops', 4: 'stone', 6: 'iron', 7: 'pitch',
                   9: 'wheat', 10: 'bread', 11: 'cheese', 12: 'meat', 13: 'apples',
                   14: 'ale', 16: 'flour', 17: 'bows', 18: 'crossbows', 19: 'spears',
                   20: 'pikes', 21: 'maces', 22: 'swords', 23: 'leather_armour',
                   24: 'metal_armour'}

TROOP_TYPES = ['archer', 'spearman', 'maceman', 'xbowman', 'pikeman', 'swordsman', 'knight', 'engineer', 'monk', 'ladderman', 'mantlet', 'ram', 'tower', 'catapult', 'trebuchet', 'mangonel', 'balista', 'tunneler', 'arab_bow', 'arab_slave', 'arab_slinger', 'arab_assasin', 'arab_horseman', 'arab_swordsman', 'arab_grenadier', 'arab_ballista', 'bedouin_camel_lancer', 'bedouin_healer', 'bedouin_eunuch', 'bedouin_ambusher', 'bedouin_skirmisher', 'bedouin_heavy_camel', 'bedouin_sapper', 'bedouin_demolisher']


class ObservationStream:
    def __init__(self, session=None):
        self.session = session or uuid.uuid4().hex
        self.generation = 0
        self.identity = None
        self.last_tick = None
        self.messages = set()
        self.valid = False

    def consume(self, record, now_ms):
        observation = record.get('observation')
        captured = record.get('captured_unix_ms', 0)
        started = record.get('capture_started_unix_ms', 0)
        status = record.get('status', 'unavailable')
        if status == 'ok' and (not isinstance(observation, dict) or
                               not 0 <= now_ms - captured <= 1500 or
                               not 0 <= captured - started <= 1000):
            status = 'stale'
        result = dict(record, status=status, session=self.session,
                      generation=self.generation, received_unix_ms=now_ms,
                      observation=None, events=[])
        if status != 'ok':
            self.valid = False
            self.messages.clear()
            return result
        identity = (observation['map_token'], observation['map_name'], observation['local_player_id'])
        tick = observation['game_time']
        reset = not self.valid or identity != self.identity or tick < self.last_tick
        if reset:
            self.generation += 1
            self.messages.clear()
        # Map pointers are internal lifecycle hints, not stable public identities.
        observation = dict(observation)
        observation.pop('map_token')
        observation['message_coverage'] = 'visible_ui_only; polling_may_miss_transient_or_repeated_messages'
        if 'resources' in observation:
            observation['wood_planks'] = observation['resources'][2]
            observation['resources_by_name'] = {
                name: observation['resources'][index] for index, name in RESOURCE_FIELDS.items()}
        # Stockpile piles [x, y, good, amount, capacity] and granaries [x, y, amount, capacity]; an
        # empty pile keeps its last good, so it is reported without one.
        if isinstance(observation.get('storage'), dict):
            storage = observation['storage']
            observation['storage'] = {
                'piles': [{'tile': [x, y], 'good': RESOURCE_FIELDS.get(good, f'good_{good}') if amount else None,
                           'amount': amount, 'capacity': capacity}
                          for x, y, good, amount, capacity in storage['piles']],
                'granaries': [{'tile': [x, y], 'amount': amount, 'capacity': capacity}
                              for x, y, amount, capacity in storage['granaries']],
                'truncated': storage['truncated']}
        # 'structures', 'placement', 'camera' and 'managed_heap' pass through
        # unchanged; the last three are null when unavailable.
        if 'own_troops' in observation:
            troops = dict(observation['own_troops'])
            troops['by_type'] = dict(zip(TROOP_TYPES, troops.pop('by_type_1_to_34'), strict=True))
            observation['own_troops'] = troops
        current = {(m['channel'], m['text']) for m in observation['visible_messages']}
        events = [{'kind': 'visible_message_observed', 'channel': channel, 'text': text,
                   'id': f'{self.session}:{self.generation}:{record["sequence"]}:{index}'}
                  for index, (channel, text) in enumerate(sorted(current - self.messages))]
        self.valid = True
        self.identity, self.last_tick, self.messages = identity, tick, current
        result.update(generation=self.generation, lifecycle_reset=reset,
                      observation=observation, events=events,
                      valid_until_unix_ms=captured + 1500)
        return result
