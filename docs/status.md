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
- Samples thrown away, on 2026-10-15 on The Sinkhole, counted from the host's stream: with
  1.7.0's reader, 37 of 340 samples during GLM 5.3 Flash's game were `unavailable`, 12%
  while paused and 10% at speed 40, and between good samples with no tick between them only
  `managed_heap`'s used bytes (109 of 109 pairs) and now and then its collection count
  changed. With both reads sharing one reading of the heap (1.7.1), a stand-in that thought
  15 s a turn saw 1 of 638 (0 of 323 paused, 0 of 179 at 40, 1 of 56 in fast waits), all
  17 `status` and 17 `get_inventory` calls answered, and `managed_heap` kept updating.

**Control**
- Clicks, right clicks, drags (selecting units), mouse-wheel list scrolling, keys,
  `P` (for the host), camera zoom with `Z` and `X`, and game speed with `+` and `-`.
- The game-window capture excludes windows covering the game.
- Stop from the dashboard and from the control monitor, and the focus check that
  blocks input while another window is active.
- The run overlay, shown with a test status: on the screen above the game, absent from
  the game-window capture the agent sees, never active, with an empty input region, and
  with keys from the host still reaching the game. Not yet watched through a model's run.
- The runner's overlay feed for a round on an earlier version, on 2026-10-13 through
  Muse Wonder's run on Oasis by the Sea at 1.5.1 (checked over SSH, not on the screen):
  this checkout's `overlay.py` copied to the game machine before the run, one feed and
  one overlay process running, and the feed's clock, tool calls, cost and figures under
  a second old. A feed left by a start that failed earlier the same day was still
  running with its runner gone; feeds now exit after 60 seconds without a line.

