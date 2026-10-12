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

## [1.6.1] - 2026-10-12

A new map, and one line of the rules reworded. A patch: tools and scoring are unchanged.

### Benchmark

- The Sinkhole: rules (`prompt/benchmarks/the-sinkhole-construction.md`), objective and the
  reference game a person played from `The Sinkhole start` for 45 game minutes (net worth
  41,631, 506 people, popularity 99), which agents see only in their interview. Its runs
  take `--game-minutes 45`.
- Each map's rules now say of weapons and armour only that what the workshops make is kept
  in an armory and is stored value, as they say of food, without how they are made or that
  an armory must stand first.

## [1.6.0] - 2026-10-12

Weapons and armour join the economy, and the fixes listed on the roadmap from the 1.5
runs. A minor version: what the model is told and the tools it has changed.

### Benchmark

- The Armory can be built (`build_structure`, `find_sites`, `place_near`), and each map's
  rules say that weapons and armour stored there count toward net worth at their sell price
  (bows 15, crossbows, maces, swords and metal armour 30, spears 10, pikes 18, leather armour
  12). Before, the rules said they add nothing and no armory could be built; the score
  always valued them. The game reference's equipment chains and workshop costs, which only
  military benchmarks showed, are now part of every run's prompt.
- New tool `set_workshop` chooses what a fletcher (bows or crossbows), poleturner (spears or
  pikes) or blacksmith (swords or maces) makes, and reads the choice back from the reader's
  new `selected_workshop`. `inspect_building` reports what a workshop is making and will
  make next, and waits up to 3 s for a panel instead of 1 (panels show about 0.6 s after
  the click).
- Tile targets work anywhere on the map. `build_structure` and `demolish_building` move
  the camera to a tile that is off screen. When choosing a Stockpile, Granary or Armory
  centres the view on the first one, `build_structure` returns to the tile through a game
  bookmark, since the minimap does nothing in placement mode. Claude Haiku 5.5 lost its
  iron mines to off-screen tiles, and Claude Opus 5.5's and GPT-6.1 Sol's storage away
  from the first stockpile and granary failed this way. `save_view` keeps 8 views; slot 9
  is the harness's.
  `place_near` refuses a Stockpile, Granary or Armory against another anchor while one
  stands, without input, and names `expand_storage` or the armoury anchor instead: in a
  1.6.0 trial GLM 5.3 Flash's Granary against the keep stopped with "call it again".
- Tiles are clicked where the game draws them: raised ground is drawn higher, about a
  screen row per 8.7 units of terrain height. On Oasis by the Sea's plateau at height 130,
  the flat projection clicked the cliff below; the harness then reported the wrong tile
  and spent retries.
- `find_sites` searches around any map tile (`tile_x`/`tile_y`). When the view has no spot
  on a building's own ground (stone, iron ore, oil, oasis grass, trees), it also searches
  the nearest such ground on the map.
- Spots the harness chooses, and `build_structure` targets, keep one tile of open ground
  around granaries and armories (`access: touches_storage`); a granary may still touch a
  granary and an armory an armory.
- `market_trade` reports a trade's gold at the market's price, so taxes landing during it
  no longer hide its cost (25 cheese Kimi K3 bought showed as 37 gold, not 200). It waits 5
  seconds for a trade to show instead of 2, after two of Kimi's trades stopped with
  nothing bought.
- Four replies without a tool call in the last game minute let the rest of the budget
  pass instead of ending the run, which had cut GLM 5.3 Flash's run 5 game seconds short.
- The prompt explains the red no-entry sign over a building: no worker is free for it, or
  workers cannot reach it (closed in, or cut off from the keep). Kimi K3 said in its
  interview that it was never explained.

### Harness

- Rounds: every agent run on a benchmark plays on the version of that benchmark's last run,
  recorded in `benchmark-rounds.json` (Oasis by the Sea at 1.5.1, Large Barren Desert at
  1.5.6). `npm run episodes` plays an earlier round's version from a git worktree of its
  commit, with that version's host on the next port and its own runner; `--new-round` plays
  on the checkout's version and moves the round there once the run is valid.
