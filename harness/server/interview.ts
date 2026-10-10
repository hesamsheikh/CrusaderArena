/**
 * The interview after an episode. Once npm run episodes has scored a counted episode and saved
 * the game, the host shows the agent its result beside the reference game a person played on the
 * same map (baselines.ts) and asks the questions in prompt/interview.md, one message at a time, in
 * the conversation the agent played in. Nothing in it reaches the score or a later episode. The
 * transcript is kept in the run's folder as interview.md and interview.json and published with
 * the run.
 */
import { existsSync, readFileSync } from "node:fs";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { referenceGame, type ReferenceGame } from "./baselines.js";
import { minutesSeconds } from "./session.js";
import { promptText } from "./preparation.js";
import type { RunSeries } from "../shared/protocol.js";

const template = readFileSync(new URL("../../prompt/interview.md", import.meta.url), "utf8");

/** What the host answers a tool call during the interview. */
export const TOOLS_OFF = "The run is over and the tools no longer work. Please answer in plain text.";
/** Replies that may call tools; each call is refused and the combined question asked on. */
const REFUSED_REPLIES = 2;

export type InterviewQuestion = { title: string; text: string };

/**
 * The questions combined into one message, each under its own "## " heading, asking for a reply
 * headed the same way so splitReply can tell the answers apart. Asking once instead of one
 * question at a time (as this replaced) cut a four-question interview from four sequential
 * requests to one (measured: ~100 s and three extra cache reads, to ~25 s and one).
 */
export function combinedQuestion(questions: InterviewQuestion[]): string {
  const body = questions.map(({ title, text }) => `## ${title}\n\n${text}`).join("\n\n");
  return `${body}\n\nAnswer all ${questions.length} questions above in this one reply. Repeat each heading exactly as written above (for example "## ${questions[0].title}") right before its answer, so the answers can be told apart.`;
}

/**
 * Splits a combined reply back into one answer per question, by the "## " headings it was asked
 * to repeat, in order. Undefined when the reply does not have exactly those headings in that
 * order (a model that did not follow the format, or answered only some of them), so the caller
 * can keep the reply whole instead of guessing at a split.
 */
export function splitReply(text: string, questions: InterviewQuestion[]): string[] | undefined {
  const parts = text.split(/^#{1,6} +/m).slice(1);
  if (parts.length !== questions.length) return undefined;
  const titled = parts.map((part) => {
    const [heading, ...body] = part.split("\n");
    return { title: heading.replace(/[*:]+$/, "").trim().toLowerCase(), answer: body.join("\n").trim() };
  });
  return titled.every(({ title }, i) => title === questions[i].title.toLowerCase()) ? titled.map(({ answer }) => answer) : undefined;
}

/** The interview's messages: each "## " section of prompt/interview.md, comments removed. */
export function interviewSections(markdown = template): InterviewQuestion[] {
  return promptText(markdown)
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [title, ...body] = section.split("\n");
      return { title: title.trim(), text: body.join("\n").trim() };
    });
}

/** How the person played the reference game on this map (prompt/reference-games/<map>.md). */
export function referencePlay(map: string) {
  const slug = map.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const file = new URL(`../../prompt/reference-games/${slug}.md`, import.meta.url);
  return slug && existsSync(file) ? promptText(readFileSync(file, "utf8")) : null;
}

/** An episode's scorecard (episode.json), as far as the interview uses it. */
export type InterviewCard = {
  map?: string | null;
  valid?: boolean;
  invalid?: string[];
  net_worth?: number | null;
  net_worth_baseline?: number;
  gold?: number | null;
  goods_value?: number | null;
  population?: number | null;
  housing?: number | null;
  popularity?: number | null;
  run?: { budget?: { gameSeconds?: number; usedGameSeconds?: number } | null } | null;
};

const amount = (value: number | null | undefined) =>
  typeof value === "number" ? Math.round(value).toLocaleString("en-US") : "unknown";

/**
 * The agent's result beside the person's, in the units the agent played with. `ended` says why a
 * run that is not a full-budget score ended (the model ended it: series.ts).
 */
