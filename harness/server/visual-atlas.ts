import { existsSync, readFileSync } from "node:fs";

// Source PNGs include a 1920 × 1080 game frame plus labels. The served PNGs
// contain only the construction tray, cropped from the source without redraw.
export type GuideLabel = {
  name: string;
  detail: string;
  box: readonly [number, number, number, number];
};
type GuidePage = {
  id: string;
  title: string;
  file: string;
  labels: readonly GuideLabel[];
};

export const atlasPages = [
  {
    id: "construction-overview",
    title: "Construction categories",
    file: "construction-overview.png",
    labels: [
      { name: "Castle Buildings", detail: "Walls, barracks, towers, gates and defenses.", box: [826, 1032, 46, 46] },
      { name: "Industry Buildings", detail: "Stockpile, raw materials and the marketplace.", box: [876, 1032, 47, 46] },
      { name: "Farm Buildings", detail: "Dairy, apples, wheat and hops.", box: [925, 1032, 47, 46] },
      { name: "Town Buildings", detail: "Housing, religion, health, water and fear-factor pages.", box: [975, 1032, 47, 46] },
      { name: "Weapons Buildings", detail: "Workshops that make arms and armor.", box: [1025, 1032, 48, 46] },
      { name: "Food Processing Buildings", detail: "Granary, bread, flour, ale and the inn.", box: [1077, 1032, 49, 46] },
      { name: "Building choices", detail: "The selected category replaces the icons in this tray. Read a fresh tooltip before placing.", box: [814, 906, 703, 127] },
    ],
  },
  {
    id: "castle",
    title: "Castle Buildings",
    file: "castle.png",
    labels: [
      { name: "Wall Stairs", detail: "Give troops access to walls and towers.", box: [816, 925, 62, 101] },
      { name: "Low Wall", detail: "Shorter, cheaper stone wall.", box: [873, 929, 82, 75] },
      { name: "Stone Wall", detail: "Standard stone wall.", box: [960, 928, 86, 90] },
      { name: "Crenelated Wall", detail: "Extra protection on existing walls.", box: [1051, 920, 93, 104] },
      { name: "Barracks", detail: "Recruit troops.", box: [1143, 929, 85, 91] },
      { name: "Mercenary Post", detail: "Recruit Arab troops.", box: [1234, 917, 84, 78] },
      { name: "Armory", detail: "Store weapons.", box: [1320, 917, 77, 108] },
      { name: "Towers", detail: "Opens five tower choices.", box: [1403, 926, 41, 46] },
      { name: "Defense equipment", detail: "Opens engineers, siege defenses and stables.", box: [1455, 926, 43, 46] },
      { name: "Gates and traps", detail: "Opens gatehouses, drawbridge, moat and traps.", box: [1403, 981, 41, 48] },
    ],
  },
  {
    id: "industry",
    title: "Industry Buildings",
    file: "industry.png",
    labels: [
      { name: "Stockpile", detail: "Stores resources.", box: [826, 909, 91, 49] },
      { name: "Woodcutter", detail: "Produces wood near trees.", box: [824, 958, 112, 68] },
      { name: "Quarry", detail: "Produces stone on a deposit; needs an Ox Tether.", box: [945, 917, 112, 110] },
      { name: "Ox Tether", detail: "Moves quarry stone to the Stockpile.", box: [1062, 939, 74, 82] },
      { name: "Iron Mine", detail: "Produces iron on an iron deposit.", box: [1145, 920, 105, 104] },
      { name: "Pitch Rig", detail: "Produces pitch on marshland.", box: [1250, 931, 130, 91] },
      { name: "Marketplace", detail: "Buy and sell food, resources and weapons.", box: [1384, 917, 109, 110] },
    ],
  },
  {
    id: "farm",
    title: "Farm Buildings",
    file: "farm.png",
    labels: [
      { name: "Dairy Farm", detail: "Produces cheese and cow skins on fertile oasis ground.", box: [982, 919, 111, 110] },
      { name: "Apple Orchard", detail: "Produces apples on fertile oasis ground.", box: [1110, 919, 111, 110] },
      { name: "Wheat Farm", detail: "Produces wheat for the Mill on fertile oasis ground.", box: [1248, 919, 105, 110] },
      { name: "Hops Farm", detail: "Produces hops for the Brewery on fertile oasis ground.", box: [1372, 919, 105, 110] },
    ],
  },
  {
    id: "town",
    title: "Town Buildings",
    file: "town.png",
    labels: [
      { name: "Hovel", detail: "Houses peasants; the tooltip says each adds 8.", box: [828, 932, 75, 91] },
      { name: "Chapel", detail: "Creates priests who bless the population.", box: [909, 929, 72, 92] },
      { name: "Church", detail: "Creates priests who bless the population.", box: [980, 920, 111, 103] },
      { name: "Cathedral", detail: "Blesses the population and recruits Monks.", box: [1094, 913, 145, 116] },
      { name: "Apothecary", detail: "Treats sickness and removes disease clouds.", box: [1235, 929, 106, 97] },
      { name: "Well", detail: "Puts out nearby fires.", box: [1320, 916, 76, 54] },
      { name: "Water Pot", detail: "A larger water source with three well boys.", box: [1362, 971, 80, 61] },
      { name: "Fear-factor page", detail: "Opens punishment structures and traps that reduce popularity.", box: [1457, 923, 48, 49] },
      { name: "Good-factor page", detail: "Opens gardens, decorations and flags.", box: [1457, 982, 48, 47] },
    ],
  },
  {
    id: "weapons",
    title: "Weapons Buildings",
    file: "weapons.png",
    labels: [
      { name: "Fletchers' Workshop", detail: "Uses wood to make bows or crossbows.", box: [832, 917, 95, 109] },
      { name: "Poleturner's Workshop", detail: "Uses wood to make spears or pikes.", box: [965, 917, 96, 109] },
      { name: "Blacksmith's Workshop", detail: "Uses iron to make swords or maces.", box: [1105, 917, 94, 109] },
      { name: "Tanner's Workshop", detail: "Uses cow skins to make leather armor.", box: [1231, 917, 101, 109] },
      { name: "Armorer's Workshop", detail: "Uses iron to make metal armor.", box: [1370, 917, 99, 109] },
    ],
  },
  {
    id: "food-processing",
    title: "Food Processing Buildings",
    file: "food-processing.png",
    labels: [
      { name: "Granary", detail: "Stores food; food rations are set there.", box: [832, 917, 99, 110] },
      { name: "Bakery", detail: "Uses flour to make bread.", box: [966, 917, 99, 110] },
      { name: "Mill", detail: "Grinds wheat into flour.", box: [1096, 917, 102, 110] },
      { name: "Brewery", detail: "Turns hops into ale.", box: [1234, 917, 101, 110] },
      { name: "Inn", detail: "Uses ale for the population.", box: [1369, 917, 101, 110] },
    ],
  },
  {
    id: "castle-towers",
    title: "Castle Towers",
    file: "castle-towers.png",
    labels: [
      { name: "Back", detail: "Returns to Castle Buildings.", box: [833, 942, 48, 52] },
      { name: "Lookout Tower", detail: "Cheap tall tower with height advantage.", box: [927, 917, 58, 111] },
      { name: "Perimeter Turret", detail: "Small, cheap first-line turret.", box: [1032, 917, 77, 111] },
      { name: "Defense Turret", detail: "Medium tower with a missile range bonus.", box: [1147, 917, 77, 111] },
      { name: "Square Tower", detail: "Large tower; can hold a mangonel or ballista.", box: [1263, 917, 87, 111] },
      { name: "Round Tower", detail: "Large tower; can hold a mangonel or ballista.", box: [1380, 917, 87, 111] },
    ],
  },
  {
    id: "castle-defense",
    title: "Castle Defense Equipment",
    file: "castle-defense.png",
    labels: [
      { name: "Back", detail: "Returns to Castle Buildings.", box: [834, 942, 48, 52] },
      { name: "Engineer's Guild", detail: "Trains engineers and laddermen.", box: [907, 917, 96, 111] },
      { name: "Mangonel", detail: "Tower-mounted rock defense; needs engineers.", box: [1005, 917, 96, 111] },
      { name: "Ballista", detail: "Tower-mounted bolt defense; needs engineers.", box: [1110, 917, 98, 111] },
      { name: "Stables", detail: "Breeds horses for knights.", box: [1215, 917, 95, 111] },
      { name: "Tunneler's Guild", detail: "Trains tunnelers.", box: [1320, 917, 96, 111] },
      { name: "Oil Smelter", detail: "Turns pitch into boiling oil for castle defense.", box: [1420, 917, 93, 111] },
    ],
  },
  {
    id: "castle-gates",
    title: "Castle Gates and Traps",
    file: "castle-gates.png",
    labels: [
      { name: "Back", detail: "Returns to Castle Buildings.", box: [827, 945, 47, 51] },
      { name: "Small Stone Gatehouse page", detail: "Opens two orientations of the Small Stone Gatehouse.", box: [908, 934, 68, 91] },
      { name: "Large Stone Gatehouse page", detail: "Opens two orientations of the Large Stone Gatehouse.", box: [997, 931, 88, 96] },
      { name: "Drawbridge", detail: "Attach to a stone gatehouse across a moat.", box: [1106, 916, 93, 111] },
      { name: "Caged War Dogs", detail: "Releases attack dogs from a cage.", box: [1227, 923, 95, 105] },
      { name: "Pitch Ditch", detail: "Ground defense that can be set alight.", box: [1332, 925, 69, 52] },
      { name: "Killing Pits", detail: "Ground spikes triggered by enemy troops.", box: [1332, 983, 69, 46] },
      { name: "Brazier", detail: "Lets archers light arrows on walls and towers.", box: [1419, 957, 38, 48] },
      { name: "Dig Moat", detail: "Marks ground to be dug into a moat.", box: [1463, 927, 44, 47] },
      { name: "No Moat", detail: "Removes a moat-digging designation.", box: [1463, 979, 44, 47] },
    ],
  },
] as const satisfies readonly GuidePage[];

