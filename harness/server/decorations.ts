/**
 * Bad and good things: built from the Town page's fear-factor and good-factor subpages. `at` is the
 * item's centre on the 1920 × 1080 tray and `gold` the price its tooltip shows, read from the live
 * tray on Oasis by the Sea, 2026-10-10 (clicking each centre showed that item's tooltip). Heads on
 * Spikes (no price shown, and its click selected nothing) and the flags (keep decorations) are left
 * out. None has workers.
 */
export const decorations: Record<string, { kind: "bad" | "good"; at: readonly [number, number]; gold: number }> = {
  Gallows: { kind: "bad", at: [900, 975], gold: 50 },
  Cesspit: { kind: "bad", at: [970, 955], gold: 40 },
  Stocks: { kind: "bad", at: [1015, 1005], gold: 45 },
  "Burning Stake": { kind: "bad", at: [1105, 985], gold: 45 },
  Dungeon: { kind: "bad", at: [1165, 945], gold: 40 },
  "Stretching Rack": { kind: "bad", at: [1255, 985], gold: 45 },
  Gibbet: { kind: "bad", at: [1340, 975], gold: 50 },
  "Chopping Block": { kind: "bad", at: [1410, 945], gold: 45 },
  "Dunking Stool": { kind: "bad", at: [1455, 990], gold: 40 },
  Maypole: { kind: "good", at: [915, 955], gold: 25 },
  "Dancing Bear": { kind: "good", at: [1005, 985], gold: 20 },
  "Shrub Garden": { kind: "good", at: [1055, 930], gold: 30 },
  "Town Garden": { kind: "good", at: [1155, 945], gold: 30 },
  "Large Garden": { kind: "good", at: [1115, 1000], gold: 30 },
  Statue: { kind: "good", at: [1235, 975], gold: 30 },
  Shrine: { kind: "good", at: [1285, 935], gold: 30 },
};
export const decorationNames: readonly string[] = Object.keys(decorations);