- `npm run episodes` copies the game machine's helpers and reader sources from the version a
  run plays and rebuilds the reader when they differ, instead of refusing until they are
  synced by hand.
- A run overlay on the game machine's screen for people watching: the model and benchmark,
  the game time used and left as a progress bar, and net worth, gold, people, popularity,
  turns, tool calls and cost. It is a separate window that takes no focus and lets clicks
  through, so the agent's screenshots and the run videos do not show it.

## [1.5.6] - 2026-10-12

Prompt fixes before rerunning every model on Large Barren Desert. A patch at the maintainers'
choice, though what the model is told changed on both maps.

### Benchmark

- Ox tethers belong beside the quarries: an ox walks from its tether to the quarries near it,
  loads the stone, carries it to the stockpile and walks back, and the farther the stockpile,
  the more tethers it takes. Kimi K3 put five tethers beside the stockpile, about 100 tiles
  from its quarries, and no stone arrived in over 7 game minutes; every other run had put
  them next to the quarries.
- The score: net worth counts most, then population and popularity (no weights given), and
  every model plays the same save for the same game time, so there is no point at which the
  economy is big enough. Before, all three counted with their weights not given, and Claude
  Sonnet 5.5 and Claude Haiku 5.5 stopped building early on Large Barren Desert. The
  objective says the same.
- The sell prices in each map's rules list pitch 10 and wheat and hops 8 each, which were
  missing; Kimi K3 had taken wheat and hops for worthless.
- The game reference and the rules say that new peasants stop arriving while 24 stand idle,
  and that jobs for them let more come: every model's population stalled there in the 1.5
  runs.
- The full-stockpile note adds that goods still to come, such as the rest of a starting
  package listed at the top left of the screen, wait outside. Claude Sonnet 5.5 read that
  list as a stale wood count and did not make room for 8 game minutes.

## [1.5.5] - 2026-10-12

Placement fixes after Kimi K3's Large Barren Desert run, whose first Marketplace was built
but reported refused. Runs on 1.5.4 that never met these cases play the same.

### Benchmark

- One more of the player's own buildings of the placed type, from the reader's counts by
  type, confirms a placement (`evidence: own_buildings`), even when a refusal message shows:
  the stockpile-locating click's "Needs to be placed adjacent to the stockpile." reappeared
  0.4 s after a Marketplace click that built it, while the starting deliveries hid its cost,
  and the Marketplace was reported refused.
- A second Marketplace is refused before the menu is touched (`already_built`, with
  `market_trade` as the remedy). The game allows one; choosing it again centred the view on
  the first, and later clicks placed nothing.
- `place_near` and `expand_storage` aim each tile-map spot through the camera as it is at the
  click, not as it was when the map was read. Kimi K3's two `expand_storage` clicks matched the
  stockpile's flush spots seen through a camera one tile away, and both were refused without a
  message. When every spot the map gave is refused that way, they now probe the view from the
  anchor outward instead of stopping (`method: tile_map_then_probing`).
- `build_structure`'s closing right-click goes near the top of the view when selecting moved
  the view and left the last target off screen; it had been sent off the window, and the call
  failed with "Coordinates must be inside the game window", leaving placement mode on.

## [1.5.4] - 2026-10-11

A patch at the maintainers' choice, though what the model is shown changed on every map: a
reminder after long waits, and trees told apart from cacti.

### Benchmark

- `wait_and_observe` reminds the model once 3 game minutes have passed with no economy
  action (building, placing, storage, demolishing, trading, taxes, rations or a
  `game_action`; camera moves and inspecting do not count): it says how long the model has
  only waited and read, and that it may be time to do something else. Claude Haiku 5.5 waited
  10 game minutes on Large Barren Desert for wood its woodcutters never delivered.
- Trees are told from cacti. Both are an organism on a trunk tile in the game's tile data,
  but only a tree has a ring of 0x2000 tiles around it within 3 tiles (live on both maps on
  2026-10-11: every palm on Oasis by the Sea had one, no cactus did). `find_sites` counts only
  trees for woodcutters, and the reader's map summary draws cacti as their own category, so
  `map_overview` lists no groves of them: on Oasis by the Sea 114 of the 204 tiles it called
  trees were cacti, and all 154 on Large Barren Desert.