export type AtlasPageId = (typeof atlasPages)[number]["id"];
const atlasRoot = new URL("../../.internal/ui-reference/trays/", import.meta.url);
const combinedFile = new URL("../../.internal/ui-reference/construction-trays.png", import.meta.url);

/** Whether the private combined guide image is installed on this host. */
export function constructionAtlasInstalled() {
  return existsSync(combinedFile);
}

/**
 * The preparation guide. The button names and roles come from the public manifest above;
 * the combined image is a private game screenshot, so a checkout without it gets text only.
 */
export function constructionAtlas() {
  const image = constructionAtlasInstalled() ? readFileSync(combinedFile).toString("base64") : null;
  return {
    image,
    text: [
      image
        ? "HISTORICAL CONSTRUCTION MENU GUIDE: one PNG containing the exact cropped construction trays for all ten pages. Numbered button descriptions are printed beneath each tray. Steam build 24816905; this is not a current observation or targeting frame."
        : "HISTORICAL CONSTRUCTION MENU GUIDE (text only; the guide image is not installed on this host): the buttons of all ten construction menu pages from Steam build 24816905. Find them on screen with the screen layout in your instructions and the game's tooltips.",
      ...atlasPages.map((page, index) =>
        `${index + 1}. ${page.title}: ${page.labels.map((label, i) => `${i + 1} ${label.name} — ${label.detail}`).join("; ")}`,
      ),
      "Inspect the live game image and tooltip before acting; availability, prices and map state may differ.",
    ].join("\n"),
  };
}