**Tools**
- `market_trade` in the game's own steps (1.5.0), on 2026-10-11. Clicking the
  marketplace through the host on a saved game: a purchase is 5 units a click for every
  good tried (wood, apples), and a sale is 20 units while 100 or more are in stock, 10
  from 50, else 5 (wood, stone and apples; 103 sold 20 and 91 sold 10, 53 sold 10 and 46
  sold 5); purchases land about 0.45 s after their clicks at any pace and at the turn of
  the month. Then four 3-game-minute GLM 5.3 Flash checks from the 1.4.0 episode's end
  save, each told to make the same trades; the last, on the final code, matched the
  game in every one: 20 lots of 102 stone sold exactly 100 in 13 clicks (gold +700);
  5 lots of 120 apples sold 20 and stopped, saying the next click would sell 10 of the 5
  left; 20 lots of wood bought 100 in 20 clicks with the month's taxes landing among
  them (gold −363, that is −400 and +37); 10 lots of bread bought 50. The earlier checks
  had each missed one purchase that landed in the very reader sample of the taxes and a
  delivery. Before the fix, two runs that day sold 105 wood for 10 lots (494a5f78) and
  all 225 for 20 (cdecaf85). The simulated market in `economy.test.ts` covers the same
  cases and a purchase the game refuses while planks are being unloaded.
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
- Run against the live game through the harness's own tool code, without a model, on
  "Oasis by the Sea benchmark start" on 2026-10-12 (the changes of 1.6.0):
  - `build_structure` placed an Armory (from the Castle page), a Fletcher's, a
    Poleturner's and a Blacksmith's Workshop and a Marketplace, each confirmed by one
    more of its type in the reader's `buildings`. A tile read showed each footprint on
    exactly the tile asked.
  - New workshops make bows, spears and swords. Each panel's left button sets bows,
    spears or swords and its right one crossbows, pikes or maces. The building record
    holds the product in progress at +0x1bc and the next at +0x1be, as goods numbers 17
    to 22, which the reader now reports as `selected_workshop`. `set_workshop` set a
    Fletcher to crossbows from a corner tile of its footprint and read it back;
    `inspect_building` later showed it making crossbows. Asked for swords there, it
    answered `wrong_workshop`; given the Armory, `not_a_workshop`. In the first of four
    calls in a row no panel opened, so the click is now tried twice.
  - A 10-game-minute GLM 5.3 Flash trial on 1.6.0 (unversioned, run d41d24dc) played
    valid with no tool errors. It placed an iron mine that `find_sites` had found out of
    view (`moved_to_tile`), an Armory, and a Fletcher's Workshop that was moved one tile
    off it (`touches_storage`). It made 2 bows and a sword. Its `set_workshop` on a
    Fletcher opened no panel in two clicks; on its end save the same call worked at every
    try. A panel shows in the reader about 0.6 s after the click, so each click now waits
    4 s and a reader without readings is reported as such.
  - Armories, on "The Sinkhole start" on 2026-10-12: one holds 50 weapons and armour of any
    mix, counted singly. Buying a lot of each of the eight types stored 40; 20 spears and
    5 of six other types filled it at 50 (the record's amount and capacity at +0xb2 and
    +0xb6 read 50 and 50); then the market refused another lot of spears with gold to
    pay. GLM 5.3 Flash's armory held 11 bows, 25 spears, 11 swords, 2 leather and 1 metal
    armour at 50 and 50 too, and a person's test with 43 swords and 5 leather armour got
    "No space in the armory." for 5 more. An empty armory reads 0 and 0. A second armory
    away from the first was refused: "Needs to be placed adjacent to the armory." No game
    message reached GLM while its 14 workshops stood at a full armory: the game says "The
    armory is full, my lord" aloud (a person's observation), and spoken lines without
    text are not read, so the stats' `full` note stands in for it.
  - The 1.6.2 reader on a person's end save with 45 leather armour and 2 swords: the stats
    showed the armory at 47 of 50; with the game running, the blacksmiths' swords took it
    to 50, where the `full` note appeared, and `market_trade` then bought no swords and
    named `expand_storage`. In that crowded town the only two spots touching the armory
    also touched other buildings; `expand_storage` (kind armory) placed a second armory on
    one of them, and the stats read two armories with room 49.
  - A click on a building's middle can open a neighbour's panel: a Hovel in front of a
    Blacksmith is drawn over the Blacksmith's middle. `set_workshop` now checks the
    opened building against the tile map and then clicks the back corner of the
    footprint, which opened the Blacksmith.
  - Choosing a Stockpile, Granary or Armory in the menu centres the view on the first
    one of its kind. In placement mode the minimap does nothing, while going to a game
    bookmark works and keeps the building selected. A Stockpile given by a tile 40
    tiles from the first came back to its tile through bookmark 9
    (`moved_back_to_tile`), and the game then refused it for adjacency, as it should.
  - Tile targets off screen: the camera moved there with one minimap click and the
    building was placed (`moved_to_tile`).
  - Terrain height: a Hovel given by a plateau tile at height 130 was refused at its
    flat position (which showed the cliff below it) and four retries. The sixth click,
    15 rows higher, placed it on the very tile asked, while the tool reported another.
    With the height-aware projection, a second Hovel on the plateau went onto its tile
    at the first click, and one on low ground (height 8) did too.
  - `market_trade` bought 20 wood and reported `goldChange` −80 at the market's price.
  - `find_sites` with `tile_x`/`tile_y` listed spots around tiles out of view, and
    `build_structure` placed there.
  - The 1.6.2 round on The Sinkhole, seven models, 2026-10-12/13: all seven played the
    full 45 game minutes and every reported placement matched the game's final count.
    `expand_storage` (kind armory) placed second armories in three runs and gave the
    no-room remedy in one; `set_workshop` set fletchers, poleturners and blacksmiths by
    tile and by pixel, though a building in front (three times the Armory, once a Hovel)
    still opened instead four times. Seen live and fixed in 1.6.3 (below): `place_near`
    could not place a first Armory (three calls threw "Game image expired" for Claude
    Haiku 5.5, one for Kimi K3, and GPT-6.1 Sol got 20 probes and "No room around your
    armory"); apple purchases stopped three times as not shown in the reader, and in the
    one checked (Claude Opus 5.5) the reader had shown it, with apples eaten and part of
    the taxes in the same sample; GLM 5.3 Flash's end-of-run save typed only a space as
    its name. The other six saved normally.

**Runs**
- 1.7.0, on 2026-10-14: three episodes through `npm run episodes` on the game machine,
  with a scripted stand-in for the model (an OpenAI-compatible endpoint on the host that
  answered with set tool calls), on "Oasis by the Sea benchmark start" (12 game minutes),
  "Large Barren Desert benchmark start" (4) and "The Sinkhole human", the person's town of
  506 at its end (8). All three were valid and used their whole budget.
  - Fast waits: 11 waits played 1,062 game seconds in 395 real seconds at 90.9 to 92.2
    ticks a second (speed 90), on the start maps and on the 506-person town alike. Every
    one measured 39.2 to 40.3 again before its last tick, none needed a correction, and
    no message showed on screen or in the reader's messages when the speed changed. The
    Oasis episode's 12 game minutes took 7 real minutes.
  - Warnings: food low ended a 120-second wait after 117; popularity 10 down (taxes at
    their highest, factor −24) ended a 300-second wait after 30, its fast wait back at 40
    first; gold below 500 led the observation after a purchase left 50. The popularity
    warning then said 81 beside stats showing 68, since the game plays on while a wait
    slows down; warnings now use the reporting observation's values. In the 506-person
    town, food hovering near two months brought "Food is low" three times in 8 game
    minutes, two of them ending waits after 19 game seconds; with food and gold warned of
    again only after a recovery, the same 8 minutes brought it once, as food went from 32
    to 108 and back to 36, and every wait ran its length.
  - `find_sites` for storage, on "Oasis by the Sea benchmark start": asked 20 tiles from
    the granary, it searched beside the granary and gave two flush spots, both placed; a
    stockpile the same; the first armory by the usual search, and a second asked 30 tiles
    away offered flush with the first and placed. None was refused as not adjacent.
  - A pixel target from a screenshot followed by a 60-game-second wait was refused as
    older than 40 game seconds of play. `flat_view`'s two images had no "Game Paused"
    banner, on Oasis by the Sea and in the Sinkhole town; in the flat image palms and
    bushes shrink to stumps. Two `build_structure` calls in one reply, a Hovel first in
    each, both placed.
  - The interview changes: `religion` 0 in the factors once a chapel stood (+2 two game
    months later), `status` counting the buildings as placed, `inspect_building` by tile
    reading a chapel (no worker fields) and a woodcutter (1 of 1 workers, keep access),
    `set_workshop` by tile setting a new fletcher to crossbows, and `find_sites` on Large
    Barren Desert saying no woodcutter spot has trees, around a tile and in the view.
    `expand_storage` with the sides that stopped GPT-6.1 Sol's calls placed 3 and 2
    stockpiles; the view did not jump, so the way back to the anchor's view was not used.
  - The runner rebuilt the game machine's reader (all 13 build steps, in 7 seconds) when
    it had no record of its sources, and nothing when they matched. The Oasis episode's
    video rendered in the background after the runner went on (4:18, its recording
    compacted from 1,107 to 81 MB, the marker then removed), and the host held its
    interview after the runner exited. Saving took 96 to 124 seconds from the run's end,
    against 237 to 256 for that day's 1.6.3 desert games, with its 95 to 103 keys at 0.71
    seconds each. Typed as one run in one bridge request, the 95 keys of an Oasis save took
    13 seconds and the save 37 from the run's end, the name complete at the first attempt;
    the load's 32 keys likewise, the Load Game dialog to the loaded map in 12 seconds
    against 26.
- 1.7.0 with three models, on 2026-10-14: 10 game minutes each from the benchmark starts,
  GLM 5.3 Flash on Oasis by the Sea, GPT-6 Luna on Large Barren Desert and Claude Haiku
  5.5 on The Sinkhole, each interviewed after; all three valid. They cost $0.050, $0.031
  and $0.024, with 77% (GLM's requests moved between its two providers), 96% and 97% of
  their input tokens read from the cache.
  - Fast waits: 1, 3 and 9 waits played 67, 115 and 274 game seconds in 26, 48 and 121
    real seconds, none needing a correction, and saved 24, 38 and 84 seconds: 3, 4 and 12%
    of the runs' real time. GLM's three waits for wood had `until` conditions and ran at 40.
    Loading took 11 to 14 seconds from the Load Game dialog, against 19 to 27 on 1.6.3.
  - In Luna's run a popularity warning ("Popularity fell from 77 to 66 since your last
    observation.") ended a 60-second wait after 58; `status` counted the buildings and
    showed religion and the inn at 0 once a chapel and an inn stood; `inspect_building`
    read ten buildings by tile, two with the warning that another building's panel had
    opened; `expand_storage` placed two stockpiles, the game refusing two of its spots as
    not adjacent, as in 1.6.3. No placement in the three runs was refused for a route.
  - Saving: GLM's and Luna's saves failed ("keys: Device disconnected") and Haiku's went
    through. The bridge answers one request at a time, and a save name's run of 100 or more
    keys took over 12 seconds: the status line the host sends every second waited behind
    it past its own 12-second timeout, which ended the connection. Haiku's 75 keys took
    about 9. Since a request's time starts when the bridge gets to it (51651b0), a stand-in
    run on Large Barren Desert with a save name of the full 32 characters typed its 112
    keys in about 15 seconds and saved 42 seconds after the run's end.
- Clicks a tile off, and `expand_storage` making up for them, on 2026-10-14 with the stand-in
  on "Large Barren Desert benchmark start". One stockpile asked against each side and then
  three: 8 of 15 probes were refused ("Needs to be placed adjacent to the stockpile.") and
  none went on the +x side. The reader's pile positions showed every placed stockpile one tile
  further along +x than aimed, and a tile read showed two hovels placed by tile one tile off as
  well, one of them in x and y; all 20 buildings Claude Haiku 5.5 placed by tile on The
  Sinkhole stood where aimed. The game's own screen-space position of the centre tile
  (`GameMap.screenCentreTileScreenSpaceX/Y`, read once for this check) differed from the
  reader's whole-tile camera centre in those views. After the fix (f9b213f), the same
  scenario refused 2 of 9 probes: the first stockpile on the +x side once, placed by its
  corrected retry, and one spot later lower on the screen, where the error was not the one
  measured near the centre; the calls after the first placed at their first click, and all 7
  stockpiles stood flush with one before them.
  - The tile under the pointer: the engine keeps it, and a pointer move without a click
    updates it, paused or running, with terrain height counted (over a dune of height 38 it
    named a tile further down than flat ground would). After clicks it named the tile each
    hovel had landed on, one off from the tile aimed. With every placement click aimed by it
    (the stand-in on the same start, 5 game minutes): three hovels and two woodcutters by tile,
    in the start view and in another, two stockpiles by `expand_storage` (one on the +x side)
    in 2 probes, two stockpiles at `find_sites` spots, a granary by `expand_storage` and two
    hovels in the stockpile's view were all placed at their first click, and a tile read showed
    each footprint exactly where asked, the stockpiles flush in a row.
  - Over a building's image the game's tile under the pointer is one of that building's: a
    grid of pointer moves over a hovel with a fletcher's workshop in front of it showed the
    fletcher's tiles over the hovel's front corner, and the hovel's tiles over open ground
    behind it. Demolishing that hovel by its far corner, behind the fletcher, aimed the pointer
    three times without reaching a hovel tile and its click demolished the fletcher. Now
    `demolish_building` takes any tile of its building, tries the back corner and the middle
    after the tile asked, clicks only where the game shows one of them, and reads the view's
    map afresh after input (its map had been from before the hovel stood): the same demolish
    removed the hovel and left the fletcher and the hovel behind it standing. In the same run
    `set_workshop` by tile set the fletcher to crossbows and `inspect_building` by tile read the
    hovel.
- 1.7.0 with three models again, on 2026-10-14, after aimed clicks (3b7ddd4): 10 game minutes
  each, GLM 5.3 Flash on Large Barren Desert, GPT-6 Luna on The Sinkhole and Claude Haiku 5.5
  on Oasis by the Sea, each interviewed after; all three valid, about $0.07 together. Every save
  went through, the desert's 106 keys too.
  - Aimed clicks: 50 of 55 placements went through, 19 of 19, 17 of 17 and 14 of 19; Haiku's 5
    were refused for its own targets (a granary not touching the one standing, a hovel in the
    signpost's zone, farms off oasis grass or with no open side). No aim failed to reach its
    tile and no demolish was `covered`. GLM's save, loaded and read, had all 19 footprints on
    the tiles asked. Luna's `set_workshop` and Haiku's `demolish_building` by tile went
    through. Placements took 6.8, 8.2 and 7.4 seconds each, camera moves included.
  - Fast waits saved 89 and 92 seconds in GLM's and Haiku's runs; Luna never waited. During
    Haiku's run the overlay showed "thinking · paused" while it thought, "acting · speed 40"
    and its waits rising to speed 60 or 75 and back to 40.
- 1.7.0 with three models a third time, on 2026-10-14, with `status`'s production readout
  (58a4cd3): 10 game minutes each, GLM 5.3 Flash on The Sinkhole, GPT-6 Luna on Oasis by the
  Sea and Claude Haiku 5.5 on Large Barren Desert, so that each model has played each map once;
  each interviewed after. All three valid, about $0.08 together, every save through.
  - The production readout reached only Luna, which called `status` 7 times and reasoned from
    it ("zero production from the iron mine and dairy"). GLM and Haiku called `status` 0 or 1
    times a game in all three rounds; both wondered mid-game whether their quarries, mines and
    fletchers delivered, and asked for production figures again in their interviews. Luna took
    its orchards for poor ones when three had just been built beside the first: the rate per
    building had divided the first one's apples by four. Both changed since (next entry).
  - 36 of 37 placements went through; GLM's iron mine lacked wood. One aim missed: a GLM hovel
    aimed at (356, 461) on The Sinkhole's slope near the top edge, where the game showed (360,
    465) under the pointer. The tile was drawn off screen, so the click had gone to its flat
    position, and the 4-tile offset there was past the 3 the aim followed. Changed since
    (next entry).
- The fixes from that round (a2cfb69), on 2026-10-15 with the stand-in on "The Sinkhole start":
  - GLM's case replayed: a woodcutter at (363, 481) moved the camera there, then the hovel at
    (356, 461), whose flat position lay near the top edge, moved the camera again and was
    clicked mid-screen at (683, 369) with the game's tile under the pointer the one asked;
    `inspect_building` there opened a hovel. In a second run, from the woodcutter's view
    again, `inspect_building` and `demolish_building` on (356, 461) each moved the camera
    (centred on (350, 457) after) and opened, then demolished, the hovel.
  - Production in every observation: two woodcutters built at about 0:28 and 1:22 showed 0
    delivered, both `built_in_window`, at 2:29 and 2:38; at 4:09, the window from 1:09, 12
    wood, 4 a minute and 2.1 per woodcutter over their 5.8 woodcutter-minutes, one built in
    the window; at 5:10, 24 wood, 8 a minute and 4 per woodcutter. `status` gave the same.
- 1.7.0 with three models a fourth time, on 2026-10-15, with production in every observation
  (49fee97): GLM 5.3 Flash on Oasis by the Sea and GPT-6 Luna on Large Barren Desert, 10 game
  minutes each; Claude Haiku 5.5's game on The Sinkhole came after the fixes below.
  - GLM never called `status` but read production from its observations throughout: it saw its
    woodcutters and iron mine still at 0 after 2 minutes, added up its food rates (apples 2.3 and
    cheese 3 a minute), and inspected a bakery and brewery that stayed at 0.
  - Luna's first game ended at 9 min 46 s of its 10: the provider's stream ended before its last
    event ("Stream ended before a terminal response event"), an error the harness did not retry;
    the runner played the episode again (valid, net worth 5,792). Retried since.
  - In that first game the readout gave Luna's first iron mine 5.9 iron a minute: the desert's 15
    starting iron had come in while the mine stood. Luna took the mine's real rate later for the
    ore running out. The reader reads the starting goods still to come since (next entry).
- The starting goods still to come, on 2026-10-15 with the stand-in on "Large Barren Desert
  benchmark start": the reader's new `starting_goods_to_come` read wood 33, stone 50, iron 15,
  pitch 20 and ale 20, as the game lists them at the top left, and stayed so while full piles kept
  them out; after a second stockpile took in the wood, stone and iron, it listed only the pitch and
  ale. On "Oasis by the Sea benchmark start", loaded right after a desert game, it was empty once
  that map's package was in. With Luna's early iron mine standing as the 15 iron came in, the
  readout showed the iron under `other_rises` and the mine at 0 until its own first iron at 3:53.
- Claude Haiku 5.5 on The Sinkhole, on 2026-10-15 after those fixes (1954444), 10 game minutes,
  interviewed after: valid, net worth 2,450, about $0.02. All 20 placements went through, none
  missed its tile. The start lists no starting goods, and the list read empty in all 34
  samples, the game after a desert game that ended with pitch and ale still listed. Its
  observations carried production from the woodcutters' first 0 to 16 to 24 wood a minute.
- Open jobs, 8 placements a call and hovels kept off the keep, on 2026-10-15 with the stand-in:
  - The workers fields of the building records, found on Claude Haiku 5.5's Sinkhole save and the
    desert start against `inspect_building`: 0xc6 needed, 0xc8 there, 0xca open. Every full
    woodcutter, orchard, dairy farm and iron mine matched its panel, and a new woodcutter on the
    desert start with nobody idle read 1, 0 and 1 in both. With four iron mines and four
    woodcutters there, the stats showed population 10 of housing 10, idle peasants 0 and
    `open_jobs` 2 (the reader's jobs: 12 needed, 10 filled), the two woodcutters with no worker.
  - One `build_structure` call placed four woodcutters and four hovels by tile on Oasis by the
    Sea's start, 8 of 8, none off its tile.
  - `find_sites` for hovels with no tile on that start, nearest the view centre on the keep, had
    listed spots flush against the campfire courtyard; now its four spots stood in a row 6 tiles
    from the keep and courtyard, as the tile map read after showed.
  - The block layout: five hovels and five woodcutters from `find_sites`, built in one call each
    on that start, stood in blocks of two, two and one hovels and of three, one and one
    woodcutters, none wider than two footprints, with a tile of open ground between blocks (the
    tile map read after); before it, the four hovels of the run above had stood in one column.
- GLM 5.3 Flash on The Sinkhole on 1.7.1, on 2026-10-15, the round's first game there (45 game
  minutes, recorded and interviewed): valid, net worth 9,319 (5,084 on 1.6.2), population 98,
  81 turns in 43.5 real minutes, $0.14 with 93% of prompt tokens cached. 72 of 84 placements
  went in, none off its tile; none of its 57 host observations lacked the reader's values. Its
  1.7.0 game before it was stopped at 34 turns for the reader fix and does not count.
- `status`'s production readout, on 2026-10-14 (stand-in on "Oasis by the Sea benchmark start",
  5 game minutes): three woodcutters and a marketplace built by tile, 20 wood bought, then
  waits. At 50 game seconds the woodcutters showed 0 delivered and the starting bread still
  arriving showed as an other rise; after the purchase they still showed 0, the 20 bought left
  out; at 3 min 40 s they showed 36 wood in the last 3 game minutes, 12 a minute and 4 per
  woodcutter, as the stock had risen.
- The run overlay's speed, on 2026-10-14 (stand-in on Oasis by the Sea, 3 game minutes): the
  phase line went from "waiting · speed 40" through 45 to "speed 90" and back down to 40 in
  each fast wait, as the + and - presses went; panels rendered from the live status showed it.
- The prompt cache key for Meta's models, on 2026-10-13: Muse Wonder's run on Oasis by
  the Sea at 1.5.1, its host given the key by `round-preload.ts`, read the cache on all
  106 requests, 96.9% of its input tokens. Its run the same morning without the key
  missed on 3 of its first 11 requests (67% of input tokens cached).
- The Large Barren Desert scenario's map facts, on 2026-10-11, from "Large Barren Desert
  benchmark start" loaded without an agent: 5,000 gold, 192 wood (the stockpile's four
  piles of 48 full) and 55 meat about 27 game seconds after load, with the rest of the
  package listed at the top left as still to come; the granary and stockpile already
  standing; and from the whole-map summary no oasis grass, stone about 100 tiles west of
  the keep and iron ore about 60 east. The summary's 154 "tree" tiles were cacti: two
  woodcutters of Claude Haiku 5.5 placed among them delivered no wood in 30 game minutes.
  In a GLM 5.3 Flash run the rest
  (50 stone, 15 iron, 20 pitch, 20 ale) arrived within 90 game seconds, once building had
  used some wood; the total wood (about 245) is read from the screen's list, not counted.
