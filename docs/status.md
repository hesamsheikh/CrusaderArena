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
- Storage, on Oasis by the Sea on 2026-10-09: each stockpile pile's good, amount and
  capacity and each granary's food and capacity, read from the engine's building
  records, followed purchases and sales at the market. Buying stopped when a good's
  piles were full and no pile was empty (wood at 140 with stone in the fourth pile; iron
  refused outright), with no text message from the game; an emptied pile took the next
  good. The model's `storage` summary showed the stockpile full at that point.
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
- `expand_storage` anchored on the stockpile's piles (2026-10-09): stockpiles placed on the
  up-right, down-left and down-right sides at the first try (up-left, the keep's side,
  fell through to the next side), and two granaries beside the granary. Before, it
  anchored on the keep beside the stockpile, and in every recorded run only spots on the
  stockpile's down-right side were placed. `market_trade` names gold or storage room when
  a purchase stops.
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
- The fixed game speed, set before a 25-game-minute idle baseline on 2026-10-08: the
  save started at 19.9 ticks a second, and four presses of `+` (5 ticks a second each)
  brought it to 39.9. Doing nothing then scored 1,304 net worth; the game placed the
  granary by itself.

- Stopping and resuming a series, in a learning series of two 1-game-minute GLM 5.3
  Flash episodes on 2026-10-08 at benchmark 1.0.0: Ctrl-C during episode 1 stopped the
  dashboard run, closed the game and paused the series within 2 seconds; `--resume`
  ran episode 1 again as attempt 2 and then episode 2 from its playbook, and the report
  counted episode 1 by its second attempt. Every run recorded its version, attempt and a clean
  commit, and the runner's check of the game machine's files caught an out-of-date one
  before the run.
- Claude through Anthropic's own API, in a learning series of two 3-game-minute Claude
  Haiku 5.5 episodes at medium effort on 2026-10-09 with a 75,000-token context budget:
  both episodes ran their full budget; all 27 buildings it tried to place were placed
  (3 at a nearby spot after a retry), as expected since Anthropic's documentation says
  these models see a 1920 × 1080 screenshot unscaled; compaction and the playbook
  request worked; and episode 2 started from the playbook. The cache marks paid off: each request read the
  conversation the previous one wrote (70–72% of all input from the cache), and the
  handoff and playbook requests read it too. Anthropic reports no cost. A 60,000-token
  budget is too small for Claude: its fresh conversation after a compaction (about
  39,300 tokens) did not fit under 65% of it, which ended that run with an error.

## Tested in code only

- The fixed game speed in an agent run: the host setting it before the budget starts,
  and failing when the keys do nothing or step past 40. The same setting worked live
  for the idle baseline (above); an agent run has not used it yet.
- `observe` and `wait_and_observe` waiting out the minimum turn length, and the "Game
  time left" line after the last tool result of each reply. Not yet run live.
- Context compaction across many turns, stop and deadline handling, and failure
  paths, with fake models and game devices (`npm test`). This includes the retries
  added before the first 25-game-minute run: failed handoff and playbook requests,
  cut-off replies with tool calls, and unconfirmed pause toggles.
- Saving the finished game (see [Running episodes](benchmark.md#running-episodes)), live
  on Oasis by the Sea (2026-10-09) through the same routine the runner calls: Game
  Options → Save, the name typed over the loaded save's, the file copied off the game
  machine (3.5 MB) and the benchmark save's hash unchanged; the game stayed paused. The
  name field takes 32 characters (a longer name was cut), and saves made this way load
  from the in-game Load dialog. Not yet run at the end of a real episode. The
  overwrite guard (copy, hash check, restore) is tested with a simulated save folder.
- Open sides for buildings with workers (see [Tools](tools.md#build)), live on Oasis
  by the Sea (2026-10-09): a woodcutter aimed at a 3×3 hole boxed in by four hovels
  came back `access: "no_open_side"` and was built 4 tiles away without the hole being
  clicked, and `find_sites` did not offer the hole. Placed there with `exact`, it warned,
  showed the game's no-entry sign, read "no access to keep" and got no worker while 19
  peasants stood idle; the moved one was staffed and working. Hovels are engine type 1.
  Spot choice, the check before clicking and the background tile read are also tested
  with tile fixtures and the simulated game (`npm test`).
- Tool changes made before the first 25-game-minute run, not yet used live: woodcutter
  spots ranked by nearby trees, placement checks waiting for a valid reader sample, and
  `cost` in placement results.
- Reading-only replies costing game time from the 12th in a row instead of ending the
  run, and the warning after each reply without a tool call. Not yet run live.
- Benchmark versions: the fingerprint, `benchmark-versions.json` and the test that
  enforces it. Resumable series: the episode outcomes, which attempts count, where a
  series resumes and the settings a resume must match. The automatic re-run after an
  infrastructure failure has not happened live yet.
- Removing duplicate messages that appear in several channels at once.
- Prompt caching marks for Claude through OpenRouter: checked against the request
  body the model library builds, not yet against a live provider.
- Host shutdown ending a run with the final pause, and the host staying ready when a
  run cannot be set up.
- Publishing runs ([Publishing](publishing.md)): packaging, scrubbing, the tables and the
  upload checks are tested in code. The first series (GLM 5.3 Flash, benchmark 1.0.0,
  20261008T191852-c1d986e9) was uploaded to the Hugging Face dataset on 2026-10-09, and its
  three tables load from the Hub with `load_dataset`.
  Making bundles smaller (images as WebP files, token deltas dropped, 720p video) is tested
  in code. Both series then in the dataset (that one, and Claude Haiku 5.5 on 1.1.0,
  20261009T100849-21b4ea9d) were packaged again with it and replaced with `--replace` on
  2026-10-09: their tables came out the same, they went from 546 to 227 MB and from 770 to
  249 MB, the files on the Hub match their manifests, and the tables load from the Hub.
  The replaced versions were then deleted from the dataset's storage with
  `permanently_delete_lfs_files` (history rewritten): the 12 old `events.jsonl` files and
  1080p videos, 1,302.5 MB. The dataset now stores 376 files, 468.8 MB, all used by `main`;
  both series still match their manifests, and the tables and a video download from the Hub.

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
