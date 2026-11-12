import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { connectionFailure, connectionRetryFetch } from "./connection-retry.js";
import { ROUND_PRELOAD } from "./version-checkout.js";

const URL_ = "https://openrouter.ai/api/v1/chat/completions";
const failed = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });

test("a request whose connection fails is sent again, with the same body, until it gets a response", async () => {
  const bodies: unknown[] = [];
  let calls = 0;
  const retries: string[] = [];
  const send = connectionRetryFetch(async (_input, init) => {
    bodies.push(init?.body);
    if (++calls < 3) throw failed();
    return new Response("ok", { status: 200 });
  }, [0, 0, 0], (attempt, reason) => retries.push(`${attempt} ${reason}`));
  const response = await send(URL_, { method: "POST", body: '{"model":"m"}' });
  assert.equal(await response.text(), "ok");
  assert.deepEqual(bodies, ['{"model":"m"}', '{"model":"m"}', '{"model":"m"}']);
  assert.deepEqual(retries, ["1 fetch failed (UND_ERR_SOCKET: other side closed)", "2 fetch failed (UND_ERR_SOCKET: other side closed)"]);
});

test("the last failure is thrown after the retries, and a response with an error status is not retried", async () => {
  let calls = 0;
  const failing = connectionRetryFetch(async () => { calls++; throw failed(); }, [0, 0], () => {});
  await assert.rejects(failing(URL_, { method: "POST", body: "{}" }), /fetch failed/);
  assert.equal(calls, 3);
  calls = 0;
  const refused = connectionRetryFetch(async () => { calls++; return new Response("busy", { status: 503 }); }, [0, 0], () => {});
  assert.equal((await refused(URL_, { method: "POST", body: "{}" })).status, 503);
  assert.equal(calls, 1);
});

test("an aborted request and a body that cannot be sent twice are not retried", async () => {
  let calls = 0;
  const controller = new AbortController();
  const aborting = connectionRetryFetch(async () => { calls++; controller.abort(); throw failed(); }, [0, 0], () => {});
  await assert.rejects(aborting(URL_, { method: "POST", body: "{}", signal: controller.signal }));
  assert.equal(calls, 1);
  calls = 0;
  const streamed = connectionRetryFetch(async () => { calls++; throw failed(); }, [0, 0], () => {});
  await assert.rejects(streamed(URL_, { method: "POST", body: new ReadableStream(), duplex: "half" } as RequestInit));
  assert.equal(calls, 1);
  assert.equal(connectionFailure(new Error("plain")), "plain");
});

test("the preload gives an earlier round's host the retry through its global fetch", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "round-preload-"));
  writeFileSync(path.join(dir, "network.mjs"),
    `let calls = 0; globalThis.fetch = async () => { if (++calls === 1) throw new TypeError("fetch failed"); return new Response("served after " + calls); };`);
  writeFileSync(path.join(dir, "host.mjs"),
    `console.log(await (await fetch(${JSON.stringify(URL_)}, { method: "POST", body: JSON.stringify({ model: "google/gemini-4-hydrogen" }) })).text());`);
  const run = spawnSync(process.execPath, ["--import", "tsx", "--import", path.join(dir, "network.mjs"), "--import", ROUND_PRELOAD, path.join(dir, "host.mjs")], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "served after 2");
  assert.match(run.stderr, /Request connection failed \(fetch failed\); retry 1 of 5\./);
});
