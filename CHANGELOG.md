# Changelog

What changed in each version of the benchmark, newest first. Versions follow semantic
versioning as described in [Versions](docs/benchmark.md#versions): runs are comparable
within one minor version, and every run records the version it ran.

Each version has a heading `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` (the date it was first
recorded in [`benchmark-versions.json`](benchmark-versions.json)) and up to two lists:

- **Benchmark:** changes to what a run plays or how it is scored. They are why the
  version changed.
- **Harness:** changes that leave runs as they were, such as providers, retries,
  reports and publishing, in the order they reached `main` after the previous version.

Changes made since the latest version wait under `## [Unreleased]` at the top, when
there are any, and move into the next version's section when it is recorded. The git tag
`vMAJOR.MINOR.PATCH` marks the commit each version was released at. A test checks that
this file lists every version in `benchmark-versions.json`, with its date.

## [1.1.0] - 2026-10-09

Not comparable with 1.0.0: the agent sees storage readings and a changed prompt.

### Benchmark

- Observations and `status` show storage: stockpile piles, empty piles and the room
  left for each stored good, granary food and room, and a `full` note when no pile is
  empty or every granary is full. The reader takes these from the game's own records of
  each pile and granary.
- The prompt explains stockpile piles: each holds one good, how much depends on the
  good, a few units of a new good take a whole pile, and once no pile is empty a good
  with no room is not delivered and its production stops, with no message from the
  game. It says to sell surplus or expand storage before that happens.
- The prompt says only quarries use oxen: iron miners carry their own iron, any ox
  carries whatever stone is ready, and a quarry far from the stockpile, or one where
  stone piles up, needs more ox tethers.
- `expand_storage` and `place_near` find the stockpile, granary, keep, market or
  signpost by building type. They used to take the building nearest the camera centre,
  which was the keep beside the stockpile, so stockpiles could only be added on one
  side.
- `market_trade` says whether gold or storage room stopped a purchase.

### Harness

- The uncommitted-change check counts only the fingerprinted files, and a paused
  series gives a clearer stop reason.
- Broken provider streams and plain 429 rate limits are retried like other transient
  provider errors.
- Versions are numbered MAJOR.MINOR.PATCH; 1.0.0 was first called v1.
- Published runs are grouped by benchmark version and series attempt.
- Claude models can run through Anthropic's own Messages API, with adaptive thinking
  at the profile's effort and prompt-cache marks for that API.
- The probe can dump raw building records (`run-proton.py structures`) for mapping game
  data.

## [1.0.0] - 2026-10-08

The first versioned benchmark, released as v1.

### Benchmark

- Oasis by the Sea construction: grow the economy for 25 game minutes and end with the
  highest net worth, gold plus stored goods at the game's sell prices. Growth is
  measured from the do-nothing baseline.
- A fixed game speed of 40, turns of at least 8 game seconds, a default wait of 5 game
  seconds and a 120,000-token context budget with compaction.
- Reading-only replies cost game time from the 12th in a row; four replies in a row
  without a tool call end the run.
- Learning series: three episodes, each starting from the playbook the one before left.

### Harness

- Series are resumable: an infrastructure failure is run again once, a stop pauses the
  series, and `--resume` continues from the episode that has no result yet.
