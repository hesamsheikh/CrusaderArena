<!--
Loaded into every run's system prompt after the controls (harness/server/preparation.ts).
HTML comments are stripped. Text between the military markers is left out for benchmarks whose
rules file says `military: false`. building-info.ts parses the building tables by section.
-->
# Game reference: Stronghold Crusader: Definitive Edition

Supporting game knowledge, not a fixed build order; the benchmark rules come first.
Costs are the manual's defaults: the live game's tooltips win for balance changes,
unavailable units and scenario restrictions.
W = wood, S = stone, G = gold. Building costs are separate from production inputs
and troop recruitment costs. A worker count means civilian jobs, not soldiers.

## Economy and population

<!-- military -->
- **Victory:** Skirmishes usually require killing enemy lords. Protect your own
  lord; losing him loses the game. Read mission-specific objectives first.
<!-- /military -->
- **Keep:** The administrative centre. Select it to adjust taxes. Idle peasants
  gather at its campfire.
- **Population:** Hovels add housing, but do not instantly create workers.
  Popularity above 50 attracts peasants when housing is available; below 50,
  peasants leave. Check both free housing and idle peasants before expanding.
- **Popularity:** Taxes reduce it; rations, food variety, religion and ale can
  improve it. Bribes spend gold to improve it. More generous rations also drain
  food faster. Inspect the popularity breakdown rather than guessing the cause.
- **Jobs:** Production needs available peasants, inputs, storage and reachable
  destinations. Workers travel to collect and deliver goods; long routes reduce
  effective output. A placed building is not necessarily producing.
- **Storage:** Stockpiles hold raw materials and intermediate goods; granaries
  hold food; armories hold weapons and armor. Expand storage when full. Granary
  extensions must touch the existing granary; keep stockpile space contiguous.
- **Trade:** A marketplace buys and sells goods for gold, including equipment.
  Auto-buy replenishes below a threshold; auto-sell sells above one. Avoid selling
  resources reserved for construction/recruitment or setting unaffordable imports.
<!-- military -->
- **Army:** Recruitment consumes an idle peasant and gold. Barracks units also
  consume equipment. Recruits leave the civilian workforce and no longer need
  civilian housing or granary rations. Recruiting everyone can starve production
  of replacement workers.
<!-- /military -->

## Buildings: economy, food and services

Farms, mines, quarries and pitch rigs need matching terrain (see the placement rules).
Leave walking access between buildings and their storage.

| Building | Build cost; workers | Function and requirements |
|---|---|---|
| Hovel | 6 W; none | Adds 8 housing spaces; immigration still needs popularity. |
| Stockpile | Free; none | Stores wood, stone, iron, pitch, wheat, flour, hops and ale. Reserve expansion space. |
| Granary | 5 W; none | Stores meat, cheese, apples and bread. Select to set rations and permitted foods. |
| Marketplace | Free / 5 W in manual; none | Buys/sells commodities and sets automatic trade. Check the placement cost shown. |
| Woodcutter | 3 W; 1 | Cuts nearby trees and delivers wood to stockpile. Essential for most early construction. |
| Quarry | 20 W; 3 | Extracts stone from a stone deposit; needs ox transport to stockpile. |
| Ox tether | 5 W; 1 | Carries quarry stone to stockpile. A quarry without transport does not supply usable stone reliably. |
| Iron mine | 20 W; 2 | Place on iron deposits; supplies iron for metal weapons and armor. |
| Pitch rig | 20 W; 1 | Place on suitable marsh; supplies pitch for fire defenses and oil smelters. |
| Hunter's post | 5 W; 1 | Hunts nearby deer and delivers meat directly to granary; depends on available animals. |
| Apple orchard | 5 W; 1 | Produces apples directly for granary; needs grassland. |
| Dairy farm | 10 W; 1 | Produces cheese; its cows also supply tanners. Needs grassland. |
| Wheat farm | 15 W; 1 | Produces wheat for stockpile; wheat is not edible until processed. Needs grassland. |
| Mill | 20 W; 3 | Turns stockpiled wheat into flour. Flour still needs a bakery. |
| Bakery | 10 W; 1 | Turns flour into bread and delivers it to granary. |
| Hops farm | 15 W; 1 | Produces hops for brewing, not food. Needs grassland. |
| Brewery | 10 W; 1 | Turns hops into ale stored in stockpile. |
| Inn | 20 W + 100 G; 1 | Distributes ale for popularity. Needs a continuing ale supply and sufficient coverage. |
| Chapel / simple mosque | 250 G; no peasant job | Supplies religious services; popularity depends on population coverage. |
| Church / mosque | 500 G; no peasant job | Religious services and an additional +1 popularity bonus. |
| Cathedral / grand mosque | 1,000 G; no peasant job | Religious services and an additional +2 popularity bonus; also recruits black monks / temple guards. |
| Well | 30 G; 1 | Sends a worker to extinguish fires. Place within useful reach of vulnerable buildings. |
| Water pot | 60 G; 3 | Firefighting with three workers. Reserve the workforce it requires. |
| Apothecary | 20 W + 150 G; 1 | Reduces disease damage and provides a worker who clears disease clouds. This is distinct from the Bedouin Healer troop. |
| Good things | 20–30 G; none | Positive fear factor: improves popularity and troop fighting effectiveness, but reduces worker productivity. |
| Bad things | 40–50 G; none | Negative fear factor: improves worker productivity at the expense of popularity and troop fighting effectiveness. |

