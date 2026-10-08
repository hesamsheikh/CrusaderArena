import type { Frame } from "../shared/protocol.js";
import { availableAtlasPages } from "./visual-atlas.js";

// Percentages describe the tested 1920 × 1080 construction bar, not targeting coordinates.
// One table drives both the human overlay and the screen layout in the model's system prompt.
const regions = [
  {
    number: 1,
    title: "Castle Buildings",
    box: [43, 95.5, 2.4, 4.3],
    detail: "Walls, barracks, towers, gates and defenses.",
  },
  {
    number: 2,
    title: "Industry Buildings",
    box: [45.6, 95.5, 2.4, 4.3],
    detail: "Stockpile, raw materials and marketplace.",
  },
  {
    number: 3,
    title: "Farm Buildings",
    box: [48.2, 95.5, 2.4, 4.3],
    detail: "Dairy Farm, Apple Orchard, Wheat Farm and Hops Farm.",
  },
  {
    number: 4,
    title: "Town Buildings",
    box: [50.8, 95.5, 2.4, 4.3],
    detail: "Housing, religious and health buildings, water, and town subpages.",
  },
  {
    number: 5,
    title: "Weapons Buildings",
    box: [53.4, 95.5, 2.5, 4.3],
    detail: "Workshops that make bows, spears, iron weapons and armor.",
  },
  {
    number: 6,
    title: "Food Processing Buildings",
    box: [56.1, 95.5, 2.5, 4.3],
    detail: "Granary, Bakery, Mill, Brewery and Inn.",
  },
  {
    number: 7,
    title: "Building choices",
    box: [42.4, 83.8, 36.6, 11.8],
    detail: "The selected category or subpage fills this tray with building buttons.",
  },
] as const;

/**
 * Where the construction controls are, for the system prompt: static, so it is cached and
 * survives compaction. The percentages come from the tested 1920 × 1080 layout.
 */
export function screenLayout() {
  return [
    "## Screen layout",
    "",
    "The construction controls sit along the bottom of the screen; positions are percentages of the screenshot's width and height in the tested 1920 × 1080 layout. `build_structure`, `place_near` and `expand_storage` open these menus for you. If the screen shows a different panel, ignore regions that are absent, and take click targets from screenshots, never from these percentages.",
    "",
    ...regions.map(
      (r) =>
        `${r.number}. ${r.title} (left ${r.box[0]}%, top ${r.box[1]}%, width ${r.box[2]}%, height ${r.box[3]}%): ${r.detail}`,
    ),
  ].join("\n");
}

/** A note for the first screenshot when the window is not the tested size; null when it is. */
export function layoutNote(frame: Frame) {
  return frame.width === 1920 && frame.height === 1080
    ? null
    : `This screenshot is ${frame.width} × ${frame.height}; the screen-layout percentages in your instructions come from a 1920 × 1080 window and are approximate here.`;
}

/** Overlay the same numbered regions the model sees in its starting observation. */
export function visualGuide(frame: Frame) {
  const labels = regions
    .map(
      (r) =>
        `<div class="region" style="left:${r.box[0]}%;top:${r.box[1]}%;width:${r.box[2]}%;height:${r.box[3]}%"><span>${r.number}</span></div>`,
    )
    .join("");
  const descriptions = regions
    .map((r) => `<li><strong>${r.number}. ${r.title}.</strong> ${r.detail}</li>`)
    .join("");
  const atlasLinks = availableAtlasPages()
    .map((page) => `<li><a href="/api/guide/${page.id}">${page.title}</a></li>`)
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Starting screenshot legend</title><style>
body{background:#171d1a;color:#eee;font:16px system-ui;max-width:1200px;margin:24px auto;padding:16px}.scene{position:relative}.scene img{width:100%;display:block}.region{position:absolute;box-sizing:border-box;border:2px solid #a8e0b8;pointer-events:none}.region span{position:absolute;top:0;left:0;background:#122821;color:#fff;padding:2px 7px;font-weight:700}li{margin:10px 0}strong{color:#b5e3c8}a{color:#b5e3c8}
</style><h1>Starting screenshot legend</h1><p>This is the first game-window image from this run. The numbered regions show approximate construction controls for the tested 1920 × 1080 HUD; menus, panel selections, scaling and scenarios can change them. The model receives this same legend with its first observation. <strong>Use a fresh image for every action target.</strong></p>
<div class="scene"><img alt="Original starting game-window observation" src="data:image/jpeg;base64,${frame.image}">${labels}</div><ul>${descriptions}</ul>
<p>Z zooms out, X zooms in and P toggles pause. Re-observe after camera, zoom, menu or panel changes. Input acknowledgement is not proof of success.</p><h2>Annotated building screenshots</h2><p>Optional references from Steam build 24816905 at 1920 × 1080. Each page has red rectangles around the actual buttons and tooltip-checked names. These are not current observations.</p><ul>${atlasLinks}</ul></html>`;
}
