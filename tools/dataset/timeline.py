"""The game minute by minute: one row per game minute of an episode, read from its events.jsonl.

Readings come from three places in the log, all taken while the agent played:
- host observations: the screenshot and stats the host sends after a turn, stamped with the
  budget clock (run_clock.game_seconds_used);
- results of tools that read the game (details.readerStats), stamped with the reader's game
  tick, which is turned into budget seconds from the final reading;
- the final reading after the game was paused.

Row m holds the latest reading at or before m game minutes into the budget (row 0 is the first
reading, the last row the final one), with the tokens, cost, turns and tool calls spent up to
that reading. `sample_game_seconds` says when the reading was taken: a minute with no fresh
reading repeats the previous one rather than guessing.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TICKS_PER_SECOND = 30
MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
          'october', 'november', 'december']
WANTED = ('"host_observation"', '"tool_execution_end"', '"tool_execution_start"', '"final_observation"',
          '"message_end"', '"preparation_reply"', '"compaction_usage"', '"reflection_usage"',
          '"request_cost"', '"turn_start"')


def sell_prices(root: Path = ROOT) -> dict[str, int]:
    """The marketplace sell prices from harness/server/market-prices.ts, the one place they live."""
    text = (root / 'harness/server/market-prices.ts').read_text(encoding='utf-8')
    block = re.search(r'export const sellPrice[^{]*\{([^}]*)\}', text)
    if not block:
        raise ValueError('sellPrice not found in market-prices.ts')
    return {name: int(price) for name, price in re.findall(r'(\w+):\s*(\d+)', block.group(1))}


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _goods(record) -> dict[str, int] | None:
    if not isinstance(record, dict):
        return None
    return {str(k): int(v) for k, v in record.items() if _num(v) is not None}


def from_summary(stats: dict) -> dict:
    """The stats summary in a host observation (what the model is shown)."""
    population, popularity, food = (stats.get(k) if isinstance(stats.get(k), dict) else {}
                                    for k in ('population', 'popularity', 'food'))
    month = year = None
    date = re.fullmatch(r'\s*([A-Za-z]+)\s+(\d{3,4})\s*', str(stats.get('date') or ''))
    if date and date[1].lower() in MONTHS:
        month, year = MONTHS.index(date[1].lower()) + 1, int(date[2])
    return {
        'gold': _num(stats.get('gold')),
        'population': _num(population.get('current')),
        'housing': _num(population.get('housing')),
        'popularity': _num(popularity.get('current')),
        'total_food': _num(food.get('total')),
        'structures': None,
        'troops': None,
        'game_year': year,
        'game_month': month,
        'goods': _goods(stats.get('goods')),
    }


def from_reading(observation: dict) -> dict:
    """A full reader sample (tool results and the final reading)."""
    settlement = observation.get('settlement') if isinstance(observation.get('settlement'), dict) else {}
    return {
        'gold': _num(observation.get('gold')),
        'population': _num(observation.get('population')),
        'housing': _num(settlement.get('housing_cap')),
        'popularity': _num(observation.get('popularity')),
        'total_food': _num(settlement.get('total_food')),
        'structures': _num((observation.get('structures') or {}).get('count')),
        'troops': _num((observation.get('own_troops') or {}).get('total')),
        'game_year': _num(settlement.get('year')),
        'game_month': _num(settlement.get('month')),
        'goods': _goods(observation.get('resources_by_name')),
    }


def _text_json(content) -> list[dict]:
    out = []
    for part in content if isinstance(content, list) else []:
        if isinstance(part, dict) and part.get('type') == 'text':
            try:
                value = json.loads(part.get('text') or '')
            except ValueError:
                continue
            if isinstance(value, dict):
                out.append(value)
    return out


def samples(events: Path, used_seconds: float | None) -> list[dict]:
    """Every reading in the log, in order, with the cumulative telemetry at that moment."""
    spent = {'tokens_total': 0, 'tokens_output': 0, 'cost_usd': 0.0, 'turns': 0, 'tool_calls': 0, 'tool_errors': 0}
    saw_cost = False
    pending = []  # (record, tick) for tool readings, placed once the start tick is known
    out = []

    def usage(u):
        if isinstance(u, dict):
            spent['tokens_total'] += _num(u.get('totalTokens')) or 0
            spent['tokens_output'] += _num(u.get('output')) or 0

    def snapshot(seconds, tick, source, values):
        out.append({'seconds': seconds, 'tick': tick, 'source': source, **values, **spent,
                    'cost_usd': spent['cost_usd'] if saw_cost else None})

    final_tick = None
    with open(events, encoding='utf-8') as handle:
        for line in handle:
            if not any(needle in line for needle in WANTED):
                continue
            try:
                event = json.loads(line).get('event') or {}
            except ValueError:
                continue
            kind = event.get('type')
            if kind == 'message_end' and (event.get('message') or {}).get('role') == 'assistant':
                usage((event.get('message') or {}).get('usage'))
            elif kind == 'preparation_reply':
                usage((event.get('reply') or {}).get('usage'))
            elif kind in ('compaction_usage', 'reflection_usage'):
                usage(event.get('usage'))
            elif kind == 'request_cost':
                saw_cost = True
                spent['cost_usd'] += _num(event.get('dollars')) or 0
            elif kind == 'turn_start':
                spent['turns'] += 1
            elif kind == 'tool_execution_start':
                spent['tool_calls'] += 1
            elif kind == 'host_observation':
                for value in _text_json((event.get('message') or {}).get('content')):
                    clock, stats = value.get('run_clock'), value.get('stats')
                    seconds = _num((clock or {}).get('game_seconds_used'))
                    if seconds is not None and isinstance(stats, dict) and stats.get('status') == 'ok':
                        snapshot(seconds, None, 'host_observation', from_summary(stats))
                        break
            elif kind == 'tool_execution_end':
                if event.get('isError') is True:
                    spent['tool_errors'] += 1
                result = event.get('result') or {}
                reading = (result.get('details') or {}).get('readerStats') or {}
                if reading.get('status') == 'ok' and isinstance(reading.get('observation'), dict):
                    clocks = [_num((v.get('run_clock') or {}).get('game_seconds_used')) for v in _text_json(result.get('content'))]
                    seconds = next((c for c in clocks if c is not None), None)
                    tick = _num(reading['observation'].get('game_time'))
                    snapshot(seconds, tick, 'tool_result', from_reading(reading['observation']))
                    if seconds is None:
                        pending.append(out[-1])
            elif kind == 'final_observation':
                reading = event.get('stats') or {}
                if reading.get('status') == 'ok' and isinstance(reading.get('observation'), dict):
                    final_tick = _num(reading['observation'].get('game_time'))
                    snapshot(used_seconds, final_tick, 'final_reading', from_reading(reading['observation']))

    # Tool readings carry a game tick, not the budget clock: the final reading anchors the two.
    if final_tick is not None and used_seconds is not None:
        start_tick = final_tick - used_seconds * TICKS_PER_SECOND
        for sample in pending:
            if sample['tick'] is not None:
                sample['seconds'] = round((sample['tick'] - start_tick) / TICKS_PER_SECOND, 2)
    return [s for s in out if s['seconds'] is not None]


def rows(events: Path, budget_seconds: float | None, used_seconds: float | None,
         prices: dict[str, int], base: dict) -> list[dict]:
    """One row per game minute of the budget."""
    found = sorted(samples(events, used_seconds), key=lambda s: s['seconds'])
    if not found:
        return []
    end = max(budget_seconds or 0, found[-1]['seconds'])
    minutes = max(1, math.ceil(end / 60 - 1e-9))
    out = []
    for minute in range(minutes + 1):
        if minute == 0:
            sample = found[0]
        elif minute == minutes:
            sample = found[-1]
        else:
            before = [s for s in found if s['seconds'] <= minute * 60 + 0.5]
            if not before:
                continue
            sample = before[-1]
        goods = sample['goods']
        worth = None
        if goods is not None and sample['gold'] is not None:
            worth = int(sample['gold'] + sum(count * prices.get(name, 0) for name, count in goods.items()))
        out.append({
            **base,
            'game_minute': minute,
            'sample_game_seconds': float(sample['seconds']),
            'sample_source': sample['source'],
            'gold': sample['gold'],
            'net_worth': worth,
            'population': sample['population'],
            'housing': sample['housing'],
            'popularity': sample['popularity'],
            'total_food': sample['total_food'],
            'structures': sample['structures'],
            'troops': sample['troops'],
            'game_year': sample['game_year'],
            'game_month': sample['game_month'],
            'goods': None if goods is None else [{'name': k, 'count': v} for k, v in sorted(goods.items())],
            'tokens_total': sample['tokens_total'],
            'tokens_output': sample['tokens_output'],
            'cost_usd': sample['cost_usd'],
            'turns': sample['turns'],
            'tool_calls': sample['tool_calls'],
            'tool_errors': sample['tool_errors'],
        })
    return out