### Production chains

- **Bread:** wheat farm → stockpiled wheat → mill → stockpiled flour → bakery → granary.
- **Ale:** hops farm → stockpiled hops → brewery → stockpiled ale → inn → popularity.
- **Stone:** quarry → ox tether transport → stockpile → walls/towers/buildings.
- **Leather armor:** dairy cows → tanner → armory. Tanning consumes cows and can
  compete with cheese production.
- **Metal equipment:** iron mine → stockpile → blacksmith/armorer → armory.
- **Wooden equipment:** woodcutter → stockpile → fletcher/poleturner → armory.

Balance stages by observing inventories. Wheat piling up while flour is empty
suggests milling capacity, staffing or access; flour piling up with no bread
suggests a bakery bottleneck. No raw input suggests the upstream producer or
transport. Check these before adding more of the same building.

<!-- military -->
## Military production and recruitment buildings

| Building | Build cost; workers | Function and inputs |
|---|---|---|
| Armory | 5 W; none | Stores finished weapons and armor for recruitment. Raw materials alone cannot equip a soldier. |
| Fletcher | 20 W + 100 G; 1 | Select bows (2 wood each) or crossbows (3 wood each). |
| Poleturner | 10 W + 100 G; 1 | Select spears (1 wood each) or pikes (2 wood each). |
| Blacksmith | 20 W + 200 G; 1 | Select maces or swords; each consumes 1 iron. |
| Armorer | 20 W + 100 G; 1 | Makes metal armor from 1 iron per suit. |
| Tanner | 10 W + 100 G; 1 | Takes dairy cows; one cow supplies three suits of leather armor. |
| Barracks | 15 S; none | Recruits European troops using idle peasants, gold and armory equipment. |
| Mercenary post | 10 W; none | Recruits Arabian troops with peasants and gold; no armory equipment chain. |
| Bedouin stockade | 10 W; none | Recruits the eight DE Bedouin types with peasants and gold when enabled. |
| Stable | 20 W + 400 G; none | Provides up to four horses for European knights; horses must be available when recruiting. Mercenary mounted units do not use these horses. |
| Engineers' guild | 10 W + 100 G; none | Recruits engineers and laddermen for gold and peasants. |
| Tunnelers' guild | Check UI; none | Recruits tunnelers for gold and peasants; manual does not specify a useful construction cost. |

Workshops with two products must be set to the intended one. Check each unit's
recruitment tooltip for its gold cost and highlighted equipment; equipment listed
below is **per soldier**, in addition to one peasant and gold.

## Troops

