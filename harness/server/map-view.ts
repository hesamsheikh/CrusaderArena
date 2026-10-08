import { crc32, deflateSync } from "node:zlib";

/**
 * A whole-map overview from the engine's tile layers (`crusader_probe --map-summary`):
 * one category letter per tile, drawn in screen orientation (up on the image is up on
 * the game screen: +x runs down-right, +y down-left) with a tile-coordinate grid, the
 * keep and the current view, plus a text list of the main deposits and farmland.
 */
export type MapSummary = { size: number; rows: string[]; bounds: { x0: number; y0: number; x1: number; y1: number } };
type Camera = { centre_tile_x: number; centre_tile_y: number; tiles_wide: number; tiles_high: number };
type Tile = { x: number; y: number };

/** Categories written by the probe (src/windows/native_tile_snapshot.hpp). */
export const categories: Record<string, { name: string; colour: [number, number, number] }> = {
  ".": { name: "open buildable land", colour: [214, 188, 140] },
  O: { name: "oasis grass (farms)", colour: [58, 190, 58] },
  s: { name: "scrub (farms if mostly oasis)", colour: [150, 185, 95] },
  S: { name: "stone ground (quarry)", colour: [235, 235, 235] },
  I: { name: "iron ore (iron mine)", colour: [178, 84, 30] },
  P: { name: "oil (pitch rig)", colour: [25, 25, 25] },
  m: { name: "marsh", colour: [110, 140, 120] },
  T: { name: "trees (woodcutters)", colour: [20, 95, 30] },
  R: { name: "rocks", colour: [125, 125, 125] },
  h: { name: "uneven ground (not buildable)", colour: [165, 132, 95] },
  M: { name: "mountain", colour: [95, 70, 55] },
  W: { name: "water / sea", colour: [45, 95, 200] },
  B: { name: "buildings", colour: [205, 40, 40] },
  K: { name: "keep", colour: [150, 0, 150] },
  F: { name: "farm fields", colour: [235, 205, 60] },
  a: { name: "animals", colour: [255, 0, 255] },
  x: { name: "other blocked ground", colour: [255, 150, 0] },
  _: { name: "outside the map", colour: [0, 0, 0] },
};

export function decodeRows(rle: string[]) {
  return rle.map((row) => row.replace(/(\D)(\d+)/g, (_m, c: string, n: string) => c.repeat(Number(n))));
}

