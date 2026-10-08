---
military: false
---
# Benchmark: Oasis by the Sea economy

**Task.** Grow the economy of the freshly loaded **Oasis by the Sea-1** Free Build save
as far as you can within the game-time budget.

**Score.** Your net worth when the run ends: gold plus every stored good valued at the
marketplace sell price per unit (wood 1, stone 7, iron 23; bread, cheese, meat and
apples 4; ale 10, flour 10). The starting package is worth
about 1,425. Population, popularity, food and buildings are reported beside the score
but do not count; buildings count only through what they produce.

**Not allowed.** Recruiting soldiers or building walls, towers, gates or other
defences: they cost resources without growing the economy.

## The map

Observed 2026-09-28. The game opens on "Site your granary" in July 1194 with a
population of 1 out of 10 housing. The starting package of 1,000 gold, 50 wood, 25 stone
and 50 bread is still being paid in when timed play starts, wood first, and has fully
arrived about 25 game seconds after the save loads. Until then the stats show less than
the package, and a message at the top left of the screen lists the amounts still to come.
That is not a reader fault: start building at once. The keep stands at the top
right of the opening view with its campfire below it, and a stockpile already stands
next to it. Oasis grass with palms and a pond lies south-west of the keep and suits
farms. A grove of trees for woodcutters stands further west, and rocky cliffs lie to the
north. An iron ore strip lies just north of the keep and a stone deposit about 50 tiles
west of it; `map_overview` shows them on the whole map and `find_sites` finds quarry and
iron mine spots in the current view.

## Ways to grow net worth

Choose, combine and adjust these as the game develops:

- **Raw materials:** quarries (with an ox tether) and iron mines produce stone and iron,
  which are worth 7 and 23 each and can be built with or sold.
- **Not weapons or armour:** their workshops deliver only to an armoury, which is not
  part of this economic benchmark, so they add nothing to net worth.
- **Food surplus:** food beyond what the population eats is stored value.
- **Taxes:** taxes start at "no taxes" (`set_tax` changes them). Food variety, ale from
  an inn and religion raise popularity; high popularity lets you tax for steady gold
  and draws more peasants.
- **Population:** housing plus popularity above 50 brings the workers who staff all of
  the above.

**Trading.** A marketplace buys and sells for gold (`market_trade`), at any time,
including at the start: 5 wood costs 20 gold. Bought goods count toward net worth at the
sell price, which is lower than the buy price, so buying lowers net worth by the
difference. Selling turns goods into the same value in gold, so it leaves net worth
unchanged. Net worth rises through taxes, produced goods and turning goods into goods
worth more than their inputs; it falls through buying, construction costs and bribes.
Early on, gold can also buy materials such as wood to put up more buildings sooner and
start the economy faster. That is one option among others: it pays off only if those
buildings go on to produce more than the buying cost.

## Start

Place the required granary near the keep with `build_structure` and the name
`Granary`. Then build wood production, housing and food as resources and terrain
permit, and keep expanding. Do not spend the run surveying.