### European troops — barracks

| Unit | Equipment required | Role and limitations |
|---|---|---|
| Archer | 1 bow | Long-range fire against lightly armored enemies. Fast and fragile; protect from melee. Can climb ladders and dig/fill moats. |
| Crossbowman | 1 crossbow + 1 leather armor | Strong against metal armor. Slower movement/reload and shorter range than archers; needs protection. |
| Spearman | 1 spear | Cheap, lightly protected melee and utility troop. Can climb ladders, push enemy ladders off walls and work on moats. |
| Pikeman | 1 pike + 1 metal armor | Durable defensive infantry for holding narrow entrances and protecting ranged troops. Slow; can work on moats. |
| Maceman | 1 mace + 1 leather armor | Mobile assault infantry with strong melee damage, but vulnerable to missile fire. Can climb ladders and work on moats. |
| Swordsman | 1 sword + 1 metal armor | Powerful, heavily armored melee infantry. Very slow; poor at chasing or responding across a large map. |
| Knight | 1 sword + 1 metal armor + 1 available stable horse | Fast, powerful cavalry for raids, interception and attacks on siege equipment. Expensive supply chain. |

### Arabian troops — mercenary post

All arrive equipped for gold; no weapons, armor or stable horses need be supplied.

| Unit | Role and limitations |
|---|---|
| Arabian archer / Arabian bow | Ready-to-hire ranged troop; useful when a bow production chain is unavailable. Protect from melee. |
| Slave | Cheap, fragile incendiary raider. Can set vulnerable buildings on fire and work on moats; poor in direct combat. |
| Slinger | Cheap short-range missile support against lightly protected targets. Avoid long-range duels. |
| Assassin | Concealed until detected nearby; climbs enemy walls with grappling hooks and can capture gatehouses. Detection is indicated by an exclamation mark. |
| Horse archer | Fast cavalry that fires while moving. Useful for harassment and kiting; avoid being trapped or entering concentrated defensive fire. |
| Arabian swordsman | Strong melee infantry, somewhat less protected and quicker than the European swordsman; still slow relative to light troops. |
| Fire thrower | Short-range fire attacks against troops and flammable buildings. Vulnerable if exposed; fire can spread beyond the intended target. |

### Bedouin troops — stockade (Definitive Edition)

Availability depends on the scenario/options; classic trails can have these
units disabled. Like Arabian mercenaries, they are hired already equipped.

| Unit | Role and limitations |
|---|---|
| Skirmisher | Relatively inexpensive javelin infantry, useful in groups; lightly protected. Can climb ladders and work on moats. |
| Sapper | Specialized wall breaker, weak in ordinary combat. Fire-resistant protection helps against pitch defenses; can work on moats. |
| Camel lancer | Fast mounted melee unit for chasing mobile enemies and raiding. |
| Heavy camel | Combines a melee fighter and archer on one mount; durable combined combat role, less agile than light cavalry. |
| Demolisher | Breaks walls and reveals enemy defenses. Its shield gives temporary missile protection; slow, and can work on moats. |
| Eunuch | Strong melee defender with area damage against groups; extremely slow. Can work on moats. |
| Healer | Restores troops' health on the battlefield; poor fighter. Keep behind the combat line. |
| Ambusher | Conceals itself while stationary and attacks with fire pots; suited to ambush positions. |

### Specialists

- **Engineer:** Recruit at engineers' guild. Builds and crews siege engines,
  mans tower weapons, handles boiling oil and can work on moats. Protect from combat.
- **Ladderman:** Recruit at engineers' guild. Places ladders against enemy walls;
  only ladder-capable troops can follow. Extremely vulnerable while approaching.
- **Tunneler:** Recruit at tunnelers' guild. Starts a tunnel near enemy defenses
  to damage their foundations. Limited reach; cannot pass beneath moats or undermine
  large square/round towers, though smaller turrets/lookout towers are vulnerable.
- **Black monk / temple guard:** Recruit at cathedral / grand mosque respectively
  for peasants and gold. Staff-armed melee troops; no armory equipment required.
