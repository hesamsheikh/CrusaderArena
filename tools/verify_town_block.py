#!/usr/bin/env python3
"""Compare an observed 5x5 tile block with native coarse resource counters.

Models only the non-organism branch at native RVA0x50904..0x50aa7.
It does not establish placement validity or available resource quantities.
"""
import argparse
import json

ENGINE = 'fbcb93195fc7efca9bdac5204852efdd76f9818f59a6711750d77c9cef2831e2'
FIELDS = ('town_stone_value', 'town_oasis', 'town_farm', 'town_iron')


def contribution(logic, logic2):
    if type(logic) is not int or type(logic2) is not int:
        raise ValueError('logic fields must be integers')
    if not -(2**31) <= logic < 2**31 or not -128 <= logic2 <= 127:
        raise ValueError('logic fields outside native types')
    # Common skip mask precedes the organism test in the actual producer.
    if logic & 0x300031:
        return dict.fromkeys(FIELDS, 0)
    if logic & 0x1000:
        raise ValueError('organism branch requires additional state; not modeled')
    return dict(zip(FIELDS, (int(bool(logic & 0x20000)),
                            int(bool(logic2 & 0x91)),
                            int(bool(logic2 & 0x90)),
                            int(not (logic & 0x20000) and bool(logic & 0x80000)))))


def verify(lines):
    lines = list(lines)
    if ENGINE + ' MATCH' not in [s.strip() for s in lines]:
        raise ValueError('unsupported engine fingerprint')
    if any(s.startswith('Probe failed:') for s in lines) or not any(
            s.startswith('Native block diagnostic finished.') for s in lines):
        raise ValueError('failed or incomplete block capture')
    records = [json.loads(s.partition(':')[2]) for s in lines if s.startswith('native_tile:')]
    if len(records) != 25:
        raise ValueError('expected exactly 25 tiles')
    points = [tuple(r['game_tile']) for r in records]
    x, y = min(p[0] for p in points), min(p[1] for p in points)
    if x % 5 or y % 5 or set(points) != {(a,b) for a in range(x,x+5) for b in range(y,y+5)}:
        raise ValueError('coordinates do not form one aligned 5x5 block')
    totals = dict.fromkeys(FIELDS, 0)
    expected = {key: records[0][key] for key in FIELDS}
    for r in records:
        if any(r[k] != expected[k] for k in FIELDS):
            raise ValueError('coarse counters changed within block')
        values = contribution(r['logic_layer'], r['logic2_layer'])
        for k in FIELDS:
            totals[k] += values[k]
    return {'tile_origin': [x,y], 'predicted_counts': totals,
            'observed_counts': expected, 'matches': totals == expected,
            'placement_validity_verified': False, 'coherence_verified': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture')
    args = parser.parse_args()
    try:
        with open(args.capture, encoding='utf-8-sig') as source:
            result = verify(source)
        print(json.dumps(result, indent=2))
        if not result['matches']:
            parser.exit(1, 'counter mismatch\n')
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f'{error}\n')
