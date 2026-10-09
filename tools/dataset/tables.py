"""The dataset's tables: one row per learning series, one per episode, and one per game minute
of each episode (timeline.py).

Each bundle writes its own small Parquet files (episode.parquet, series.parquet). The dataset
card collects them into tables by path, so every file of a table must have the same columns
and types: the schema is fixed here. Counts keyed by name (goods, tools) are lists of
{name, count}. The final image is stored inside the table so the Hub's viewer can show it.
"""
from __future__ import annotations

from pathlib import Path

try:
    from datasets import Dataset, Features, Image, Value, disable_progress_bars
except ImportError as error:  # pragma: no cover - a message for a missing dependency
    raise SystemExit('Packaging needs the Hugging Face datasets library: pip install datasets') from error

disable_progress_bars()

COUNTS = [{'name': Value('string'), 'count': Value('int64')}]

# Columns both tables share: what was run, with which code and settings, and who sent it.
IDENTITY = {
    'dataset_version': Value('string'),
    'benchmark_fingerprint': Value('string'),
    'guide': Value('string'),
    'benchmark': Value('string'),
    'map': Value('string'),
    'save': Value('string'),
    'model_id': Value('string'),
    'model_name': Value('string'),
    'endpoint': Value('string'),
    'reasoning': Value('string'),
    'max_tokens': Value('int64'),
    'providers': [Value('string')],
    'allow_fallbacks': Value('bool'),
    'harness_commit': Value('string'),
    'prompt_sha256': Value('string'),
    'tools_sha256': Value('string'),
    'game_minutes_budget': Value('float64'),
    'wall_limit_minutes': Value('float64'),
    'run_settings': Value('string'),
    'tier': Value('string'),
    'submitted_by': Value('string'),
    'series_id': Value('string'),
}

EPISODE = Features({
    **IDENTITY,
    'run_id': Value('string'),
    'episode': Value('int64'),
    'attempt': Value('int64'),
    'outcome': Value('string'),
    'episodes': Value('int64'),
    'started_at': Value('string'),
    'ended_at': Value('string'),
    'instruction': Value('string'),
    'status': Value('string'),
    'ended': Value('string'),
    'end_detail': Value('string'),
    'score_source': Value('string'),
    'valid': Value('bool'),
    'invalid': [Value('string')],
    'net_worth': Value('int64'),
    'net_worth_baseline': Value('int64'),
    'net_worth_growth': Value('int64'),
    'goods_value': Value('int64'),
    'gold': Value('int64'),
    'goods': COUNTS,
    'population': Value('int64'),
    'housing': Value('int64'),
    'popularity': Value('int64'),
    'total_food': Value('int64'),
    'structures': Value('int64'),
    'troops': Value('int64'),
    'game_year': Value('int64'),
    'game_month': Value('int64'),
    'game_seconds': Value('float64'),
    'game_seconds_budget': Value('float64'),
    'wall_seconds': Value('float64'),
    'inference_seconds': Value('float64'),
    'turns': Value('int64'),
    'compactions': Value('int64'),
    'tokens_total': Value('int64'),
    'tokens_input': Value('int64'),
    'tokens_cache_read': Value('int64'),
    'tokens_cache_write': Value('int64'),
    'tokens_output': Value('int64'),
    'cached_share': Value('float64'),
    'tokens_per_game_minute': Value('float64'),
    'cost_usd': Value('float64'),
    'cost_source': Value('string'),
    'tool_calls': Value('int64'),
    'tool_calls_by_name': COUNTS,
    'tool_errors': Value('int64'),
    'build_attempts': Value('int64'),
    'build_placed': Value('int64'),
    'build_failed': Value('int64'),
    'build_unverified': Value('int64'),
    'build_retries': Value('int64'),
    'build_missing': Value('int64'),
    'anchor_calls': Value('int64'),
    'anchor_placed': Value('int64'),
    'anchor_failed': Value('int64'),
    'anchor_partly_placed': Value('int64'),
    'peak_game_rss_mib': Value('int64'),
    'playbook': Value('string'),
    'final_image': Image(),
    'video': Value('string'),
    'files': Value('string'),
})

SERIES = Features({
    **IDENTITY,
    'episodes': Value('int64'),
    'episodes_completed': Value('int64'),
    'net_worth_by_episode': [Value('int64')],
    'valid': Value('bool'),
    'valid_by_episode': [Value('bool')],
    'score': Value('int64'),
    'change': Value('int64'),
    'cost_usd': Value('float64'),
    'tokens_total': Value('int64'),
    'game_seconds': Value('float64'),
    'wall_seconds': Value('float64'),
    'turns': Value('int64'),
    'tool_calls': Value('int64'),
    'playbook_final': Value('string'),
    'final_image': Image(),
    'video': Value('string'),
    'files': Value('string'),
})


TIMELINE = Features({
    'dataset_version': Value('string'),
    'benchmark': Value('string'),
    'model_id': Value('string'),
    'series_id': Value('string'),
    'run_id': Value('string'),
    'episode': Value('int64'),
    'game_minute': Value('int64'),
    'sample_game_seconds': Value('float64'),
    'sample_source': Value('string'),
    'gold': Value('int64'),
    'net_worth': Value('int64'),
    'population': Value('int64'),
    'housing': Value('int64'),
    'popularity': Value('int64'),
    'total_food': Value('int64'),
    'structures': Value('int64'),
    'troops': Value('int64'),
    'game_year': Value('int64'),
    'game_month': Value('int64'),
    'goods': COUNTS,
    'tokens_total': Value('int64'),
    'tokens_output': Value('int64'),
    'cost_usd': Value('float64'),
    'turns': Value('int64'),
    'tool_calls': Value('int64'),
    'tool_errors': Value('int64'),
})


def write(rows: list[dict], features: Features, path: Path):
    """Write rows as Parquet with the table's schema; a missing or unknown column is a bug."""
    for row in rows:
        missing, extra = set(features) - set(row), set(row) - set(features)
        if missing or extra:
            raise ValueError(f'{path.name}: missing columns {sorted(missing)}, unknown columns {sorted(extra)}')
    Dataset.from_list(rows, features=features).to_parquet(str(path))
