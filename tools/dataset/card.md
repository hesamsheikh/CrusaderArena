---
pretty_name: Crusader Arena runs
license: other
license_name: TODO
tags:
- benchmark
- agents
- computer-use
- games
- strategy
configs:
- config_name: series
  default: true
  data_files:
  - split: train
    path: "v*/*/*/*/series.parquet"
- config_name: episodes
  data_files:
  - split: train
    path: "v*/*/*/*/episode-*/episode.parquet"
- config_name: timeline
  data_files:
  - split: train
    path: "v*/*/*/*/episode-*/timeline.parquet"
---

# Crusader Arena runs

Runs of [Crusader Arena](https://github.com/hesamsheikh/CrusaderArena), a benchmark in which
AI models play Stronghold Crusader: Definitive Edition through screenshots and mouse and
keyboard tools. Each run keeps the model's full trace, telemetry, a video and the final state
of the settlement.

A model plays a **learning series**: several episodes from the same start, carrying a
playbook of notes from one episode to the next. The last episode's net worth is the series'
score. The [benchmark page](https://github.com/hesamsheikh/CrusaderArena/blob/main/docs/benchmark.md)
describes the task and the scoring.

## Load it

```python
from datasets import load_dataset

series = load_dataset("{{repo}}", "series", split="train")      # one row per learning series
episodes = load_dataset("{{repo}}", "episodes", split="train")  # one row per episode
timeline = load_dataset("{{repo}}", "timeline", split="train")  # one row per game minute of each episode
```

The tables hold the numbers and the final image. Videos, logs and model traces are files
next to them; the `files` and `video` columns give their paths in this repository.

## Layout

```
v1/                                       benchmark version
  oasis-by-the-sea-construction/          benchmark
    z-ai--glm-5.3-flash/                  model ID, "/" written as "--"
      20261008T140646-dfacebd1/           one learning series (run-<time>-<id> for a single run)
        series.parquet                    one row: the series' score
        series.json                       the series as the runner recorded it
        playbook-after-episode-<n>.md     the playbook each episode left
        manifest.json                     every file's size and SHA-256, what was scrubbed
        episode-1/
          episode.parquet                 one row: score, game state, telemetry, final image
          timeline.parquet                one row per game minute: economy and telemetry so far
          final-overview.jpg              the settlement at the end, zoomed out
          video.mp4                       the run, edited: actions at real speed, idle time fast
          run.json                        model, settings, harness version, budget, outcome
          inputs.json                     exactly what the model was given
          episode.json                    the scorecard
          events.jsonl                    every model message, tool call and result, with screenshots
          logs.jsonl                      the readable log
          notifications.jsonl             messages the game showed
          memory.json, notebook.md, playbook.md   the agent's own notes
```

## Comparing runs

Runs are comparable when they share a benchmark version (the top folder). Within a version,
`harness_commit`, `prompt_sha256` and `tools_sha256` say exactly which code and prompt ran;
`run_settings` holds the time budget and the other run settings.

`tier` is `official` for runs made by the maintainers and `community` for submitted runs.
A submitted score comes from the submitter's machine; the video, the screenshots in
`events.jsonl` and the reader samples make it checkable, not verified.

## Columns

Both tables: `dataset_version`, `benchmark`, `map`, `save`, `model_id`, `model_name`,
`endpoint`, `reasoning`, `max_tokens`, `providers`, `allow_fallbacks`, `harness_commit`,
`prompt_sha256`, `tools_sha256`, `game_minutes_budget`, `wall_limit_minutes`, `run_settings`,
`tier`, `submitted_by`, `series_id`, `final_image`, `video`, `files`.

**series**: `episodes`, `episodes_completed`, `net_worth_by_episode`, `valid` (every episode
is a full-budget score), `valid_by_episode`, `score` (the last
episode's net worth), `change` (last minus first), `cost_usd`, `tokens_total`, `game_seconds`,
`wall_seconds`, `turns`, `tool_calls` (totals over the series), `playbook_final`.

**episodes**:

- run: `run_id`, `episode`, `episodes`, `started_at`, `ended_at`, `instruction`, `status`,
  `ended` (what ended it), `end_detail`
- score and game state: `score_source`, `valid` and `invalid` (whether the net worth is a
  full-budget score, and if not why), `net_worth`, `net_worth_baseline` (what doing nothing
  scores on the same save and budget), `net_worth_growth` (net worth minus that baseline),
  `goods_value`, `gold`, `goods`, `population`, `housing`, `popularity`, `total_food`,
  `structures`, `troops`, `game_year`, `game_month`
- time: `game_seconds`, `game_seconds_budget`, `wall_seconds`, `inference_seconds`
- tokens and cost: `tokens_total`, `tokens_input` (uncached), `tokens_cache_read`,
  `tokens_cache_write`, `tokens_output`, `cached_share`, `tokens_per_game_minute`, `cost_usd`
- agent: `turns`, `compactions`, `tool_calls`, `tool_calls_by_name`, `tool_errors`,
  `build_attempts`, `build_placed`, `build_failed`, `build_unverified`, `build_retries`,
  `build_missing`, `anchor_calls`, `anchor_placed`, `anchor_failed`, `anchor_partly_placed`,
  `peak_game_rss_mib`, `playbook`

**timeline**: `dataset_version`, `benchmark`, `model_id`, `series_id`, `run_id`, `episode`,
`game_minute`; the reading used for that minute, `sample_game_seconds` (game seconds into the
budget when it was taken) and `sample_source` (`host_observation`, `tool_result` or
`final_reading`); the game then, `gold`, `net_worth`, `population`, `housing`, `popularity`,
`total_food`, `structures`, `troops`, `game_year`, `game_month`, `goods`; and what the agent had
spent by then, `tokens_total`, `tokens_output`, `cost_usd`, `turns`, `tool_calls`, `tool_errors`.
Row `m` is the latest reading at or before minute `m`; minute 0 is the first reading and the
last row the final one. Readings come from the agent's turns, so a minute without a fresh
reading repeats the one before (its `sample_game_seconds` shows this). Structures and troops
are only in full reader samples (`tool_result`, `final_reading`).

Missing values are null, never zero.

## What was removed

Before upload every text file is scrubbed: the game machine's address and paths, home
directories and host names are replaced with placeholders such as `<home>`; the game's process
and window IDs, the machine-wide memory and graphics details and absolute local paths are
dropped; and a bundle with
any key, user name, home path, IP or email address left in it is refused. The raw recording
frames and the agent's checkpoint are not published.

## License

TODO: choose the license for the logs and tables.

The screenshots, final images and videos show Stronghold Crusader: Definitive Edition,
© Firefly Studios. TODO: state the terms under which this footage is shared.
