# Tool reference

[← Documentation](README.md)

These are the 26 tools the model can call during timed play (29 in a learning
series's episodes, with the three playbook tools below). During preparation it
has none. All are defined in `harness/server/model.ts`. Tool calls run one at a time.

**Reading tools keep the game paused.** `status`, `get_inventory`, `find_sites`,
`map_overview`, `building_info` and the memory tools run with the game
still paused from the model's thinking, so they cost no game time. Any other tool
unpauses the game, which then runs for the rest of that reply. `observe` unpauses
too, because a paused game shows a "Game Paused" overlay. `go_to_tile` and
`navigate_minimap` called while the game is still paused make their minimap clicks
with it paused, which the game allows, and unpause it only for their screenshot;
`flat_view` likewise toggles the view paused and unpauses it for its two images.

**Waits may run fast.** The game time `wait_and_observe` and the host's own waits let
pass may be played at the game's top speed, back at 40 before the wait ends (see
[Fast waits](how-it-works.md#fast-waits)). Waits are in game seconds, so nothing about
them changes for the model.

**Action** marks tools that count toward the limit of 8 actions per reply. **Obs**
means the result includes an observation: a fresh screenshot plus the JSON reading
described in [Context](context.md#observations), or, from `wait_and_observe` with
`screenshot: false`, the same reading as text only (see
[Text-only observations](context.md#text-only-observations)). Tools that click need a
previous observation (they target its pixels) and refuse screenshots more than 40 game
seconds old, counted on the game clock, so time the game spends paused does not count;
a text-only observation does not supply one. Two exceptions need no observation at all:
`find_sites`, and a `build_structure` placement given by map tile instead of pixels
(see [Build](#build)); both read the live camera themselves.

**Failures.** A result that failed or fell short (a status other than success, or a
`not_set`, `partly_placed` or stopped trade) carries a `remedy`: the tool call that
addresses it, for example `no_market` says to build a Marketplace with
`build_structure` and call `market_trade` again, and a placement refused for want of
wood names the `wait_and_observe` `until` that covers its cost or the purchase.
Errors a tool throws end with the fix the same way ("Observe the game first: … Call
observe …"). The remedies are in `harness/server/remedies.ts`.

## Look

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `observe` | none | Takes a screenshot once the turn has run the minimum turn length; the host lets the rest pass first and says so. Any [warnings](context.md#warnings) since the last observation lead it | Obs | No |
| `wait_and_observe` | `seconds` 0–300 (game seconds); optional `until: {amount, at_least}`; optional `screenshot` (default true) | Lets game time pass, at least until the turn has run the minimum turn length, then looks. `until` ends the wait early once a good, `gold`, `population`, `food` or `idle_peasants` reaches a value, but not before the minimum. A [warning](context.md#warnings) (popularity 10 below the last observation, food low for the people at their rations, gold below 500) ends it early too, after the minimum, with a line saying how long it ran. `screenshot: false` waits the same way but returns stats, game events and `run_clock` as text only, with no image, and does not update the targeting frame. Once 3 game minutes have passed with no economy action (`build_structure`, `place_near`, `expand_storage`, `demolish_building`, `set_workshop`, `market_trade`, `set_tax`, `set_rations` or a `game_action`; camera moves and inspecting do not count), the result reminds the model how long it has only waited and read, and that it may be time to do something else | Wait result, then Obs (or the text-only observation) | No |
| `flat_view` | none | With the game paused, toggles the flattened landscape view on and back, telling from paused captures whether each toggle took; the flat image and the targeting image are taken with the game running, since a paused frame has "Game Paused" across the middle, and the game runs on afterwards (about a game second passes for the flat image). Buildings and rock become flat footprints, which shows free ground; trees and bushes shrink to stumps, so ground under them can look free too (live on Oasis by the Sea, 2026-10-14) | Flat image (for reading only), then Obs (the targeting image) | No |

## Build

Buildable names (29): Stockpile, Woodcutter, Quarry, Ox Tether, Iron Mine, Pitch Rig,
Marketplace, Dairy Farm, Apple Orchard, Wheat Farm, Hops Farm, Hovel, Chapel, Church,
Cathedral, Apothecary, Well, Water Pot, Fletchers' Workshop, Poleturner's Workshop,
Blacksmith's Workshop, Tanner's Workshop, Armorer's Workshop, Granary, Bakery, Mill,
Brewery, Inn, Armory, plus the good and bad things. The Armory is the one building
offered from the Castle page: the weapon workshops deliver only to it, and what it
stores counts toward net worth. Other castle and military buildings are not offered.

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `build_structure` | `placements`: 1–8 of `{name, x?, y?, tile_x?, tile_y?, exact?}`, exactly one of the pixel pair or the tile pair | For each placement: opens the menu (for a good or bad thing, the Town page's good-factor or fear-factor subpage), selects the building, clicks the target pixel, then checks with the reader whether it was placed. A pixel target (`x`, `y`) needs the latest screenshot; a tile target (`tile_x`, `tile_y`, as named by `map_overview` or `find_sites`) needs none — right before its click the host reads the live camera and projects the tile to a pixel itself, at the tile's terrain height, moving the camera first when it is drawn off screen (see Tile targets), then moves the pointer there without a click and reads the tile the game picks under it (`mouse_tile`), moving by the difference until it is the tile asked, up to 3 moves, and clicks there. The reader's camera is a whole tile and the view can lie part of a tile from it, so the projection alone could pick a neighbour: every building placed by tile on Large Barren Desert's start went one tile off (live 2026-10-14). An offset of up to 3 tiles along each axis is kept for the view, so the next target there usually needs one move; across the screen the pointer follows no more than that, while up or down it follows raised ground as far as the screen goes; a placement whose pointer never reached its tile reports the tile the game showed as `cursorTile`. Retries a silently blocked spot nearby, and moves a target that would close a building with workers in (see Open sides) or leave a building no way from the keep (see Routes to the keep), unless `exact` is set. Right-clicks at the end to leave placement mode | A status per placement (see below) | Yes, one per placement (a pixel target reported `invalid_target`, or a tile target reported `not_on_screen`, does not count) |
| `place_near` | `building`, `anchor` (as for `center_on`), optional `side`, `count` 1–3 | Centres on an existing building and places new ones flush against it, using the tile map or probing outward (see Tile map). A second Marketplace is refused without any input (`stopped: already_built`), and so is a Stockpile, Granary or Armory against another anchor while one stands (`stopped: view_jumps`: choosing it would centre the view on the first one; the remedy names `expand_storage` or the armoury anchor) | What was placed, where, and why it stopped | Yes, one |
| `expand_storage` | `kind`: `stockpile`, `granary` or `armory`, optional `count` 1–3, `side` | Places more stockpiles, granaries or armories touching the existing ones: the one it centres on, or any of the same kind joined to it. The game refuses an armory that does not touch one ("Needs to be placed adjacent to the armory.", live 2026-10-12). It prefers spots that keep the tile of open ground around granaries and armories (Room around storage) and, when none does, takes one beside the storage that does not rather than none. With no free ground beside it at all, the remedy says to sell some of what the storage holds or demolish a building beside it. Its clicks are aimed like `build_structure`'s tile targets, by the tile the game picks under the pointer (projected clicks alone put every stockpile on Large Barren Desert's start one tile further along +x, and each flush spot on that side was refused as not adjacent, live 2026-10-14), and the later spots go against where the reader shows each storage building placed. Choosing the building centres the view on the first one of its kind, and a refused stockpile jumps the view to the stockpile; both `expand_storage` and `place_near` bookmark the anchor's view before choosing a Stockpile, Granary or Armory and go back to it with the building still selected, as `build_structure` does, and stop with `camera_moved` only when that fails | As `place_near` | Yes, one |
| `set_workshop` | `product`: `bows`, `crossbows`, `spears`, `pikes`, `maces` or `swords`; one target as for `demolish_building` | Clicks the workshop (for a tile target, the middle of the building on that tile; if the panel that opens is another building's, one drawn in front of it, the back corner of its footprint and then its roof; the middle and the back corner are aimed by the tile the game picks under the pointer, as for `build_structure`, any tile of the building counting, and the roof is taken from the aimed back corner; when only the one in front opens, it is `not_a_workshop` even if that one is a workshop too, and its product is left alone), presses the product's button in its panel, reads the choice back from the reader (`selected_workshop.next`) and right-clicks to close the panel. The two buttons sit at the same spots on the fletcher's (bows, crossbows), blacksmith's (swords, maces) and poleturner's (spears, pikes) panels; new workshops make bows, swords and spears (live 2026-10-12). The item in progress is finished first | `set`, `already`, `wrong_workshop` (with the workshop that makes it), `not_a_workshop`, `unverified` (also when the reader had no reading after the clicks), `invalid_target`, `camera_moved` or `not_on_screen`. A panel shows in the reader about 0.6 s after the click; each click waits up to 4 s | Yes, one |
| `demolish_building` | one target: `x`, `y` (pixels of the latest screenshot) or `tile_x`, `tile_y` (a tile of the building's footprint) | Selects the game's demolish tool (the X on the red strip beside the construction tray), clicks the target, checks with the reader that the number of structures on the map fell, and right-clicks to leave demolish mode. A tile target is projected from the live camera at its terrain height, with the camera moved first when it is drawn off screen, and aimed by the tile the game picks under the pointer before its click, as for `build_structure`: any tile of the building on it will do, at the tile asked, else at the back corner of its footprint or its middle (the building as the view's tile map shows it, read afresh when anything was sent to the game since the last observation). A building drawn over the spot keeps the game's tile on itself, and a click would demolish it instead (a fletcher in front of a hovel's corner took a demolish meant for the hovel, live 2026-10-14), so when every spot shows another building nothing is clicked and the status is `covered` | `demolished`, `not_demolished`, `covered`, `not_selected`, `unverified`, `invalid_target`, `camera_moved` or `not_on_screen`, with a remedy when it did not go through | Yes, one |
| `find_sites` | `building`, optional `count` 1–5, `near_x`, `near_y`, `tile_x`, `tile_y` | Uses the tile map and the live camera for the current view (no observation needed), or with `tile_x`/`tile_y` a map read of the area around that tile anywhere on the map (spots within 25 tiles of it; the camera does not move), and lists free spots where the building fits, keeps an open side (see Open sides) and a way from the keep (see Routes to the keep), grouped by the ground under them (see Special ground), each as a map tile and, while the latest screenshot shows it, its pixel too. When the view holds no spot on the building's own ground (stone for a quarry, iron ore for a mine, oil for a pitch rig, oasis grass for a farm, trees for a woodcutter), it also searches around the nearest such area on the map summary whose centre is out of view, and says so in `searchedAround`. Farms report their share of oasis ground. Spots for buildings nobody walks to (hovels, the marketplace, churches, the good and bad things) stay at least 6 tiles from the keep, its doors and its campfire courtyard, in this search and in `build_structure`'s retries: the peasants come from the campfire, and nearest the view centre, which a game starts on the keep, the search had packed hovels around it (2026-10-15). `place_near` beside the keep still puts them flush against it. Spots the search picks, and `build_structure`'s retry spots, come in blocks: a spot may touch other buildings (corners too) only if they make with it a block of at most four, at most two footprints across each way, so every block has a tile of open ground around it for walking (the user's layout rule, 2026-10-15); the keep, its doors and its courtyard make a block of five, so nothing picked touches them. Storage flush with its kind and `place_near` beside an anchor keep their own rules. Woodcutter spots come closest to trees first, each with the trees within 12 tiles. A tree is a trunk tile with the ring of tiles a tree has around it; cacti carry the same trunk marks without a ring and do not count. Another Stockpile, Granary or Armory, once the reader counts one, gets only spots flush with one of its kind, the only place the game takes it ("Needs to be placed adjacent to the granary."): the search moves beside the one nearest the asked spot, from the reader's storage positions, and `searchedAround` says so; its usual search had offered spots the game refused (four 1.6.3 games, and a live test on 2026-10-14). When no woodcutter spot has a tree in reach, the note says so, in a search around a tile too, with the nearest grove on the map summary, or that the map has none (GLM 5.3 Flash built four woodcutters on Large Barren Desert, which has no trees, from a tile search that listed `"trees": 0` under the usual note, 1.6.3) | Spots by ground, as tiles (and pixels) | No |

A stockpile is not one building in the tile map but four 2×2 piles at the corners of a
5×5 square; the tile map joins each four into its square. `place_near` and
`expand_storage` anchor on the stockpile's square, on the granary, the keep, the market
or the signpost by building type, and on the building nearest the camera centre for the
other anchors. A stockpile, granary or armory must touch one of its kind only once one
stands: the first armory goes against any anchor like other buildings.

**Placement statuses** returned by `build_structure`. A placement whose terrain was
clicked also reports the map `tile` it was placed or tried at, whether it came from
`tile_x`/`tile_y` or was worked out from the pixel (for a pixel target, only when the
tile map is available):

| Status | Meaning |
| --- | --- |
| `placed` | Confirmed: the reader counts one more of the player's own buildings of that type, the building's cost left the stock, or the structure count rose (`evidence`: `own_buildings`, `cost` or `structure_count`). One more of its own type counts even with a refusal message on screen, which can be an earlier click's |
| `not_placed` | Nothing happened: no cost, no new structure, no message. Usually a silently blocked spot or, with `retrySkipped: not_enough_resources`, an unaffordable one |
| `rejected` | The game showed a new refusal message (its text is in `feedback`) |
| `possibly_rejected` | A refusal message was visible, but it may be an old one |
| `not_selected` | The building could not be selected in the menu, so the terrain was not clicked |
| `invalid_target` | A pixel target is outside the screenshot or over the bottom HUD, or the coordinates given are not exactly one whole pair (`x`+`y` or `tile_x`+`tile_y`); `reason` says which. Nothing was sent, and it does not count toward the 8 actions |
| `not_on_screen` | A tile target could not be brought into view (the camera cannot centre near the map edge, or there is no live camera), or choosing the building moved the view and it could not come back; `reason` says which and `camera` names the live centre tile when known. The terrain was not clicked |
| `camera_moved` | A pixel target's view changed since the screenshot, so the rest of the pixel targets in the batch were skipped; tile targets in the same batch still ran |
| `screenshot_expired` | The screenshot had less than 10 game seconds left of its 40, too little for another placement (about 7 live), so this pixel target and the later ones were skipped without a click; tile targets in the same batch still ran. A call takes up to 8 placements, and 8 pixel targets can outlast their screenshot |
| `unverified` | No confirmation either way |
| `already_built` | A Marketplace while the player has one: the game allows one, and choosing it again only centres the view on it. Nothing was sent, and it does not count toward the 8 actions; the remedy names `market_trade` |

A tile target the host moved the camera for reports `view`: `moved_to_tile` (it was off
screen) or `moved_back_to_tile` (choosing the building moved the view away).

A `placed` building also reports `cost`, its cost from the game reference. The stock
change around the click is kept in the run's events only, not shown to the model: the
starting goods still arriving, production and food show in it too. An `invalid_target`
or `not_on_screen` placement is reported on its own, without a terrain click, so the
rest of the batch still runs; the final right-click that leaves placement
mode is skipped only if no placement in the call was attempted. If selecting a building
moved the view and left the last target off screen, the right-click goes near the top of
the view instead. The call then waits, up to a second, for a reader sample taken after the
right-click that shows placement mode ended: a `build_structure` call straight after another
one, placing the same building first, used to read the end of the previous call's placement
mode as its own selection failing and reported `not_selected` (17 placements in 9 calls,
benchmarks 1.5.1 to 1.6.3).

**Tile targets.** `tile_x`/`tile_y` name a map tile instead of a screenshot pixel (flat
optional fields rather than a schema union, for providers that reject one). Such a
placement needs no prior `observe`: when its turn in the batch comes, the host reads the
game's live camera (waiting briefly for a valid reader sample) and projects the tile to
the pixel where it is drawn, from the view's tile map (read now if none is known): the
game draws raised ground higher, about one screen row per 8.7 units of the tile layers'
height, so a plateau tile at height 130 sits about 14 rows above where flat ground would
put it (live on Oasis by the Sea, 2026-10-12; the earlier flat projection hit the cliff
below it). If that pixel is off screen, as a raised tile near the top edge can be while
its flat position is on screen (a hovel on The Sinkhole's slope, clicked at its flat
position, went 4 tiles off, live 2026-10-14), the host first moves the camera with
`go_to_tile`'s minimap clicks to where the tile is drawn mid-screen: up the map from it
by the rows its height raises it, half along each axis. Before that it right-clicks to
leave placement mode when an earlier placement of the call left it on: the minimap does
nothing in placement mode. A tile off screen in the first view has no height known yet,
so the camera moves once more when the map read after the move shows the tile drawn off
screen. Choosing a Stockpile, Granary or Armory centres the view on the first one of its
kind, so for those the host saves the view in game bookmark 9 before choosing the
building and goes back to it if the tile is no longer on screen; a bookmark works in
placement mode and keeps the building selected. If the tile still cannot be clicked,
the placement is reported `not_on_screen` without a terrain click. A pixel target in the
same batch keeps its rules (latest screenshot, its age, the camera guard), so a camera
move for a tile target makes later pixel targets report `camera_moved`; a batch may mix
both kinds. A tile target's clicks go with the latest capture, whatever its age, as the
host's own hotkeys do: only the window's identity and size are taken from it, so the
40-game-second limit, which protects pixels read off an image, does not apply to them.

**Retries.** A `not_placed` target is retried at nearby spots: up to 6 per building and
24 per call. With the tile map, the host picks the nearest spots where the building
fits (a farm on oasis grass, a quarry, iron mine or pitch rig on its ground, anything
else off every other building's ground); otherwise
it steps a short distance along each axis. The spots are projected from the camera the
placement's own click came from: the screenshot's for a pixel target, the live one for
a tile target (with a tile map read for that view). Retries stop when that camera
moves or placement mode ends, and a pixel target's also when its screenshot is 34 game
seconds old. Affordability is checked from the
reader before each placement's first click, re-read so an earlier placement in the
same call is accounted for; an unaffordable target is reported with
`retrySkipped: not_enough_resources` and `missing` without being clicked. Without a
stock reading the click goes ahead and, if the spot turns out free but nothing was
placed, the same check during the retry reports it instead.

**Special ground.** Oasis grass is the only ground farms can use, and stone, iron ore
and oil the only ground of quarries, iron mines and pitch rigs. `find_sites` lists its
spots grouped by the ground under them (`plain`, `oasis_grass`, `stone`, `iron_ore`,
`oil`, or several joined by `+`), up to `count` per group with the building's own ground
first, so the model sees what each spot would take and chooses. Every spot the harness
chooses by itself (retries, `place_near`, `expand_storage`) keeps its whole footprint
off the ground of other buildings; scrub counts as plain. A target the model gives
itself is clicked as given.

**Open sides.** A building with workers (every building except hovels, the
marketplace, stockpiles, granaries, armories, churches and the good and bad things) needs one whole side of open ground: its workers
go in and out there, and one closed in on all four sides stays empty. In the tile map
a side is open when every tile along it is buildable ground with nothing on it, or the
keep's courtyard; trees, bushes, rocks, water, cliffs, farm fields and buildings close
it. Every spot the host chooses (`find_sites`, `place_near`, `expand_storage`, retries)
leaves the new building an open side if it has workers, and takes no neighbour's last
open side; several spots in one list leave each other one too. Existing buildings of
types the harness cannot name are kept open as well. A `build_structure` target that fails the check is
moved like a blocked one without being clicked, and the placement reports `access`
(`no_open_side` or `closes_neighbour`); with `exact` it is placed as asked and `access`
warns.

**Room around storage.** Every spot the host chooses, and every `build_structure`
target, keeps one tile of open ground between a granary, armory or stockpile and any
other building, built, placed earlier in the call or planned in it; another granary may
touch a granary, another armory an armory and another stockpile a stockpile, and the
keep and its courtyard do not count. A target that would touch one is moved like a
blocked one and reports `access: touches_storage` (with `exact`, placed as asked with
the warning). A stockpile target is moved, and retried, only to spots flush with the
stockpile, where the game takes one: those that keep the tile of open ground first,
else one that does not, as `expand_storage` does. `place_near` beside a granary, the armoury or the stockpile therefore places at
a gap of one tile. Any flush stockpile touches the pile at each end of its side, since
the walkway between a stockpile's piles is one tile wide.

**Room for the stockpile to grow.** The same spots and targets keep one spot free beside
the stockpile where another stockpile fits, as `expand_storage` looks for them: a
footprint that would cover the last such spot is moved like a blocked one and reports
`access: blocks_stockpile` (with `exact`, placed as asked with the warning). Spots taken
earlier in the call do not count as room, a stockpile with no room left sets no limit,
and neither does one whose surroundings the tile map has not read in full. Boxed-in
stockpiles were one of the runs' commonest dead ends (runs of 2026-10-12 and 13).

**Routes to the keep.** An open side is only a row of tiles; the ground beyond it can
still be walled off by other buildings, water or cliffs, and then no worker reaches the
building (the game's "no access to keep"). So the same spots and targets also keep a way
to walk from the keep: to an open side of the new building if it has workers, to any
tile beside it if it is storage (goods are carried there), and the same for every
building that has one now, built, placed earlier in the call or planned in it. A
footprint people could not walk to reports `access: no_route`; one that would close
another building's last way, by walling it off or by standing on the tiles beside it
that people reach, reports `access: cuts_route`; both are moved like a blocked target
(with `exact`, placed as asked with the warning). The way is searched over the
tile map: from the keep's courtyard, or from the edge of the area read, since the
ground beyond is unknown and taken to lead to the keep. Buildings (but the courtyard),
water, mountains and rock close it; trees, bushes and farm fields count as walkable,
which can only let a walled-off spot through, never refuse a good one. Which of them
people really cross is still to be checked in the live game. Hovels, the marketplace,
churches and the good and bad things need no way.

**Tile map.** An external read of the game's own tile layers for the current view
(about 2 seconds, read-only). It knows where structures, trees and rock are, which
ground suits farms, quarries, iron mines and pitch rigs, and the no-build zone around
the signpost. `find_sites`, `place_near`, `expand_storage` and `build_structure` use
it. Each observation starts a read for its view in the background while the game is
paused for the model; `find_sites` and `build_structure` use that read, and
`build_structure` waits for it before the game is unpaused, so it costs no game time.
`place_near` and `expand_storage` read the view they centre on, starting the read
while they select the building so the two overlap. They aim each spot the map gives
through the camera as it is at the click, so a view that moved a tile after the read
does not push a flush spot into the anchor. If every spot the map gave is refused
without a message, they probe the view from the anchor outward, as they do without a
tile map (`method: tile_map_then_probing`). Their clicks go through a frame captured
afresh once the one they started with is 27 game seconds old, so long probing never meets
the 40-game-second age limit on input.
Without a screenshot of the live view, `find_sites` reads the map for the live camera in
the call itself and reports tiles only, ignoring `near_x`/`near_y` (they are pixels of
a screenshot); the next `build_structure` call reuses that read for tile targets in the
same view if no input was sent in between, and otherwise reads one on its first retry.

## Move the camera

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `center_on` | `target`: `keep`, `granary`, `market`, `barracks`, `armoury`, `engineers_guild`, `mercenary_post`, `signpost`, `stockpile` | Centres the camera with the game's own hotkeys and closes any panel it opened. The stockpile has no hotkey; the first call finds it and bookmarks the view | Status, then Obs | Yes |
| `map_overview` | none | Reads the whole map's tiles (about 2 seconds). Draws it with a 20-tile grid, the keep and the current view, and lists stone, iron, oil, farmland and tree groves with their distance from the keep. Cacti are drawn apart from trees and are not groves | Text and a map image | No |
| `go_to_tile` | `x`, `y` 1–799 | Moves the camera to a map tile with up to 4 minimap clicks | Status, then Obs | Yes |
| `save_view` | `name` (letters, digits, space, `_`, `-`; up to 24) | Saves the current view as a game bookmark (8 slots, 1–8: slot 0 holds the located stockpile and 9 `build_structure`'s target view) | Saved views | No |
| `go_to_view` | `name` | Returns to a saved view (can differ by about one tile) | Obs | Yes |
| `navigate_minimap` | `x`, `y` 0–1 | One click on the minimap, as a fraction of its size | Obs | Yes |

## Run the economy

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `status` | none | Summarises the latest reading: budget, date, gold, population and housing, idle peasants and open jobs, popularity and its factors, worker efficiency, food, stock, the player's buildings counted by type (a stockpile's four piles as one stockpile, parts such as keep doors left out; a building counts from the click that places it), production (as in each observation's stats: see [Context](context.md#observations)), troops, placement mode, selected building, camera, saved views, visible messages | Text | No |
| `get_inventory` | `section`: `all`, `stockpile`, `granary`, `armory` | Stored goods from the reader, with the change since the previous call. `unavailable` if the reading is stale | Text | No |
| `inspect_building` | one target as for `demolish_building` | Clicks a building as `set_workshop` clicks a workshop (by tile: its middle, then the back corner of its footprint and its roof, past a building drawn in front, aimed as there), reads its panel (workers, vacancies, working, keep access, missing inputs, health; for a fletcher, poleturner or blacksmith the product it is making and the next one) and closes it | The building, with a `warning` when only a building drawn in front of the one on the tile opened; `building: null` when no panel opened; `invalid_target`, `camera_moved` or `not_on_screen` | Yes |
| `set_tax` | `level` 0–11 | Opens the keep and steps the tax arrows until the reader shows that level. 0–2 are bribes, 3 is no tax (the start), 4–11 are taxes | From, to, the popularity effect (the reader's own factor after the last step, or the reference table without one), and the panel's tax figure: gold a month at that level for the current population | Yes |
| `set_rations` | `rations`: `none`, `half`, `full`, `extra` or `double` | Opens a granary with its hotkey and clicks the ration plate until the reader shows those rations (they apply to every granary) | From, to, the ration factor the panel shows | Yes |
| `market_trade` | `good` (20 goods), `action`: `buy` or `sell`, `lots` 1–20 (5 units each) | Opens the marketplace and trades one click at a time in the game's own steps, up to `lots` × 5 units and never more: a purchase is 5 units a click; a sale is 20 units a click while 100 or more are in stock, 10 from 50, else 5 (seen live on wood, stone and apples). A purchase the reader shows no room for (a full armory, granary or stockpile) is not clicked: the game refuses it ("No space in the armory." at 50 weapons and armour) and the result names `expand_storage`. A click counts once the reader shows its trade within 5 seconds (two of Kimi K3's trades stopped after 2 seconds with nothing bought): from one reader sample to the next the stock or the gold moved by exactly its units, or the gold did since the click, also with the month's taxes (the keep's tax figure) on top; for a purchase, also when the stock rose and the gold fell in one sample, unless bribes are taking gold (food eaten and part of the month's taxes in the sample of a purchase left neither exact). So a delivery or a tax payment meanwhile neither hides a trade nor passes for one | Units traded, clicks, the gold change at the market's price (units × the buy or sell price, so taxes landing meanwhile do not hide a trade's cost), the net worth change, the gold now, price; when it stops early, why: the next sale step was larger than what was left (with the step to ask for), nothing left to sell, a trade that did not show, or for a purchase too little gold or storage room as the reader shows them | Yes |

After `set_tax`, `set_rations`, `market_trade`, `place_near` or `expand_storage`, the model must
observe again before it can click.

## Look things up

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `building_info` | `name` | One building's role, default cost, workers, footprint and menu position, from the game reference | Text | No |

This is a reference from the game's documentation and an earlier game build. The
current game's tooltips win if they differ. (`list_buildings` and `guide_page` were
removed, unused in 24 recent runs; the construction menu guide still arrives as images
in [the preparation message](context.md#the-preparation-message).)

## Raw input

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `game_action` | `type`: `click`, `drag`, `key` or `scroll`; `x`, `y`; `endX`, `endY` for drags; `button` 1 (left) or 3 (right); `key`; `direction` for scrolls | Sends one input to the game window at pixels of the latest screenshot | "Input acknowledged; outcome unverified" | Yes |

Allowed keys: letters, digits, arrows, `Enter`, `Tab` and `Backspace`. `P` and
`Escape` are refused; `Space`, `+` and `-` are not offered (the game speed is fixed by
the host). Useful ones: arrows move the camera, `Z` zooms out and `X` zooms in, and a
right click cancels placement or selection. Mouse-wheel zoom does not work through the
bridge.

## Memory

| Tool | Parameters | What it does |
| --- | --- | --- |
| `update_plan` | `plan`: up to 20 `{step, status}` | Replaces the plan. Status is `pending`, `in_progress` or `completed` |
| `notebook_read` | none | Returns the notebook text and its revision |
| `notebook_write` | `revision`, `text` (up to 8 KB) | Replaces the notebook. Fails if the revision is not current |
| `notification_history` | `after` (cursor), optional `limit` up to 50 | Pages through every message the reader saw on screen during the run |
| `playbook_read` | none | Returns the playbook text and its revision. Learning series only |
| `playbook_write` | `revision`, `text` (up to 8 KB) | Replaces the playbook. Fails if the revision is not current. Learning series only |
| `playbook_edit` | `revision`, `before`, `after` | Replaces text that appears exactly once. Learning series only |

None of these count as actions or touch the game. The playbook tools exist only in the
episodes of a learning series, where the playbook carries over to the next episode
(see [Benchmark](benchmark.md#learning-series)).
