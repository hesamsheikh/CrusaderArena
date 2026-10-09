# Tool reference

[← Documentation](README.md)

These are the 27 tools the model can call during timed play. During preparation it
has none. All are defined in `harness/server/model.ts`. Tool calls run one at a time.

**Reading tools keep the game paused.** `status`, `get_inventory`, `find_sites`,
`map_overview`, `flat_view`, `building_info`, `list_buildings`, `guide_page` and the
memory tools run with the game still paused from the model's thinking, so they cost no
game time. Any other tool unpauses the game, which then runs for the rest of that
reply. `observe` unpauses too, because a paused game shows a "Game Paused" overlay.

**Action** marks tools that count toward the limit of 8 actions per reply. **Obs**
means the result includes an observation: a fresh screenshot plus the JSON reading
described in [Context](context.md#observations). Tools that click need a previous
observation (they target its pixels) and refuse screenshots more than 30 seconds old,
not counting time the game spent paused by the host.

## Look

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `observe` | none | Takes a screenshot once the turn has run the minimum turn length; the host lets the rest pass first and says so | Obs | No |
| `wait_and_observe` | `seconds` 0–300 (game seconds); optional `until: {amount, at_least}` | Lets game time pass, at least until the turn has run the minimum turn length, then looks. `until` ends the wait early once a good, `gold`, `population`, `food` or `idle_peasants` reaches a value, but not before the minimum | Wait result, then Obs | No |
| `flat_view` | none | With the game paused, toggles the flattened landscape view, captures it, toggles back and restores the pause state it found. Buildings and rock become flat footprints, which shows free ground | Flat image (for reading only), then Obs (the targeting image) | No |

## Build

Buildable names (28): Stockpile, Woodcutter, Quarry, Ox Tether, Iron Mine, Pitch Rig,
Marketplace, Dairy Farm, Apple Orchard, Wheat Farm, Hops Farm, Hovel, Chapel, Church,
Cathedral, Apothecary, Well, Water Pot, Fletchers' Workshop, Poleturner's Workshop,
Blacksmith's Workshop, Tanner's Workshop, Armorer's Workshop, Granary, Bakery, Mill,
Brewery, Inn. Castle and military buildings are not offered.

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `build_structure` | `placements`: 1–4 of `{name, x, y, exact?}` | For each placement: opens the menu, selects the building, clicks the target pixel, then checks with the reader whether it was placed. Retries a silently blocked spot nearby unless `exact` is set. Right-clicks at the end to leave placement mode | A status per placement (see below) | Yes, one per placement |
| `place_near` | `building`, `anchor` (as for `center_on`), optional `side`, `count` 1–3 | Centres on an existing building and places new ones flush against it, using the tile map or probing outward | What was placed, where, and why it stopped | Yes, one |
| `expand_storage` | `kind`: `stockpile` or `granary`, optional `count` 1–3, `side` | Places more stockpiles or granaries touching the existing ones: the one it centres on, or any of the same kind joined to it | As `place_near` | Yes, one |

A stockpile is not one building in the tile map but four 2×2 piles at the corners of a
5×5 square; the tile map joins each four into its square. `place_near` and
`expand_storage` anchor on the stockpile's square, on the granary, the keep, the market
or the signpost by building type, and on the building nearest the camera centre for the
other anchors.
| `find_sites` | `building`, optional `count` 1–5, `near_x`, `near_y` | Reads the tile map for the current view and lists free spots where the building fits, as screen pixels. Farms report their share of oasis ground. Woodcutter spots come closest to trees first, each with the trees within 12 tiles | Spots as pixels | No |

**Placement statuses** returned by `build_structure`:

| Status | Meaning |
| --- | --- |
| `placed` | Confirmed: the building's cost left the stock, or the structure count rose (`evidence` says which) |
| `not_placed` | Nothing happened: no cost, no new structure, no message. Usually a silently blocked spot |
| `rejected` | The game showed a new refusal message (its text is in `feedback`) |
| `possibly_rejected` | A refusal message was visible, but it may be an old one |
| `not_selected` | The building could not be selected in the menu, so the terrain was not clicked |
| `camera_moved` | The camera moved since the screenshot, so the rest of the batch was skipped |
| `unverified` | No confirmation either way |

A `placed` building also reports `cost`, its cost from the game reference. The stock
change around the click is kept in the run's events only, not shown to the model: the
starting goods still arriving, production and food show in it too.

**Retries.** A `not_placed` target is retried at nearby spots: up to 6 per building and
12 per call. With the tile map, the host picks the nearest spots where the building
fits; otherwise it steps a short distance along each axis. It stops when the camera
moves, placement mode ends or the screenshot is 25 seconds old. If the map shows the
spot free but nothing was placed and the stock cannot pay, it stops with
`not_enough_resources` and lists what is `missing`.

**Tile map.** An external read of the game's own tile layers for the current view
(about 2 seconds, read-only). It knows where structures, trees and rock are, which
ground suits farms, quarries, iron mines and pitch rigs, and the no-build zone around
the signpost. `find_sites`, `place_near`, `expand_storage` and `build_structure`
retries use it.

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
| `status` | none | Summarises the latest reading: budget, date, gold, population and housing, idle peasants, popularity and its factors, food, stock, troops, placement mode, selected building, camera, saved views, visible messages | Text | No |
| `get_inventory` | `section`: `all`, `stockpile`, `granary`, `armory` | Stored goods from the reader, with the change since the previous call. `unavailable` if the reading is stale | Text | No |
| `inspect_building` | `x`, `y` | Clicks a building, reads its panel (workers, vacancies, working, keep access, missing inputs, health) and closes it | Text | Yes |
| `set_tax` | `level` 0–11 | Opens the keep and steps the tax arrows until the reader shows that level. 0–2 are bribes, 3 is no tax (the start), 4–11 are taxes | From, to, popularity effect | Yes |
| `market_trade` | `good` (20 goods), `action`: `buy` or `sell`, `lots` 1–20 | Opens the marketplace and buys or sells one lot per click (5 units, 10 for food) | Units, gold change, net worth change, price; when a purchase stops early, whether gold or storage room ran out | Yes |

After `set_tax`, `market_trade`, `place_near` or `expand_storage`, the model must
observe again before it can click.

## Look things up

| Tool | Parameters | What it does | Returns | Action |
| --- | --- | --- | --- | --- |
| `building_info` | `name` | One building's role, default cost, workers, footprint and menu position, from the game reference | Text | No |
| `list_buildings` | optional `category` | Building names, optionally for one category | Text | No |
| `guide_page` | `page`: one of 10 construction menu pages | One page of the construction menu guide with its button names | Text and an image; "unavailable" without the private page images | No |

These are references from the game's documentation and an earlier game build. The
current game's tooltips win if they differ.

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
| `notebook_edit` | `revision`, `before`, `after` | Replaces text that appears exactly once |
| `notification_history` | `after` (cursor), optional `limit` up to 50 | Pages through every message the reader saw on screen during the run |
| `playbook_read` | none | Returns the playbook text and its revision. Learning series only |
| `playbook_write` | `revision`, `text` (up to 8 KB) | Replaces the playbook. Fails if the revision is not current. Learning series only |
| `playbook_edit` | `revision`, `before`, `after` | Replaces text that appears exactly once. Learning series only |

None of these count as actions or touch the game. The playbook tools exist only in the
episodes of a learning series, where the playbook carries over to the next episode
(see [Benchmark](benchmark.md#learning-series)).
