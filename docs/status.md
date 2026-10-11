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
- Popularity readings against the game's panels on 2026-10-10 (a scratch reader build,
  on the reference games' end saves and agent saves): the keep panel's tax figure
  (`tax_amount`) at every level for 202 people, 0.2 gold a person per step from Low
  (121) to Crueler than cruel (404) and the bribes' −121, −161 and −202; the rations
  factor at all five levels (−8 to +8), with the food factor equal to the rations and
  food-variety factors added up; worker efficiency (140% with the fear factor at −4,
  110% at −1). The game's religion line was 3 points above the reader's `religion`
  factor in both reference games, which have a church and a cathedral: the bonus the
  reader reads as `church_bonus`. Read from the committed reader on 2026-10-10, it is 75
  on both end saves (the factors' 25 per point) and 0 on a save with only a chapel; the
  factors in the model's stats then add up to the game's coming change on all three.
- The player's buildings by type (`buildings`), from the committed reader on
  2026-10-10: on both reference games' end saves they match the count made earlier with
  a test build (57 bakeries, 24 hovels and 54 bad things on Oasis by the Sea; 95
  bakeries, 11 inns and 21 bad things on Large Barren Desert), a save with only a chapel
  lists it, and each building placed in the tool checks below appeared under its type
  at once. The keep panel's tax figure read 150 gold a month at Low taxes for 250 people.
- Placement and resource warning messages are captured and reach the model with
  their age.
- Sampling every 100 ms has no measurable cost to the game.
- The [collector watchdog](reader.md#collector-watchdog) against a real collector stall,
  in a 25-game-minute GLM 5.3 Flash episode on 2026-10-10 (benchmark 1.1.4): the
  collection count stopped at 334, and after 20 seconds the reader forced a collection
  (25 ms). The count then moved on by itself every few seconds, and the game's memory
  stayed at 3.1 GiB. The collector's variables confirmed the cause: the thread-stack
  total had wrapped around (2^64 minus about 2.9 GB, so a thread's stack pointer read
  about 2.9 GB above the base of its stack), the threshold for the next collection was
  3.1 × 10^18 bytes, and collection was neither disabled nor in manual mode.
- The same watchdog against a simulated stall, on a paused Oasis by the Sea on
  2026-10-10. A test build switched off automatic collection (Unity's manual mode),
  so the collection count stopped and the heap's used bytes grew 7.5 MiB a second, as
  in a real stall. After 20 seconds the reader forced a collection, which took 23 ms
  and brought used bytes back from 499 to 364 MiB, and it did so again every 20 seconds
  until automatic collection was switched back on; the heap grew from 516 to 548 MiB in
  all. The collector variables it recorded were sensible: a 23 MiB threshold (the game
  allocates about 24 MiB between collections), 162 KiB of thread stacks, and manual
  mode on.

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
- Run against the live game through the harness's own tool code, without a model, on
  2026-10-10 (benchmark 1.2.0). `set_tax` on the Large Barren Desert reference game (250
  people): Low to Average returned 200 gold a month, to the generous bribe −250, back to
  Low 150, with the popularity effects −4, +7 and −2, and the keep panel closed each
  time. `set_rations` from none: half, extra, double, full and none returned the ration
  factors −4, +4, +8, 0 and −8 as the reader showed them; asking for the current rations
  clicked nothing; the granary panel closed each time. `build_structure` on "Oasis by the
  Sea benchmark start" placed a dancing bear, gallows, a hovel straight after the
  gallows (so the tray left the fear-factor page), a town garden, a dungeon, a shrine and
  a woodcutter, each confirmed by its cost or the structure count; the town garden's
  first two spots, offered by `find_sites`, were silently refused and it went 3 tiles
  over. With three good things and two bad ones in a settlement of 10 people, the fear
  factor read +1 and worker efficiency 90%: good and bad things offset each other.
  `inspect_building` opened a panel only with the game running, as it is during play.

**Runs**
- Timed runs with game-time budgets, pausing during thinking, compaction and the
  final pause, with several models including Kimi K3 and GLM 5.3 Flash.
- Unattended episodes end to end: launch, load by name, run, scorecard, close.
- The [results](benchmark.md#the-results) and the [interview](benchmark.md#the-interview),
  on 2026-10-10: three dry runs of "Oasis by the Sea benchmark start" wrote their
  scorecards and results in folders of their own, and a 3-game-minute GLM 5.3 Flash
  episode (an unversioned trial) wrote its results, was saved and closed, and was then
  interviewed. The model answered all four questions in 1 min 40 s without calling a
  tool; 96% of the interview's 152,164 tokens were read from the provider's cache, and
  it cost $0.006, kept in `interview.json`. The run's own cost in `run.json` stayed the
  sum of its gameplay and preparation requests, and `events.jsonl` has no interview
  events. The first question said the budgets were not like for like (3 minutes beside
  the person's 33).
- Run recording and video rendering, with scripted inputs and in a 2-game-minute
  GLM 5.3 Flash episode on 2026-10-08.
- On a paused game: minimap clicks and `Z` move and zoom the camera, and the keep
  hotkey does nothing. The final overview's camera sequence (minimap to the keep's
  tile, then `Z` until the view stops widening) was run by script on 2026-10-08, and
  at the end of real runs since: five GLM 5.3 Flash runs on Oasis by the
  Sea (2026-10-10 and 2026-10-11) each recorded the paused minimap move to the keep as
  `arrived`.
- Acting tools' own steps taking less game time (see the 1.3.0 changelog), in a
  15-game-minute GLM 5.3 Flash run on Oasis by the Sea on 2026-10-11 (run 0b08f7e0,
  unversioned because of uncommitted changes). All five `go_to_tile` calls came first
  among their reply's acting tools; in each, the minimap clicks came before the unpause
  (`recording/inputs.jsonl`), none of the five screenshots showed the "Game Paused"
  overlay, four arrived and one stopped with the tile in view, and no pause toggle was
  retried. Their time to the first input fell from 1.28 s to 0.40 s on average. The one
  `expand_storage` call placed both stockpiles. Its tile read overlapped the building
  selection but took about 4 s, against about 3 s in earlier runs, so the first terrain
  click still came 2.8 s after the selection (3.15 s before); one call cannot tell
  whether the overlap slows the read. Reusing the latest capture applied in 4 of 15
  calls, saving about 0.25 s each: in the rest it was over 20 s old, because text-only
  observations take no screenshot.
- Benchmark 1.4.0 beside the published 1.1.0 run, on 2026-10-11: one 25-game-minute GLM
  5.3 Flash episode (series 20261011T114226-a46cbd06, run cdecaf85) with the settings
  of episode 1 of the published series 20261009T122236-3aae6fc4 (run 171a1a71): the
  same save, objective text, game speed 40, budgets and model profile, but no playbook
  (the published series had one, still empty in its episode 1). Both were valid and used
  the whole budget. Against the published episode: cost $0.129 against $0.207, with
  109k tokens of uncached input against 714k (97% of the input read from the cache);
  the agent's 25 game minutes took 34 min 53 s of real time against 41 min 06 s, and
  the agent started 41 s after the series did against 2 min 59 s; the median wait
  for a reply's first token was 8.6 s against 10.7 s, and inference 871 s against
  1,126 s over 80 turns against 84; acting tools took 204 s against 428 s for about the
  same number of clicks (about 230), the game machine's tile reads 9 s against 70 s;
  one compaction against two; the host sent 6 screenshots and 47 text observations
  against 57 screenshots. The first gameplay request read 19,712 tokens from the cache
  and 1,732 uncached, after a preparation request of 19,718 that called no tool. Net
  worth was 6,231 against 4,748 (popularity 79 against 64); one episode each, and
  single GLM episodes vary widely, so the score difference is not established. The
  stockpile ended with 3 of 12 piles empty. With 5 game minutes left the agent saw wood
  room 111 (two empty piles counted in it) and sold wood anyway to keep piles free for
  iron and stone; it took all 225 (see Known issues).
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

- Full-length runs: a learning series of three 25-game-minute GLM 5.3 Flash episodes on
  2026-10-10 at benchmark 1.1.4 (run unversioned, before the change was committed). All
  three ran their whole budget and were scored valid (net worth 5,032, 3,021 and
  5,038), with the game's memory at 3.1–3.3 GiB throughout. The third had the collector
  stall described under Reader, which the watchdog broke.
- Stopping and resuming a series, in a learning series of two 1-game-minute GLM 5.3
  Flash episodes on 2026-10-08 at benchmark 1.0.0: Ctrl-C during episode 1 stopped the
  dashboard run, closed the game and paused the series within 2 seconds; `--resume`
  ran episode 1 again as attempt 2 and then episode 2 from its playbook, and the report
  counted episode 1 by its second attempt. Every run recorded its version, attempt and a clean
  commit, and the runner's check of the game machine's files caught an out-of-date one
  before the run.
- The automatic re-run after an infrastructure failure, in two series on 2026-10-09
  (20261009T122236-3aae6fc4 and 20261009T164620-3dd2f4e8): one series' episode 3 failed
  on attempt 1 and was valid on attempt 2; the other's episode 2 failed on attempts 1
  to 4 and was valid on attempt 5. Each time the runner started the next attempt from
  the same playbook on its own, without pausing the series.
- Claude through Anthropic's own API, in a learning series of two 3-game-minute Claude
  Haiku 5.5 episodes at medium effort on 2026-10-09 with a 75,000-token context budget:
  both episodes ran their full budget; all 27 buildings it tried to place were placed
  (3 at a nearby spot after a retry), as expected since Anthropic's documentation says
  these models see a 1920 × 1080 screenshot unscaled; compaction and the playbook
  request worked; and episode 2 started from the playbook. The cache marks paid off: each request read the
  conversation the previous one wrote (70–72% of all input from the cache), and the
  handoff and playbook requests read it too. Anthropic reports no cost; the costs of
  that day's ten Claude runs were worked out afterwards with `npm run cost` from their
  recorded tokens at Anthropic's list prices (about $0.60 in all; $0.31 for the three
  published episodes of series 20261009T100849-21b4ea9d, $0.38 with the attempt that
  was run again), not checked against Anthropic's billing. A 60,000-token
  budget is too small for Claude: its fresh conversation after a compaction (about
  39,300 tokens) did not fit under 65% of it, which ended that run with an error.

## Tested in code only

- `market_trade` trading in the game's own steps (1.5.0), with a simulated market
  (`economy.test.ts`): 20 lots of 225 wood sell exactly 100; a sale stops, with the step
  to ask for, when the next step is larger than what is left; a delivery and a tax
  payment at the same moment as a click neither hide a trade nor pass for one. The
  steps themselves were measured live on 2026-10-11 by clicking the marketplace through
  the host on a saved game (wood, stone and apples: a purchase 5 units a click, a sale
  20 from 100 in stock, 10 from 50, else 5; 103 sold 20 and 91 sold 10, 53 sold 10 and
  46 sold 5). Before the fix, two GLM 5.3 Flash runs that day sold 105 wood for 10 lots
  (494a5f78) and all 225 for 20 (cdecaf85).
- The 1.4.0 request savings (see the changelog), with a fake provider: the preparation
  request carries the gameplay tools and the first gameplay request repeats them
  (`controller.test.ts`, `model-config.test.ts`), a preparation reply that calls a tool
  is asked again, and the observation stats leave out goods with none stored
  (`model-observation.test.ts`). The enums' validation was checked against pi-ai's
  validator by script. The cache read it brings was seen live (see Runs above); the
  retry of a preparation reply that calls a tool has not been needed in a run.
- A good's `room` in `storage` counting the empty piles, and an empty granary adding 250
  to the granary room (`anchors.test.ts`), from pile and granary readings shaped like
  those seen live on 2026-10-09 and 2026-10-11. One live run has played with it (see
  Runs above); an empty granary's 250 has not come up live.
- Acting tools' own steps taking less game time (see the 1.3.0 changelog), with fake game
  devices (`controller.test.ts`, `anchors.test.ts`, `model-observation.test.ts`):
  `go_to_tile` and `navigate_minimap` click the minimap paused only when nothing in the
  reply has unpaused the game yet, and add no pause toggle when it is already running.
  `navigate_minimap` has not been called in a live run since.
- Compacting a run's raw recording frames into `recording/frames.mp4`
  (`tools/video/compact-recording.py`) and rendering from it instead of the JPEGs: with
  synthetic recordings (`tools/video/test_compact_recording.py`), encoding, `ffprobe`
  verification, a verification failure keeping the JPEGs, and a render from the
  compacted video matching the JPEG render (mean pixel difference under 6 of 255 on
  sampled frames, the extra JPEG → H.264 round trip's own loss). An interrupted render
  (`SIGTERM` or `KeyboardInterrupt`) leaving no partial file is tested the same way,
  and confirmed once with a real `SIGTERM` to a running `render-video.py` process. The
  10–25× size and SSIM ≥ 0.987 in [Run videos](harness.md#run-videos) are from earlier
  offline encoding experiments, not reproduced by this test suite. Neither the
  compaction nor the decode-from-video path has run against a real recorded run or a
  live episode.
- The fixed game speed in an agent run: the host setting it before the budget starts,
  and failing when the keys do nothing or step past 40. The same setting worked live
  for the idle baseline (above); an agent run has not used it yet.
- `observe` and `wait_and_observe` waiting out the minimum turn length, and the "Game
  time left" line after the last tool result of each reply. Not yet run live.
- Context compaction across many turns, stop and deadline handling, and failure
  paths, with fake models and game devices (`npm test`). This includes the retries
  added before the first 25-game-minute run: failed handoff and playbook requests,
  cut-off replies with tool calls, and unconfirmed pause toggles. The headroom check's
  switch to the same anchored estimate as the 65% trigger, against a fake model that
  reports a small usage figure over a long conversation, is tested the same way; it
  has not yet been seen to change when a real run compacts.
- Saving the finished game (see [Running episodes](benchmark.md#running-episodes)), live
  on Oasis by the Sea (2026-10-09) through the same routine the runner calls: Game
  Options → Save, the name typed over the loaded save's, the file copied off the game
  machine (3.5 MB) and the benchmark save's hash unchanged; the game stayed paused. The
  name field takes 32 characters (a longer name was cut), and saves made this way load
  from the in-game Load dialog. Real episodes have since saved themselves at their end
  (GPT-6 Luna on 1.1.3, GLM 5.3 Flash on 1.1.4). The overwrite guard (copy, hash check,
  restore) is tested with a simulated save folder.
- Reference games (`--human`, see [Scoring](benchmark.md#scoring-net-worth)), live on
  Oasis by the Sea (2026-10-10) with a 30-game-second budget and the unpause sent as a
  player would: the runner paused the game after 31 game seconds, wrote the scorecard
  and a 1920×1080 screenshot, saved the game and closed it; the benchmark save's hash
  was unchanged. Not yet used for a full game.
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
- `build_structure`'s per-placement checks, with fake game devices (`npm test`), not
  yet used live: a target outside the screenshot or over the bottom HUD reports
  `invalid_target` on its own (nothing sent, the rest of the batch still runs) instead
  of stopping the whole call; affordability is checked from the reader before each
  placement's first click, re-read so an earlier placement in the same batch is
  accounted for; and a quarry, iron mine or pitch rig refused for its ground is
  retried nearby on matching ground the same way a farm is retried on oasis.
- `set_tax`'s popularity factor read live from the reader (`popularity_factors.tax`,
  the same points conversion as `set_rations`) instead of the static table, with a
  fake keep panel (`economy.test.ts`). The live run recorded above (benchmark 1.2.0)
  predates this change and shows the static table's values.
- The per-tool-call frame cache for input-only clicks and hotkeys (`anchors.ts`'s
  `frame()`, reused for up to `FRAME_REUSE_MS` after a capture) and `build_structure`
  remembering the construction tray's open category across calls (falling back to the
  full category click when the reader does not confirm it), with fake game devices
  (`anchors.test.ts`, `device-lifecycle.test.ts`, `model-observation.test.ts`). Neither
  the 20-second reuse window nor the category memory's savings have been measured
  live.
- Targeting `build_structure` placements by map tile (`tile_x`/`tile_y`) instead of a
  screenshot pixel, and `find_sites` running without an observation at all (both read
  the live camera, waiting out an unavailable sample): a tile placement on screen, one
  off screen reported `not_on_screen` without sending input, one projected again when
  the view moves during selection, a batch mixing pixel and tile targets (only the pixel
  target's clicks keep the screenshot age limit), a blocked tile target retried at a
  nearby tile the map shows free (also after the camera moved since the last
  screenshot, and stopped when the live camera moves) or by fixed offsets reporting the
  tile it went to, `find_sites` giving pixels and using `near_x`/`near_y` only while a
  screenshot shows the live view, its map reused by the next placement's retry, and a
  shape error (neither or both coordinate pairs given) reported `invalid_target`; all
  with fake game devices (`model-observation.test.ts`). Not yet used live.
- `wait_and_observe`'s `screenshot: false` (waits the same, no capture, the old
  screenshot still targets clicks) and the `fallbackObservation` setting (text after a
  turn with only text-only actions under `when-needed`; a screenshot after a
  `game_action` click or key, after a reply with no tool calls, or under `always`; the
  reading-only top-up; the briefing for each value; the default recorded in
  `run.json`), with fake game devices (`model-observation.test.ts`,
  `controller.test.ts`, `protocol.test.ts`). Not yet run live; how models use the
  text-only observation is unmeasured.
- Screenshots kept in the conversation until compaction (a batch prune only past 16),
  so every request repeats the previous one unchanged: checked across a fake run whose
  every turn brings a screenshot (`controller.test.ts`) and for the cap
  (`context.test.ts`); Claude's cache marks on where the previous request ended and the
  newest message (`model-config.test.ts`). The cost effect is not yet measured live;
  the 1.3.0 partial run of 2026-10-11 (only the two newest screenshots kept) showed the
  cache misses this removes.
- A `remedy` on every failed or partial tool result and fix-it wording in thrown errors
  (`remedies.test.ts`, `economy.test.ts`, `model-observation.test.ts`). Whether models
  follow them is not yet seen live.
- Recognising the main menu and the Load Game dialog from pixel colours during save
  loading: the classifier against colours measured on captures of 2026-09-28
  (`menu-screen.test.ts`) and the sampler with synthetic images (`tools/runner`). Not
  yet used in a live launch; the seconds it saves, and whether the dialog is ready to
  type into a second after it is recognised, need one.
- Screenshots scaled down by the game-machine bridge with clicks scaled back up: live on
  2026-10-11 through the host's own `GameDevice`, a 1280 × 720 capture of a 1920 × 1080
  window, and a click on the main menu's Load Game at its 1280-wide coordinates opening
  the Load Game dialog. The window-coordinate scaling and the run applying the setting
  are tested in code (`protocol.test.ts`, `controller.test.ts`). No agent run has used
  the smaller screenshots yet.
- Clicking through the startup screens: live on 2026-10-11, clicking the screen centre
  once a second skipped the Firefly and Stronghold intro videos and the promo splash and
  brought the main menu 25 s after launch instead of 49 s, with nothing else opened;
  built into the runner after that and not yet used by `npm run episodes`.
- `demolish_building`: the demolish button (the X on the red strip beside the
  construction tray at 1537, 1016 in the 1920 × 1080 layout) putting the game in
  demolish mode (reader placement action 6), a click on a woodcutter's hut removing it
  at once with no confirmation (the map's structure count 68 to 67 within 1.5 s) and a
  right-click leaving the mode, checked live on 2026-10-11 through the host's input
  API. The tool's own statuses and remedies are tested with fake game devices
  (`model-observation.test.ts`); no agent has used it yet.
- `find_sites` grouping its spots by ground, and harness-chosen spots keeping off other
  buildings' ground (oasis grass, stone, iron ore, oil): `tile-map.test.ts`,
  `model-observation.test.ts`. Not yet used live.
- The construction guide sent as `construction-trays.jpg` when installed, else the
  PNG: file choice tested with temporary files (`visual-atlas.test.ts`). The JPEG at
  quality 90 was checked by eye on 2026-10-10 (labels readable), and runs on 1.3.0 used
  it. The 80% guide of 1.4.0 (1530 × 2270) was checked by eye on 2026-10-11: titles,
  button numbers and the 13-point notes are readable; run cdecaf85 used it.
- Good and bad things' footprints are from static analysis of the game files, the same
  method as the other buildings'; the town garden's refused spots (above) may mean its
  footprint is larger than recorded.
- Reading-only replies costing game time from the 12th in a row instead of ending the
  run, and the warning after each reply without a tool call. Not yet run live.
- Results written for a reference game or a do-nothing baseline by the runner: only dry
  runs and an agent episode have written them live. The two reference games' results
  were written afterwards from their recorded readings.
- The interview's refusal of tool calls, its retries and the 30-minute stop, with fake
  models (`npm test`): the live trial's model called no tool. The interview files in
  published bundles are tested in code only. The four questions asked as one combined
  request under titled headings, and the reply split back into four answers by them
  (or kept as one answer when the headings do not line up), is tested the same way;
  the live trial predates this and asked one question per request.
- Benchmark versions: the fingerprint, `benchmark-versions.json` and the test that
  enforces it. Resumable series: the episode outcomes, which attempts count, where a
  series resumes and the settings a resume must match (the automatic re-run after an
  infrastructure failure is confirmed live; see Runs above).
- A learning series starting the next episode's game (launch, connect, load, pause)
  while the previous episode's interview is still going, instead of waiting for it
  first (`episodes.ts`'s `prepareEpisode`/`abandonPrepared`). `episodes.ts` drives a
  live dashboard and game machine through `fetch` and `ssh` and has no unit tests, so
  this is checked by reading the code, not run live or under `npm test`.
- Dropping a tool call's image from the two extra copies `events.jsonl` would
  otherwise keep (`omitDuplicateToolImages`, `context.test.ts`) and skipping image
  data in key redaction (`store.test.ts`, mirroring `tools/dataset/scrub.py`'s own
  rule): the wiring that applies the first to a live run's event stream (`index.ts`)
  has no test of its own.
- Pricing requests on endpoints other than OpenRouter with the profile's prices
  (see [Context](context.md#tokens-and-caching)): against fake Anthropic and
  OpenAI-format streams, including Claude Haiku 5.5's higher prices for prompts over
  100,000 tokens, and the refusal to start a run without prices. Not yet used in a live
  run.
- Removing duplicate messages that appear in several channels at once.
- Prompt caching marks for Claude through OpenRouter: checked against the request
  body the model library builds, not yet against a live provider. The session-affinity
  header sent with every OpenRouter request, and the upstream provider name
  (`upstream`, e.g. "DeepInfra") read from a cost chunk when OpenRouter reports one,
  are checked against fake responses only (`model-config.test.ts`).
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
  The three series in the dataset then (those two and GLM 5.3 Flash on 1.1.0,
  20261009T122236-3aae6fc4) were packaged again with `cost_source` and replaced with
  `--replace` on 2026-10-09. Compared value by value with the bundles before: the GLM
  series changed only by `cost_source` (`billed`), their costs unchanged; the Haiku series
  gained its costs from list prices ($0.31, `prices`) and its run files the cost events.
  The files on the Hub match the manifests, and the tables load from the Hub.

## Not verified or not built

- **Messages:** low-popularity warnings and enemy messages are not verified; the
  skirmish chat area is not read; spoken lines without text cannot be captured.
- **Mouse-wheel camera zoom** does not work through the bridge (use `Z` and `X`).
- **Other setups:** other Linux distributions and desktops, native Wayland, Windows
  or macOS game machines, window sizes other than 1920 × 1080, other game builds.
- **Long runs:** three 25-game-minute episodes have run in full with the collector
  watchdog (above), too few to call full-length runs reliable.
- **The current prompt** has been used only in runs of up to 5 game minutes, and no
  model has yet played with the text-only menu guide.
- **Benchmark:** scoring exists only for Oasis by the Sea; there is no military
  scoring, no ranking across runs and no published comparison of models. Early
  single-model pilots used older harness versions and are not comparable.

## Known issues

- **Garbage-collector stalls.** Under Proton, the game's garbage collector can stop
  starting collections, paused or running, with or without the reader: about once per
  1,300–1,500 collections, or 0.75 times an hour of play, in recorded runs up to
  2026-10-09. The managed heap then grows 7.5 MiB a second, and the game's memory
  300–470 MiB a minute, until the memory guard closes the game and ends the run (the
  scorecard then uses the last valid reading). In all 13 recorded stalls the collection
  count stopped right after an ordinary collection. The cause is
  [Wine bug 59333](https://bugs.winehq.org/show_bug.cgi?id=59333) (also
  [Proton #9430](https://github.com/ValveSoftware/Proton/issues/9430)): found by
  reading the collector's source and disassembling the game's Mono runtime, and
  confirmed by the collector's state in a stall on 2026-10-10 (above). The reader's
  [collector watchdog](reader.md#collector-watchdog) forces a collection after 20
  seconds of stall, which ended that stall at no cost to the run. The memory guard
  stays as the backstop.
- **NVIDIA graphics.** On the test laptop the game stalled at startup on the NVIDIA
  GPU; the Intel GPU with Vulkan works. See [Setup](setup.md#known-issues).
- **Map-wide structure count.** The reader's structure count includes other players,
  so it cannot attribute a change to the agent on maps with opponents.
- **Reads are not atomic.** Each sample is read twice and checked, but it is not a
  guaranteed consistent snapshot.
- **Guide images are private.** A fresh checkout runs with a text-only menu guide.
  All recorded runs used the image guide, which you can make from your own
  screenshots (see [Setup](setup.md#3-guide-images)).
