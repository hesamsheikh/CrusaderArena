/**
 * Square building footprints in tiles, read from the game's own data: the managed
 * Setup_eStructToMapperDictionary maps each STRUCT_* type to a placement mapper, and
 * CrusaderDE.dll's DLL_GetMapperSize switch gives each mapper's size (static analysis
 * of Steam build 24816905, 2026-09-29).
 */
export const footprintTiles: Record<string, number> = {
  Stockpile: 5,
  Woodcutter: 3,
  Quarry: 6,
  "Ox Tether": 2,
  "Iron Mine": 4,
  "Pitch Rig": 4,
  Marketplace: 5,
  "Dairy Farm": 10,
  "Apple Orchard": 10,
  "Wheat Farm": 9,
  "Hops Farm": 9,
  Hovel: 4,
  Chapel: 6,
  Church: 9,
  Cathedral: 13,
  Apothecary: 6,
  Well: 3,
  "Water Pot": 4,
  "Fletchers' Workshop": 4,
  "Poleturner's Workshop": 4,
  "Blacksmith's Workshop": 4,
  "Tanner's Workshop": 4,
  "Armorer's Workshop": 4,
  Granary: 4,
  Bakery: 4,
  Mill: 3,
  Brewery: 4,
  Inn: 5,
};

/** Footprints of the buildings place_near and expand_storage can anchor on. */
export const anchorFootprintTiles = {
  keep: 7, // the first two keep types; larger keeps are 11
  granary: 4,
  market: 5,
  barracks: 5,
  armoury: 4,
  engineers_guild: 5,
  mercenary_post: 5,
  signpost: 2,
  stockpile: 5,
} as const;

/** Footprint side in tiles; unknown names get a conservative mid-size default. */
export function footprintOf(name: string) {
  return footprintTiles[name] ?? 4;
}