- Placing next to the desert stockpile, on 2026-10-12, by replaying Kimi K3's clicks on
  "Large Barren Desert benchmark start" through the host without an agent: with the camera
  on the stockpile (tile 506,373), the first flush Marketplace click built it on the
  stockpile's up-right side, and the reader's own-building counts showed it (type 26) at
  the next check. The tile map then had it and offered `expand_storage` two flush spots
  (tiles 513,375 and 508,380). Kimi's run had clicked pixels that match those spots seen
  through a camera one tile away, and the game refused both without a message. Clicked
  again here, the first of Kimi's pixels placed a pile and the second was refused, so a
  one-tile error can go either way; the map's second spot then placed a pile (its first
  was covered by the new pile by then). Kimi's recorded frames show that
  choosing the Marketplace again with one standing centres the view on it, and that later
  Marketplace clicks placed nothing.
- Ox tethers away from the quarries, on 2026-10-12 (Kimi K3, benchmark 1.5.5, run 8ef9720b,
  stopped at 9 game minutes): five tethers beside the stockpile, about 100 tiles from three
  staffed and working quarries, delivered no stone in over 7 game minutes; the oxen stood at
  their tethers. In every other run the tethers stood 4 to 12 tiles from a quarry and stone
  arrived. Seen in that run, not tested apart; from 1.5.6 the prompt says to build tethers
  beside the quarries.
