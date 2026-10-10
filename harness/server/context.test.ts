import test from "node:test";
import assert from "node:assert/strict";
import { capImages, ContextBudget, contextEstimate, IMAGE_CAP, IMAGES_AFTER_CAP, IMAGE_LOGGED_ELSEWHERE, omitDuplicateToolImages, pruneImages } from "./context.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
const text = (value: string): AgentMessage => ({
  role: "user",
  content: value,
  timestamp: 1,
});
const tools = [
  {
    name: "observe",
    description: "Capture the game",
    parameters: { type: "object" },
  },
];
test("measured input replaces byte estimate only for unchanged request parts", () => {
  const budget = new ContextBudget();
  const messages = [text("a".repeat(18000))];
  assert.equal(
    budget.estimate(messages, "controls", tools),
    contextEstimate(messages, "controls" + JSON.stringify(tools)),
  );
  budget.record(messages, "controls", tools, 6000);
  assert.equal(budget.estimate(messages, "controls", tools), 6000);
  const next = text("fresh observation");
  assert.equal(
    budget.estimate([...messages, next], "controls", tools),
    6000 + contextEstimate([next], ""),
  );
  // Replacing content must not disappear into a net byte-length difference.
  assert.equal(
    budget.estimate([text("b".repeat(18000))], "controls", tools),
    6000 + contextEstimate([text("b".repeat(18000))], ""),
  );
  // The system prompt changes every turn (time left) and is already in the measured tokens:
  // only its growth is added.
  assert.equal(budget.estimate(messages, "changes!", tools), 6000);
  assert.equal(
    budget.estimate(messages, "controls plus more", tools),
    6000 + Math.ceil((Buffer.byteLength("controls plus more") - Buffer.byteLength("controls")) / 2.5),
  );
});
test("new images, duplicate messages and changed tools retain conservative allowances", () => {
  const budget = new ContextBudget();
  const m = text("same");
  budget.record([m], "", tools, 1000);
  assert.equal(
    budget.estimate([m, m], "", tools),
    1000 + contextEstimate([m], ""),
  );
  const image: AgentMessage = {
    role: "user",
    content: [{ type: "image", data: "abc", mimeType: "image/jpeg" }],
    timestamp: 1,
  };
  assert.equal(
    budget.estimate([m, image], "", tools, 8192),
    1000 + contextEstimate([image], "", 8192),
  );
  assert.ok(budget.estimate([m], "", [...tools, { name: "act" }]) > 1000);
  budget.record([image], "", tools, 5000);
  assert.ok(budget.estimate(pruneImages([image], 0), "", tools) >= 5000);
});
test("missing usage and compaction reset return to conservative estimates", () => {
  const budget = new ContextBudget();
  const messages = [text("evidence")];
  for (const usage of [0, NaN, -1, Infinity]) {
    budget.record(messages, "", tools, usage);
    assert.equal(
      budget.estimate(messages, "", tools),
      contextEstimate(messages, JSON.stringify(tools)),
    );
  }
  budget.record(messages, "", tools, 100);
  budget.reset();
  assert.equal(
    budget.estimate(messages, "", tools),
    contextEstimate(messages, JSON.stringify(tools)),
  );
});
test("a measured small context does not compact merely because UTF-8 bytes exceed threshold", () => {
  const budget = new ContextBudget();
  const messages = [text("Observed evidence. ".repeat(5000))];
  const threshold = 48000 * 0.65;
  assert.ok(budget.estimate(messages, "controls", tools) > threshold);
  budget.record(messages, "controls", tools, 10330);
  assert.ok(
    budget.estimate([...messages, text("New result")], "controls", tools) <
      threshold,
  );
  budget.record(messages, "controls", tools, 40000);
  assert.ok(budget.estimate(messages, "controls", tools) > threshold);
});

test("omitDuplicateToolImages replaces a toolResult message's image data without touching the original", () => {
  const original = {
    role: "toolResult" as const,
    toolCallId: "c1",
    toolName: "observe",
    content: [
      { type: "text" as const, text: "{\"ok\":true}" },
      { type: "image" as const, data: "a".repeat(2000), mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 1,
  };
  const slim = omitDuplicateToolImages(original);
  assert.notEqual(slim, original);
  assert.deepEqual(slim.content[0], original.content[0]);
  assert.deepEqual(slim.content[1], { type: "image", mimeType: "image/png", omitted: IMAGE_LOGGED_ELSEWHERE });
  // The original (the very array the live conversation and tool_execution_end both hold) is untouched.
  assert.deepEqual(original.content[1], { type: "image", data: "a".repeat(2000), mimeType: "image/png" });
});

test("omitDuplicateToolImages leaves non-toolResult messages and image-free toolResults as they are", () => {
  const user: AgentMessage = { role: "user", content: [{ type: "image", data: "x".repeat(2000), mimeType: "image/png" }], timestamp: 1 };
  assert.equal(omitDuplicateToolImages(user), user);
  const noImage = { role: "toolResult" as const, toolCallId: "c1", toolName: "observe", content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: 1 };
  assert.equal(omitDuplicateToolImages(noImage), noImage);
});

test("screenshots stay until there are more than IMAGE_CAP, then the oldest go in one batch", () => {
  const shot = (n: number): AgentMessage => ({ role: "user", content: [{ type: "text", text: `shot ${n}` }, { type: "image", data: `img${n}`, mimeType: "image/jpeg" }], timestamp: n });
  const guide = shot(0);
  const pinned = new Set([guide]);
  let messages = [guide];
  for (let n = 1; n <= IMAGE_CAP; n++) {
    const next = capImages([...messages, shot(n)], pinned);
    // Unchanged up to the cap: the same message objects, so every request repeats the last.
    assert.deepEqual(next.slice(0, messages.length), messages);
    messages = next;
  }
  const images = (list: AgentMessage[]) => JSON.stringify(list).split('"type":"image"').length - 1;
  assert.equal(images(messages), IMAGE_CAP + 1, "all screenshots and the pinned guide image");
  const over = capImages([...messages, shot(IMAGE_CAP + 1)], pinned);
  assert.equal(images(over), IMAGES_AFTER_CAP + 1, "down to the newest few, plus the guide");
  assert.equal(over[0], guide, "the pinned guide keeps its image");
});
