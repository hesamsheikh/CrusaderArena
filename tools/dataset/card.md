---
pretty_name: Crusader Arena runs
license: other
license_name: cc-by-4.0-except-game-footage
language:
- en
size_categories:
- n<1K
tags:
- benchmark
- agents
- computer-use
- games
- strategy
- video
- agent-trajectories
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

> **Research use only.** Crusader Arena studies AI agents in single-player games. It is an
> independent project, not affiliated with or endorsed by Firefly Studios. See
> [Responsible use](#responsible-use) and [License](#license).

## The benchmark

The [benchmark page](https://github.com/hesamsheikh/CrusaderArena/blob/main/docs/benchmark.md)
describes the task and the scoring in full; this is the short version for benchmark version
`1.0.0`.

- **Task.** In the scenario *Oasis by the Sea construction* the model starts a Free Build game
  on the map Oasis by the Sea from a fixed save and grows the economy. Soldiers and defences
  are not allowed.
- **Score: net worth** when the run ends: gold plus every stored good at the game's marketplace
  sell price. Buildings count only through what they produce.
- **Time.** Each episode gets 25 game minutes at a fixed game speed of 40, counted in game
  ticks. The game is paused while the model thinks, so a slow model loses no game time; a
  real-time limit of 6 hours only stops runs that have gone badly wrong.
- **Learning series.** A model plays three episodes in a row from the same start. One thing
  carries over: a playbook of notes of up to 8 KB that the agent writes during play and
  rewrites after each episode, once it has seen its result. The **last episode's net worth is
  the series' score**; the change from episode 1 shows how much it learned.
- **Baseline.** Doing nothing scores 1,304 on this save and budget: the starting package of
  1,000 gold, 50 wood, 25 stone and 50 bread arrives, the game places the granary by itself,
  and the peasants eat some of the bread. `net_worth_growth` is net worth minus this baseline.
- **The agent** sees screenshots of the game window and numbers read from the running game
  (gold, goods, population, popularity, on-screen messages), and acts through tools to look,
  click, build, move the camera, trade, wait, and keep a plan and notes (see the
  [tool reference](https://github.com/hesamsheikh/CrusaderArena/blob/main/docs/tools.md)). Each turn that runs
  the game lasts at least 8 game seconds. Long conversations are compacted into a handoff the
  model writes itself.
- **Versions.** Benchmark versions are `MAJOR.MINOR.PATCH`: a major version changes the task or
  scoring, a minor version what the model is told or can do, a patch fixes the harness. Runs
  compare within one minor version, across its patches; the accepted file fingerprints are in
  [`benchmark-versions.json`](https://github.com/hesamsheikh/CrusaderArena/blob/main/benchmark-versions.json).

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
v1.0/                                     benchmark version, major.minor
  oasis-by-the-sea-construction/          benchmark
    z-ai--glm-5.3-flash/                  model ID, "/" written as "--"
      <series id>/                        one learning series (run-<time>-<id> for a single run)
        series.parquet                    one row: the series' score
        series.json                       the series as the runner recorded it
        playbook-after-episode-<n>.md     the playbook each episode left
        manifest.json                     every file's size and SHA-256, what was scrubbed
        episode-1/
          episode.parquet                 one row: score, game state, telemetry, final image
          timeline.parquet                one row per game minute: economy and telemetry so far
          final-overview.jpg              the settlement at the end, zoomed out
          video.mp4                       the run, edited, 720p: actions at real speed, idle time fast
          run.json                        model, settings, harness version, budget, outcome
          inputs.json                     exactly what the model was given
          episode.json                    the scorecard
          events.jsonl                    every model message, tool call and result
          images/                         the screenshots and reference images events.jsonl points to
          logs.jsonl                      the readable log
          notifications.jsonl             messages the game showed
          memory.json, notebook.md, playbook.md   the agent's own notes
```

## Comparing runs

Runs are comparable within one minor version, which is the top folder (`v1.0/`); patches are
harness fixes and stay comparable. `dataset_version` holds the exact version (`1.0.0`),
`benchmark_fingerprint` identifies the exact files a run used (a version can accept more than
one when files change without changing behaviour) and `guide` whether the preparation guide had
images. `harness_commit`, `prompt_sha256` and `tools_sha256` say which
code and prompt ran; `run_settings` holds the time budget and the other run settings.

An episode that was stopped or failed for reasons outside the model is run again; the table
holds the attempt the series kept (`attempt`, `outcome`: `valid` or `model_failure`).

`tier` is `official` for runs made by the maintainers and `community` for submitted runs.
A submitted score comes from the submitter's machine; the video, the screenshots in
`images/` and the reader samples make it checkable, not verified.

## Columns

Both tables: `dataset_version`, `benchmark_fingerprint`, `guide`, `benchmark`, `map`, `save`,
`model_id`, `model_name`, `endpoint`, `reasoning`, `max_tokens`, `providers`, `allow_fallbacks`,
`harness_commit`,
`prompt_sha256`, `tools_sha256`, `game_minutes_budget`, `wall_limit_minutes`, `run_settings`,
`tier`, `submitted_by`, `series_id`, `final_image`, `video`, `files`.

**series**: `episodes`, `episodes_completed`, `net_worth_by_episode`, `valid` (every episode
is a full-budget score), `valid_by_episode`, `score` (the last
episode's net worth), `change` (last minus first), `cost_usd`, `tokens_total`, `game_seconds`,
`wall_seconds`, `turns`, `tool_calls` (totals over the series), `playbook_final`.

**episodes**:

- run: `run_id`, `episode`, `attempt`, `outcome`, `episodes`, `started_at`, `ended_at`,
  `instruction`, `status`, `ended` (what ended it), `end_detail`
- score and game state: `score_source`, `valid` and `invalid` (whether the net worth is a
  full-budget score, and if not why), `net_worth`, `net_worth_baseline` (what doing nothing
  scores on the same save and budget), `net_worth_growth` (net worth minus that baseline),
  `goods_value`, `gold`, `goods`, `population`, `housing`, `popularity`, `total_food`,
  `structures`, `troops`, `game_year`, `game_month`
- time: `game_seconds`, `game_seconds_budget`, `wall_seconds`, `inference_seconds`
- tokens and cost: `tokens_total`, `tokens_input` (uncached), `tokens_cache_read`,
  `tokens_cache_write`, `tokens_output`, `cached_share`, `tokens_per_game_minute`, `cost_usd`,
  `cost_source` (`billed`: what OpenRouter billed; `prices`: the episode's tokens at the
  model's list prices, for providers that do not report a cost)
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

## What is in the files

The logs keep everything the model was given and did: its messages and reasoning text, every
tool call and result, and the screenshots it saw. Images are files in the episode's `images/`
folder, and `events.jsonl` holds their paths: an image block reads
`{"type": "image", "mimeType": "image/webp", "path": "images/<hash>.webp"}`. They are the
model's images at full size, compressed to WebP at quality 70 (kept as they were when that is
no smaller), and each is stored once although the log may refer to it several times. In runs
made with the image guide (`guide` is not null), the preparation message also holds two
reference images: a guide to the game's construction menus, made from game screenshots, and a
screenshot of a developed settlement from an earlier human game on another map. The token
deltas of streaming replies are left out; each reply's `message_end` holds all of it.
Screenshots and videos show only the game window.

Before upload every text file is scrubbed: the game machine's address and paths, home
directories and host names are replaced with placeholders such as `<home>`; the game's process
and window IDs, the machine-wide memory and graphics details and absolute local paths are
dropped; and a bundle with any key, user name, home path, IP or email address left in it is
refused. The raw recording frames and the agent's checkpoint are not published.

## Limitations

- **One setup.** All runs so far come from one Ubuntu laptop running the game (Steam build
  24816905) through Proton, driven by a Mac running the harness. Other machines and game builds
  are untested.
- **Few runs.** Neither the game's nor the model's randomness is fixed, so a single series
  mixes skill, learning and chance. Compare several series per model before drawing
  conclusions.
- **One reading.** The score is one sample of the game's memory after the final pause, read
  twice and checked, not an atomic snapshot.
- **Submitted runs are checkable, not verified** (see `tier` above).
- **Only one scored scenario.** The other scenarios in the repository are diagnostic and have
  no score; military play is not scored.

See the repository's [status page](https://github.com/hesamsheikh/CrusaderArena/blob/main/docs/status.md)
for what has been checked in the live game.

## Responsible use

Crusader Arena is for research on AI agents in single-player games. Its game-state reader
refuses multiplayer games, and the harness will not start or continue a run in one. Do not use
the project against other players. The reader loads its own code into the running game, which
the game's license terms may not permit; anyone reproducing these runs does so at their own
risk and with their own copy of the game. The game is not included.

## License

- **Logs, tables, playbooks and model outputs**, everything in this dataset except the game
  footage below: [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
  Credit "Crusader Arena" and link to this dataset or the repository.
- **Game footage**: the screenshots and reference images in `images/`,
  `final-overview.jpg` and `video.mp4` show Stronghold Crusader: Definitive Edition,
  © Firefly Studios. They are not covered by the license above. They are shared, unaltered
  apart from compression and the video's editing and overlays, for non-commercial research
  and to document how the agents played. Crusader Arena is not affiliated with or endorsed by Firefly Studios.
  Rights holders can ask for removal through the repository's
  [issues](https://github.com/hesamsheikh/CrusaderArena/issues).
- **The code** that produced the runs is in the
  [GitHub repository](https://github.com/hesamsheikh/CrusaderArena) under the MIT License.

## Citation

If you use these runs, please cite the repository:
<https://github.com/hesamsheikh/CrusaderArena>.
