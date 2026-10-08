import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "./store.js";
const fixture = () =>
  new Store(mkdtempSync(path.join(tmpdir(), "arena-store-")), {
    MOONSHOT_API_KEY: "env-secret-test",
  });
test("credentials persist privately; public profiles never expose keys; editing preserves credentials", () => {
  const store = fixture();
  const model = store.saveModel({
    name: "Another model",
    modelId: "test-model",
    baseUrl: "https://example.com/v1",
    apiKey: "private-test-key",
  });
  assert.equal(model.keyConfigured, true);
  assert.ok(!JSON.stringify(store.models()).includes("private-test-key"));
  const saved = store.saveModel({
    id: model.id,
    name: "Renamed",
    modelId: model.modelId,
    baseUrl: model.baseUrl,
    apiKey: "",
  });
  assert.equal(saved.keyConfigured, true);
  const restored = new Store(store.root, {});
  assert.equal(restored.key(model.id), "private-test-key");
  assert.equal(
    statSync(path.join(store.root, "config/models.json")).mode & 0o777,
    0o600,
  );
  assert.throws(() =>
    store.saveModel({
      ...saved,
      baseUrl: "https://different.example/v1",
      keyConfigured: undefined,
    }),
  );
  assert.throws(
    () =>
      store.saveModel({
        id: model.id,
        name: "a",
        modelId: "b",
        baseUrl: "https://different.example/v1",
      }),
    /Enter an API key/,
  );
  assert.throws(() =>
    store.saveModel({
      name: "a",
      modelId: "b",
      baseUrl: "https://user:password@example.com",
    }),
  );
});
test("OpenRouter profile references its environment key without persisting the secret", () => {
  const root = mkdtempSync(path.join(tmpdir(), "arena-store-router-"));
  const env = { OPENROUTER_API_KEY: "router-secret-test" };
  const store = new Store(root, env);
  const model = store.saveModel({
    name: "Space Bunny Alpha",
    modelId: "stealth/space-bunny-alpha",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
  });
  assert.equal(store.key(model.id), env.OPENROUTER_API_KEY);
  assert.ok(!readFileSync(path.join(root, "config/models.json"), "utf8").includes(env.OPENROUTER_API_KEY));
  assert.throws(() => store.saveModel({
    name: "Wrong endpoint", modelId: "test", baseUrl: "https://example.com/v1",
    envKey: "OPENROUTER_API_KEY",
  }), /does not match/);
});
test("named runs append full logs and deltas immediately, survive restart, and remain grouped", () => {
  const store = fixture();
  const model = store.models()[0];
  const run = store.create("../../Test run", model.id, "Look", 4);
  const other = store.create("../../Test run", model.id, "Look", 4);
  assert.notEqual(run.folder, other.folder);
  assert.ok(!run.folder.includes(".."));
  assert.ok(run.folder.startsWith("Test-run-"));
  const text = "x".repeat(5000) + " env-secret-test";
  store.log(run.id, { id: "entry", at: Date.now(), kind: "agent", text });
  store.event(run.id, {
    type: "text_delta",
    delta: "A streamed response",
    apiKey: "any-secret",
  });
  assert.equal(store.logs(run.id)[0].text, "x".repeat(5000) + " [redacted]");
  const raw = readFileSync(store.file(run.id, "events.jsonl"), "utf8");
  assert.ok(raw.includes("A streamed response"));
  assert.ok(!raw.includes("any-secret"));
  store.finish(run.id, "completed");
  const restored = new Store(store.root, {});
  assert.equal(restored.get(run.id).status, "completed");
  assert.equal(restored.get(other.id).status, "interrupted");
  assert.equal(restored.list().filter((r) => r.modelId === model.id).length, 2);
  assert.equal(restored.logs(run.id)[0].text.length, 5011);
  assert.throws(() => restored.get("../../config/models.json"));
});
test("legacy sessions are imported once without losing available logs", () => {
  const store = fixture();
  const at = Date.now();
  writeFileSync(
    path.join(store.root, "old.jsonl"),
    [
      { id: "one", at, kind: "user", text: "Inspect the game" },
      { id: "two", at: at + 1, kind: "agent", text: "Paused." },
      {
        id: "three",
        at: at + 2,
        kind: "system",
        text: "Run finished. Manual control available.",
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  const imported = new Store(store.root, {});
  assert.equal(imported.list().length, 1);
  assert.equal(imported.list()[0].status, "imported");
  assert.equal(imported.logs(imported.list()[0].id).length, 3);
  assert.equal(new Store(store.root, {}).list().length, 1);
});

test("runs keep their model snapshot and cannot be reassigned by editing a profile", () => {
  const store = fixture();
  const first = store.models()[0];
  const second = store.saveModel({
    name: "Second model",
    modelId: "vision-model",
    baseUrl: "https://example.com/v1",
    apiKey: "other-key",
  });
  const runA = store.create("First", first.id, "Inspect", 2);
  const runB = store.create("Second", second.id, "Inspect", 2);
  assert.deepEqual(
    store
      .list()
      .filter((r) => r.modelId === first.id)
      .map((r) => r.id),
    [runA.id],
  );
  assert.deepEqual(
    store
      .list()
      .filter((r) => r.modelId === second.id)
      .map((r) => r.id),
    [runB.id],
  );
  assert.equal(runB.model.modelId, "vision-model");
  assert.throws(
    () =>
      store.saveModel({
        id: second.id,
        name: second.name,
        modelId: "different-model",
        baseUrl: second.baseUrl,
      }),
    /Add a new model profile/,
  );
  assert.throws(
    () =>
      store.saveModel({
        name: "Duplicate",
        modelId: second.modelId,
        baseUrl: second.baseUrl,
      }),
    /already exists/,
  );
});
