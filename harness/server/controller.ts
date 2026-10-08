import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { writeFileSync } from "node:fs";
import { layoutNote, visualGuide } from "./visual-guide.js";
import { atlasIndex, atlasPage, constructionAtlasInstalled } from "./visual-atlas.js";
import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  Frame,
  ModelProfile,
  Run,
  RuntimeProgress,
} from "../shared/protocol.js";
import { TICKS_PER_GAME_SECOND } from "../shared/protocol.js";
import { Session, ObservationCycle } from "./session.js";
import { DOCUMENT_BYTES, RunMemory } from "./run-memory.js";
import { RunRecorder, defaultRecording } from "./recorder.js";
import {
  ContextBudget,
  contextEstimate,
  handoffInstruction,
  pruneImages,
  recentExchange,
} from "./context.js";
import {
  compactHandoff,
  gameControls,
  makeAgent,
  prepareModel,
  reflectionReply,
  type AgentRuntime,
} from "./model.js";
import {
  benchmarkMarkdown,
  benchmarkSpec,
  isPreparedReply,
  preparationMessage,
  reflectionInstruction,
  runSystemPrompt,
} from "./preparation.js";
import type { GameDevice } from "./device.js";
import { ackTime, goToTile, sampleAfter, type AnchorContext } from "./anchors.js";
import { MapView } from "./map-view.js";
import { cameraKey } from "./construction-ui.js";
import type { Ack } from "./placement.js";
import type { Store } from "./store.js";
import { codeVersion, sha256 } from "./version.js";

/** Most `Z` presses the final overview tries; it stops once the camera stops zooming out. */
const MAX_ZOOM_OUT_STEPS = 8;
/** Time for the game to draw the zoomed-out view before the overview capture. */
const OVERVIEW_SETTLE_MS = 700;

/** Provider failures worth one more request: no content, overload, rate limit or server error. */
export function isTransientProviderError(message?: string) {
  return /empty response|overloaded|rate limit|timeout|timed out|\b5\d\d\b|temporarily|unavailable|ECONNRESET|socket hang up/i.test(message ?? "");
}