export function resultText(card: InterviewCard, reference: ReferenceGame, ended?: string) {
  const budget = card.run?.budget;
  const played = budget?.usedGameSeconds;
  // The person's own timing came within a few game seconds of the agents' 2,000.
  const alike = typeof budget?.gameSeconds === "number" && Math.abs(budget.gameSeconds - reference.gameSeconds) <= reference.gameSeconds * 0.02;
  const row = (label: string, yours: string, theirs: string) => `| ${label} | ${yours} | ${theirs} |`;
  const lines = [
    alike
      ? "Your result, read from the game when your run ended, beside a person's game on the same map for the same game time:"
      : `Your result, read from the game when your run ended, beside a person's game on the same map. They played ${minutesSeconds(reference.gameSeconds)} of game time${typeof budget?.gameSeconds === "number" ? ` and your budget was ${minutesSeconds(budget.gameSeconds)}` : ""}, so the two are not like for like:`,
    "",
    "| | You | The person |",
    "| --- | ---: | ---: |",
    row("Game time played", typeof played === "number" ? minutesSeconds(played) : "unknown", minutesSeconds(reference.gameSeconds)),
    row("Net worth", amount(card.net_worth), amount(reference.netWorth)),
    row("Gold", amount(card.gold), amount(reference.gold)),
    row("Stored goods, at the sell price", amount(card.goods_value), amount(reference.goodsValue)),
    row("Population", amount(card.population), amount(reference.population)),
    row("Housing", amount(card.housing), amount(reference.housing)),
    row("Popularity", amount(card.popularity), amount(reference.popularity)),
  ];
  if (card.valid === false) {
    const why = (ended || (card.invalid ?? []).join("; ")).replace(/[.\s]+$/, "");
    lines.push("", `Your run ended before its game time was used up${why ? ` (${why})` : ""}, so this is not a full-budget result.`);
  }
  if (typeof card.net_worth_baseline === "number")
    lines.push("", `Leaving the game alone for the same time ends with a net worth of ${amount(card.net_worth_baseline)}.`);
  return lines.join("\n");
}

/**
 * The interview for an episode: the sections of prompt/interview.md with the agent's result and
 * the reference game filled in, or why there is none (no person has played the map yet).
 */
export function interviewQuestions(card: InterviewCard, ended?: string, markdown?: string): { questions: InterviewQuestion[] } | { skipped: string } {
  const map = card.map ?? "";
  const reference = referenceGame(map);
  const play = reference && referencePlay(map);
  if (!reference || !play)
    return { skipped: map ? `no reference game for ${map}` : "the scorecard names no map" };
  const fill = (text: string) =>
    text.replaceAll("{result}", () => resultText(card, reference, ended)).replaceAll("{reference_play}", () => play);
  return { questions: interviewSections(markdown).map(({ title, text }) => ({ title, text: fill(text) })) };
}

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
function addTokens(total: Tokens, usage: Partial<Tokens> | undefined) {
  for (const key of Object.keys(total) as (keyof Tokens)[]) total[key] += usage?.[key] ?? 0;
  return total;
}

/** One question and the agent's answer. */
export type Exchange = {
  title: string;
  question: string;
  /** The text of the agent's replies to the question, in order. */
  answer: string;
  /** The agent's reasoning, where the provider returns it as text. */
  thinking?: string;
  /** Tools the agent called instead of answering; each call was refused (TOOLS_OFF). */
  refusedTools?: string[];
  stopReason: string;
  tokens: Tokens;
  seconds: number;
  /**
   * True when the reply to the combined question (below) could not be split by title, so it is
   * kept here as one exchange instead of the four asked: title is "All questions" and `question`
   * is the combined message, not any one question's own text.
   */
  unsplit?: true;
};

/**
 * Asks the questions in one combined message after the run's own messages (combinedQuestion), and
 * splits the reply back into one exchange per question (splitReply). A reply that calls tools
 * gets each call refused and the combined question asked on, up to REFUSED_REPLIES times. `ask`
 * makes one request and throws when it fails, before any exchange has gone to `answered`.
 */
export async function conductInterview(
  context: Message[],
  questions: InterviewQuestion[],
  ask: (messages: Message[]) => Promise<AssistantMessage>,
  answered: (exchange: Exchange) => void = () => {},
) {
  const messages = [...context];
  const started = Date.now();
  const combined = combinedQuestion(questions);
  messages.push({ role: "user", content: combined, timestamp: started });
  const replies: AssistantMessage[] = [];
  const refused: string[] = [];
  for (;;) {
    const reply = await ask(messages);
    messages.push(reply);
    replies.push(reply);
    const calls = reply.content.filter((part) => part.type === "toolCall");
    for (const call of calls) {
      refused.push(call.name);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: TOOLS_OFF }],
        isError: true,
        timestamp: Date.now(),
      });
    }
    if (!calls.length || replies.length > REFUSED_REPLIES) break;
  }
  const parts = replies.flatMap((reply) => reply.content);
  const thinking = parts.flatMap((part) => (part.type === "thinking" && !part.redacted && part.thinking.trim() ? [part.thinking.trim()] : []));
  const text = parts.flatMap((part) => (part.type === "text" && part.text.trim() ? [part.text.trim()] : [])).join("\n\n");
  const stopReason = replies.at(-1)!.stopReason;
  const tokens = replies.reduce((total, reply) => addTokens(total, reply.usage), noTokens());
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const split = splitReply(text, questions);
  // The full cost (tokens, thinking, refused calls) of the one request goes on its first exchange
  // only, so interviewTokens (a sum over exchanges) still totals what was actually spent.
  const exchanges: Exchange[] = split
    ? questions.map(({ title, text: question }, i) => ({
        title,
        question,
        answer: split[i],
        ...(i === 0 && thinking.length ? { thinking: thinking.join("\n\n") } : {}),
        ...(i === 0 && refused.length ? { refusedTools: refused } : {}),
        stopReason,
        tokens: i === 0 ? tokens : noTokens(),
        seconds: i === 0 ? seconds : 0,
      }))
    : [{
        title: "All questions",
        question: combined,
        answer: text,
        unsplit: true,
        ...(thinking.length ? { thinking: thinking.join("\n\n") } : {}),
        ...(refused.length ? { refusedTools: refused } : {}),
        stopReason,
        tokens,
        seconds,
      }];
  for (const exchange of exchanges) answered(exchange);
  return exchanges;
}