export class MapView {
  readonly rows: string[];
  constructor(readonly summary: MapSummary) {
    this.rows = decodeRows(summary.rows);
  }
  at(t: Tile) {
    return this.rows[t.y]?.[t.x] ?? "_";
  }
  /** Connected areas of the given categories (4-neighbour), largest first. */
  areas(cats: string, minTiles = 1) {
    const { x0, y0, x1, y1 } = this.summary.bounds;
    const seen = new Set<number>();
    const found: { tiles: number; centre: Tile; box: { x0: number; y0: number; x1: number; y1: number } }[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = y * 1000 + x;
        if (seen.has(k) || !cats.includes(this.at({ x, y }))) continue;
        const stack = [{ x, y }];
        seen.add(k);
        let n = 0, sx = 0, sy = 0;
        const box = { x0: x, y0: y, x1: x, y1: y };
        while (stack.length) {
          const t = stack.pop()!;
          n++; sx += t.x; sy += t.y;
          box.x0 = Math.min(box.x0, t.x); box.y0 = Math.min(box.y0, t.y); box.x1 = Math.max(box.x1, t.x); box.y1 = Math.max(box.y1, t.y);
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const u = { x: t.x + dx, y: t.y + dy }, uk = u.y * 1000 + u.x;
            if (!seen.has(uk) && cats.includes(this.at(u))) { seen.add(uk); stack.push(u); }
          }
        }
        if (n >= minTiles) found.push({ tiles: n, centre: { x: Math.round(sx / n), y: Math.round(sy / n) }, box });
      }
    return found.sort((a, b) => b.tiles - a.tiles);
  }
  /** Trees are single tiles: group them by 10×10 blocks and merge touching blocks. */
  groves(minTrees = 6) {
    const counts = new Map<string, number>();
    const { x0, y0, x1, y1 } = this.summary.bounds;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (this.at({ x, y }) === "T") {
        const key = `${Math.floor(x / 10)},${Math.floor(y / 10)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    const blocks = [...counts].filter(([, n]) => n >= minTrees).map(([k, n]) => ({ bx: +k.split(",")[0], by: +k.split(",")[1], n }));
    const groups: typeof blocks[] = [];
    for (const b of blocks) {
      const touching = groups.filter((g) => g.some((o) => Math.abs(o.bx - b.bx) <= 1 && Math.abs(o.by - b.by) <= 1));
      const merged = [b, ...touching.flat()];
      for (const g of touching) groups.splice(groups.indexOf(g), 1);
      groups.push(merged);
    }
    return groups
      .map((g) => {
        const n = g.reduce((s, b) => s + b.n, 0);
        const cx = g.reduce((s, b) => s + (b.bx * 10 + 5) * b.n, 0) / n, cy = g.reduce((s, b) => s + (b.by * 10 + 5) * b.n, 0) / n;
        return { tiles: n, centre: { x: Math.round(cx), y: Math.round(cy) } };
      })
      .sort((a, b) => b.tiles - a.tiles);
  }
  keep(): Tile | null {
    const k = this.areas("K")[0];
    return k ? k.centre : null;
  }
  /** Text overview: where the keep, deposits, farmland and groves are. */
  describe(camera?: Camera) {
    const keep = this.keep();
    const dist = (t: Tile) => (keep ? ` ${Math.round(Math.hypot(t.x - keep.x, t.y - keep.y))} tiles from the keep` : "");
    const list = (label: string, items: { tiles: number; centre: Tile; box?: { x0: number; y0: number; x1: number; y1: number } }[], limit: number, unit = "tiles") =>
      items.length
        ? `${label}:\n` + items.slice(0, limit).map((a) => `- centre (${a.centre.x}, ${a.centre.y}), ${a.tiles} ${unit}${a.box ? `, x ${a.box.x0}–${a.box.x1}, y ${a.box.y0}–${a.box.y1}` : ""},${dist(a.centre)}`).join("\n")
        : `${label}: none on this map`;
    return [
      keep ? `Keep: (${keep.x}, ${keep.y}).` : "Keep: not found.",
      camera ? `Current view centre: (${camera.centre_tile_x}, ${camera.centre_tile_y}).` : "",
      list("Stone deposits (quarry needs 8 stone tiles in its 6×6)", this.areas("S", 8), 4),
      list("Iron ore (iron mine needs 4 ore tiles in its 4×4)", this.areas("I", 4), 4),
      list("Oil (pitch rig)", this.areas("P", 1), 3),
      list("Farmland (oasis grass with its scrub edge)", this.areas("Os", 60), 5),
      list("Tree groves (woodcutters)", this.groves(), 5, "trees"),
    ].filter(Boolean).join("\n");
  }
  /**
   * PNG in screen orientation: horizontal = x - y, vertical = x + y, at the game's 2:1
   * tile aspect. Grid lines every 20 tiles (x lines run down-left, y lines down-right),
   * labelled "x,y" at every 40-tile crossing; the keep ringed, the current view boxed.
   */
  /** The playable tiles' extent in screen axes: u = x - y across, v = x + y down. */
  extent() {
    const { x0, y0, x1, y1 } = this.summary.bounds;
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (this.at({ x, y }) !== "_") {
        umin = Math.min(umin, x - y); umax = Math.max(umax, x - y); vmin = Math.min(vmin, x + y); vmax = Math.max(vmax, x + y);
      }
    return { umin, umax, vmin, vmax };
  }
  png(camera?: Camera, su = 4) {
    const { x0, y0, x1, y1 } = this.summary.bounds;
    const sv = su / 2, pad = 6;
    const { umin, umax, vmin, vmax } = this.extent();
    const w = Math.ceil((umax - umin + 1) * su) + 2 * pad, h = Math.ceil((vmax - vmin + 1) * sv) + 2 * pad;
    const img = Buffer.alloc(w * h * 3);
    const set = (px: number, py: number, c: readonly number[]) => {
      px = Math.round(px); py = Math.round(py);
      if (px < 0 || py < 0 || px >= w || py >= h) return;
      img.set(c, (py * w + px) * 3);
    };
    const toPx = (x: number, y: number) => ({ px: pad + (x - y - umin + 0.5) * su, py: pad + (x + y - vmin + 0.5) * sv });
    for (let py = 0; py < h; py++)
      for (let px = 0; px < w; px++) {
        const u = umin + (px - pad) / su - 0.5, v = vmin + (py - pad) / sv - 0.5;
        const x = Math.round((u + v) / 2), y = Math.round((v - u) / 2);
        set(px, py, categories[this.at({ x, y })]?.colour ?? [255, 255, 255]);
      }
    const inMap = (x: number, y: number) => this.at({ x: Math.round(x), y: Math.round(y) }) !== "_";
    const blend = (px: number, py: number, c: readonly number[], a: number) => {
      px = Math.round(px); py = Math.round(py);
      if (px < 0 || py < 0 || px >= w || py >= h) return;
      const i = (py * w + px) * 3;
      for (let k = 0; k < 3; k++) img[i + k] = Math.round(img[i + k] * (1 - a) + c[k] * a);
    };
    // Grid lines every 20 tiles.
    for (let g = Math.ceil(x0 / 20) * 20; g <= x1; g += 20)
      for (let t = y0; t <= y1; t += 0.25) if (inMap(g, t)) { const p = toPx(g, t); blend(p.px, p.py, [0, 0, 0], 0.45); }
    for (let g = Math.ceil(y0 / 20) * 20; g <= y1; g += 20)
      for (let t = x0; t <= x1; t += 0.25) if (inMap(t, g)) { const p = toPx(t, g); blend(p.px, p.py, [0, 0, 0], 0.45); }
    // Current view: the screen rectangle is axis-aligned in this orientation.
    if (camera) {
      const c = toPx(camera.centre_tile_x, camera.centre_tile_y);
      const hw = (camera.tiles_wide / 2) * su, hh = (camera.tiles_high / 2) * sv;
      for (let px = c.px - hw; px <= c.px + hw; px++) for (const py of [c.py - hh, c.py - hh + 1, c.py + hh, c.py + hh - 1]) set(px, py, [255, 255, 255]);
      for (let py = c.py - hh; py <= c.py + hh; py++) for (const px of [c.px - hw, c.px - hw + 1, c.px + hw, c.px + hw - 1]) set(px, py, [255, 255, 255]);
    }
    const keep = this.keep();
    if (keep) {
      const c = toPx(keep.x, keep.y);
      for (let a = 0; a < 360; a += 2) for (const r of [14, 15]) set(c.px + r * Math.cos((a * Math.PI) / 180), c.py + (r / 2) * Math.sin((a * Math.PI) / 180), [255, 255, 255]);
      text(img, w, h, c.px - 11, c.py - 22, "KEEP", 2);
    }
    for (let gx = Math.ceil(x0 / 40) * 40; gx <= x1; gx += 40)
      for (let gy = Math.ceil(y0 / 40) * 40; gy <= y1; gy += 40) {
        if (!inMap(gx, gy)) continue;
        const p = toPx(gx, gy), label = `${gx},${gy}`;
        text(img, w, h, p.px - label.length * 4 + 1, p.py + 3, label, 2);
      }
    return encodePng(img, w, h);
  }
}

/** A 3×5 bitmap font for grid labels. */
const glyphs: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
  "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001001001001",
  "8": "111101111101111", "9": "111101111001111", ",": "000000000010100",
  K: "101101110101101", E: "111100111100111", P: "111101111100100",
};
function text(img: Buffer, w: number, h: number, x: number, y: number, s: string, scale: number) {
  const put = (px: number, py: number, c: number[]) => {
    px = Math.round(px); py = Math.round(py);
    if (px >= 0 && py >= 0 && px < w && py < h) img.set(c, (py * w + px) * 3);
  };
  [...s].forEach((ch, i) => {
    const g = glyphs[ch];
    if (!g) return;
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++) {
        if (g[r * 3 + c] !== "1") continue;
        for (let dy = -1; dy <= scale; dy++) for (let dx = -1; dx <= scale; dx++) put(x + i * 4 * scale + c * scale + dx, y + r * scale + dy, [0, 0, 0]);
      }
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++) {
        if (g[r * 3 + c] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x + i * 4 * scale + c * scale + dx, y + r * scale + dy, [255, 255, 255]);
      }
  });
}

function encodePng(rgb: Buffer, w: number, h: number) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