- The Large Barren Desert rules no longer say trees grow there singly. The map has only
  cacti; the rules now say nothing about wood.

## [1.5.3] - 2026-10-11

Comparable with 1.5.0 to 1.5.2 on Oasis by the Sea; the Large Barren Desert rules changed.

### Benchmark

- The Large Barren Desert rules gave the starting package as 5,000 gold, wood and 55 meat,
  worth about 5,400, all arrived within 27 game seconds. It also holds 50 stone, 15 iron,
  20 pitch, 20 ale and more wood, about 6,500 in all, and that part waits until the
  stockpile, full of wood, has room. The live check missed it because nothing freed the
  stockpile; a GLM 5.3 Flash run on 1.5.2 received it within 90 game seconds. The rules now
  say so.

### Harness

- Saving the finished game failed on Large Barren Desert ("no save file appeared"): the
  click on the Save dialog's name field put the cursor inside the long loaded name, so
  clearing it left "rt" behind and the game saved under the new name plus "rt". The runner
  now moves the cursor to the end of the name before clearing it.

## [1.5.2] - 2026-10-11

Comparable with 1.5.0 and 1.5.1: nothing an Oasis by the Sea run sees changed.

### Benchmark

- A second scored scenario, *Large Barren Desert construction*, on the save "Large Barren
  Desert benchmark start" (the start of the person's reference game on that map): the Oasis
  rules with the map described from the save, read live (a desert with no farmland, single
  trees, stone far west of the keep and iron east of it; 5,000 gold, wood and meat as the
  starting package), and its own objective file.

## [1.5.1] - 2026-10-11

Comparable with 1.5.0: runs on the profiles that 1.5.0 accepted send and play the same.

### Harness

- Moonshot profiles take Kimi K3's reasoning levels, `low`, `high` and `max`, sent as its
  `reasoning_effort`; before, Moonshot took only `default`, which sends none and which
  Kimi K3 treats as `max`. Kimi K3 has no `medium`, so other levels are refused.

## [1.5.0] - 2026-10-11

Comparable within itself only: `market_trade` sells in the game's own steps and never
more than asked, and its description says how the game trades.

### Benchmark

- `market_trade` sold more than asked when a good was plentiful: the game sells 20
  units a click while 100 or more are in stock and 10 from 50, not 5, so a GLM 5.3 Flash
  run that asked for 20 lots of its 225 wood sold all 225, and another sold 105 for 10
  lots. Seen live on wood, stone and apples: a purchase is always 5 units a click, a
  sale 20, 10 or 5. The tool now trades one click at a time in those steps up to
  `lots` × 5 units and stops, saying which step to ask for, when the next step is
  larger than what is left. A click counts once the reader shows its trade within 2
  seconds: from one sample to the next the stock or the gold moved by exactly its units,
  or the gold did since the click, also with the month's taxes (the keep's tax figure)
  on top. A trade changes both at once while a delivery or the taxes change one, so
  neither hides a trade nor passes for one; the stock is not compared with the click's,
  because a woodcutter unloading a plank a sample adds up to 5 in half a second. In
  three short live checks a purchase that landed in the very sample of the month's
  taxes and a delivery (gold +17, stock +6) had been missed, and the first time blamed
  on storage room. A stopped purchase now blames gold or room only when the reader
  shows it short of them. The result gives the units traded
  and the clicks. The description no longer says food trades in lots of 10: food is
  bought 5 units a click like the rest.

### Harness

- Model profiles have a `max` reasoning level, the endpoint's highest effort as
  Artificial Analysis reports models: Claude's own `max` effort (which Pi would otherwise
  send as `high`) and OpenRouter's `xhigh`. Runs record it with their model settings.

## [1.4.0] - 2026-10-11

Comparable within itself only: the observation stats leave out goods with none stored,
and the tool definitions and the preparation request are sent in fewer tokens.

### Benchmark

- The preparation request carries the gameplay tools, so the first gameplay request
  starts with it and the provider's prompt cache covers it: in a GLM 5.3 Flash run on
  1.3.0 that request read 26k tokens uncached, a third of the run's uncached input. The
  preparation message now asks the model not to call tools yet, and a reply that calls
  one is asked again.
