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

## [1.3.0] - 2026-10-10

Comparable within itself only: `build_structure` reports and retries more cases and
takes map tiles, the host sends text instead of a screenshot after a turn without
`game_action`, `inspect_building` or a pixel placement, screenshots stay in the
conversation until compaction, every failure names its remedy, `set_tax` reads a live
figure, and three little-used tools were removed.

### Benchmark

- A tool that returns text only and leaves the last screenshot unusable (`set_tax`,
  `set_rations`, `market_trade`, `place_near`, `expand_storage`) now names itself in
  the next "Observe the game first" error, instead of every such tool giving the same
  generic message.
- `build_structure`: a target outside the screenshot or over the bottom HUD is its own
  status, `invalid_target` (`reason` names the pixel boundary), instead of aborting
  the whole call, and does not count toward the 8-actions-per-reply limit.
  Affordability is checked from the reader before each placement's first click
  (re-read so an earlier placement in the same call is accounted for), so an
  unaffordable target costs no click; before, this was only caught after a click had
  already been spent on it. A quarry, iron mine or pitch rig refused for its ground is
  now retried nearby the same way a farm refused for its ground already was. The
  call's final right-click (leaving placement mode) now targets the last placement
  actually attempted, instead of always the batch's last requested target, and is
  skipped entirely when every target in the call was invalid.
- `set_tax` returns the reader's own tax popularity factor, read from the keep panel
  after the last step, when the reader has one, instead of always the static
  reference table.
