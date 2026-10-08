#!/usr/bin/env python3
"""Annotate captured scenery JSON lines, without attaching to the game.

Mappings apply only to the analyzed Assembly-CSharp build. These identify
sprite families, not harvestability, current tree health or placement rules.
"""
import argparse
import json
import sys

ASSEMBLY_SHA256 = 'bc8b6a395f01d48557db413600c8dd8d1fdfd3abdf97bfbbb68a3c56b04fd789'
# Cross-checked against GM constants and SpriteLoad.addGMFile registrations.
SPRITES = {
    29: ('tree_birch', 'tree_birch'),
    30: ('tree_pine', 'tree_pine'),
    31: ('tree_chestnut', 'Tree_Chestnut'),
    70: ('tree_oak', 'Tree_Oak'),
    71: ('shrub_1', 'tree_shrub1'),
    72: ('shrub_2', 'tree_shrub2'),
    97: ('tree_apple', 'tree_apple'),
    200: ('cactus', 'tree_cactii'),
}


def annotate(record):
    if not isinstance(record, dict):
        raise ValueError('scenery record must be an object')
    code = record.get('sprite_file')
    if type(code) is not int:
        raise ValueError('sprite_file must be an integer')
    result = dict(record)
    match = SPRITES.get(code)
    result['visual_family'] = match[0] if match else 'unknown'
    result['sprite_asset'] = match[1] if match else None
    result['classification_basis'] = 'static_sprite_registration' if match else 'unmapped'
    result['harvestable'] = None
    return result


def validate_capture(lines):
    # Require a verified build in the captured launcher report before applying
    # version-specific names. Reject failed/partial captures as a whole.
    lines = list(lines)
    if not any(line.strip() == ASSEMBLY_SHA256 + ' MATCH' for line in lines):
        raise ValueError('capture does not contain the supported assembly fingerprint')
    if any(line.startswith('error:') for line in lines):
        raise ValueError('capture contains an adapter error')
    if not any(line.startswith('Inspection finished.') for line in lines):
        raise ValueError('capture is incomplete')
    return lines


def convert(lines):
    lines = validate_capture(lines)
    return [annotate(json.loads(line.partition(':')[2]))
            for line in lines if line.startswith('scenery:')]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', help='launcher sample-result.txt; use - for stdin')
    args = parser.parse_args()
    try:
        if args.capture == '-':
            records = convert(sys.stdin)
        else:
            with open(args.capture, encoding='utf-8-sig') as source:
                records = convert(source)
        print(json.dumps({'schema': 1, 'source': 'render_scenery_sample',
                          'complete_map': False, 'coherence_verified': False,
                          'scenery': records}, indent=2))
    except (OSError, ValueError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