- The `goods` in each observation's stats list only the goods in stock; about 20 empty
  ones went out with every observation and stayed in the conversation. The prompt says
  a good not listed has none; `status` and `get_inventory` still list every good.
- Tool parameters that take one of a list of names (buildings, goods, anchors, keys,
  sides and the like) are plain JSON Schema enums instead of unions of literals, which
  spelled out each name as its own object: the 21 game tools' definitions went from
  about 24,500 to 18,500 characters, which every request repeats. The names and
  descriptions are unchanged.
- The construction guide image is made at 80% of its former size, 1530 × 2270 pixels
  instead of 1912 × 2838 (64% of the pixels; `tools/make-construction-trays.m`), with
  its smallest text still readable. A 1280 × 720 screenshot cost GLM 5.3 Flash about
  1,400 tokens, which puts the guide near 8,000 tokens before and 5,300 after, in every
  request of a run. The guide is private, so runs record its hash beside the version.

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
- The model's screenshots are scaled down to 1280 × 720 by default (new run setting
  `screenshotWidth`, `--screenshot-width`; 0 keeps the window's own size): about 44% of
  the pixels and image tokens, with buildings, terrain and the HUD's figures still
  legible. GLM's wait for the first token had grown by about a second with every
  1920 × 1080 screenshot kept in the conversation. The bridge on the game machine scales
  the capture, and the host scales clicks back to the window.
- New tool `demolish_building`: removes one of the agent's buildings, given by map tile
  or pixel, with the game's own demolish tool, checked through the reader (the
  structure count falls). It counts as one action. Before, only raw `game_action`
  clicks could demolish, and nothing told the agent how.
- The prompt no longer tells the agent to place the granary near the keep, and says the
  ground close to the keep is limited and critical for buildings whose efficiency
  matters more there. In 31 of 32 recorded Oasis runs the granary went within 10 tiles
  of the keep's campfire, with hovels and some woodcutters beside it.
- Tools that act spend less game time on their own steps. Acting tools took 25–38% of
  the game budget in recorded runs, mostly waits between clicks rather than the clicks
  themselves. The clicks they send are unchanged:
  - `go_to_tile` and `navigate_minimap`, called before anything else in a reply has
    unpaused the game, make their minimap clicks with the game still paused (the
    game allows it) and unpause it only for the screenshot they return. Each minimap
    click had cost about 0.8 s of play, and the first `go_to_tile` of a run about 4 s
    more for reading the map.
  - `place_near` and `expand_storage` start reading the tile map while they select
    the building, instead of after. The read takes about 3 s on the game machine and
    was 19% of acting-tool time in a GLM 5.3 Flash run.
  - Tools that send input without looking at the screen (`place_near`,
    `expand_storage`, `center_on`, `go_to_tile`, `market_trade`, `set_tax`,
    `set_rations`) use the latest capture when it is under 20 s old, instead of taking
    a new one at the start of each call (about 0.25 s each at the 1280-wide
    screenshot size).
- A good's `room` in `storage` counts the empty piles, which take any good, at what one
  of its piles holds, and an empty granary adds its 250 to the granary room. The room
  was that of the good's own piles only, so it read as full while empty piles stood
  ready: a GLM 5.3 Flash run sold 40 wood at "room 1" with 13 empty piles, wood it
  had bought earlier and was waiting for. The prompt says what the room counts.

### Harness

- Claude's cache marks (through OpenRouter and Anthropic's own API) go on where the
  previous request ended and on the newest message, now that the conversation only
  grows between compactions, instead of before the oldest kept screenshot.
- `npm run episodes` recognises the game's main menu and the Load Game dialog from a few
  pixel colours of a capture (`tools/runner/screen_probe.py`, Pillow on the host)
  instead of waiting for the screen to stop changing, which the animated menu never did:
  every launch ran out a 90 s and a 15 s timeout. While waiting it clicks the screen
  centre once a second, which skips the intro videos and the promo splash: the menu came
  25 s after launch instead of 49 s. The save's name is typed with one
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
