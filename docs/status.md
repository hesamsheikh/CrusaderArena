# Status

[← Documentation](README.md)

Crusader Arena is research software. This page separates what has been checked in the
real game from what has only been tested in code, and what is not built yet. Live
checks were made on one Ubuntu 26.04 laptop with Steam build 24816905 of the game,
between September and October 2026.

## Checked in the live game

**Reader**
- Gold, population, popularity, 20 stored goods and own-troop totals by type match
  the game's panels.
- Date, housing, idle peasants, rations, popularity factors, selected-building
  workers, placement mode and camera position match the game.
- Placement and resource warning messages are captured and reach the model with
  their age.
- Sampling every 100 ms has no measurable cost to the game.

**Control**
- Clicks, right clicks, drags (selecting units), mouse-wheel list scrolling, keys,
  `P` (for the host), camera zoom with `Z` and `X`, and game speed with `+` and `-`.
- The game-window capture excludes windows covering the game.
- Stop from the dashboard and from the control monitor, and the focus check that
  blocks input while another window is active.

**Tools**
- `build_structure` placement, its verification by cost and structure count, the
  camera guard, and retries at nearby spots.
- `center_on`, `place_near`, `expand_storage`, `flat_view` and saved views.
- `map_overview`, `go_to_tile`, `set_tax` and `market_trade` have been used in live
  runs; marketplace prices on screen match the price table.

**Runs**
- Timed runs with game-time budgets, pausing during thinking, compaction and the
  final pause, with several models including Kimi K3 and GLM 5.3 Flash.
- Unattended episodes end to end: launch, load by name, run, scorecard, close.
- Run recording and video rendering, with scripted inputs and in a 2-game-minute
  GLM 5.3 Flash episode on 2026-10-08.
- On a paused game: minimap clicks and `Z` move and zoom the camera, and the keep
  hotkey does nothing. The final overview's camera sequence (minimap to the keep's
  tile, then `Z` until the view stops widening) was run by script on 2026-10-08; it
  has not yet run at the end of a real run.
- The current harness and prompt, in two 5-game-minute GLM 5.3 Flash episodes on
  2026-10-08 that completed: the compact observation summary, reading tools at the
  start of a reply running while the game stays paused, the dashboard fetching a
  screenshot only when the run has a new one, and the model settings and harness
  version recorded in `run.json`. The second ran with a 60,000-token budget and
  compacted twice; each handoff request repeated the gameplay request and was
  served about three-quarters from the provider's cache.
- The minimum turn length (8 game seconds), in a 2-game-minute GLM 5.3 Flash episode
  on 2026-10-08: every turn that ran the game took at least 8 game seconds, short
  turns were topped up with the model told why, and reading-only turns stayed free.
- A learning series of three 3-game-minute GLM 5.3 Flash episodes on 2026-10-08: each
  episode started from the playbook the one before left, the agent changed it during
  play, the request after each episode rewrote it, and the series records and report
  table were written. What OpenRouter billed was recorded for every request, about
  $0.04 per episode.

## Tested in code only

- The fixed game speed: measuring the speed from reader ticks, pressing `+` and `-`
  until it reads 40, failing when the keys do nothing or step past 40, and the idle
  baseline doing the same. Not yet run in the live game: the speed keys' step size and
  the speed the saves start at are unknown (2026-10-08 runs ran at about 20 ticks a
  second).
- `observe` and `wait_and_observe` waiting out the minimum turn length, and the "Game
  time left" line after the last tool result of each reply. Not yet run live.
- Context compaction across many turns, stop and deadline handling, and failure
  paths, with fake models and game devices (`npm test`).
- Removing duplicate messages that appear in several channels at once.
- Prompt caching marks for Claude through OpenRouter: checked against the request
  body the model library builds, not yet against a live provider.
- Host shutdown ending a run with the final pause, and the host staying ready when a
  run cannot be set up.

## Not verified or not built

- **Messages:** low-popularity warnings and enemy messages are not verified; the
  skirmish chat area is not read; spoken lines without text cannot be captured.
- **Mouse-wheel camera zoom** does not work through the bridge (use `Z` and `X`).
- **Other setups:** other Linux distributions and desktops, native Wayland, Windows
  or macOS game machines, window sizes other than 1920 × 1080, other game builds.
- **Long runs:** runs longer than 10 game minutes, including the default 25, have not
  been shown to be stable, because of the memory issue below.
- **The current prompt** has been used only in runs of up to 5 game minutes, and no
  model has yet played with the text-only menu guide.
- **Benchmark:** scoring exists only for Oasis by the Sea; there is no military
  scoring, no ranking across runs and no published comparison of models. Early
  single-model pilots used older harness versions and are not comparable.

## Known issues

- **Memory growth while paused.** The game can start leaking memory at about 400 MiB
  per minute during long pauses, with or without the reader. The cause is unknown.
  The memory guard closes the game before it exhausts the machine, which ends the run
  (the scorecard then uses the last valid reading).
- **NVIDIA graphics.** On the test laptop the game stalled at startup on the NVIDIA
  GPU; the Intel GPU with Vulkan works. See [Setup](setup.md#known-issues).
- **Map-wide structure count.** The reader's structure count includes other players,
  so it cannot attribute a change to the agent on maps with opponents.
- **Reads are not atomic.** Each sample is read twice and checked, but it is not a
  guaranteed consistent snapshot.
- **Guide images are private.** A fresh checkout runs with a text-only menu guide.
  All recorded runs used the image guide, which you can make from your own
  screenshots (see [Setup](setup.md#3-guide-images)).
