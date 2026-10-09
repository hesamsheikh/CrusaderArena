import test from "node:test";
import assert from "node:assert/strict";
import { saveGame, type SaveIo } from "./game-save.js";

const keysFor = (text: string) => [...text].map((c) => (c === " " ? "Space" : c.toUpperCase()));

/** A save folder and a game whose Save button writes the typed name (or the default one). */
function machine(options: { typing?: boolean; existing?: string[]; backupMatches?: boolean } = {}) {
  const files = new Map<string, string>([["Oasis by the Sea-1", "original"], ...(options.existing ?? []).map((n) => [n, "old"] as [string, string])]);
  const backup = { sha256: "sha:original" };
  let field = "Oasis by the Sea-1";
  const calls: string[] = [];
  const written: Record<string, Buffer> = {};
  const io: SaveIo = {
    key: async (key) => {
      calls.push(key);
      if (options.typing === false) return;
      if (key === "Backspace") field = field.slice(0, -1);
      else if (key === "Space") field += " ";
      else if (key.length === 1) field += key.toLowerCase();
    },
    click: async (x, y) => {
      calls.push(`click ${x},${y}`);
      if (x === 474 && y === 742) files.set(field, `game at ${field}`);
    },
    settle: async () => {},
    sleep: async () => {},
    session: async (command, names) => {
      calls.push(`${command} ${names.join("|")}`);
      const info = (n: string) => (files.has(n) ? { exists: true, bytes: files.get(n)!.length, sha256: `sha:${files.get(n)}` } : { exists: false });
      if (command === "backup-save") return { backup, matches: options.backupMatches ?? true };
      if (command === "saves") return { saves: Object.fromEntries(names.map((n) => [n, info(n)])) };
      if (command === "restore-save") { files.set(names[0], "original"); return { restored: info(names[0]) }; }
      return { ...info(names[0]), data: Buffer.from(files.get(names[0])!).toString("base64") };
    },
    write: (file, data) => { written[file] = data; },
  };
  return { io, files, calls, written };
}

test("the finished game is saved under its own name and copied into the run folder", async () => {
  const m = machine();
  const result = await saveGame(m.io, "arena glm 5-3 flash v1-1-1 3aae6fc4 e3", "Oasis by the Sea-1", keysFor);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.file, "arena glm 5-3 flash v1-1-1 3aae6fc4 e3.sav");
  assert.equal(m.written[result.file!].toString(), "game at arena glm 5-3 flash v1-1-1 3aae6fc4 e3");
  assert.equal(m.files.get("Oasis by the Sea-1"), "original");
  assert.ok(m.calls.indexOf("backup-save Oasis by the Sea-1") < m.calls.indexOf("Escape"), "the copy is kept before the menu opens");
});

test("a save that overwrote the benchmark save is put back and stops the series", async () => {
  const m = machine({ typing: false });
  const result = await saveGame(m.io, "arena test e1", "Oasis by the Sea-1", keysFor);
  assert.equal(result.benchmarkSaveChanged, true);
  assert.match(result.error!, /put back/);
  assert.equal(m.files.get("Oasis by the Sea-1"), "original");
  assert.ok(m.calls.includes("restore-save Oasis by the Sea-1"));
  assert.deepEqual(m.written, {});
});

test("nothing is saved when the benchmark save no longer matches its copy, or the name is taken", async () => {
  const changed = machine({ backupMatches: false });
  const r1 = await saveGame(changed.io, "arena test e1", "Oasis by the Sea-1", keysFor);
  assert.equal(r1.benchmarkSaveChanged, true);
  assert.ok(!changed.calls.includes("Escape"), "the menu is never opened");
  const taken = machine({ existing: ["arena test e1"] });
  const r2 = await saveGame(taken.io, "arena test e1", "Oasis by the Sea-1", keysFor);
  assert.equal(r2.error, "a save with this name exists");
  assert.ok(!taken.calls.includes("Escape"));
});
