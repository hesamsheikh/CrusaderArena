---
military: false
---
# Benchmark: Large Barren Desert economy

**Task.** Grow the economy of the freshly loaded **Large Barren Desert** Free Build save as
far as you can within the game-time budget.

**Score.** The settlement is judged as you leave it when the run ends. Net worth counts
most; population and popularity count too, for less. Net worth is gold plus every stored
good valued at the marketplace sell price per unit (wood 1, stone 7, iron 23, pitch 10;
wheat and hops 8; bread, cheese, meat and apples 4; ale 10, flour 10; in the armory,
bows 15, crossbows 30, spears 10, pikes 18, maces 30, swords 30, leather armour 12 and
metal armour 30); the starting
package is worth about 6,500. Buildings count only through what they bring.

**A race.** Every model plays this save for the same game time, and runs are compared on
how far each one gets. There is no target to reach and no point at which the economy is
big enough: growth up to the last minute counts.

**Not allowed.** Recruiting soldiers or building walls, towers, gates or other
defences: they cost resources without growing the economy.

## The map

Observed 2026-10-11. The game opens in March 1172 with a population of 1 out of 10
housing. A granary and a stockpile already stand, so there is no granary to site. The
starting package is 5,000 gold, 55 meat, about 245 wood, 50 stone, 15 iron, 20 pitch and
20 ale. It is still being paid in when timed play starts: the gold, the meat and 192 wood
arrive within about 27 game seconds, which fills the stockpile's four piles of 48 with
wood. The rest waits until the stockpile has room for it, and a message at the top left of
the screen lists what is still to come. Until then the stats show less than the package.
The opening view shows bare desert with the granary near the bottom; the keep and the
stockpile beside it stand just off the right edge of the view.

There is no oasis grass anywhere on the map, so no farm can be built. Two stone deposits
lie about 100 tiles west of the keep (up and to the left on screen), and strips of iron
ore about 60 tiles east of it (down and to the right). `map_overview` shows them on the whole map and `find_sites`
finds quarry and iron mine spots on them, in view or around a tile you give.

## Ways to grow net worth

Choose, combine and adjust these as the game develops:

- **Raw materials:** quarries (with ox tethers beside them) and iron mines produce stone and iron,
  which are worth 7 and 23 each and can be built with or sold.
- **Weapons and armour:** fletchers and poleturners make them from wood, blacksmiths
  and armorers from iron, and tanners from dairy cows. Each is stored in an armory and
  counts at its sell price. The workshops deliver only to an armory, so one must stand
  first.
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

The granary and stockpile are already in place. Build housing, food and production as
resources and terrain permit, and keep expanding. Do not spend the run surveying.
