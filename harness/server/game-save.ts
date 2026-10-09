/** What saving a finished episode in the game did (episode.json `game_save`). */
export type GameSave = { name: string; file?: string; bytes?: number; sha256?: string; error?: string; benchmarkSaveChanged?: boolean };

/** The runner's game input and the game machine's save helper (tools/ubuntu/game-session.py). */
export type SaveIo = {
  key: (key: string) => Promise<unknown>;
  /** A click in the 1920 × 1080 menu layout, scaled to the window. */
  click: (x: number, y: number) => Promise<unknown>;
  /** Wait until the screen stops changing, up to `seconds`. */
  settle: (seconds: number) => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  session: (command: "saves" | "backup-save" | "restore-save" | "export-save", names: string[]) => Promise<any>;
  write: (file: string, data: Buffer) => void;
};

/**
 * Save the finished, paused episode in the game as `name` (Game Options → Save, layout live
 * 2026-10-09) and copy the file into the run folder, to load and watch later. The Save dialog
 * starts with the loaded save's name, so saving without replacing it would overwrite the
 * benchmark save: a copy of that save is kept on the game machine, its hash is compared after
 * saving, and a changed one is put back. Never throws; a failure is reported in the result.
 */
export async function saveGame(io: SaveIo, name: string, benchmarkSave: string, keysFor: (text: string) => string[]): Promise<GameSave> {
  try {
    const backup = await io.session("backup-save", [benchmarkSave]);
    if (!backup.matches)
      return { name, error: `"${benchmarkSave}" differs from the copy kept before the first save; not saving`, benchmarkSaveChanged: true };
    if ((await io.session("saves", [name])).saves[name]?.exists) return { name, error: "a save with this name exists" };
    const keys = keysFor(name);
    await io.key("Escape"); // Game Options
    await io.sleep(1500);
    await io.click(958, 298); // Save
    await io.settle(15);
    await io.click(600, 496); // Name field, holding the loaded save's name
    await io.sleep(400);
    for (let i = 0; i < 40; i++) await io.key("Backspace");
    for (const key of keys) await io.key(key);
    await io.sleep(400);
    await io.click(474, 742); // Save button; the dialog and the menu close
    await io.sleep(3000);
    const after = await io.session("saves", [benchmarkSave, name]);
    if (after.saves[benchmarkSave]?.sha256 !== backup.backup.sha256) {
      await io.session("restore-save", [benchmarkSave]);
      return { name, error: `saving changed "${benchmarkSave}"; it was put back from the copy`, benchmarkSaveChanged: true };
    }
    if (!after.saves[name]?.exists) return { name, error: "no save file appeared" };
    const exported = await io.session("export-save", [name]);
    const file = `${name}.sav`;
    io.write(file, Buffer.from(exported.data, "base64"));
    return { name, file, bytes: exported.bytes, sha256: exported.sha256 };
  } catch (error) {
    return { name, error: error instanceof Error ? error.message : String(error) };
  }
}
