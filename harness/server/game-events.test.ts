import { test } from "node:test";
import assert from "node:assert/strict";
import { GameEvents } from "./game-events.js";
const record = (id: string, text = "Cannot place that there") => ({
  status: "ok",
  session: "one",
  generation: 1,
  captured_unix_ms: 100,
  events: [
    { kind: "visible_message_observed", id, channel: "Feedback_1", text },
  ],
});
test("messages survive quiet polls and independent consumers acknowledge by cursor", () => {
  const buffer = new GameEvents();
  buffer.ingest(record("a"), 100);
  buffer.ingest({ ...record("a"), events: [] }, 200);
  const first = buffer.since(0, 250);
  assert.equal(
    first.events.filter((e) => e.kind === "visible_message_observed").length,
    1,
  );
  assert.deepEqual(buffer.since(first.cursor, 250).events, []);
  assert.equal(buffer.since(0, 250).events.length, first.events.length);
  buffer.ingest(record("a"), 300);
  assert.deepEqual(buffer.since(first.cursor, 300).events, []);
  buffer.ingest(record("b"), 400); // Same warning observed again is a new event.
  assert.equal(buffer.since(first.cursor, 400).events[0].id, "b");
});
test("overflow and age eviction are explicit, and storage stays bounded", () => {
  const buffer = new GameEvents(2, 1000);
  buffer.ingest(record("a"), 100);
  buffer.ingest(record("b"), 200);
  assert.equal(buffer.since(0, 200).dropped, 1); // Reader boundary was evicted.
  assert.equal(buffer.since(0, 200).events.length, 2);
  assert.equal(buffer.since(0, 1201).dropped, 3);
  assert.deepEqual(buffer.since(0, 1201).events, []);
});
test("gaps, reconnects and generations preserve event provenance", () => {
  const buffer = new GameEvents();
  buffer.ingest(record("a"), 100);
  const cursor = buffer.cursor();
  buffer.ingest({ status: "unavailable" }, 200);
  buffer.ingest({ status: "unavailable" }, 250);
  buffer.ingest({ ...record("b"), generation: 2 }, 300);
  buffer.disconnect(400);
  const events = buffer.since(cursor, 400).events;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["reader_gap", "reader_boundary", "visible_message_observed", "reader_gap"],
  );
  assert.equal(events[2].generation, 2);
  assert.equal(events[2].provenance, "game_ui_text");
});
test("reader gaps never push game messages out of a full buffer", () => {
  const buffer = new GameEvents(4, 60_000);
  buffer.ingest(record("a", "Wood needed"), 100);
  for (let i = 0; i < 10; i++) {
    buffer.ingest({ status: "unavailable" }, 200 + i * 20);
    buffer.ingest({ ...record("x"), generation: 2 + i, events: [] }, 210 + i * 20);
  }
  const view = buffer.messagesSince(0, 0, 500);
  assert.deepEqual(view.messages, [{ text: "Wood needed", seconds_ago: 0 }]);
  assert.equal(view.dropped, 0);
  // The full journal view still reports the evicted reader rows.
  assert.ok(buffer.since(0, 500).dropped > 0);
});
test("messages are listed once at their newest receipt, and long reader outages are reported", () => {
  const buffer = new GameEvents();
  buffer.ingest(record("a", "Wood needed"), 1_000);
  buffer.ingest(record("b", "Too close to signpost to build."), 2_000);
  buffer.ingest({ ...record("c", "Wood needed"), generation: 2 }, 3_000);
  buffer.ingest({ status: "unavailable" }, 4_000);
  buffer.ingest({ status: "unavailable" }, 4_100); // Brief: not reported.
  buffer.ingest({ ...record("d", "x"), generation: 3, events: [] }, 4_200);
  buffer.ingest({ status: "stream_closed" }, 5_000);
  buffer.ingest({ ...record("e", "x"), generation: 4, events: [] }, 9_000); // Down 4 s.
  const view = buffer.messagesSince(0, 0, 10_000);
  assert.deepEqual(view.messages, [
    { text: "Too close to signpost to build.", seconds_ago: 8 },
    { text: "Wood needed", seconds_ago: 7 },
  ]);
  assert.equal(view.unavailableSeconds, 4);
  // Only the part of an outage after the previous delivery counts.
  assert.equal(buffer.messagesSince(0, 7_000, 10_000).unavailableSeconds, 2);
  assert.equal(buffer.messagesSince(0, 8_500, 10_000).unavailableSeconds, 0);
});
