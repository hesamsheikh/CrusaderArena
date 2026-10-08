#!/usr/bin/env python3
"""Name ground sprite sheets in a supported diagnostic capture.

Asset names describe renderer artwork, not fertility or mineable resources.
"""
import argparse
import json
from annotate_scenery import validate_capture

# Assembly-CSharp SpriteLoad registrations; indexes belong to these sheets.
SHEETS = {2: 'tile_land8', 5: 'tile_sea8', 12: 'tile_land3',
          14: 'tile_farmland', 55: 'tile_land_macros',
          56: 'tile_rocks8', 60: 'tile_land_and_stones'}


def annotate(record):
    if not isinstance(record, dict):
        raise ValueError('map_tile record must be an object')
    keys = ('ground_sprite_file', 'ground_sprite_image',
            'ground_sprite_alternate', 'ground_sprite_matches')
    if any(type(record.get(key)) is not int for key in keys):
        raise ValueError('ground sprite fields must be integers')
    code, image, alternate, matches = (record[key] for key in keys)
    if matches < 0:
        raise ValueError('ground sprite match count cannot be negative')
    unique = matches == 1 and image >= 0 and alternate in (0, 1)
    asset = SHEETS.get(code) if unique else None
    result = dict(record)
    result.update(sprite_asset=asset,
                  classification_basis='static_sprite_registration' if asset else 'unknown',
                  fertile=None, quarryable=None, walkable=None,
                  coordinate_validity_verified=False)
    return result


def convert(lines):
    lines = validate_capture(lines)
    return {'schema': 1, 'source': 'render_ground_sample',
            'complete_map': False, 'coherence_verified': False,
            'tiles': [annotate(json.loads(line.partition(':')[2]))
                      for line in lines if line.startswith('map_tile:')]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture')
    args = parser.parse_args()
    try:
        with open(args.capture, encoding='utf-8-sig') as source:
            print(json.dumps(convert(source), indent=2))
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