- **Lord:** Your critical survival unit. Do not treat him as expendable infantry.

## Fortifications and siege

| Structure | Cost / requirements | Use |
|---|---|---|
| Stone walls and stairs | Stone; exact footprint cost in UI | Block ground approaches. Stairs/connectivity let infantry reach the top. A wall without access cannot serve as a firing position. |
| Small / large stone gatehouse | 10 / 20 S | Allows friendly traffic through defenses. Enemy troops can capture gates; defend their approaches and tops. |
| Drawbridge | 10 W; attach to gatehouse | Crosses a moat and can be raised to obstruct attackers. |
| Lookout tower / perimeter turret / defense turret | 10 / 10 / 15 S | Elevated defensive positions; protection and capacity vary. |
| Square / round tower | 35 / 40 S | Stronger positions that support mounted siege weapons; resistant to tunneling. |
| Moat | Eligible troops and suitable low ground | Marking a plan does not dig it. Assign capable troops and allow time; attackers can fill it. |
| Killing pit | 6 W | Concealed trap lethal to many troops. |
| Pitch ditch | 2 pitch per 5 squares | Ignite using a nearby brazier-equipped archer; placement alone does not trigger fire. |
| Oil smelter | 10 iron + 100 G; pitch and engineers | First engineer operates the smelter; additional engineers collect pots and pour oil on attackers. |
| Caged war dogs | 10 W + 100 G | Released dogs attack nearby units/workers; their attacks are not safely limited to enemies. |
| Tower ballista / mangonel | Suitable tower, gold and engineer crew; check UI | Ballista provides accurate anti-siege fire; mangonel scatters stones against groups. |

Select an engineer to build field siege equipment. Pay its displayed construction
cost, protect the construction tent, then provide the required crew. An uncrewed
machine cannot operate. Construction cost and crew recruitment are separate.

| Siege engine | Crew | Purpose / requirements |
|---|---|---|
| Portable shield | 1 engineer | Mobile protection from missiles; vulnerable to melee. |
| Battering ram | 4 engineers | Close-range destruction of gates, walls and towers; slow approach. |
| Siege tower | 4 engineers | Move against an enemy wall to deploy a bridge for infantry access. |
| Catapult | 2 engineers | Mobile, medium-range bombardment of structures; needs rock ammunition. |
| Trebuchet | 3 engineers | Fixed-position, long-range bombardment; less accurate but powerful. Needs rock ammunition. |
| Fire ballista | Check crew requirement in UI | Mobile fire against troops and flammable buildings; does not damage stone defensive structures. |

Catapults/trebuchets can replenish ammunition by exchanging 10 stockpiled stone
for 20 rocks. They can also launch diseased cattle. Disease and fire threaten an
economy as well as troops; firefighting and apothecaries address different hazards.
<!-- /military -->

## Acting on observations

- Check popularity, food, gold, housing and idle peasants regularly.
- Before building, check terrain, cost, workers, inputs, storage and access.
<!-- military -->
- Before recruiting, check idle peasants, gold, equipment/horses and unit availability.
- Before attacking, assess visible enemy protection, approach routes and your own
  ranged/melee/siege balance. Protect ranged troops and siege crews from melee.
<!-- /military -->
- After acting, confirm the building, inventory change, selected units or movement
  on a fresh observation. Let game time pass before judging production.

<!--
Sources and scope: paraphrased from Firefly's [official Definitive Edition manual](https://store.steampowered.com/manual/3024040),
sections 3–10: economy, recruitment, combat, siege, building costs and unit tables.
The manual is linked by [Firefly Support](https://firefly-studios.helpshift.com/hc/en/18-stronghold-crusader-definitive-edition/faq/616-is-there-a-manual-for-stronghold-crusader-definitive-edition/).
Reviewed 2026-09-19. Where the manual is ambiguous or omits a cost, this reference
explicitly defers to the UI; it does not invent a value. Tactical advice is general
guidance, not a claim that a particular benchmark strategy has been validated.
-->