export class RunController {
  readonly session: Session;
  readonly memory: RunMemory;
  readonly cycle = new ObservationCycle();
  readonly agent: Agent;
  readonly runtime: AgentRuntime;
  /** Game-window video recording (run config `recordVideo`); captures only while the agent acts. */
  readonly recorder?: RunRecorder;
  private operatorStopped = false;
  private requestStartedAt?: number;
  private firstDeltaMs?: number;
  private contextBudget = new ContextBudget();
  private initialGuideSent = false;
  private prepared = false;
  /**
   * The preparation message (guide images and text) and the agent's reply. They open every
   * request unchanged, before and after compaction, so they stay visible and cached.
   */
  private guide: AgentMessage[] = [];
  private pinned() {
    return new Set(this.guide);
  }
  private pauseStartedAt?: number;
  private pausedTotalMs = 0;
  private pausedMilliseconds() {
    return this.pausedTotalMs +
      (this.pauseStartedAt === undefined ? 0 : Date.now() - this.pauseStartedAt);
  }
  private contextTools() {
    return this.agent.state.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }
  private interruption?: "stopped" | "error";
  progress: RuntimeProgress = {
    phase: "starting",
    remainingSeconds: 0,
    plan: [],
    notebook: { revision: 0, text: "" },
    compactions: 0,
    contextEstimate: 0,
    inference: {
      completed: 0,
      totalMs: 0,
      failed: 0,
      aborted: 0,
      compactionMs: 0,
    },
  };
  constructor(
    readonly run: Run,
    private store: Store,
    private device: GameDevice,
    private profile: ModelProfile,
    private key: string,
    private refresh: (frame: Frame) => void,
    private log: (kind: "action" | "system" | "error" | "agent", text: string) => void,
    private changed: () => void,
    private dependencies: {
      now?: () => number;
      handoff?: (
        messages: AgentMessage[],
        system: string,
        tools: AgentTool<any>[],
      ) => Promise<{ text: string; usage: { totalTokens: number }; stopReason?: string }>;
      prepare?: (message: AgentMessage, system: string) => Promise<AssistantMessage>;
      reflection?: (
        messages: AgentMessage[],
        system: string,
        tools: AgentTool<any>[],
      ) => Promise<{ text: string; usage: { totalTokens: number }; stopReason?: string }>;
      spawnRecorder?: (args: string[]) => ChildProcessWithoutNullStreams;
      /** The playbook a learning episode (run.series) starts with: what the previous episode left. */
      playbook?: string;
    } = {},
  ) {
    if (!run.config) throw new Error("Missing run configuration");
    this.memory = new RunMemory(
      path.dirname(store.file(run.id, "run.json")),
      (event) => store.event(run.id, event),
    );
    // Before the agent is made: its playbook tools exist only in learning episodes.
    if (run.series) this.memory.startPlaybook(dependencies.playbook ?? "");
    if (run.config.recordVideo)
      this.recorder = new RunRecorder(
        path.dirname(store.file(run.id, "run.json")),
        () => device.currentStats(),
        (event) => store.event(run.id, event),
        (text) => log("system", text),
        defaultRecording,
        dependencies.spawnRecorder,
      );
    this.session = new Session(
      run.config.wallLimitMinutes * 60,
      () => {
        this.agent?.abort();
        device.cancelQueued();
      },
      dependencies.now,
      {
        budgetTicks: Math.round(run.config.gameMinutes * 60 * TICKS_PER_GAME_SECOND),
        clock: () => {
          const stats = device.currentStats();
          const tick = stats.observation?.game_time;
          const map = stats.observation?.map_name;
          return stats.status === "ok" && typeof tick === "number" && typeof map === "string"
            ? { tick, map }
            : null;
        },
      },
    );
    this.runtime = {
      session: this.session,
      cycle: this.cycle,
      memory: this.memory,
      config: run.config,
      military: benchmarkSpec(run.benchmarkType || "")?.military ?? true,
      phase: (phase) => {
        this.progress.phase = phase;
        this.publish();
      },
      changed: () => this.publish(),
      beforeInference: async () => {
        await this.ensurePauseState(true);
        this.recorder?.setActive(false);
        this.store.event(this.run.id, { type: "inference_pause_confirmed", at: Date.now() });
      },
      beforeToolCall: async () => {
        this.cycle.ran = true;
        this.recorder?.setActive(true);
        await this.ensurePauseState(false);
      },
      setPaused: (paused) => this.ensurePauseState(paused),
      isPaused: () => this.pauseStartedAt !== undefined,
      pausedMilliseconds: () => this.pausedMilliseconds(),
      pinned: () => this.pinned(),
      cost: (kind, dollars) => this.recordCost(kind, dollars),
      requestStarted: () => {
        this.requestStartedAt = performance.now();
        this.firstDeltaMs = undefined;
        store.event(run.id, {
          type: "inference_request_started",
          kind: "gameplay",
        });
      },
      timing: (ms, outcome, kind) => {
        store.event(run.id, {
          type: "inference_timing",
          kind,
          durationMs: ms,
          outcome,
          ...(kind === "gameplay"
            ? {
                firstDeltaMs: this.firstDeltaMs ?? null,
                afterFirstDeltaMs:
                  this.firstDeltaMs === undefined
                    ? null
                    : Math.max(0, ms - this.firstDeltaMs),
              }
            : {}),
        });
        const timing = this.progress.inference;
        if (kind === "reflection") return;
        if (kind === "compaction") timing.compactionMs += ms;
        else if (outcome === "aborted") timing.aborted++;
        else if (outcome === "error") timing.failed++;
        else {
          timing.completed++;
          timing.totalMs += ms;
        }
        this.publish();
      },
    };
    this.agent = makeAgent(
      device,
      refresh,
      (kind, text) => log(kind, text),
      1,
      profile,
      key,
      this.runtime,
    );
    this.agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        this.requestStartedAt !== undefined &&
        this.firstDeltaMs === undefined &&
        ["thinking_delta", "text_delta", "toolcall_delta"].includes(
          event.assistantMessageEvent.type,
        )
      ) {
        this.firstDeltaMs = performance.now() - this.requestStartedAt;
        store.event(run.id, {
          type: "inference_first_delta",
          kind: "gameplay",
          durationMs: this.firstDeltaMs,
        });
      }
      if (event.type === "message_end" && event.message.role === "assistant")
        this.store.update(run.id, {
          tokens: run.tokens + event.message.usage.totalTokens,
        });
      if (event.type === "turn_end")
        this.store.update(run.id, { turns: run.turns + 1 });
    });
    this.compact = async () => {
      this.runtime.phase("compacting");
      await this.runtime.beforeInference?.();
      const system = this.agent.state.systemPrompt;
      const instruction: AgentMessage = { role: "user", content: handoffInstruction, timestamp: Date.now() };
      const limit = this.runtime.config.contextBudget - 4096;
      const request = async (messages: AgentMessage[], tools: AgentTool<any>[]) => {
        const result = await (this.dependencies.handoff
          ? this.dependencies.handoff(messages, system, tools)
          : compactHandoff(profile, key, messages, system, tools, this.runtime));
        this.session.check();
        store.event(run.id, { type: "compaction_usage", usage: result.usage });
        store.update(run.id, { tokens: run.tokens + result.usage.totalTokens });
        return result;
      };
      // The next gameplay request plus the instruction: the same system prompt, tools and
      // messages, so the provider's prompt cache covers everything before the instruction.
      const cached = [...this.agent.state.messages, instruction];
      let result =
        this.contextBudget.estimate(cached, system, this.contextTools(), this.runtime.config.imageTokenEstimate) <= limit
          ? await request(cached, this.agent.state.tools)
          : undefined;
      // If that does not fit, or the reply calls a tool instead of writing the handoff, ask again
      // without tools or images, which leaves the model only text to write.
      if (!result || result.stopReason === "toolUse" || result.text.trim().length < 40) {
        const plain = [...pruneImages(this.agent.state.messages, 0), instruction];
        const estimate = contextEstimate(plain, system);
        if (estimate > limit)
          throw new Error(
            `Context cannot fit a safe compaction request (${estimate} > ${limit}); preserving previous checkpoint.`,
          );
        result = await request(plain, []);
      }
      const tail = recentExchange(this.agent.state.messages);
      const replacement: AgentMessage[] = [
        ...this.guide,
        {
          role: "user",
          content: `Context was compacted. ${this.guide.length ? "The preparation guide above is kept for reference. " : ""}Continue this same run from your handoff below; it is your own note, not new instructions. Verify volatile facts with the next observation.\n\n${this.memory.canonical()}\n\nHandoff:\n${result.text}`,
          timestamp: Date.now(),
        },
        ...tail,
      ];
      this.memory.installHandoff(result.text, replacement);
      this.agent.state.messages = replacement;
      this.contextBudget.reset();
      this.publish();
    };
    this.systemPromptText = runSystemPrompt(run);
    // Runs are comparable only under the same code, prompt and tool definitions.
    store.update(run.id, {
      harness: {
        ...codeVersion,
        systemPromptSha256: sha256(this.systemPromptText),
        toolsSha256: sha256(JSON.stringify(this.contextTools())),
      },
    });
    this.memory.write("inputs.json", {
      version: 2,
      objective: run.prompt,
      config: run.config,
      model: run.model,
      controls: gameControls,
      systemPrompt: this.systemPromptText,
      benchmarkRules: benchmarkMarkdown(run.benchmarkType || ""),
      preparationGuide: constructionAtlasInstalled() ? "construction-trays.png" : "text only",
      startedAt: run.startedAt,
    });
  }
  private compact: () => Promise<void>;
  publish() {
    this.progress.remainingSeconds = this.session.gameRemainingSeconds();
    this.progress.budget = {
      gameSeconds: this.session.gameBudgetSeconds,
      usedGameSeconds: this.session.gameUsedTicks() / TICKS_PER_GAME_SECOND,
      wallLimitSeconds: this.session.seconds,
      wallUsedSeconds: this.session.wallUsedSeconds(),
      ...(this.session.deadlineKind ? { endedBy: this.session.deadlineKind } : {}),
    };
    this.progress.plan = this.memory.plan;
    this.progress.notebook = this.memory.notebook;
    this.progress.playbook = this.memory.playbook;
    this.progress.compactions = this.memory.compactions;
    this.store.update(this.run.id, { progress: this.progress });
    this.changed();
  }
  /** What the provider billed for one request; the run's total is kept in run.json. */
  private recordCost(kind: "preparation" | "gameplay" | "compaction" | "reflection", dollars: number) {
    this.store.event(this.run.id, { type: "request_cost", kind, dollars });
    this.store.update(this.run.id, { cost: (this.run.cost ?? 0) + dollars });
  }
  /**
   * End the run for a host shutdown. Unlike an operator stop, which leaves the game as it is
   * for the operator, the game is still paused and captured at the end.
   */
  interrupt() {
    this.interruption = "stopped";
    this.session.stop("stopped");
    this.agent.abort();
    this.device.cancelQueued();
  }
  stop(reason: "stopped" | "error" = "stopped") {
    this.operatorStopped = true;
    this.interruption = reason;
    this.session.stop(reason);
    this.agent.abort();
    this.device.cancelQueued();
  }
  /** Built once per run and never changed, so the provider's prompt cache keeps working. */
  private readonly systemPromptText: string;
  private systemPrompt() {
    return this.systemPromptText;
  }
  private async ensurePauseState(target: boolean) {
    const allowed = () => {
      if (this.operatorStopped || this.session.reason) throw new Error("Run stopped.");
    };
    const freshState = async () => {
      for (let i = 0; i < 16; i++) {
        allowed();
        const stats = this.device.currentStats();
        if (stats.status === "ok" && typeof stats.observation?.paused === "boolean")
          return stats;
        if (i < 15) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("Fresh pause state unavailable after three seconds; refusing to toggle P blindly.");
    };
    allowed();
    let before = await freshState();
    if (before.observation?.paused === target) {
      if (target && this.pauseStartedAt === undefined)
        this.pauseStartedAt = Date.now();
      if (!target && this.pauseStartedAt !== undefined)
        throw new Error("Game became unpaused outside the harness; paused-frame age cannot be trusted.");
      return;
    }
    const frame = await this.device.capture();
    allowed();
    before = await freshState();
    if (before.observation?.paused === target) {
      if (target && this.pauseStartedAt === undefined)
        this.pauseStartedAt = Date.now();
      if (!target && this.pauseStartedAt !== undefined)
        throw new Error("Game became unpaused outside the harness; paused-frame age cannot be trusted.");
      return;
    }
    await this.device.action({ type: "key", key: "P" }, frame.id, allowed);
    const previousExpiry = before.valid_until_unix_ms || 0;
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      allowed();
      const current = this.device.currentStats();
      if (
        current.status === "ok" &&
        current.observation?.paused === target &&
        (current.valid_until_unix_ms || 0) > previousExpiry
      ) {
        if (target) this.pauseStartedAt = Date.now();
        else if (this.pauseStartedAt !== undefined) {
          this.pausedTotalMs += Date.now() - this.pauseStartedAt;
          this.pauseStartedAt = undefined;
        }
        return;
      }
    }
    throw new Error(`${target ? "Pause" : "Unpause"} input sent but not confirmed by a new reader sample.`);
  }
  async prepare() {
    if (this.prepared) throw new Error("Run already prepared.");
    this.runtime.phase("preparing");
    await this.ensurePauseState(true);
    this.log("system", "Game confirmed paused for agent preparation.");
    if (!constructionAtlasInstalled())
      this.log("system", "No construction guide image is installed; the agent gets the text guide only.");
    const message = preparationMessage(this.run, this.memory.playbook?.text);
    this.store.event(this.run.id, { type: "preparation_message", message });
    const started = performance.now();
    const request = () => this.dependencies.prepare
      ? this.dependencies.prepare(message, this.systemPromptText)
      : prepareModel(
          this.profile,
          this.key,
          this.systemPromptText,
          message as import("@earendil-works/pi-ai").UserMessage,
          this.session.abort.signal,
          (dollars) => this.recordCost("preparation", dollars),
        );
    // The game stays paused during preparation, so transient provider failures are retried.
    // A reply without BEGIN is also retried twice (GLM 5.3 Flash, 2026-09-28).
    let reply: AssistantMessage | undefined;
    let text = "";
    for (let attempt = 0, missing = 0; !reply; attempt++) {
      try {
        reply = await request();
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (attempt >= 5 || !isTransientProviderError(text) || this.operatorStopped || this.session.reason) throw error;
        this.log("error", `Preparation request failed (${text}); retrying.`);
        await new Promise((resolve) => setTimeout(resolve, [2000, 4000, 8000, 16000, 30000][attempt]));
        continue;
      }
      if (this.operatorStopped || this.session.reason) throw new Error("Run stopped during preparation.");
      text = reply.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (isPreparedReply(text)) break;
      this.store.event(this.run.id, { type: "preparation_rejected", reply });
      const cutOff = reply.stopReason === "length" ? " (cut off at the output-token limit)" : "";
      if (++missing > 2)
        throw new Error(`Agent did not finish its preparation reply with BEGIN${cutOff}; game remains paused. Last reply: ${JSON.stringify(text.slice(-300))}`);
      this.log("error", `Preparation reply did not end with BEGIN${cutOff}; retrying.`);
      reply = undefined;
    }
    this.store.event(this.run.id, { type: "preparation_reply", reply, durationMs: performance.now() - started });
    this.store.update(this.run.id, { tokens: this.run.tokens + reply.usage.totalTokens });
    this.guide = [message, reply];
    this.agent.state.messages = [message, reply];
    this.prepared = true;
    this.log("agent", text);
    this.runtime.phase("ready");
  }
  private async observe(seconds: number) {
    this.recorder?.setActive(true);
    await this.ensurePauseState(false);
    this.runtime.phase("waiting");
    await this.session.waitGame(seconds);
    const tool = this.agent.state.tools.find((t) => t.name === "observe")!;
    const result = await tool.execute(
      "host-observation",
      {},
      this.session.abort.signal,
    );
    const firstObservation = !this.initialGuideSent;
    this.initialGuideSent = true;
    const overview = firstObservation && !this.prepared ? atlasPage("construction-overview") : null;
    const message: AgentMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: firstObservation
            ? "Timed play has started: the game is running and the budget is counting. Here is the first screenshot."
            : seconds > 0
              ? `You acted without requesting a screenshot, so the host let ${seconds} game seconds pass. Fresh screenshot:`
              : "Fresh screenshot from the host.",
        },
        ...(firstObservation && this.device.latest && layoutNote(this.device.latest)
          ? [{ type: "text" as const, text: layoutNote(this.device.latest)! }]
          : []),
        // A prepared run already saw the guide-page list in the preparation message.
        ...(firstObservation && !this.prepared ? [{ type: "text" as const, text: atlasIndex() }] : []),
        ...(overview
          ? [
              { type: "text" as const, text: overview.text },
              { type: "image" as const, data: overview.image, mimeType: "image/png" as const },
            ]
          : []),
        ...result.content,
      ],
      timestamp: Date.now(),
    };
    this.store.event(this.run.id, { type: "host_observation", message });
    this.agent.state.messages = [...this.agent.state.messages, message];
  }
  async runSession() {
    const unsubscribe = this.device.events.subscribe((record) => {
      try {
        this.memory.journal(this.store.redact(record));
      } catch (error) {
        this.log("error", `Notification journal failed: ${String(error)}`);
        this.stop("error");
      }
    });
    // Memory-guard samples (every 5 s) go to the run's events with the game clock and pause state,
    // so a guard stop shows what grew and whether it grew while paused.
    const unsubscribeGuard = this.device.onGuard?.((record) => {
      if (record.kind === "sample") {
        const mib = (kib: unknown) => (typeof kib === "number" ? Math.round(kib / 1024) : undefined);
        const observation = this.device.currentStats().observation;
        const sample = {
          type: "memory_sample",
          gameRssMiB: mib(record.rss_kib),
          gameSwapMiB: mib(record.swap_kib),
          availableMiB: mib(record.available_kib),
          threads: record.threads,
          resident: record.resident_kib,
          system: record.system_kib,
          graphics: record.graphics,
          gameTime: observation?.game_time,
          paused: observation?.paused,
          limits: record.limits,
        };
        this.store.event(this.run.id, sample);
        const m = this.progress.memory ?? { samples: 0, maxGameRssMiB: 0, maxGameSwapMiB: 0, minAvailableMiB: Infinity };
        this.progress.memory = {
          samples: m.samples + 1,
          maxGameRssMiB: Math.max(m.maxGameRssMiB, sample.gameRssMiB ?? 0),
          maxGameSwapMiB: Math.max(m.maxGameSwapMiB, sample.gameSwapMiB ?? 0),
          minAvailableMiB: Math.min(m.minAvailableMiB, sample.availableMiB ?? Infinity),
        };
      } else if (record.kind === "memory_map" || record.kind === "termination_requested") {
        this.store.event(this.run.id, { type: `memory_guard_${record.kind}`, record });
      }
    });
    this.memory.journal({
      kind: "journal_start",
      cursor: this.device.events.cursor(),
      at: Date.now(),
      coverage: "Only events captured during this run; no hidden game history.",
    });
    // The budget starts from a valid game-clock sample; a live stream has brief unavailable samples.
    for (let i = 0; i < 30; i++) {
      const stats = this.device.currentStats();
      if (stats.status === "ok" && typeof stats.observation?.game_time === "number") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.session.start();
    this.recorder?.start();
    const unsubscribeInput = this.recorder && this.device.onInput?.((input) => this.recorder!.input(input));
    let empty = 0,
      readingOnly = 0;
    try {
      if (this.prepared) {
        this.recorder?.setActive(true);
        await this.ensurePauseState(false);
        this.log("system", "Agent ready; game confirmed unpaused and timed play started.");
      }
      await this.observe(0);
      if (this.device.latest)
        writeFileSync(
          path.join(this.memory.directory, "controls-guide.html"),
          visualGuide(this.device.latest),
          { mode: 0o600 },
        );
      while (true) {
        this.session.check();
        this.agent.state.systemPrompt = this.systemPrompt();
        this.agent.state.messages = pruneImages(this.agent.state.messages, 2, this.pinned());
        this.progress.contextEstimate = this.contextBudget.estimate(
          this.agent.state.messages,
          this.agent.state.systemPrompt,
          this.contextTools(),
          this.runtime.config.imageTokenEstimate,
        );
        // Compact while the fallback handoff request (text only) still fits with room to spare.
        const handoffHeadroom = this.runtime.config.contextBudget - Math.min(30000, this.runtime.config.contextBudget * 0.25);
        const nextHandoffEstimate = contextEstimate(
          [
            ...pruneImages(this.agent.state.messages, 0),
            { role: "user", content: handoffInstruction, timestamp: Date.now() },
          ],
          this.agent.state.systemPrompt,
        );
        if (
          this.progress.contextEstimate > this.runtime.config.contextBudget * 0.65 ||
          nextHandoffEstimate > handoffHeadroom
        ) {
          await this.compact();
          await this.observe(0);
          this.agent.state.systemPrompt = this.systemPrompt();
          this.progress.contextEstimate = this.contextBudget.estimate(
            this.agent.state.messages,
            this.agent.state.systemPrompt,
            this.contextTools(),
            this.runtime.config.imageTokenEstimate,
          );
          if (
            this.progress.contextEstimate >
            this.runtime.config.contextBudget * 0.65
          )
            throw new Error(
              `Canonical context exceeds working budget after compaction (${this.progress.contextEstimate} > ${this.runtime.config.contextBudget * 0.65}).`,
            );
        }
        const requestMessages = [...this.agent.state.messages];
        const requestSystem = this.agent.state.systemPrompt;
        const requestTools = this.contextTools();
        this.store.event(this.run.id, {
          type: "context_budget",
          estimate: this.progress.contextEstimate,
          limit: this.runtime.config.contextBudget,
          compactions: this.memory.compactions,
        });
        this.cycle.begin();
        this.runtime.phase("thinking");
        // A complete single Pi turn settles all its tool results before this loop continues.
        // A transient provider failure (empty response, overload, 5xx) on the model reply is retried up
        // to five times with backoff: the game is paused during requests, so it costs no game time.
        let truncated = false;
        let lengthRetries = 0;
        for (let attempt = 0; ; attempt++) {
          const tail = this.agent.state.messages.at(-1);
          if (truncated)
            await this.agent.prompt(
              "Your previous reply ran out of output tokens while reasoning and was discarded. Think briefly, then call tools now.",
            );
          else if (tail?.role === "user" || tail?.role === "toolResult")
            await this.agent.continue();
          else
            await this.agent.prompt(
              "Continue the same run. Consult your current plan and the latest observation.",
            );
          truncated = false;
          this.session.check();
          const reply = this.agent.state.messages.at(-1);
          // GLM 5.3 Flash once reasoned in a loop until maxTokens ("length", 2026-09-28). Discard the
          // truncated reply and ask for a short one, up to twice per turn.
          if (lengthRetries < 2 && reply?.role === "assistant" && reply.stopReason === "length") {
            lengthRetries++;
            this.log("error", "Model reply hit the output-token limit; retrying with a brief-reply nudge.");
            this.store.event(this.run.id, { type: "inference_retry", attempt: lengthRetries, error: "length" });
            this.agent.state.messages = this.agent.state.messages.slice(0, -1);
            truncated = true;
            continue;
          }
          if (
            attempt < 5 &&
            reply?.role === "assistant" &&
            reply.stopReason === "error" &&
            isTransientProviderError(reply.errorMessage)
          ) {
            this.log("error", `Model request failed (${reply.errorMessage}); retrying.`);
            this.store.event(this.run.id, { type: "inference_retry", attempt: attempt + 1, error: reply.errorMessage });
            this.agent.state.messages = this.agent.state.messages.slice(0, -1);
            // Image requests to the provider failed in bursts (502 "provider unavailable", 2026-09-28).
            await new Promise((resolve) => setTimeout(resolve, [2000, 4000, 8000, 16000, 30000][attempt]));
            this.session.check();
            continue;
          }
          break;
        }
        if (this.agent.state.errorMessage)
          throw new Error(this.agent.state.errorMessage);
        const last = this.agent.state.messages
          .slice()
          .reverse()
          .find((m) => m.role === "assistant");
        if (
          last?.role === "assistant" &&
          ["error", "aborted", "length"].includes(last.stopReason)
        )
          throw new Error(
            last.errorMessage || `Model stopped: ${last.stopReason}`,
          );
        if (last?.role === "assistant")
          this.contextBudget.record(
            requestMessages,
            requestSystem,
            requestTools,
            last.usage.input + last.usage.cacheRead + last.usage.cacheWrite,
          );
        this.agent.state.messages = pruneImages(this.agent.state.messages, 2, this.pinned());
        this.memory.checkpoint(this.agent.state.messages, {
          remainingMs: this.session.remaining(),
          progress: this.progress,
        });
        empty = this.cycle.tools === 0 ? empty + 1 : 0;
        // Reading tools before any action keep the game paused and cost no game time, so a run of
        // reading-only replies would never use up the budget; it ends here instead.
        readingOnly =
          !this.cycle.acted && !this.cycle.ran && this.cycle.tools > 0
            ? readingOnly + 1
            : 0;
        if (empty >= 4 || readingOnly >= 12)
          throw new Error(
            "No game action or wait across repeated turns.",
          );
        if (this.run.maxTurns && this.run.turns >= this.run.maxTurns) {
          this.progress.stopReason = "turn_limit";
          break;
        }
        if (this.cycle.needsFallback())
          await this.observe(this.runtime.config.defaultWaitSeconds);
      }
    } catch (error) {
      if (!this.session.reason) {
        this.session.stop("error");
        this.log("error", String(error));
      }
    } finally {
      this.session.close();
      if (this.session.errorDetail) this.log("error", this.session.errorDetail);
      if (this.recorder) {
        const recording = await this.recorder.stop();
        this.progress.recording = { frames: recording.frames, bytes: recording.bytes, ...(recording.lastError ? { lastError: recording.lastError } : {}) };
      }
      try {
        this.progress.stopReason =
          this.interruption ||
          this.session.reason ||
          this.progress.stopReason ||
          "completed";
        this.runtime.phase("finalizing");
        if (!this.operatorStopped)
          await this.finalizePause();
        else
          this.progress.finalPause =
            "Not attempted after operator stop.";
        if (!this.operatorStopped) await this.reflect();
        this.progress.stopReason =
          this.interruption || this.progress.stopReason;
        this.progress.phase =
          this.progress.stopReason === "error"
            ? "error"
            : this.progress.stopReason === "stopped"
              ? "stopped"
              : "completed";
        this.memory.checkpoint(pruneImages(this.agent.state.messages), {
          progress: this.progress,
        });
        this.publish();
      } finally {
        unsubscribe();
        unsubscribeGuard?.();
        unsubscribeInput?.();
      }
    }
    return this.progress.phase as "completed" | "stopped" | "error";
  }
  /**
   * After a learning episode: show the agent its final result and ask for the playbook's next
   * version. A failed request leaves the playbook as the agent last wrote it.
   */
  private async reflect() {
    const series = this.run.series;
    const playbook = this.memory.playbook;
    if (!series || !playbook || !this.prepared) return;
    this.runtime.phase("reflecting");
    const system = this.agent.state.systemPrompt;
    const instruction: AgentMessage = {
      role: "user",
      content: reflectionInstruction(series, playbook.text, this.device.currentStats(), this.runtime.military),
      timestamp: Date.now(),
    };
    const request = async (messages: AgentMessage[], tools: AgentTool<any>[]) => {
      const result = await (this.dependencies.reflection
        ? this.dependencies.reflection(messages, system, tools)
        : reflectionReply(this.profile, this.key, messages, system, tools, this.runtime));
      this.store.event(this.run.id, { type: "reflection_usage", usage: result.usage });
      this.store.update(this.run.id, { tokens: this.run.tokens + result.usage.totalTokens });
      return result;
    };
    try {
      // As with the handoff: the last gameplay request plus the instruction, then text only.
      let result = await request([...this.agent.state.messages, instruction], this.agent.state.tools);
      if (result.stopReason === "toolUse" || !result.text.trim())
        result = await request([...pruneImages(this.agent.state.messages, 0), instruction], []);
      const text = result.text.trim();
      if (!text) throw new Error("the reply was empty");
      if (Buffer.byteLength(text) > DOCUMENT_BYTES) throw new Error(`the reply is over ${DOCUMENT_BYTES} bytes`);
      this.memory.writePlaybook(this.memory.playbook!.revision, text);
      this.store.event(this.run.id, { type: "reflection", playbook: text });
      this.log("agent", `Playbook for the next episode:\n${text}`);
    } catch (error) {
      this.log("error", `Reflection failed (${error instanceof Error ? error.message : String(error)}); the playbook stays as the agent last wrote it.`);
    }
  }
  private async finalizePause() {
    // Host-only finalization; no agent actions after stopping and no blind P toggle.
    const allowed = () => {
      if (this.operatorStopped)
        throw new Error("Operator stop overrides finalization.");
    };
    try {
      allowed();
      let frame = await this.device.capture();
      allowed();
      let stats = this.device.currentStats();
      for (let i = 0; i < 10 && (stats.status !== "ok" || typeof stats.observation?.paused !== "boolean"); i++) {
        await new Promise((r) => setTimeout(r, 200));
        allowed();
        stats = this.device.currentStats();
      }
      if (stats.status !== "ok" || typeof stats.observation?.paused !== "boolean")
        throw new Error("Fresh pause state unavailable.");
      if (!stats.observation.paused) {
        await this.device.action({ type: "key", key: "P" }, frame.id, allowed);
        const after = Date.now();
        let confirmed = false;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 200));
          allowed();
          const current = this.device.currentStats();
          if (
            current.status === "ok" &&
            current.observation?.paused === true &&
            (current.valid_until_unix_ms ?? 0) > after + 1500
          ) {
            confirmed = true;
            break;
          }
        }
        if (!confirmed)
          throw new Error(
            "Pause input sent but not confirmed by a new reader sample.",
          );
      }
      frame = await this.device.capture();
      allowed();
      this.refresh(frame);
      this.store.event(this.run.id, {
        type: "final_observation",
        frame,
        stats: this.device.currentStats(),
      });
      this.progress.finalPause =
        "Confirmed paused with final game-window capture.";
    } catch (error) {
      this.progress.finalPause = String(error);
      this.log("error", `Final verification incomplete: ${String(error)}`);
      return;
    }
    try {
      await this.finalOverview(allowed);
    } catch (error) {
      this.log("error", `Final overview not captured: ${String(error)}`);
    }
  }
  /**
   * With the game confirmed paused after the final reading, centre on the keep, zoom all the way
   * out and save the view as <run>/final-overview.jpg: a picture of what the agent built. Host-only
   * and best effort; it changes only the camera and never touches the scorecard reading. The keep
   * hotkey does nothing while paused, but minimap clicks and Z do (live 2026-10-08). Near a map
   * edge the zoomed-out view cannot centre on the keep, but the keep stays in view.
   */
  private async finalOverview(allowed: () => void) {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (!this.device.currentStats().observation?.camera) {
      this.log("system", "Final overview skipped: the reader has no camera position.");
      return;
    }
    const ctx: AnchorContext = {
      device: this.device,
      capture: async () => {
        allowed();
        return this.device.capture();
      },
      send: async (frame, action) => (await this.device.action(action, frame.id, allowed)) as Ack,
      hotkey: (name) => this.device.hotkey(name, allowed),
      pause: (seconds) => wait(seconds * 1000),
      state: {},
    };
    const map = new MapView(await this.device.mapSummary());
    const keep = map.keep();
    const centre = keep ? (await goToTile(ctx, keep, map.extent())).status : "no_keep";
    let steps = 0;
    for (; steps < MAX_ZOOM_OUT_STEPS; steps++) {
      const before = cameraKey(this.device.currentStats().observation ?? {});
      const ack = await ctx.send(await ctx.capture(), { type: "key", key: "Z" });
      if (!(await sampleAfter(ctx, ackTime(ack), (o) => cameraKey(o) !== before, 0.8))) break;
    }
    await wait(OVERVIEW_SETTLE_MS);
    const frame = await ctx.capture();
    const camera = this.device.currentStats().observation?.camera ?? null;
    writeFileSync(path.join(this.memory.directory, "final-overview.jpg"), Buffer.from(frame.image, "base64"), { mode: 0o600 });
    this.refresh(frame);
    this.store.event(this.run.id, { type: "final_overview", frame, keep, centre, zoomOutSteps: steps, camera });
    this.log("system", `Final overview saved (camera to the keep: ${centre.replace("_", " ")}; zoomed out ${steps} step${steps === 1 ? "" : "s"}).`);
  }
}
