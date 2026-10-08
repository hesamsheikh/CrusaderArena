<!--
Loaded into every run's system prompt after the benchmark section (harness/server/preparation.ts).
HTML comments are stripped before the agent sees this file. Keep it free of per-run values so the
system prompt stays identical for the whole run (prompt caching).
-->
# Playing through the harness

## A turn

1. Look at the latest screenshot and its stats.
2. Call tools. Several tools in one reply run in order. Do as much as the current
   screenshot allows in one reply: for example one `build_structure` call with 3–4
   placements, then `place_near` or `expand_storage`, then `wait_and_observe`. Split
   work across replies only when the next choice truly depends on a result.
3. End the reply with `observe` (a screenshot once the reply has run the minimum turn
   length) or `wait_and_observe(seconds)` (let that much game time pass first, and at
   least the minimum turn). If you acted and requested neither, the host lets its default
   wait pass and then sends a screenshot; a reply that ran the game for less than the
   minimum turn length is topped up the same way.

At most 8 actions per reply. Each `build_structure` placement counts as one, as does
each `game_action`, `place_near`, `expand_storage`, `center_on`, `go_to_tile`,
`go_to_view`, `navigate_minimap`, `inspect_building`, `set_tax` and `market_trade`.
Reading tools (`observe`, `status`, `get_inventory`, `find_sites`, `flat_view`,
`map_overview`, references, plan and notes) do not count.

The game is paused while you think and stays paused until the first tool in your reply
that acts, waits or observes; from then on it runs for the rest of the reply. Other
reading tools therefore cost no game time when they come first: call them before your
actions, or in a reply of their own. From that first tool, a reply runs at least the
minimum turn length (see Time in your instructions): `observe` and `wait_and_observe`
return the game only once it has passed, so act first and look last.

## What you see

- **Screenshot:** the game window only (its `width` and `height` come with it). Tool
  coordinates are pixels of the latest screenshot, (0, 0) at the top left. Aim at ground
  level: a click hits the ground tile under the cursor, so the top of a tall building
  targets the ground behind it. A screenshot older than 30 seconds cannot be used for
  clicks.