- New peasants stop arriving while 24 stand idle: in the 1.5 runs on both maps the
  population stopped with 24 idle, and grew again only when jobs took some of them
  (Claude Sonnet 5.5's four iron mines brought 8 people on Large Barren Desert, GPT-6 Luna's
  quarries 5 to 11 each time). Seen in runs, not read from the game; the prompt says it from
  1.5.6.
- Timed runs with game-time budgets, pausing during thinking, compaction and the
  final pause, with several models including Kimi K3 and GLM 5.3 Flash.
- Unattended episodes end to end: launch, load by name, run, scorecard, close.
- The 21 runs in the evaluation (seven models on each of Oasis by the Sea, Large Barren
  Desert and The Sinkhole, benchmarks 1.5.0 to 1.6.2, 2026-10-11 to 2026-10-13), from
  their event logs:
  - All played their whole budget (33⅓ game minutes, 45 on The Sinkhole) except GLM 5.3
    Flash's on Oasis by the Sea, which four replies without tool calls ended about 5 game
    seconds early (from 1.6.0 the rest of the budget passes instead). None was cut short by
    the game.
  - The host's game-speed step ran before every budget and measured 39.4 to 40.4 ticks a
    second. The saves already run at 40, so it pressed no key.
  - `observe` waited out the rest of the minimum turn 31 times in 14 runs and said so in
    its result. Every reply's last tool result carried the "Game time left" line.
  - The collector watchdog broke 16 stalls in 12 runs. Each showed the wrapped
    thread-stack total of the Wine bug (see Reader), and each forced collection set the
    collection count moving again.
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
- The game on the test laptop's NVIDIA GPU, on 2026-10-13 with Ubuntu kernel 7.0.0-38
  and NVIDIA driver 610.57.04, the harness disconnected except where named: it reached
  the main menu with DXVK (three launches on Proton Experimental 11, one on Proton
  9.0-4) and with WineD3D/OpenGL, and `nvidia-smi` listed it as a graphics client with
  about 3 GB. A dry run loaded "The Sinkhole start" 52 seconds after launch, and a
  45-game-minute do-nothing run on it scored 2,195 at 39.9 ticks a second, as on the
  Intel GPU the day before. In September, with kernel 7.0.0-31, the game stalled at the
  end of loading on the NVIDIA GPU with both APIs, on Proton 9.0-4 and Proton
  Experimental alike, with or without the reader. The cause was not found. Proton is
  ruled out (the same Proton 9.0-4 build stalled then and loads now), and so are the
  game, the NVIDIA driver, Mesa, Mutter, Xwayland and the Steam client, which did not
  change in between. The kernel update is the likeliest fix; the only other change near
  the display path was FreeRDP, which GNOME's remote desktop uses.
  Agent runs have played on the NVIDIA GPU since: the 26 evaluation games from 2026-10-13
  10:39 UTC to 2026-10-14 (the 1.6.3 rounds on Oasis by the Sea and Large Barren Desert, and
  games on 1.5.1, 1.5.6 and 1.6.2) all ran their full game time at the first attempt.

