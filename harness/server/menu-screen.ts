/**
 * Which pre-game screen is showing, from a few pixel colours of a capture (sampled by
 * tools/runner/screen_probe.py). The episode runner waits for the main menu and the Load Game
 * dialog with this instead of waiting for the screen to stop changing, which the animated menu
 * never does (a 90 s and a 15 s timeout ran out in every load before, about 105 s of each launch).
 *
 * Points are in the 1920 x 1080 menu layout. Colours measured on captures from 2026-09-28: on the
 * main menu the six button bars are near black (each channel at most 16) over the bright cover
 * art; on the Load Game dialog the parchment is tan (R about 205-215, G 170-177, B 120-128) under a
 * dark red header row (99, 18, 0). The Firefly logo is black throughout, and the loading screen
 * and the promo splash are bright or mixed at the bar points.
 */
export const MENU_PROBES = {
  loadBarLeft: [560, 1018],
  loadBarRight: [790, 1018],
  skirmishLeft: [1240, 80],
  skirmishRight: [1640, 120],
  mapEditorRight: [1640, 720],
  roadmapLeft: [1240, 870],
  art: [400, 600],
  dialogTop: [1200, 130],
  dialogHeader: [1000, 212],
} as const satisfies Record<string, readonly [number, number]>;
export type ProbeName = keyof typeof MENU_PROBES;
export type Rgb = readonly [number, number, number];
export type MenuScreen = "main_menu" | "load_dialog" | "other";

const dark = ([r, g, b]: Rgb) => Math.max(r, g, b) <= 40;
const bright = ([r, g, b]: Rgb) => (r + g + b) / 3 >= 80;
const parchment = ([r, g, b]: Rgb) => r >= 170 && g >= 130 && b >= 80 && b <= 160 && r > g && g > b;
const darkRed = ([r, g, b]: Rgb) => r >= 60 && r <= 140 && g <= 45 && b <= 35;

/** The screen the probe colours show; `colours` follows MENU_PROBES' order. */
export function menuScreen(colours: readonly Rgb[]): MenuScreen {
  const names = Object.keys(MENU_PROBES) as ProbeName[];
  if (colours.length !== names.length) return "other";
  const at = Object.fromEntries(names.map((name, i) => [name, colours[i]])) as Record<ProbeName, Rgb>;
  const bars: ProbeName[] = ["loadBarLeft", "loadBarRight", "skirmishLeft", "skirmishRight", "mapEditorRight", "roadmapLeft"];
  if (bars.every((name) => dark(at[name])) && bright(at.art)) return "main_menu";
  const sheet: ProbeName[] = ["art", "dialogTop", "skirmishLeft", "skirmishRight"];
  if (sheet.every((name) => parchment(at[name])) && darkRed(at.dialogHeader)) return "load_dialog";
  return "other";
}