- Removed `list_buildings`, `guide_page` and `notebook_edit`: unused in 24 recent
  runs. The construction-menu guide images still arrive in
  [the preparation message](docs/context.md#the-preparation-message).
- `build_structure` placements can name a map tile (`tile_x`/`tile_y`, as
  `map_overview` and `find_sites` give them) instead of a screenshot pixel. The host
  projects the tile through the live camera right before its click, so a tile target
  needs no screenshot and no age limit applies; a tile not clickable in the live view
  is reported `not_on_screen` without input. Every tried or placed spot reports its
  `tile`, and a tile target's retries use a tile map read for the live view. See
  [Build](docs/tools.md#build).
- `find_sites` works without a screenshot: it reads the live camera and returns each
  site's tile, plus its pixel only while the latest screenshot shows that view. It no
  longer refuses after the camera moved.
- `wait_and_observe` takes `screenshot: false`: the same wait, and the same stats,
  game events and `run_clock` as text, with no image; the last screenshot still
  targets clicks. See [Text-only observations](docs/context.md#text-only-observations).
- New run setting `fallbackObservation` (`--fallback-observation`, and the
  dashboard's run settings), recorded in `run.json`. With `when-needed`, the default,
  the host's observation after a turn that acted without looking (or ran short of the
  minimum turn), and the reading-only top-up, is that text-only observation unless the
  turn used `game_action`, `inspect_building` or a pixel placement. A reply with no tool calls, the first
  observation and the one after a compaction stay screenshots. `always` keeps a
  screenshot every time, as before, for comparison. The briefing and the controls say
  which applies. Recorded runs had a host screenshot after 44–54% of their turns,
  mostly after text-only tools, and 40–43% of screenshots were never used for a click.
- The construction guide in the preparation message is sent as a JPEG when
  `.internal/ui-reference/construction-trays.jpg` is installed (quality 90, about a
  third of the PNG's 3.7 MB at the same image size and token cost; it is resent in
  every request), else as the PNG. `tools/make-construction-trays.mjs` writes the JPEG.
  See [Setup](docs/setup.md#3-guide-images).
- Screenshots stay in the conversation until compaction instead of only the newest two,
  so every request repeats the previous one unchanged and the provider's prompt cache
  covers it. With the newest two kept and screenshots now rarer, each new one replaced
  an image many turns back and cost 20–47k uncached tokens (GLM 5.3 Flash, 2026-10-11).
  Past 16 unpinned images the oldest are replaced in one batch, a safety limit for
  providers' per-request image limits. See
  [Keeping the context small](docs/context.md#keeping-the-context-small).
- A tool result that failed or fell short carries a `remedy`: the tool call that
  addresses it, for example `market_trade`'s `no_market` says to build a Marketplace
  with `build_structure`, and a placement that cannot be paid names the
  `wait_and_observe` `until` covering its cost. Thrown errors end with the fix the same
  way. See [Failures](docs/tools.md#tools).
- `find_sites` groups its spots by the ground under them (plain, oasis grass, stone,
  iron ore, oil), so the agent sees which spots would take farmland or a deposit and
  chooses; it had offered woodcutters and hovels spots on the oasis grass, and the
  agent took them (a 1.3.0 run on 2026-10-11). Spots the harness picks by itself
  (placement retries, `place_near`, `expand_storage`) keep off the ground of other
  buildings: oasis grass for farms, stone, iron ore and oil for quarries, iron mines and
  pitch rigs. A target the agent gives itself is still clicked as given.
- New tool `demolish_building`: removes one of the agent's buildings, given by map tile
  or pixel, with the game's own demolish tool, checked through the reader (the
  structure count falls). It counts as one action. Before, only raw `game_action`
  clicks could demolish, and nothing told the agent how.
- The prompt no longer tells the agent to place the granary near the keep, and says the
  ground close to the keep is limited and critical for buildings whose efficiency
  matters more there. In 31 of 32 recorded Oasis runs the granary went within 10 tiles
  of the keep's campfire, with hovels and some woodcutters beside it.

### Harness

- Claude's cache marks (through OpenRouter and Anthropic's own API) go on where the
  previous request ended and on the newest message, now that the conversation only
  grows between compactions, instead of before the oldest kept screenshot.
- `npm run episodes` recognises the game's main menu and the Load Game dialog from a few
  pixel colours of a capture (`tools/runner/screen_probe.py`, Pillow on the host)
  instead of waiting for the screen to stop changing, which the animated menu never did:
  every launch ran out a 90 s and a 15 s timeout. The save's name is typed with one
  capture instead of one per key, and the loaded map is polled every 250 ms. A host
  without Pillow waits the old way.

- Compaction's headroom check (the second of its two triggers) now reads the same
  anchored context estimate as the 65% trigger, instead of a fresh recount of the
  whole conversation at a crude bytes-per-token rate; a provider reporting low real
  usage over a long conversation no longer tripped this early from the recount's own
  inflation. See [Compaction](docs/context.md#keeping-the-context-small).
- A tool call that only clicks or presses a hotkey (not one that inspects pixels or
  returns a screenshot) reuses the call's own last captured frame while it is
  comfortably under the game device's 30-second action age limit, instead of
  recapturing the window every time: `build_structure`'s menu and terrain clicks, the
  `dismiss` helper several tools share, and the camera-movement anchors (`center_on`,
  `place_near`, `go_to_tile`). The host's own pause and speed-key presses do the same.
  `build_structure` also remembers the construction tray's open category across
  calls, with the input count at the time so it can tell whether anything else
  touched the game meanwhile, and reuses it instead of reopening the category tray;
  falls back to the full click when the reader does not confirm the remembered
  category.
- OpenRouter profiles send session-affinity headers, so a run's requests favour the
  same upstream deployment and its prompt cache; request cost tracking also records
  which upstream provider served a request (e.g. "DeepInfra") when OpenRouter reports
  one. See [Tokens and caching](docs/context.md#tokens-and-caching).
- The post-episode interview's four questions go in one combined request instead of
  four sequential ones, each under its own heading; the host splits the single reply
  back into four answers by its headings, or keeps it as one unsplit answer when they
  do not line up. A combined request's tokens, reasoning and refused tool calls are
  attributed to the first answer only, so the interview's token total is not counted
  four times over.
- A learning series starts the next episode's game (launch, connect, load, pause)
  while the previous episode's interview is still going, instead of waiting for it
  first; a stale dashboard, an operator stop or a changed benchmark save still waits
  for or closes the started game correctly before pausing the series.
- `events.jsonl` no longer stores the same tool-call image three times (pi-agent-core
  emits a tool result's image in `tool_execution_end` and again in the `toolResult`
  message's `message_start` and `message_end`): the two duplicates keep only their
  `mimeType` and a pointer to `tool_execution_end`'s copy.
- The store's key redaction skips strings that are plainly image data (a long base64
  string or a `data:image` URL) instead of scanning them for every saved API key,
  which was slow on `events.jsonl`'s multi-megabyte screenshots.
- `npm run report` shows a run's post-episode interview tokens and cost in their own
  columns, apart from the run's own.
- `run.json`'s request timings separate `preparationMs` and `reflectionMs` from
  `compactionMs`.
- `tools/video/compact-recording.py` re-encodes a run's recorded JPEG frames into one
  `recording/frames.mp4` (libx264, verified against `frames.jsonl` by frame count,
  width and height before the JPEGs are deleted), cutting a run's recording to a
  fraction of its size; `render-video.py` renders from a compacted recording the same
  way it renders from loose frames. The host queues this after a run's own video
  render; `npm run compact-recordings` runs it by hand over older runs. See
  [Run videos](docs/harness.md#run-videos).

## [1.2.1] - 2026-10-10

Comparable with 1.2.0: a fix to what the agent is shown of its popularity.

### Benchmark

- `status` and each observation's stats count the church and cathedral bonus in
  popularity points. The reader gives it in the factors' own units, 25 per point, so a
  church and a cathedral showed as religion +75 instead of +3 and the factors did not
  add up to the coming change. Found on the reference games' end saves with the
  committed reader.

### Harness

- After each episode that counts, `npm run episodes` has the host interview the agent in
  the conversation it played in, with the tools off: its result beside the reference game
  a person played on the same map, then how the person played, then what it thinks of the
  benchmark, one question at a time. The transcript goes to `interview.md` and
  `interview.json` in the run's folder and is published with the run; the interview's cost
  is kept apart from the run's. `--no-interview` leaves it out. See
  [The interview](docs/benchmark.md#the-interview).
- The reference games on Oasis by the Sea and Large Barren Desert, and what doing nothing
  scores on both benchmark start saves in 33⅓ game minutes, are recorded in
  `harness/server/baselines.ts`.
- Every run `npm run episodes` makes (agent episodes, reference games, do-nothing
  baselines and dry runs) records the whole state at its end in `results.json` and as
  tables in `results.md`: net worth with every stored good, population, popularity and its
  factors, taxes, food, efficiency, storage and buildings. They are published with each
  episode. Do-nothing baselines and dry runs now get folders like reference games. See
  [The results](docs/benchmark.md#the-results).
- The reader counts the player's buildings by type (`buildings`). The agent is not shown
  them.

## [1.2.0] - 2026-10-10

Not comparable with 1.1.4: the agent is told that population and popularity count, sees
more of its settlement, has new tools, and no longer carries a playbook between episodes.

### Benchmark

- The agent is told that the settlement is judged at the end on its population and
  popularity as well as its net worth, but not how the three are weighed (the Oasis by
  the Sea rules file and objective). Reports rank runs by net worth until the combined
  score is settled.
- Episodes are independent games of the same save: the playbook carries over only with
  `--playbook`.
- `status` and each observation's stats show worker efficiency (from the fear factor),
  count the food factor once with what the rations and food variety add to it under
  `food`, and include the church and cathedral bonus in religion, so the factors add up
  to the coming change. Before, food appeared twice and the bonus not at all.
- The reader reads the church and cathedral bonus and the keep panel's tax figure.
  `set_tax` returns that figure: the gold a month at the new level.
- New tool `set_rations` sets the granary's rations and returns the ration factor the
  panel shows.
- `build_structure` places the good and bad things (gardens, statue, shrine, maypole and
  dancing bear; gallows, gibbet, stocks, dungeon and the rest) from the Town page's
  subpages, and `building_info` gives their prices and footprints. They have no workers,
  so they need no open side.

### Harness

- `npm run episodes -- --human` runs a reference game played by a person: the save is
  loaded and left paused at the benchmark speed, and when the game-time budget is used
  up the game is paused, scored, screenshotted and saved. See
  [Reference games](docs/benchmark.md#scoring-net-worth).
- The dashboard lists the popularity factors as `status` does.

## [1.1.4] - 2026-10-10

Comparable with 1.1.3: a fix for runs the memory guard ended.

### Benchmark

- The reader breaks stalls of the game's garbage collector, which let the game's memory
  grow 300–470 MiB a minute until the memory guard closed it and ended the run. When the
  collection count has not moved for 20 seconds while the managed heap grew by 64 MiB,
  it asks the game's Mono runtime for one collection, which starts the collector again.
  Before that it records the collector's state, which in a stall during testing showed
  the cause: Wine bug 59333. See [Collector watchdog](docs/reader.md#collector-watchdog).

### Harness

- The 5-second memory samples in `events.jsonl` carry the reader's managed-heap reading
  (heap, used, collection count, whether collection is disabled). Each collection the
  reader forced is a `gc_watchdog` event and a line in the run log, and the count shows
  in `run.json`, the dashboard's game-memory figure and `npm run report` (`Forced GC`).
- The memory guard's message no longer says the game leaks memory while paused.

## [1.1.3] - 2026-10-09

Comparable with 1.1.2: runs play and score the same.

### Harness

- Runs record their cost on every endpoint. OpenRouter still reports what it billed;
  for other endpoints, such as Anthropic's and Moonshot's, which report only tokens, a
  model profile now has prices (US dollars per million tokens, with optional higher
  prices for long prompts, as Claude Haiku 5.5 has over 100,000 tokens), and the host
  prices each request's tokens with them. A run cannot start on such an endpoint without
  prices. Each `request_cost` event says whether it was `billed` or worked out from
  `prices`; `npm run report` marks the latter with `~`, and the dataset's episodes table
  has a `cost_source` column.
- `npm run cost` prices earlier runs that recorded tokens but no cost, at their model
  profile's prices; `--write` records the costs.

## [1.1.2] - 2026-10-09

Comparable with 1.1.1: runs play and score the same.

### Harness

- `npm run episodes` saves each finished episode in the game, named by model, version,
  series and episode (for example `glm 5-3 flash 1-1-1 ae6fc4 e3a2`), and copies the save
  file into the run's folder, to load and watch later. Saving uses the game's Save
  dialog, which starts with the benchmark save's name: a copy of the benchmark save is
  kept on the game machine, its hash is checked after every save, and a changed one is
  put back and pauses the series. Save files are not published.

## [1.1.1] - 2026-10-09

Comparable with 1.1.0: a placement fix.

### Benchmark

- Buildings with workers keep one whole side of open ground, where their workers go in
  and out; houses, the marketplace, stockpiles and granaries need none. `find_sites`,
  `place_near`, `expand_storage` and placement retries choose only spots that leave the
  new building an open side and take no neighbour's last one. A `build_structure`
  target that fails is moved like a blocked one without being clicked and reports
  `access`; with `exact` it is placed and `access` warns. The prompt explains the rule
  and suggests two rows back to back or blocks of four.
- The tile map for each observed view is read in the background while the game is
  paused for the model. `find_sites` and `build_structure` use it, so the check and
  `build_structure` retries no longer read the map while the game runs.

### Harness

- The repository's package version is the benchmark version, and
  `npm run benchmark-version -- bump` sets it.
- Published runs are smaller: packaging writes the images in `events.jsonl` once each as
  WebP files in `images/`, drops the token deltas of streaming replies and scales the
  video to 720p. `npm run upload -- --replace` replaces a bundle already in the dataset.

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