const exampleFile = new URL("../../.internal/ui-reference/example-settlement.jpg", import.meta.url);

/** A private screenshot of a developed settlement from an earlier human game, shown once for scale. */
export function exampleSettlement() {
  if (!existsSync(exampleFile)) return null;
  return {
    image: readFileSync(exampleFile).toString("base64"),
    text: "EXAMPLE OF WHAT IS POSSIBLE: a screenshot from an earlier human game on a different map, several game years in. It shows the scale a strong economy reaches: a walled town with dense hovels, rows of farms, a large industrial district, granaries and a stockpile grown into a large block. It is not the current map, and positions in it are not targets.",
  };
}

export function availableAtlasPages() {
  return atlasPages.filter((page) => existsSync(new URL(page.file, atlasRoot)));
}
export function atlasIndex() {
  const pages = availableAtlasPages();
  return pages.length
    ? `Optional historical cropped building-tray PNGs, retrievable with guide_page(page): ${pages.map((p) => `${p.id} (${p.title})`).join(", ")}. Steam build 24816905; these are references, not current map state. Request only the page needed for the current panel.`
    : "No private historical building guide pages are installed. Inspect the live UI and its tooltips.";
}
export function atlasPage(id: AtlasPageId) {
  const page = atlasPages.find((p) => p.id === id)!;
  const imageFile = new URL(page.file, atlasRoot);
  if (!existsSync(imageFile)) return null;
  const image = readFileSync(imageFile).toString("base64");
  const text = [
    `HISTORICAL BUILDING GUIDE: ${page.title}. Exact 780 × 230 construction-tray crop from a paused game screenshot on Steam build 24816905, captured 2026-09-23. The red numbers match the list below. This is not a current observation or targeting frame.`,
    ...page.labels.map((label, i) => `${i + 1}. ${label.name}: ${label.detail}`),
    "Inspect the current game image and tooltip before acting; availability, prices and map state may differ.",
  ].join("\n");
  return { page, text, image };
}

export function atlasHtml(id: AtlasPageId) {
  const result = atlasPage(id);
  if (!result) return null;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${result.page.title}</title><style>body{margin:0;padding:24px;background:#17201e;color:#fff;font:16px system-ui}main{max-width:900px;margin:auto}img{display:block;max-width:100%;height:auto}li{margin:12px 0}</style><main><h1>${result.page.title}</h1><p>Historical construction tray from Steam build 24816905. Use the live game image and tooltip for actions.</p><img alt="${result.page.title} construction tray" src="data:image/png;base64,${result.image}"><ol>${result.page.labels.map((label) => `<li><strong>${label.name}</strong>: ${label.detail}</li>`).join("")}</ol></main></html>`;
}