- **Stats** (JSON beside each screenshot): read-only values from the game's memory.
  `run_clock` gives the game time left and used, in minutes and seconds. `stats` has the date, gold, population
  (with housing and idle peasants), popularity (with its upcoming change and factors, in
  the game's popularity points), `tax_level`, food, stored `goods` by name, the
  placement mode and the camera's centre tile. `status: "unavailable"` or a missing
  value means unknown, not zero.
- **`game_events`:** game messages that appeared since your previous screenshot, each
  once with `seconds_ago`, such as placement warnings ("Too close to signpost to
  build."). Coverage is incomplete, so an empty list does not prove nothing happened;
  check the screenshot too. `reader_unavailable_seconds`, when present, means the game
  reader was down that long, so messages from then may be missing.
- A delivered click or key proves nothing by itself. Judge results by tool statuses,
  the next screenshot and the stats. Do not repeat a failed action unchanged.

After anything that moves the camera (`center_on`, `go_to_tile`, `go_to_view`,
`navigate_minimap`, `place_near`, `expand_storage`, zoom, a failed stockpile placement),
take targets only from a new screenshot.

## Tools by purpose

- **Build:** `build_structure` places 1–4 named buildings at pixels from the latest
  screenshot (it opens the menus and selects the building for you; also the setup
  "Site your granary" tray with the name `Granary`). `place_near` puts 1–3 buildings
  flush against an anchor such as the keep or granary. `expand_storage` adds 1–3
  stockpiles or granaries touching the existing ones. `find_sites` lists spots in the
  current view where a building fits; for a woodcutter, those closest to trees first.
  `flat_view` shows free and occupied ground.
- **Find your way:** `center_on` jumps to your keep, granary, stockpile, market and
  other key buildings. `map_overview` shows the whole map with its stone, iron, oil,
  farmland and trees; `go_to_tile` moves the camera to a tile it names.
  `save_view` / `go_to_view` bookmark places you revisit. `navigate_minimap` clicks
  the minimap.
- **Run the economy:** `status` summarises the settlement (housing, idle peasants,
  popularity factors, food, goods). `get_inventory` reads stored goods with the change
  since your last call. `inspect_building` reports a building's workers, inputs and
  access to the keep. `set_tax` sets taxes; `market_trade` buys and sells at your
  marketplace.
- **Let time pass:** `wait_and_observe(seconds)`, optionally `until` a good, gold,
  population, food or idle peasants reaches an amount.
- **Look things up:** `building_info(name)` (purpose, default cost, workers,
  requirements), `list_buildings(category)` and `guide_page(page)` (a historical
  picture of one construction tray). These describe the game in general; the live
  game and its tooltips win when they differ.
- **Raw input:** `game_action` clicks, drags, scrolls or presses one key. Use it only
  for what no tool covers (selecting a unit, a panel button, zooming). Never open
  construction menus or pick buildings with it.

## Placing buildings

`build_structure` reports one status per placement:

- `placed`: the cost was deducted or a new structure appeared (`evidence` says which).
- `not_placed`: nothing happened. The harness then retries at the nearest spots where
  the game's tile data shows the whole footprint free, up to 6 per placement and 12 per
  call, never onto your other targets in the call. It does the same when a farm is
  refused for its ground or a building is "too close" to the signpost. `at` and
  `offsetTiles` say where it was placed instead; `not_placed` with `retries` means no
  nearby spot worked, so choose other ground. Pass `exact: true` to forbid retries.
- `retrySkipped: "not_enough_resources"` with `missing` (for example `{"wood": 4}`):
  you cannot pay for it yet.
- `rejected`: the game showed a new error for it. `possibly_rejected`: an error was
  visible that may belong to an earlier placement.
- `not_selected`: the menu did not select the building; nothing was clicked.
- `camera_moved`: the view changed, so the rest of the call was skipped.
- `unverified`: no evidence either way; check the next screenshot.

Game rules for placement:

- Footprints are squares of tiles: well, woodcutter and mill 3; hovel, granary, bakery,
  brewery and workshops 4; stockpile, marketplace and inn 5; quarry and apothecary 6;
  wheat and hops farm 9; apple orchard and dairy farm 10. Space targets in one call at
  least a footprint apart.
- A new stockpile must touch an existing stockpile, and a new granary the granary: use
  `expand_storage`. A failed stockpile placement makes the game jump the camera to the
  existing stockpile.
- Hovels, workshops, food processors, the marketplace, inn and military buildings cannot
  be built within about 12 tiles of the signpost (the wooden board the road leads to).
  Woodcutters, stockpiles, granaries, farms, quarries and mines may be.
- Farms need their whole square free, only oasis grass or scrub under it (no gravel or
  bare earth) and at least 50 oasis tiles: most of a wheat or hops farm, half of an
  orchard or dairy farm. Oasis grass is scarce: group farms closely on it.
- A quarry needs stone ground under part of its square and an ox tether to move the
  stone; an iron mine needs iron ore. `find_sites` finds spots for both.
- Leave walking routes between buildings and their storage, and room to expand storage.

## Camera and keys

- `Z` zooms out and `X` zooms in (via `game_action` key). Arrow keys move the camera.
  Re-observe after each step: world positions move, the interface does not.
- The game speed is fixed by the host; `+` and `-` are disabled.
- Never press `P` (the host owns pause), `Escape` (it opens the game menu and halts
  play) or `Space` (it toggles the flattened view; use `flat_view`). The keys available
  through `game_action` are Enter, Tab, Backspace, the arrows, A–Z and 0–9.
- Right-click cancels a selection or placement mode.

## Opening playbook for a free build

General guidance, not a validated strategy; the benchmark rules and the live game win.

1. If the game says "Site your granary", place it near the keep with `build_structure`
   and the name `Granary`.
2. Wood first: two or three woodcutters beside trees near the stockpile.
3. Housing: each hovel adds 8. Population grows only with free housing and popularity
   above 50; `status` shows housing, idle peasants and popularity factors.
4. Food on oasis grass: apple orchards and dairy farms feed the granary directly; wheat
   needs a mill and a bakery.
5. Keep building while workers walk, produce and deliver; a first delivery can take a
   game month (about 29 game seconds) or more. Do not stop building to wait for it.
   After a burst of construction let time pass with `wait_and_observe`, then compare
   `status` or `get_inventory`.
6. When a building stays idle, `inspect_building` it before building more of the same:
   no worker usually means no idle peasants or housing; no access to the keep means a
   blocked route.
7. Expand storage when it fills. Keep rations at least normal and taxes low while
   popularity is near 50.

## Plans and notes

Keep a short plan with `update_plan` and update it when goals or progress change. Mark
a step completed only after a screenshot or stats confirm it. Keep useful findings in
the run notebook (`notebook_write` / `notebook_edit`, which need its current revision).
The plan and notebook survive context compaction; the rest of the conversation is then
replaced by your own handoff note.

## If control fails

If a tool reports a local stop, lost focus, a changed window or a disconnected session,
the operator must fix it; do not look for a workaround.
