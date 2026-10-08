---
military: false
---
# Benchmark: Cactus Valley settlement (diagnostic)

**Task.** Establish a basic working settlement on the freshly loaded **Cactus Valley-1**
Free Build save within the play-time budget: a granary, stockpile, wood production,
housing and food production, as resources and terrain permit.

**Not allowed.** Recruiting soldiers or building defences.

## The map

Observed 2026-09-28. The keep and the starting stockpile sit together at the start;
trees and the keep hem the stockpile in, so use `expand_storage` rather than placing
stockpiles by hand. Oasis grass for farms lies east of the keep. Wolves roam near the
keep. Housing starts at 10.

## Start

If the game says "Site your granary", place it near the keep with `build_structure` and
the name `Granary`. Then build the rest. Do not spend the run surveying.