/** interview.json: the interview of one run, written after every answer. */
export type InterviewRecord = {
  format: 1;
  run: { id: string; folder: string; series?: RunSeries };
  model: { name: string; modelId: string };
  benchmark: { name: string | null; version: string | null };
  map: string | null;
  status: "running" | "completed" | "failed" | "stopped";
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** The conversation the questions followed: its messages and how often it was compacted. */
  context: { messages: number; compactions: number };
  exchanges: Exchange[];
  tokens: Tokens;
  /** US dollars, apart from the run's cost; null when no request reported one. */
  cost: number | null;
  costSource: "billed" | "prices" | null;
};

export function interviewTokens(exchanges: Exchange[]) {
  return exchanges.reduce((total, exchange) => addTokens(total, exchange.tokens), noTokens());
}

/**
 * Lowers the answer's own headings below the question headings (## n.), outside code blocks, so
 * an answer cannot break up the transcript.
 */
function nested(text: string) {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return fenced ? line : line.replace(/^(#{1,4})(?= )/, (hashes) => "#".repeat(hashes.length + 2));
    })
    .join("\n");
}

const dollars = (value: number) => `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;

/** interview.md: the transcript as published with the run. */
export function interviewMarkdown(record: InterviewRecord) {
  const name = record.model.name;
  const tokens = record.tokens;
  const series = record.run.series;
  const lines = [
    `# Interview: ${name} on ${record.map ?? "an unknown map"}`,
    "",
    `After its game, the agent was shown its result beside a person's game on the same map and asked the questions below in one message, in the conversation it had played in${record.context.compactions ? ` (compacted ${record.context.compactions} time${record.context.compactions === 1 ? "" : "s"} during the game)` : ""}. The tools were off, and nothing it said changed its score.`,
    "",
    `- Model: ${name} (\`${record.model.modelId}\`)`,
    `- Benchmark: ${record.benchmark.name ?? "Custom"}, version ${record.benchmark.version ?? "none"}`,
    series ? `- Series ${series.id}, episode ${series.episode} of ${series.episodes}` : `- Run ${record.run.id}`,
    `- Date: ${new Date(record.startedAt).toISOString().slice(0, 10)}`,
    `- Interview: ${record.exchanges.length} answer${record.exchanges.length === 1 ? "" : "s"}, ${tokens.totalTokens.toLocaleString("en-US")} tokens (${tokens.cacheRead.toLocaleString("en-US")} read from the cache)${record.cost !== null ? `, ${record.costSource === "prices" ? "about " : ""}${dollars(record.cost)}` : ""}`,
    "",
  ];
  record.exchanges.forEach((exchange, i) => {
    lines.push(`## ${i + 1}. ${exchange.title}`, "", "**Interviewer:**", "", exchange.question, "", `**${name}:**`, "", exchange.answer ? nested(exchange.answer) : "*(no answer)*", "");
    if (exchange.unsplit)
      lines.push("*The reply did not come back under the separate question headings asked for, so it is kept here as one.*", "");
    if (exchange.refusedTools?.length)
      lines.push(`*It also called ${[...new Set(exchange.refusedTools)].map((tool) => `\`${tool}\``).join(", ")}; the host refused, as the tools were off.*`, "");
    if (exchange.stopReason === "length") lines.push("*The answer was cut off at the output limit.*", "");
  });
  if (record.status !== "completed" && record.status !== "running")
    lines.push(`*The interview ${record.status === "stopped" ? "was stopped" : "ended early"}${record.error ? `: ${record.error}` : ""}.*`, "");
  return lines.join("\n");
}
