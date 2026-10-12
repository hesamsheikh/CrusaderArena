---
military: false
---
# Benchmark: The Sinkhole economy

**Task.** Grow the economy of the freshly loaded **The Sinkhole** Free Build save as far as
you can within the game-time budget.

**Score.** The settlement is judged as you leave it when the run ends. Net worth counts
most; population and popularity count too, for less. Net worth is gold plus every stored
good valued at the marketplace sell price per unit (wood 1, stone 7, iron 23, pitch 10;
wheat and hops 8; bread, cheese, meat and apples 4; ale 10, flour 10; in the armory,
bows 15, crossbows 30, spears 10, pikes 18, maces 30, swords 30, leather armour 12 and
metal armour 30); the starting package is worth about 2,415. Buildings count only
through what they bring.

**A race.** Every model plays this save for the same game time, and runs are compared on
how far each one gets. There is no target to reach and no point at which the economy is
big enough: growth up to the last minute counts.

**Not allowed.** Recruiting soldiers or building walls, towers, gates or other
defences: they cost resources without growing the economy.

## The map

Observed 2026-10-12. The game opens in January 1181 with a population of 5 out of 10
housing. A granary and four joined stockpiles already stand by the keep, so there is no
granary to site. The starting package of 2,000 gold, 55 wood, 20 stone and 55 meat has
already arrived. The keep stands at the top of the opening view, the stockpiles beside
it and the granary at the bottom.

The keep lies on the inner edge of a wide ring of oasis grass, which suits farms and
circles a sunken basin. The basin's rim is uneven ground that cannot be built on. Inside
the basin lie patches of iron ore about 50 to 90 tiles east of the keep (to the right on
screen) and a large stone deposit about 85 tiles away (up and to the right). A grove of
trees for woodcutters stands about 40 tiles from the keep (down and to the left), and more
groves stand along the ring. `map_overview` shows them on the whole map and `find_sites`
finds quarry and iron mine spots on them, in view or around a tile you give.

## Ways to grow net worth

Choose, combine and adjust these as the game develops:

- **Raw materials:** quarries (with ox tethers beside them) and iron mines produce stone and iron,
  which are worth 7 and 23 each and can be built with or sold.
- **Weapons and armour:** what the weapon workshops make is kept in an armory and is
  stored value.
- **Food surplus:** food beyond what the population eats is stored value.
- **Taxes:** taxes start at "no taxes" (`set_tax` changes them). Food variety, ale from
  an inn and religion raise popularity; high popularity lets you tax for steady gold
  and draws more peasants.
- **Population:** housing plus popularity above 50 brings the workers who staff all of
  the above. New peasants stop arriving while 24 stand idle: jobs for them let more come.

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

The granary and stockpiles are already in place. Build housing, food and production as
resources and terrain permit, and keep expanding. Do not spend the run surveying.
