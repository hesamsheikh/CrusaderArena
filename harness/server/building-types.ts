/**
 * The game's building types by engine type number (its structure list, read from the game files;
 * hovels 1, stockpile piles 10, granaries 19 and the keep 41 were also seen live), under the
 * names the harness uses for them. Types not listed here are reported by number.
 */
export const buildingTypes: Record<number, string> = {
  1: "Hovel",
  2: "Bedouin Outpost",
  3: "Woodcutter",
  4: "Ox Tether",
  5: "Iron Mine",
  6: "Pitch Rig",
  7: "Hunter's Post",
  8: "Barracks (wood)",
  9: "Barracks (stone)",
  10: "Stockpile pile",
  11: "Armoury",
  12: "Fletchers' Workshop",
  13: "Blacksmith's Workshop",
  14: "Poleturner's Workshop",
  15: "Armorer's Workshop",
  16: "Tanner's Workshop",
  17: "Bakery",
  18: "Brewery",
  19: "Granary",
  20: "Quarry",
  21: "Quarry pile",
  22: "Inn",
  23: "Apothecary",
  24: "Engineers' Guild",
  25: "Tunnellers' Guild",
  26: "Marketplace",
  27: "Well",
  28: "Oil Smelter",
  29: "Siege Tent",
  30: "Wheat Farm",
  31: "Hops Farm",
  32: "Apple Orchard",
  33: "Dairy Farm",
  34: "Mill",
  35: "Stables",
  36: "Chapel",
  37: "Church",
  38: "Cathedral",
  39: "Ruins",
  40: "Keep",
  41: "Keep",
  42: "Keep",
  43: "Keep",
  44: "Keep",
  45: "Gate",
  46: "Gate",
  47: "Gate",
  48: "Postern Gate",
  49: "Drawbridge",
  50: "Tunnel Entrance",
  52: "Signpost",
  55: "Campfire",
  60: "Gatehouse",
  61: "Tower",
  62: "Gallows",
  63: "Stocks",
  64: "Witch Hoist",
  65: "Maypole",
  66: "Garden",
  67: "Killing Pit",
  68: "Pitch Ditch",
  69: "Siege Tower",
  70: "Water Pot",
  71: "Keep door",
  72: "Keep door",
  73: "Keep door",
  74: "Tower",
  75: "Tower",
  76: "Tower",
  77: "Tower",
  78: "Tower",
  91: "Cesspit",
  92: "Burning Stake",
  93: "Gibbet",
  94: "Dungeon",
  95: "Stretching Rack",
  96: "Flogging Rack",
  97: "Chopping Block",
  98: "Dunking Stool",
  99: "Dog Cage",
  100: "Statue",
  101: "Shrine",
  102: "Bee Hive",
  103: "Dancing Bear",
  104: "Pond",
  105: "Bear Cave",
  109: "Dock",
};

/** Records that are parts of another building, or the map's own, not buildings the player placed. */
const parts = new Set(["Quarry pile", "Keep door", "Campfire", "Signpost"]);

/** The engine types whose records placing `name` adds: a Stockpile adds piles. */
export function typesOf(name: string): number[] {
  const wanted = name === "Stockpile" ? "Stockpile pile" : name;
  return Object.entries(buildingTypes).filter(([, n]) => n === wanted).map(([t]) => Number(t));
}

/**
 * Buildings a lord can have only one of. With a Marketplace standing, choosing it again in the
 * menu centres the view on it, and clicks on open ground place nothing (a recorded run, 2026-10-12).
 */
const singleBuildings = new Set(["Marketplace"]);

/** Whether `name` is a one-only building the player already has, from the reader's counts by type. */
export function alreadyBuilt(name: string, observation: Record<string, unknown> | null | undefined) {
  if (!singleBuildings.has(name)) return false;
  const counts = observation?.buildings as Record<string, number> | undefined;
  return !!counts && typeof counts === "object" && typesOf(name).some((t) => (counts[String(t)] ?? 0) > 0);
}

/**
 * The player's buildings by name from the reader's counts by type: a stockpile's four piles
 * count as one stockpile, parts of other buildings are left out, and unnamed types appear as
 * "type <number>". Sorted by count, most first.
 */
export function namedBuildings(byType: Record<string, number>) {
  const named: Record<string, number> = {};
  for (const [type, count] of Object.entries(byType)) {
    if (!(count > 0)) continue;
    const name = buildingTypes[Number(type)] ?? `type ${type}`;
    if (parts.has(name)) continue;
    if (name === "Stockpile pile" && count % 4 === 0) named.Stockpile = (named.Stockpile ?? 0) + count / 4;
    else named[name] = (named[name] ?? 0) + count;
  }
  return Object.fromEntries(Object.entries(named).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)));
}
