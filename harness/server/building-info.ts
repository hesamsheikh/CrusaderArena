import { readFileSync } from "node:fs";
import { atlasPages } from "./visual-atlas.js";
import { footprintTiles } from "./footprints.js";

type ManualBuilding = {
  name: string;
  buildCost: string;
  workers: string | null;
  functionAndRequirements: string;
  section: string;
};

const manual = readFileSync(new URL("../../prompt/game-mechanics.md", import.meta.url), "utf8");
const sections = new Set([
  "Buildings: economy, food and services",
  "Military production and recruitment buildings",
  "Fortifications and siege",
]);
const manualBuildings: ManualBuilding[] = [];
let section = "";
for (const line of manual.split("\n")) {
  if (line.startsWith("## ")) section = line.slice(3).trim();
  if (line.startsWith("| Siege engine |")) section = "Siege engines";
  if (!sections.has(section) || !line.startsWith("|")) continue;
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length !== 3 || cells[0] === "Building" || cells[0] === "Structure" ||
      /^-+$/.test(cells[0])) continue;
  const separator = section === "Fortifications and siege" ? -1 : cells[1].lastIndexOf(";");
  manualBuildings.push({
    name: cells[0],
    buildCost: separator >= 0 ? cells[1].slice(0, separator).trim() : cells[1],
    workers: separator >= 0 ? cells[1].slice(separator + 1).trim() : null,
    functionAndRequirements: cells[2],
    section,
  });
}

const aliases: Record<string, string> = {
  "apple farm": "Apple Orchard",
  "cheese farm": "Dairy Farm",
  house: "Hovel",
  "hunter hut": "Hunter's post",
  "fletchers' workshop": "Fletcher",
  "poleturner's workshop": "Poleturner",
  "blacksmith's workshop": "Blacksmith",
  "tanner's workshop": "Tanner",
  "armorer's workshop": "Armorer",
  stables: "Stable",
  "engineer's guild": "Engineers' guild",
  "tunneler's guild": "Tunnelers' guild",
  "killing pits": "Killing pit",
  "wall stairs": "Stone walls and stairs",
  "low wall": "Stone walls and stairs",
  "stone wall": "Stone walls and stairs",
  "crenelated wall": "Stone walls and stairs",
  "lookout tower": "Lookout tower / perimeter turret / defense turret",
  "perimeter turret": "Lookout tower / perimeter turret / defense turret",
  "defense turret": "Lookout tower / perimeter turret / defense turret",
  "square tower": "Square / round tower",
  "round tower": "Square / round tower",
  "small stone gatehouse": "Small / large stone gatehouse",
  "large stone gatehouse": "Small / large stone gatehouse",
  mangonel: "Tower ballista / mangonel",
  ballista: "Tower ballista / mangonel",
  "chapel": "Chapel / simple mosque",
  "church": "Church / mosque",
  "cathedral": "Cathedral / grand mosque",
};

const nonBuildingLabels = new Set([
  "Back", "Towers", "Defense equipment", "Gates and traps",
  "Fear-factor page", "Good-factor page", "Dig Moat", "No Moat",
  "Small Stone Gatehouse page", "Large Stone Gatehouse page",
]);
const atlasBuildings = atlasPages
  .filter((page) => page.id !== "construction-overview")
  .flatMap((page) => page.labels
    .filter((label) => !nonBuildingLabels.has(label.name))
    .map((label) => ({ name: label.name, category: page.title, atlasDescription: label.detail })));

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const lookupManual = (name: string) => manualBuildings.find((row) => normalize(row.name) === normalize(aliases[name.toLowerCase()] || name));
const exactCosts: Record<string, string> = {
  "Lookout Tower": "10 S", "Perimeter Turret": "10 S", "Defense Turret": "15 S",
  "Square Tower": "35 S", "Round Tower": "40 S",
  "Small Stone Gatehouse": "10 S", "Large Stone Gatehouse": "20 S",
};

export function listBuildings(category?: string) {
  const rows: { name: string; category: string }[] = atlasBuildings.map(({ name, category }) => ({ name, category }));
  for (const row of manualBuildings)
    if (!rows.some((entry) => lookupManual(entry.name)?.name === row.name))
      rows.push({ name: row.name, category: row.section });
  return category ? rows.filter((row) => normalize(row.category).includes(normalize(category))) : rows;
}

export function buildingInfo(query: string) {
  const wanted = normalize(query);
  const alias = aliases[query.toLowerCase()];
  const atlas = atlasBuildings.find((row) => normalize(row.name) === wanted) ||
    atlasBuildings.find((row) => normalize(row.name) === normalize(alias || query));
  const manualEntry = lookupManual(alias || atlas?.name || query);
  if (!atlas && !manualEntry) {
    const suggestions = listBuildings()
      .filter((row) => normalize(row.name).includes(wanted) || wanted.includes(normalize(row.name)))
      .slice(0, 8);
    return { found: false as const, query, suggestions };
  }
  return {
    found: true as const,
    name: atlas?.name || (alias ? query : manualEntry!.name),
    category: atlas?.category || manualEntry!.section,
    whatItDoes: manualEntry?.functionAndRequirements || atlas!.atlasDescription,
    buildCost: exactCosts[atlas?.name || query] || manualEntry?.buildCost || null,
    workers: manualEntry?.workers || null,
    // Square side in tiles, from the game's own placement data.
    footprintTiles: footprintTiles[atlas?.name ?? ""] ?? null,
    atlasDescription: atlas?.atlasDescription || null,
    source: manualEntry ? "project manual reference; default values, not live game state" : "tooltip-checked historical atlas; cost and workers unknown",
    note: "Check the current game tooltip for cost, availability and placement. A building needs suitable terrain, workers, inputs, storage and access to operate.",
  };
}

/**
 * Build cost from the manual ("20 W + 100 G"; W wood, S stone, G gold); where the manual lists
 * alternatives ("Free / 5 W in manual") the larger amount per resource is used. Null when unknown.
 */
export function costOf(name: string): { wood: number; stone: number; gold: number } | null {
  const info = buildingInfo(name);
  if (!info.found || !info.buildCost) return null;
  const cost = { wood: 0, stone: 0, gold: 0 };
  for (const m of info.buildCost.matchAll(/(\d[\d,]*)\s*([WSG])\b/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    const key = m[2] === "W" ? "wood" : m[2] === "S" ? "stone" : "gold";
    cost[key] = Math.max(cost[key], n);
  }
  return cost;
}

/** What is missing to pay for `name` from a reader observation; null when affordable or unknown. */
export function shortfall(name: string, observation: Record<string, unknown> | null | undefined) {
  const cost = costOf(name);
  const goods = observation?.resources_by_name as Record<string, number> | undefined;
  if (!cost || !goods || typeof observation?.gold !== "number") return null;
  const have = { wood: goods.wood_planks ?? 0, stone: goods.stone ?? 0, gold: observation.gold as number };
  const missing = Object.fromEntries(
    (["wood", "stone", "gold"] as const).filter((k) => cost[k] > have[k]).map((k) => [k, cost[k] - have[k]]),
  );
  return Object.keys(missing).length ? missing : null;
}
