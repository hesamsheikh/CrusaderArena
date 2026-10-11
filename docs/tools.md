# Tool reference

[← Documentation](README.md)

These are the 26 tools the model can call during timed play (29 in a learning
series's episodes, with the three playbook tools below). During preparation it
has none. All are defined in `harness/server/model.ts`. Tool calls run one at a time.

**Reading tools keep the game paused.** `status`, `get_inventory`, `find_sites`,
`map_overview`, `flat_view`, `building_info` and the memory tools run with the game
still paused from the model's thinking, so they cost no game time. Any other tool
unpauses the game, which then runs for the rest of that reply. `observe` unpauses
too, because a paused game shows a "Game Paused" overlay. `go_to_tile` and
`navigate_minimap` called while the game is still paused make their minimap clicks
with it paused, which the game allows, and unpause it only for their screenshot.

**Action** marks tools that count toward the limit of 8 actions per reply. **Obs**
means the result includes an observation: a fresh screenshot plus the JSON reading
described in [Context](context.md#observations), or, from `wait_and_observe` with
`screenshot: false`, the same reading as text only (see
[Text-only observations](context.md#text-only-observations)). Tools that click need a
previous observation (they target its pixels) and refuse screenshots more than 30
seconds old, not counting time the game spent paused by the host; a text-only
observation does not supply one. Two exceptions need no observation at all:
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
| `observe` | none | Takes a screenshot once the turn has run the minimum turn length; the host lets the rest pass first and says so | Obs | No |
| `wait_and_observe` | `seconds` 0–300 (game seconds); optional `until: {amount, at_least}`; optional `screenshot` (default true) | Lets game time pass, at least until the turn has run the minimum turn length, then looks. `until` ends the wait early once a good, `gold`, `population`, `food` or `idle_peasants` reaches a value, but not before the minimum. `screenshot: false` waits the same way but returns stats, game events and `run_clock` as text only, with no image, and does not update the targeting frame | Wait result, then Obs (or the text-only observation) | No |
| `flat_view` | none | With the game paused, toggles the flattened landscape view, captures it, toggles back and restores the pause state it found. Buildings and rock become flat footprints, which shows free ground | Flat image (for reading only), then Obs (the targeting image) | No |

## Build

Buildable names (28): Stockpile, Woodcutter, Quarry, Ox Tether, Iron Mine, Pitch Rig,
Marketplace, Dairy Farm, Apple Orchard, Wheat Farm, Hops Farm, Hovel, Chapel, Church,
Cathedral, Apothecary, Well, Water Pot, Fletchers' Workshop, Poleturner's Workshop,
Blacksmith's Workshop, Tanner's Workshop, Armorer's Workshop, Granary, Bakery, Mill,
Brewery, Inn. Castle and military buildings are not offered.

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `build_structure` | `placements`: 1–4 of `{name, x?, y?, tile_x?, tile_y?, exact?}`, exactly one of the pixel pair or the tile pair | For each placement: opens the menu (for a good or bad thing, the Town page's good-factor or fear-factor subpage), selects the building, clicks the target pixel, then checks with the reader whether it was placed. A pixel target (`x`, `y`) needs the latest screenshot; a tile target (`tile_x`, `tile_y`, as named by `map_overview` or `find_sites`) needs none — right before its click the host reads the live camera and projects the tile to a pixel itself. Retries a silently blocked spot nearby, and moves a target that would close a building with workers in (see Open sides), unless `exact` is set. Right-clicks at the end to leave placement mode | A status per placement (see below) | Yes, one per placement (a pixel target reported `invalid_target`, or a tile target reported `not_on_screen`, does not count) |
| `place_near` | `building`, `anchor` (as for `center_on`), optional `side`, `count` 1–3 | Centres on an existing building and places new ones flush against it, using the tile map or probing outward | What was placed, where, and why it stopped | Yes, one |
| `expand_storage` | `kind`: `stockpile` or `granary`, optional `count` 1–3, `side` | Places more stockpiles or granaries touching the existing ones: the one it centres on, or any of the same kind joined to it | As `place_near` | Yes, one |
| `demolish_building` | one target: `x`, `y` (pixels of the latest screenshot) or `tile_x`, `tile_y` (a tile of the building's footprint) | Selects the game's demolish tool (the X on the red strip beside the construction tray), clicks the target, checks with the reader that the number of structures on the map fell, and right-clicks to leave demolish mode. A tile target is projected from the live camera, as for `build_structure` | `demolished`, `not_demolished`, `not_selected`, `unverified`, `invalid_target`, `camera_moved` or `not_on_screen`, with a remedy when it did not go through | Yes, one |
| `find_sites` | `building`, optional `count` 1–5, `near_x`, `near_y` | Uses the tile map and the live camera for the current view (no observation needed) and lists free spots where the building fits and keeps an open side (see Open sides), grouped by the ground under them (see Special ground), each as a map tile and, while the latest screenshot shows the live view, its pixel too. Farms report their share of oasis ground. Woodcutter spots come closest to trees first, each with the trees within 12 tiles | Spots by ground, as tiles (and pixels) | No |

A stockpile is not one building in the tile map but four 2×2 piles at the corners of a
5×5 square; the tile map joins each four into its square. `place_near` and
`expand_storage` anchor on the stockpile's square, on the granary, the keep, the market
or the signpost by building type, and on the building nearest the camera centre for the
other anchors.

**Placement statuses** returned by `build_structure`. A placement whose terrain was
clicked also reports the map `tile` it was placed or tried at, whether it came from
`tile_x`/`tile_y` or was worked out from the pixel (for a pixel target, only when the
tile map is available):

| Status | Meaning |
| --- | --- |
| `placed` | Confirmed: the building's cost left the stock, or the structure count rose (`evidence` says which) |
| `not_placed` | Nothing happened: no cost, no new structure, no message. Usually a silently blocked spot or, with `retrySkipped: not_enough_resources`, an unaffordable one |
| `rejected` | The game showed a new refusal message (its text is in `feedback`) |
| `possibly_rejected` | A refusal message was visible, but it may be an old one |
| `not_selected` | The building could not be selected in the menu, so the terrain was not clicked |
| `invalid_target` | A pixel target is outside the screenshot or over the bottom HUD, or the coordinates given are not exactly one whole pair (`x`+`y` or `tile_x`+`tile_y`); `reason` says which. Nothing was sent, and it does not count toward the 8 actions |
| `not_on_screen` | A tile target is not clickable right now: off screen, over the bottom HUD, or no live camera; `camera` names the live centre tile when known. Nothing was sent, and it does not count toward the 8 actions, unless the view moved while the building was being selected (`reason` says so) |
| `camera_moved` | A pixel target's view changed since the screenshot, so the rest of the pixel targets in the batch were skipped; tile targets in the same batch still ran |
| `unverified` | No confirmation either way |

A `placed` building also reports `cost`, its cost from the game reference. The stock
change around the click is kept in the run's events only, not shown to the model: the
starting goods still arriving, production and food show in it too. An `invalid_target`
or `not_on_screen` placement is reported on its own, without a terrain click, so the
rest of the batch still runs; the final right-click that leaves placement
mode is skipped only if no placement in the call was attempted.

**Tile targets.** `tile_x`/`tile_y` name a map tile instead of a screenshot pixel (flat
optional fields rather than a schema union, for providers that reject one). Such a
placement needs no prior `observe`: when its turn in the batch comes, the host reads the
game's live camera (waiting briefly for a valid reader sample) and projects the tile to
a pixel for the current window size, the same projection `find_sites` and `map_overview`
use, and projects it again after selecting the building if the view has moved. If the
tile is not clickable (off screen, or in the bottom HUD band), the placement is reported
`not_on_screen` without a terrain click. A pixel target in the same batch is unaffected
and keeps its rules (latest screenshot, its age, the camera guard); a batch may mix both
kinds. A tile target's clicks go with the latest capture, whatever its age, as the
host's own hotkeys do: only the window's identity and size are taken from it, so the
30-second limit, which protects pixels read off an image, does not apply to them.

**Retries.** A `not_placed` target is retried at nearby spots: up to 6 per building and
12 per call. With the tile map, the host picks the nearest spots where the building
fits (a farm on oasis grass, a quarry, iron mine or pitch rig on its ground, anything
else off every other building's ground); otherwise
it steps a short distance along each axis. The spots are projected from the camera the
placement's own click came from: the screenshot's for a pixel target, the live one for
a tile target (with a tile map read for that view). Retries stop when that camera
moves or placement mode ends, and a pixel target's also when its screenshot is 25
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
marketplace, stockpiles, granaries and the good and bad things) needs one whole side of open ground: its workers
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

**Tile map.** An external read of the game's own tile layers for the current view
(about 2 seconds, read-only). It knows where structures, trees and rock are, which
ground suits farms, quarries, iron mines and pitch rigs, and the no-build zone around
the signpost. `find_sites`, `place_near`, `expand_storage` and `build_structure` use
it. Each observation starts a read for its view in the background while the game is
paused for the model; `find_sites` and `build_structure` use that read, and
`build_structure` waits for it before the game is unpaused, so it costs no game time.
`place_near` and `expand_storage` read the view they centre on, starting the read
while they select the building so the two overlap.
Without a screenshot of the live view, `find_sites` reads the map for the live camera in
the call itself and reports tiles only, ignoring `near_x`/`near_y` (they are pixels of
a screenshot); the next `build_structure` call reuses that read for tile targets in the
same view if no input was sent in between, and otherwise reads one on its first retry.

## Move the camera

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `center_on` | `target`: `keep`, `granary`, `market`, `barracks`, `armoury`, `engineers_guild`, `mercenary_post`, `signpost`, `stockpile` | Centres the camera with the game's own hotkeys and closes any panel it opened. The stockpile has no hotkey; the first call finds it and bookmarks the view | Status, then Obs | Yes |
| `map_overview` | none | Reads the whole map's tiles (about 2 seconds). Draws it with a 20-tile grid, the keep and the current view, and lists stone, iron, oil, farmland and tree groves with their distance from the keep | Text and a map image | No |
| `go_to_tile` | `x`, `y` 1–799 | Moves the camera to a map tile with up to 4 minimap clicks | Status, then Obs | Yes |
| `save_view` | `name` (letters, digits, space, `_`, `-`; up to 24) | Saves the current view as a game bookmark (9 slots) | Saved views | No |
| `go_to_view` | `name` | Returns to a saved view (can differ by about one tile) | Obs | Yes |
| `navigate_minimap` | `x`, `y` 0–1 | One click on the minimap, as a fraction of its size | Obs | Yes |

## Run the economy

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `status` | none | Summarises the latest reading: budget, date, gold, population and housing, idle peasants, popularity and its factors, worker efficiency, food, stock, troops, placement mode, selected building, camera, saved views, visible messages | Text | No |
| `get_inventory` | `section`: `all`, `stockpile`, `granary`, `armory` | Stored goods from the reader, with the change since the previous call. `unavailable` if the reading is stale | Text | No |
| `inspect_building` | `x`, `y` | Clicks a building, reads its panel (workers, vacancies, working, keep access, missing inputs, health) and closes it | Text | Yes |
| `set_tax` | `level` 0–11 | Opens the keep and steps the tax arrows until the reader shows that level. 0–2 are bribes, 3 is no tax (the start), 4–11 are taxes | From, to, the popularity effect (the reader's own factor after the last step, or the reference table without one), and the panel's tax figure: gold a month at that level for the current population | Yes |
| `set_rations` | `rations`: `none`, `half`, `full`, `extra` or `double` | Opens a granary with its hotkey and clicks the ration plate until the reader shows those rations (they apply to every granary) | From, to, the ration factor the panel shows | Yes |
| `market_trade` | `good` (20 goods), `action`: `buy` or `sell`, `lots` 1–20 | Opens the marketplace and buys or sells one lot per click (5 units, 10 for food) | Units, gold change, net worth change, price; when a purchase stops early, whether gold or storage room ran out | Yes |

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
