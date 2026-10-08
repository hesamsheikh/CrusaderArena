import test from "node:test";
import assert from "node:assert/strict";
import { atlasHtml, atlasIndex, atlasPage, atlasPages, availableAtlasPages, constructionAtlas } from "./visual-atlas.js";

test("guide pages use unique safe IDs and bounded screenshot regions", () => {
  assert.equal(new Set(atlasPages.map((p) => p.id)).size, atlasPages.length);
  assert.equal(atlasPages.length, 10);
  for (const page of atlasPages) {
    assert.match(page.id, /^[a-z-]+$/);
    assert.equal(page.file, `${page.id}.png`);
    assert.ok(page.labels.length > 0);
    for (const label of page.labels) {
      const [x, y, width, height] = label.box;
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
      assert.ok(x + width <= 1920 && y + height <= 1080);
    }
  }
});

test("installed private pages yield a historical image and never claim current state", () => {
  const installed = availableAtlasPages();
  const index = atlasIndex();
  if (!installed.length) {
    assert.match(index, /No private historical building guide pages/);
    return;
  }
  const page = atlasPage(installed[0].id);
  assert.ok(page);
  assert.match(page.text, /HISTORICAL BUILDING GUIDE/);
  assert.match(page.text, /not a current observation or targeting frame/);
  assert.ok(Buffer.from(page.image, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.ok(index.includes(installed[0].id));
  const png = Buffer.from(page.image, "base64");
  assert.equal(png.readUInt32BE(16), 780);
  assert.equal(png.readUInt32BE(20), 230);
  const html = atlasHtml(installed[0].id);
  assert.ok(html?.includes("data:image/png;base64,"));
  assert.ok(html?.includes(page.page.labels[0].name));
});

test("the preparation guide lists all ten pages with or without the private image", () => {
  const guide = constructionAtlas();
  assert.match(guide.text, /HISTORICAL CONSTRUCTION MENU GUIDE/);
  assert.equal(guide.text.includes("text only"), guide.image === null);
  for (const page of atlasPages) assert.ok(guide.text.includes(page.title));
});

test("combined preparation guide contains ten cropped construction trays", () => {
  const guide = constructionAtlas();
  if (!guide.image) return;
  const png = Buffer.from(guide.image, "base64");
  assert.equal(png.readUInt32BE(16), 1912);
  assert.equal(png.readUInt32BE(20), 2838);
});