## Tested in code only

- The 1.7.3 "(no arms)" benchmarks, not yet played: each map's no-arms rules read its
  map's rules with the weapon prices left out and the no-arms sentences in, the three
  maps' own rules come out byte for byte as before, and `arms_counted` follows the rules
  file (`benchmark-rules.test.ts`); results list weapons at 0 and say so
  (`results.test.ts`); a weapon sale's `netWorthChange` adds its gold only when weapons
  are left out (`economy.test.ts`); the dataset timeline values them at 0
  (`tools/dataset/test_dataset.py`).
- The 1.7.2 changes, not yet tried in the live game:
  - The stockpile's last spot (`blocks_stockpile`) counted only where `expand_storage`
    could place one (`tile-map.test.ts`): a free spot people cannot walk to is no room, a
    building that touches the last spot and so closes it is refused while one beside it
    that leaves it usable is not, and the rule holds for storage placed flush with its kind
    and for a stockpile partly outside the area read. Not known: whether this would have
    kept room in the four 1.7.1 games on The Sinkhole that ran out (their tile maps were
    not logged; their end saves are in the run folders).
  - `build_structure` retries within `reach` of the target, `moved` in words, and
    `nearestFit` with its remedy past reach (`model-observation.test.ts`).
  - In-stream server errors without a status code retried (`controller.test.ts`, with
    GPT-6.1 Sol's message of 2026-10-15).
  - `game-session.py` ending a Steam launch left behind without the game before a launch,
    leaving one that is still starting, and ending one left after closing
    (`tools/ubuntu/test_game_session.py`, on the process table of 2026-10-15).
- The 1.7.0 changes (`game-speed.test.ts`, `session.test.ts`, `controller.test.ts`,
  `device-lifecycle.test.ts`, `protocol.test.ts`, `anchors.test.ts`, `tile-map.test.ts`,
  `model-observation.test.ts`, `game-save.test.ts`, `video.test.ts`, `warnings.test.ts`,
  `tools/video/test_render_queue.py`, `tools/dataset/test_dataset.py`), of which the live
  test on 2026-10-14 (see Runs above) showed the normal course; the cases below it did not
  reach stay tested in code only:
  - [Fast waits](how-it-works.md#fast-waits), on a simulated game clock: waits of 3 to 300
    game seconds end at speed 40 before their last tick, short ones press nothing, a lost
    `-` press and a lower top speed are set right by the end measurement, dead speed keys
    turn fast waits off, and a run stopped in a fast wait presses the speed back down after
    its final pause, or without one after an operator stop; a fast wait that fails partway
    (the reader gone) recovers to a measured 40 or ends the run; with key presses of 60 to
    300 ms and reader samples 200 ms late, about one wait in a hundred ends past its last
    tick, by under a game second; the device refusing game input while the speed is
    unconfirmed. Not known from the live game: whether the speed keys work while paused
    (the restore after a run stopped mid-wait presses them so), how late reader samples
    reach the host (the end margin held in all 11 live waits), and that a tick is the same
    game at 90 as at 40.
  - A screenshot's age counted in real time when there is no game-clock reading.
  - The tile of open ground kept around stockpiles (the keep may touch them), the last
    spot for another stockpile kept free (`blocks_stockpile`), also after a target was
    refused there, and a stockpile, granary or armory target moved or retried only flush
    with one of its kind.
  - [Routes to the keep](tools.md#build) (`no_route`, `cuts_route`): walled-in spots
    refused, a gap, the courtyard or the read area's edge giving a way, water and
    mountains closing one, a footprint on a building's only way in refused, churches
    needing none, and the searches that skip most of the work agreeing with a plain
    search of the whole area on random walled towns with nooks. Not known from the live game:
    whether people cross trees, bushes and farm fields (counted walkable), and whether the
    game's own keep access matches these ways.
  - `build_structure` waiting after its closing right-click for the reader to show
    placement mode ended, so a call straight after it selects the same building again
    (reproduced with a reader sample that lags the right-click).
  - The episode runner: the video rendered in the background, one at a time behind a lock,
    its marker removed on a stop and recognised by packaging when left by a killed render,
    a hung step ended, and a render that cannot start never failing the episode; the last
    interview left to the host. The runner's own waits
    for the host's interviews have no automated test (episodes.ts runs on import).
  - [Warnings](context.md#warnings) for popularity, food and gold: when each comes up and
    comes up again, in the values of the observation that reports it or as it came up,
    on a simulated game. The food rates come from recorded runs (food falling with no
    deliveries, against population and the rations set); how often each warning comes up
    was replayed on 97 recorded runs.
  - Changes from the 1.6.3 round's interviews, on simulated readings and a simulated game:
    religion and the inn shown at 0 while the reader counts a chapel, church, cathedral or
    inn; `status` counting the player's buildings by type; `find_sites` saying when no
    woodcutter spot has a tree in reach, also around a tile, with the nearest grove or none
    on the map; `inspect_building` by map tile, and it and `set_workshop` reporting a
    building drawn in front of the one on the tile (`set_workshop` then pressing nothing);
    `expand_storage` and `place_near` going back to the anchor's bookmarked view after
    choosing a Stockpile, Granary or Armory moved it. Not known from the live game: that a
    bookmark taken at the anchor before choosing a storage building brings the view back with
    it still selected there too (seen for `build_structure` tile targets, 2026-10-12).
  - The runner rebuilding the game machine's reader unless its programs were built from
    the reader sources of the version a run plays (`version-checkout.test.ts`, with a fake
    game machine; the build command also run in a shell with a stand-in `cmake`; seen live
    on 2026-10-14, Runs above). The 1.6.3 games played from 2026-10-13 21:39 UTC to 2026-10-14, on Oasis by the Sea and
    Large Barren Desert, ran a probe built from 1.5.0's sources, read on the game
    machine on 2026-10-14: its sources were 1.6.3's, its `crusader_probe.exe`
    dated from a 1.5.0 round 11 minutes before, and the sync's build said "ninja: no work
    to do". The reader DLL was 1.6.2's build, whose sources 1.6.3 shares.
  - Of the production changes (`production.test.ts`), what the live check (Runs above) did not
    reach: a rise credited to its good's maker only once one stands, else an other rise, a
    sample without building counts keeping the last ones, and a rise of a starting good past the
    most the list showed of it going to its makers.
  - A model request whose stream ended before its last event retried like the other provider
    failures (`controller.test.ts`); no such error has come up since.
  - A pixel target in a long `build_structure` batch skipped as `screenshot_expired` once its
    screenshot has under 10 game seconds left, with the later pixel targets, while tile targets
    still run, and 24 retries a call (`model-observation.test.ts`); a record whose workers
    words do not read as workers left out of `jobs` (reader code only).
  - Of the raised-tile changes (`model-observation.test.ts`, `placement.test.ts`, on a
    simulated plateau; the test of `build_structure` fails on the code before), what the live
    check did not reach: the second camera move when only the map read after the first shows
    the tile's height, and the aim following raised ground's offset up the screen past 3 tiles
    when a click starts from a flat position (no tile map), keeping only an offset of up to 3
    tiles for the view.

- The shims that bring two harness changes to rounds played on earlier versions
  (`cache-key.test.ts`, `overlay-feed.test.ts`, `test_overlay.py`; both also used in a
  run, above): the key added to the harness's own requests as Pi sends them and by the
  preload through an earlier host's global fetch, with none for other models; the
  overlay's figures read from an earlier host's state, its clock run on from the game
  tick between that host's updates, tool calls counted from the run's events, and the
  feed's figures used only while fresh.

- The 1.6.3 fixes (`model-observation.test.ts`, `remedies.test.ts`, `economy.test.ts`,
  `game-save.test.ts`), not yet run live:
  - `place_near` placing the first Armory (or first of any storage kind) against its anchor
    from the tile map, and the no-room remedy kept for a storage's own anchor.
  - `place_near` and `expand_storage` sending clicks through a frame captured afresh once
    the one they started with is 20 s old (27 game seconds from 1.7.0).
  - `market_trade` counting a purchase when the stock rose and the gold fell in one sample.
  - The end-of-run save trying once more when no save under the new name appears.

- The 1.6.0 changes not yet run live (`model-observation.test.ts`, `tile-map.test.ts`,
  `economy.test.ts`, `controller.test.ts`):
  - `find_sites` searching around the nearest ground of a building's own kind on the
    map when the view has none.
  - The one tile of open ground kept around granaries and armories
    (`access: touches_storage`).
  - `demolish_building` moving the camera to a tile target off screen.
  - The right-click that leaves placement mode before a later placement's camera move.
  - `market_trade` waiting 5 seconds for a trade to show.
  - Four replies without a tool call in the last game minute letting the rest of the
    budget pass.
  - None has been used in an agent's run yet.

- The run overlay on the game machine (`test_overlay.py`, `test_control_status.py`): what it
  shows from the bridge's status and how it draws it, and the host's status carrying the
  session's game clock, tool calls, net worth, popularity and cost.
- The placement fixes of 1.5.5 (`construction-ui.test.ts`, `model-observation.test.ts`,
  `building-types.test.ts`): one more of the player's own buildings of the placed type
  confirms a placement over a refusal message; a second Marketplace is refused before any
  input; `place_near` aims its tile-map spots through the live camera and probes the view
  when every spot it gave was refused without a message; `build_structure`'s closing
  right-click stays on screen when selecting moved the view. Not yet run live in an
  agent's run; that the own-building count changes within the 120 ms settle sample, as the
  structure count does, is assumed from both coming from the same reader sample.
- Trees told from cacti by the ring of 0x2000 tiles a tree has around it (`tile-map.test.ts`
  for `find_sites`' tree counts), from tile data read live on 2026-10-11: on Oasis by the
  Sea every trunk tile on a palm had a ring tile within 3 tiles and every one on a cactus had
  none, and Large Barren Desert has no ring tiles at all. The reader's map summary draws
  trunks without a ring as cacti (`c`) instead of trees.
- Clearing the Save dialog's whole name field when the click lands inside a long loaded
  name (`game-save.test.ts`), the cause of the failed saves on Large Barren Desert, where
  the game saved "glm 5-3 flash 1-5-3 ea2895rt". Since the fix, every desert run of
  2026-10-11 and 2026-10-12 saved under its own name.
- A Moonshot profile's reasoning level sent as Kimi K3's `reasoning_effort` (`low`, `high`,
  `max`), with `default` still sending none and other levels refused
  (`model-config.test.ts`, `store.test.ts`). Moonshot's guide lists those three values;
  not yet checked live.
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
- The fixed game speed's key presses in an agent run, and its failures when the keys do
  nothing or step past 40. Live, the idle baseline pressed the keys (above), and every
  agent run so far started at 40 and pressed none.
- `wait_and_observe` waiting out the minimum turn length when asked to wait less than the
  turn still owes. No live run has asked for that yet; `observe`'s wait has run live
  (above).
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
  `frame()`, reused until it is `FRAME_REUSE_GAME_SECONDS` old) and `build_structure`
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
- **The text-only menu guide** that a fresh checkout uses: no model has played with it
  yet.
- **Benchmark:** there is no military scoring. Early single-model pilots used older
  harness versions and are not comparable.

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
- **Map-wide structure count.** The reader's structure count includes other players,
  so it cannot attribute a change to the agent on maps with opponents.
- **Reads are not atomic.** Each sample is read twice and checked, but it is not a
  guaranteed consistent snapshot.
- **Guide images are private.** A fresh checkout runs with a text-only menu guide.
  All recorded runs used the image guide, which you can make from your own
  screenshots (see [Setup](setup.md#3-guide-images)).
