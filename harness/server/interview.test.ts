import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { referenceGames } from "./baselines.js";
import {
  TOOLS_OFF,
  conductInterview,
  interviewMarkdown,
  interviewQuestions,
  interviewSections,
  interviewTokens,
  referencePlay,
  type InterviewCard,
  type InterviewRecord,
} from "./interview.js";

const usage = { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, totalTokens: 1020, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "test",
  model: "test",
  usage,
  stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
  timestamp: Date.now(),
});
const text = (value: string) => ({ type: "text" as const, text: value });
const toolCall = (name: string) => ({ type: "toolCall" as const, id: crypto.randomUUID(), name, arguments: {} });

/** An episode on Oasis by the Sea that used its whole budget (episode.json). */
const card = (changes: Partial<InterviewCard> = {}): InterviewCard => ({
  map: "Oasis by the Sea",
  valid: true,
  net_worth: 4321,
  net_worth_baseline: 1220,
  gold: 3900,
  goods_value: 421,
  population: 64,
  housing: 72,
  popularity: 58,
  run: { budget: { gameSeconds: 2000, usedGameSeconds: 2000.4 } },
  ...changes,
});

test("the interview template is four messages with known placeholders", () => {
  const sections = interviewSections();
  assert.deepEqual(sections.map((s) => s.title), ["Your result", "Playing again", "The benchmark", "Anything else"]);
  const placeholders = sections.flatMap((s) => s.text.match(/\{[a-z_]+\}/g) ?? []);
  assert.deepEqual(placeholders.sort(), ["{reference_play}", "{result}"]);
  for (const section of sections) assert.doesNotMatch(section.text, /<!--|^## /m);
});

test("each map with a reference game has its own file of how the person played it, and no file lacks a game", () => {
  const files = readdirSync(new URL("../../prompt/reference-games/", import.meta.url)).filter((f) => f.endsWith(".md"));
  const slug = (map: string) => map.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  assert.deepEqual(files.sort(), Object.keys(referenceGames).map((map) => `${slug(map)}.md`).sort());
  for (const map of Object.keys(referenceGames)) {
    const play = referencePlay(map);
    assert.ok(play && play.length > 200, map);
    assert.doesNotMatch(play, /<!--|harness\//, "maintainer notes are not shown to the agent");
  }
});

test("the first message shows the agent's result beside the person's, the second how the person played", () => {
  const plan = interviewQuestions(card());
  assert.ok("questions" in plan);
  const [result, again] = plan.questions;
  assert.match(result.text, /for the same game time:/);
  assert.match(result.text, /\| Net worth \| 4,321 \| 19,513 \|/);
  assert.match(result.text, /\| Population \| 64 \| 202 \|/);
  assert.match(result.text, /\| Popularity \| 58 \| 100 \|/);
  assert.match(result.text, /\| Game time played \| 33 min 20 s \| 33 min 18 s \|/);
  assert.match(result.text, /Leaving the game alone for the same time ends with a net worth of 1,220\./);
  assert.doesNotMatch(result.text, /not a full-budget result|\{/);
  assert.match(again.text, /57 bakeries/);
  assert.doesNotMatch(again.text, /\{reference_play\}/);
  // The person's strategy waits for the second question.
  assert.doesNotMatch(result.text, /bakeries/);
});

test("a run on another budget or ended by the model says so; a map without a reference game is not interviewed", () => {
  const short = interviewQuestions(card({ run: { budget: { gameSeconds: 120, usedGameSeconds: 120 } }, net_worth_baseline: undefined }));
  assert.ok("questions" in short);
  assert.match(short.questions[0].text, /They played 33 min 18 s of game time and your budget was 2 min, so the two are not like for like/);
  assert.doesNotMatch(short.questions[0].text, /Leaving the game alone/);
  const failed = interviewQuestions(card({ valid: false, invalid: ["run error (error)"] }), "No tool calls in 4 replies in a row.");
  assert.ok("questions" in failed);
  assert.match(failed.questions[0].text, /ended before its game time was used up \(No tool calls in 4 replies in a row\), so this is not a full-budget result/);
  assert.deepEqual(interviewQuestions(card({ map: "Cactus Valley" })), { skipped: "no reference game for Cactus Valley" });
  assert.deepEqual(interviewQuestions(card({ map: "constructor" })), { skipped: "no reference game for constructor" });
});

test("questions go one at a time after the game, each with the answers before it; tool calls are refused", async () => {
  const context: Message[] = [{ role: "user", content: "Fresh screenshot.", timestamp: 1 }];
  const sent: Message[][] = [];
  const replies = [
    reply([text("I built too few houses."), toolCall("observe")]),
    reply([text("That was all.")]),
    reply([text("I would build bakeries early.")]),
  ];
  const answered: string[] = [];
  const exchanges = await conductInterview(
    context,
    [{ title: "One", text: "Q1" }, { title: "Two", text: "Q2" }],
    async (messages) => {
      sent.push(structuredClone(messages));
      return replies.shift()!;
    },
    (exchange) => answered.push(exchange.title),
  );
  assert.deepEqual(answered, ["One", "Two"]);
  assert.equal(exchanges[0].answer, "I built too few houses.\n\nThat was all.");
  assert.deepEqual(exchanges[0].refusedTools, ["observe"]);
  assert.equal(exchanges[0].tokens.totalTokens, 2040);
  assert.equal(exchanges[1].answer, "I would build bakeries early.");
  assert.equal(exchanges[1].refusedTools, undefined);
  // The first request is the game's conversation and the question; the refusal answers the call.
  assert.deepEqual(sent[0].map((m) => m.role), ["user", "user"]);
  const refusal = sent[1].at(-1)!;
  assert.equal(refusal.role, "toolResult");
  assert.deepEqual(refusal.role === "toolResult" && refusal.content, [{ type: "text", text: TOOLS_OFF }]);
  // The second question follows the whole first exchange.
  assert.deepEqual(sent[2].map((m) => m.role), ["user", "user", "assistant", "toolResult", "assistant", "user"]);
  assert.equal(context.length, 1, "the run's messages are not changed");
});

test("a model that keeps calling tools is asked twice more, then the interview moves on", async () => {
  let requests = 0;
  const exchanges = await conductInterview([], [{ title: "One", text: "Q1" }, { title: "Two", text: "Q2" }], async (messages) => {
    requests++;
    return messages.at(-1)?.role === "user" && messages.at(-1)!.content === "Q2" ? reply([text("Fine.")]) : reply([toolCall("status")]);
  });
  assert.equal(requests, 4);
  assert.deepEqual(exchanges[0].refusedTools, ["status", "status", "status"]);
  assert.equal(exchanges[0].answer, "");
  assert.equal(exchanges[1].answer, "Fine.");
});

test("a failed request ends the interview with the answers before it kept", async () => {
  const answered: string[] = [];
  await assert.rejects(
    conductInterview([], [{ title: "One", text: "Q1" }, { title: "Two", text: "Q2" }], async (messages) => {
      if (messages.length > 2) throw new Error("401 Unauthorized");
      return reply([text("An answer.")]);
    }, (exchange) => answered.push(exchange.answer)),
    /401/,
  );
  assert.deepEqual(answered, ["An answer."]);
});

test("the transcript names the model and run, keeps answers under their questions and says how it ended", () => {
  const exchanges = [
    { title: "Your result", question: "How do you see it?", answer: "## My view\nToo slow.\n```\n# not a heading\n```", stopReason: "stop", tokens: { input: 10, output: 5, cacheRead: 900, cacheWrite: 0, totalTokens: 915 }, seconds: 3 },
    { title: "Playing again", question: "What would you change?", answer: "", refusedTools: ["observe", "observe"], stopReason: "toolUse", tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, seconds: 2 },
  ];
  const record: InterviewRecord = {
    format: 1,
    run: { id: "run-1", folder: "f", series: { id: "20261010T000000-abcd1234", episode: 2, episodes: 3 } },
    model: { name: "GLM 5.3 Flash", modelId: "z-ai/glm-5.3-flash" },
    benchmark: { name: "Oasis by the Sea construction", version: "1.2.0" },
    map: "Oasis by the Sea",
    status: "failed",
    error: "502 provider unavailable",
    startedAt: Date.UTC(2026, 9, 10),
    context: { messages: 40, compactions: 2 },
    exchanges,
    tokens: interviewTokens(exchanges),
    cost: 0.0123,
    costSource: "billed",
  };
  const markdown = interviewMarkdown(record);
  assert.match(markdown, /^# Interview: GLM 5\.3 Flash on Oasis by the Sea\n/);
  assert.match(markdown, /compacted 2 times during the game/);
  assert.match(markdown, /- Series 20261010T000000-abcd1234, episode 2 of 3/);
  assert.match(markdown, /- Benchmark: Oasis by the Sea construction, version 1\.2\.0/);
  assert.match(markdown, /930 tokens \(900 read from the cache\), \$0\.012/);
  assert.match(markdown, /## 1\. Your result\n\n\*\*Interviewer:\*\*\n\nHow do you see it\?\n\n\*\*GLM 5\.3 Flash:\*\*\n\n#### My view\nToo slow\.\n```\n# not a heading\n```/);
  assert.match(markdown, /\*\(no answer\)\*\n\n\*It also called `observe`; the host refused, as the tools were off\.\*/);
  assert.match(markdown, /\*The interview ended early: 502 provider unavailable\.\*\n$/);
});
