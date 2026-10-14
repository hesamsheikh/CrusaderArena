import { z } from "zod";
export const allowedKeys = [
  "+",
  "-",
  "Space",
  "Escape",
  "Enter",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
] as const;
const coordinate = z.number().int().min(0).max(7679);
export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("click"),
      x: coordinate,
      y: coordinate,
      button: z.union([z.literal(1), z.literal(3)]).default(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      x: coordinate,
      y: coordinate,
      endX: coordinate,
      endY: coordinate,
      button: z.union([z.literal(1), z.literal(3)]).default(1),
    })
    .strict(),
  z.object({ type: z.literal("key"), key: z.enum(allowedKeys) }).strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: coordinate,
      y: coordinate,
      direction: z.enum(["up", "down"]),
    })
    .strict(),
]);
export type GameAction = z.infer<typeof actionSchema>;
/** Model tool APIs may populate unrelated optional fields; keep only fields for the chosen action. */
export function modelToolAction(value: Record<string, unknown>): GameAction {
  const picked = value.type === "key"
    ? { type: value.type, key: value.key }
    : value.type === "click"
      ? { type: value.type, x: value.x, y: value.y, button: value.button }
      : value.type === "drag"
        ? { type: value.type, x: value.x, y: value.y, endX: value.endX, endY: value.endY, button: value.button }
        : value.type === "scroll"
          ? { type: value.type, x: value.x, y: value.y, direction: value.direction }
          : value;
  return actionSchema.parse(picked);
}
export type Frame = {
  id: string;
  image: string;
  mimeType: "image/jpeg";
  /** The image's size: the pixels the model and the tools target. */
  width: number;
  height: number;
  /** The game window's own size, when the image was scaled down from it (windowAction). */
  windowWidth?: number;
  windowHeight?: number;
  windowId: number;
  pid: number;
  capturedAt: number;
  receivedAt: number;
  scope: "game-window";
  /** The game clock (reader ticks) and map when the capture was taken, when the reader had them (frameAgeSeconds). */
  gameTick?: number;
  mapName?: string;
};
export type LogEntry = {
  id: string;
  at: number;
  kind: "system" | "user" | "agent" | "action" | "error";
  text: string;
};
export type Stats = {
  status: string;
  session?: string;
  generation?: number;
  captured_unix_ms?: number;
  valid_until_unix_ms?: number;
  observation?: {
    local_player_id?: number;
    game_time?: number;
    map_name: string;
    gold: number;
    population: number;
    popularity: number;
    wood_planks: number;
    resources_by_name?: Record<string, number>;
    paused?: boolean;
    is_paused?: boolean;
    own_troops?: { total: number };
    /** Engine object-pool counter; probably map-wide, not the local player's buildings. */
    structures?: { count: number; limit: number };
    /** MainControls action (5 = placing) and mapper item; null when unavailable. */
    placement?: { action: number; sub_action: number } | null;
    /** View anchor: tile at screen centre, visible tile span and zoom scale; null when unavailable. */
    camera?: {
      centre_tile_x: number;
      centre_tile_y: number;
      tiles_wide: number;
      tiles_high: number;
      pixels_per_unit_scale: number;
    } | null;
    /**
     * The map tile under the mouse pointer as the game picks it for a click, terrain height
     * included; a pointer move updates it without a click. Null when unavailable.
     */
    mouse_tile?: { x: number; y: number } | null;
    /** Mono GC heap totals and the reader's collector watchdog (memory diagnostics); null when unavailable. */
    managed_heap?: {
      heap_bytes: number;
      used_bytes: number;
      collections?: number;
      finalizers_pending?: boolean;
      gc_disabled?: boolean;
      /** Collections the reader forced after the collector stalled, and the latest one. */
      watchdog?: { forced: number; last: GcWatchdogRecord | null };
    } | null;
    /** Calendar (month 0 = January), housing, food and popularity factors (25 per UI point); null when unavailable. */
    settlement?: {
      month: number;
      year: number;
      housing_cap: number;
      peasants_available: number;
      total_food: number;
      months_of_food: number;
      rationing: number;
      food_types_eaten: number;
      food_types_available: number;
      /** Worker efficiency in percent from the fear factor; 0 before the game's first reckoning. */
      efficiency: number;
      upcoming_popularity: number;
      popularity_factors: Record<string, number>;
      /** The church and cathedral popularity bonus, apart from the blessing in `religion`, in the factors' units (25 per point); null when unreadable. */
      church_bonus?: number | null;
      /** The keep panel's tax figure: gold a month at the current tax level, negative for a bribe. */
      tax_amount?: number;
    } | null;
    /**
     * The local player's stockpile piles (four per stockpile, each holding one good; an empty pile
     * has no good) and granaries, from the engine's building records; null when unavailable.
     */
    storage?: {
      piles: { tile: [number, number]; good: string | null; amount: number; capacity: number }[];
      granaries: { tile: [number, number]; amount: number; capacity: number }[];
      /** Absent from readers before 1.6.2. */
      armories?: { tile: [number, number]; amount: number; capacity: number }[];
      truncated: boolean;
    } | null;
    /**
     * The local player's building records counted by engine type number (building-types.ts),
     * parts kept as their own records included (a stockpile's piles, a quarry's pile, the keep's
     * doors); null when unavailable, absent from readers before it.
     */
    buildings?: Record<string, number> | null;
    /** The building whose panel is open; null when none. */
    selected_building?: {
      id: number;
      type: number;
      have_stats: number;
      workers_have: number;
      job_vacancies: number;
      workers_needed: number;
      working: number;
      turned_off: number;
      keep_access: number;
      hp: number;
      max_hp: number;
      no_resources: number;
    } | null;
    /**
     * The open panel's workshop, for a fletcher (12), blacksmith (13) or poleturner (14): the goods
     * numbers it is making and will make next; null otherwise, absent from readers before it.
     */
    selected_workshop?: { id: number; type: number; making: number; next: number } | null;
    [key: string]: unknown;
  } | null;
};
/**
 * Reasoning effort sent with every request. "default" sends no setting and leaves it to the
 * endpoint; "off" (OpenRouter only) asks for none.
 */
/** "max" is the endpoint's highest effort: Claude's own "max", OpenRouter's "xhigh" (as Artificial Analysis reports models). */
export const reasoningLevels = ["default", "off", "minimal", "low", "medium", "high", "max"] as const;
export type ReasoningLevel = (typeof reasoningLevels)[number];
/** How a profile's requests are made; part of every run's model snapshot. */
export type ModelSettings = {
  reasoning: ReasoningLevel;
  /** Output tokens per reply, reasoning included. */
  maxTokens: number;
  /** OpenRouter only: upstream providers in order of preference; empty lets OpenRouter choose. */
  providers: string[];
  /** OpenRouter only: whether providers outside the list may serve a request. */
  allowFallbacks: boolean;
};
/** US dollars per million tokens. Cache writes are the 5-minute rate; a 1-hour write costs twice the input rate. */
export type TokenRates = { input: number; output: number; cacheRead: number; cacheWrite: number };
/**
 * A model's list prices, for endpoints that do not report what they bill (every one but OpenRouter).
 * `longPrompt` holds the rates for a request whose prompt (input, cache reads and cache writes) is
 * over `above` tokens, such as Claude Haiku 5.5's over 100,000.
 */
export type TokenPrices = TokenRates & { longPrompt?: TokenRates & { above: number } };
export type ModelProfile = {
  id: string;
  name: string;
  modelId: string;
  baseUrl: string;
  keyConfigured: boolean;
  prices?: TokenPrices;
} & Partial<ModelSettings>;
export const isOpenRouter = (baseUrl: string) => new URL(baseUrl).hostname === "openrouter.ai";
/**
 * Why a run on this profile would record no cost; null when it records one. OpenRouter reports
 * what it billed for each request; elsewhere the host prices each request's tokens.
 */
export function costProblem(profile: { baseUrl: string; prices?: TokenPrices }) {
  if (isOpenRouter(profile.baseUrl) || profile.prices) return null;
  return "This endpoint does not report what it bills. Enter the model's prices in its settings so runs record their cost.";
}
export const isMoonshot = (baseUrl: string) => /^api\.moonshot\./.test(new URL(baseUrl).hostname);
/**
 * Reasoning levels a Moonshot profile can take: Default sends nothing, which Kimi K3 treats as max;
 * a level is sent as Kimi K3's `reasoning_effort`, which takes only "low", "high" and "max".
 */
export const moonshotReasoning = new Set<ReasoningLevel>(["default", "low", "high", "max"]);
/** Anthropic's own Messages API (not its OpenAI-compatible layer). */
export const isAnthropic = (baseUrl: string) => new URL(baseUrl).hostname === "api.anthropic.com";
/**
 * A profile's settings with defaults. Missing values are what the harness sent before they were
 * settings (2026-10-08): low reasoning on OpenRouter, the endpoint's default elsewhere, 8192 tokens.
 */
export function modelSettings(profile: { baseUrl: string } & Partial<ModelSettings>): ModelSettings {
  return {
    reasoning: profile.reasoning ?? (isOpenRouter(profile.baseUrl) ? "low" : "default"),
    maxTokens: profile.maxTokens ?? 8192,
    providers: profile.providers ?? [],
    allowFallbacks: profile.allowFallbacks ?? true,
  };
}
/** Recorded settings in one line; null for runs that recorded none. */
export function settingsLabel(model: Partial<ModelSettings>) {
  if (model.reasoning === undefined) return null;
  return [
    `reasoning ${model.reasoning}`,
    `${model.maxTokens} max tokens`,
    ...(model.providers?.length
      ? [`providers ${model.providers.join(", ")}${model.allowFallbacks ? " (fallbacks allowed)" : " only"}`]
      : []),
  ].join(" · ");
}
/** Settings the endpoint cannot honour; null when they are all usable. */
export function settingsProblem(baseUrl: string, settings: ModelSettings) {
  if (isMoonshot(baseUrl) && !moonshotReasoning.has(settings.reasoning))
    return "Moonshot's endpoint takes Default (Kimi K3's own max) or the levels Kimi K3 accepts: low, high or max.";
  if (!isOpenRouter(baseUrl) && settings.reasoning === "off")
    return "Reasoning off is only available on OpenRouter; choose Default or a level.";
  if (!isOpenRouter(baseUrl) && settings.providers.length)
    return "Provider routing applies only to OpenRouter endpoints.";
  return null;
}
/**
 * Game ticks per game second. The reader's game_time advances at the speed
 * setting per real second (30.3/s at 30, 45.5/s at 45; live 2026-09-28), so a
 * game second is one real second at the default speed of 30.
 */
export const TICKS_PER_GAME_SECOND = 30;
/**
 * The benchmark's fixed game speed setting. The host sets it with the game's speed keys before
 * timed play and the agent cannot change it; the game clock then runs about 40 ticks per real
 * second, so a game second takes about 0.75 real seconds.
 */
export const GAME_SPEED = 40;
/**
 * The speed the host plays waits at (run config `fastWaits`, harness/server/game-speed.ts): the
 * game's top speed, which its + key reaches in steps of 5. Only game time the run waits for
 * passes at it; the host brings the game back to GAME_SPEED, measured, before a wait ends.
 */
export const FAST_GAME_SPEED = 90;
/**
 * Game seconds of play after which a screenshot no longer serves for input aimed at its pixels:
 * the game changes under a stale image. Counted on the game clock, so time the game spends paused
 * does not count and waits the host plays faster (fast waits) count in full; 40 game seconds is
 * the 30 real seconds the limit was before 1.7.0, at GAME_SPEED.
 */
export const FRAME_MAX_AGE_GAME_SECONDS = 40;
/**
 * Seconds of play since `frame` was captured, in game seconds: from the game clock when the frame
 * and `clock` (the reader's latest reading) both have one for the same map, else from real time at
 * GAME_SPEED, less `creditMs` (time the host kept the game paused since), as in menus or a reader
 * gap. A clock that went back, or another map, means another game: the frame is too old for it.
 * An infinite credit waives the age: input aimed from the live camera (a tile target) takes only
 * the window's identity and size from the frame, so any capture serves it.
 */
export function frameAgeSeconds(
  frame: Pick<Frame, "receivedAt" | "gameTick" | "mapName">,
  clock: { tick: number; map: string } | null,
  now = Date.now(),
  creditMs = 0,
) {
  if (creditMs === Number.POSITIVE_INFINITY) return 0;
  if (clock && typeof frame.gameTick === "number" && frame.mapName !== undefined) {
    if (frame.mapName !== clock.map || clock.tick < frame.gameTick) return Number.POSITIVE_INFINITY;
    return (clock.tick - frame.gameTick) / TICKS_PER_GAME_SECOND;
  }
  return (Math.max(0, now - creditMs - frame.receivedAt) * GAME_SPEED) / (1000 * TICKS_PER_GAME_SECOND);
}
/**
 * Reading-only replies keep the game paused, so they cost no game time. From this many in a row,
 * the host lets game time pass after each one, so reading stops being free (it used to end the run).
 */
export const READING_ONLY_LIMIT = 12;
/** Replies in a row without any tool call that end the run: the model has stopped playing. */
export const EMPTY_REPLY_LIMIT = 4;
/**
 * Game seconds left within which reaching EMPTY_REPLY_LIMIT lets the rest of the budget pass
 * instead of ending the run: a reply without tools only waits, and the host waits out what is left
 * without another request. GLM 5.3 Flash's run (2026-10-11) ended this way 5 game seconds short.
 */
export const EMPTY_REPLY_GRACE_SECONDS = 60;
export const runConfigSchema = z
  .object({
    /** Benchmark budget in game time: 1 game minute = 60 × 30 = 1,800 game ticks. */
    gameMinutes: z.number().min(0.5).max(120).default(25),
    /** Real-time safety limit covering model thinking while the game is paused. */
    wallLimitMinutes: z.number().min(0.5).max(720).default(360),
    /** Fallback wait after an action turn, in game seconds. */
    defaultWaitSeconds: z.number().min(0).max(300).default(5),
    /**
     * Least game time a turn that runs the game takes, in game seconds; the host lets the rest
     * pass after a shorter one. It bounds model requests per game minute, so cost. 0 turns it off.
     */
    minTurnSeconds: z.number().min(0).max(60).default(8),
    /**
     * Whether the host's own fallback observation (after a turn that acted without looking or ran
     * short of the minimum turn, or the reading-only top-up) is a screenshot or the text-only
     * observation: "when-needed" sends text unless the turn sent input that works from the
     * screenshot (any game_action, inspect_building, a build_structure placement given in pixels);
     * "always" is a screenshot every time, as every run did before this setting existed.
     * A reply with no tool calls gets a screenshot under either.
     */
    fallbackObservation: z.enum(["when-needed", "always"]).default("when-needed"),
    /**
     * Width the model's screenshots are scaled down to, keeping the window's aspect (1280 gives
     * 1280 x 720 from 1920 x 1080: about 44% of the pixels and image tokens, the buildings, terrain
     * and HUD figures still legible); 0 keeps the window's own size. Fixed for the run, so the
     * conversation's images stay alike for the prompt cache. Clicks are scaled back to the window.
     */
    screenshotWidth: z.number().int().min(0).max(7680).default(1280),
    contextBudget: z.number().int().min(32000).max(200000).default(120000),
    imageTokenEstimate: z.number().int().min(1024).max(16384).default(4096),
    /** Record the game window while the agent acts (not while it thinks) for tools/video/render-video.py. */
    recordVideo: z.boolean().default(false),
    /**
     * Fast waits: the host plays the game time a run only waits for (the model's waits and its own)
     * at FAST_GAME_SPEED where that saves real time, back at GAME_SPEED, measured, before each
     * wait ends. Every tick is the same game at any speed, so only the run's real time changes.
     */
    fastWaits: z.boolean().default(true),
  })
  .strict();
export type RunConfig = z.infer<typeof runConfigSchema>;
/** The speed the host found, the speed it measured after setting it, and the key presses it took. */
export type GameSpeedSetting = { target: number; before: number; after: number; presses: number };
export type RuntimeProgress = {
  phase: string;
  /** Game seconds left in the budget (runs before 2026-09-28: wall seconds). */
  remainingSeconds: number;
  budget?: {
    gameSeconds: number;
    usedGameSeconds: number;
    wallLimitSeconds: number;
    wallUsedSeconds: number;
    /** Which limit ended the run, if one did. */
    endedBy?: "game_time" | "wall_limit";
  };
  /** How the host set the game speed before timed play (runs from 2026-10-08). */
  gameSpeed?: GameSpeedSetting;
  /**
   * Fast waits (run config `fastWaits`): how many waits were played fast, the game and real
   * seconds they took, the real seconds they saved (estimated), the presses it took to set the
   * speed again after a wrong end speed, and why they stopped for the run, if they did.
   */
  fastWaits?: { count: number; gameSeconds: number; realSeconds: number; savedSeconds: number; corrections: number; off?: string };
  stopReason?: string;
  /** The error that ended the run, when one did. */
  endError?: string;
  plan: { step: string; status: "pending" | "in_progress" | "completed" }[];
  notebook: { revision: number; text: string };
  /** A learning episode's playbook (see RunSeries); absent in other runs. */
  playbook?: { revision: number; text: string } | null;
  compactions: number;
  contextEstimate: number;
  inference: {
    completed: number;
    totalMs: number;
    failed: number;
    aborted: number;
    compactionMs: number;
    /** The one-off preparation request before timed play starts, retries included. */
    preparationMs: number;
    /** Reflection requests after a learning episode (the playbook rewrite); gameplay is unaffected. */
    reflectionMs: number;
  };
  finalPause?: string;
  /** Memory-guard extremes on the game host during the run (MiB), and collections the reader forced. */
  memory?: { samples: number; maxGameRssMiB: number; maxGameSwapMiB: number; minAvailableMiB: number; forcedCollections?: number };
  /** Frames saved under recording/ when the run config asked for a video. */
  recording?: { frames: number; bytes: number; lastError?: string };
};
/**
 * A collection the reader forced because the game's collector stopped starting them (see
 * src/windows/gc_watchdog.hpp), with the collector globals read just before it.
 */
export type GcWatchdogRecord = {
  at_unix_ms: number;
  stalled_ms: number;
  used_growth_bytes: number;
  collections_before: number;
  collections_after: number;
  collect_ms: number;
  total_stack_bytes: number | null;
  threshold_bytes: number | null;
  dont_gc: number | null;
  automatic_disabled: number | null;
};
/** Enough to tell whether two runs used the same harness, prompt and tools. */
export type HarnessVersion = {
  /** Git commit the host process started from; null when git was unavailable. */
  commit: string | null;
  /** Whether the files the benchmark fingerprint covers (benchmark-version.ts) differed from it. */
  dirty: boolean | null;
  /** SHA-256 of those differences (tracked diff plus new files), when dirty. */
  diffSha256?: string;
  systemPromptSha256: string;
  toolsSha256: string;
};
/** The benchmark version a host runs (harness/server/benchmark-version.ts). */
export type BenchmarkStamp = {
  /** MAJOR.MINOR.PATCH, such as 1.0.0; null when benchmark-versions.json lists no version for the fingerprint. */
  version: string | null;
  /** SHA-256 of the files that decide how a run plays and is scored. */
  fingerprint: string;
  /** SHA-256 of the private preparation images; null when the guide is text only. */
  guide: string | null;
};
export type Run = {
  config?: RunConfig;
  progress?: RuntimeProgress;
  benchmarkType?: string;
  id: string;
  name: string;
  modelId: string;
  /**
   * The profile when the run started; runs before 2026-10-08 have no settings recorded. `prices`
   * are the ones its cost was worked out from (endpoints other than OpenRouter).
   */
  model: Pick<ModelProfile, "name" | "modelId" | "baseUrl" | "prices"> & Partial<ModelSettings>;
  /** The harness that ran it; runs before 2026-10-08 have none. */
  harness?: HarnessVersion;
  /** The benchmark version it ran; runs before versioning have none. */
  benchmark?: BenchmarkStamp;
  prompt: string;
  maxTurns: number | null;
  folder: string;
  startedAt: number;
  endedAt: number | null;
  status:
    | "running"
    | "completed"
    | "stopped"
    | "error"
    | "interrupted"
    | "timed-out"
    | "imported";
  turns: number;
  tokens: number;
  /**
   * US dollars for the run's requests: what OpenRouter billed, or elsewhere each request's tokens at
   * the profile's prices (`model.prices`). Absent when neither was available.
   */
  cost?: number;
  /** Set for an episode of a learning series (npm run episodes). */
  series?: RunSeries;
  logCount: number;
  eventCount: number;
  legacySource?: string;
};
/** Episodes of one series play the same save in turn, carrying the agent's playbook forward. */
/** An episode of a learning series; `attempt` counts its runs (an infrastructure failure or a stop is run again). */
export type RunSeries = { id: string; episode: number; episodes: number; attempt?: number };
export type State = {
  /** When the dashboard server process started (ms); runs use the code loaded then. */
  serverStartedAt?: number;
  /** The benchmark version and code this host runs, read when it started. */
  benchmark?: BenchmarkStamp & { commit: string | null; dirty: boolean | null };
  /** Host memory guard for the connected game (see GameDevice.guardState). */
  memoryGuard?: "off" | "starting" | "active" | "failed";
  models: ModelProfile[];
  runs: Run[];
  activeRunId: string | null;
  streamingText: string;
  connected: boolean;
  connecting: boolean;
  deviceError: string | null;
  frame: Omit<Frame, "image"> | null;
  stats: Stats | null;
  running: boolean;
  model: string;
  keyConfigured: boolean;
  modelStatus: string;
  tokens: number;
  turns: number;
  logs: LogEntry[];
  /** The interview after an episode (npm run episodes): the one in progress, or the last one. */
  interview?: {
    runId: string;
    status: "running" | "completed" | "failed" | "stopped" | "skipped";
    answered: number;
    questions: number;
    /** Why it was skipped or ended early. */
    error?: string;
  };
};
/**
 * The input for the game window from one aimed at `frame`'s image: coordinates scaled up when the
 * image was scaled down from the window (Frame.windowWidth/windowHeight), clamped inside it.
 */
export function windowAction<A extends GameAction>(action: A, frame: Pick<Frame, "width" | "height" | "windowWidth" | "windowHeight">): A {
  const ww = frame.windowWidth ?? frame.width, wh = frame.windowHeight ?? frame.height;
  if (ww === frame.width && wh === frame.height) return action;
  const sx = (v: number) => Math.min(ww - 1, Math.round((v * ww) / frame.width));
  const sy = (v: number) => Math.min(wh - 1, Math.round((v * wh) / frame.height));
  const scaled: Record<string, unknown> = { ...action };
  if ("x" in action) { scaled.x = sx(action.x); scaled.y = sy(action.y); }
  if (action.type === "drag") { scaled.endX = sx(action.endX); scaled.endY = sy(action.endY); }
  return scaled as A;
}
/** Refuses input aimed at `frame` once it is `ageSeconds` of play old (frameAgeSeconds), or outside it. */
export function validateFrameAction(
  action: GameAction,
  frame: Frame,
  ageSeconds: number,
) {
  if (ageSeconds > FRAME_MAX_AGE_GAME_SECONDS)
    throw new Error(`Game image expired (older than ${FRAME_MAX_AGE_GAME_SECONDS} game seconds of play): call observe for a fresh screenshot and target its pixels.`);
  if ("x" in action && (action.x >= frame.width || action.y >= frame.height))
    throw new Error("Click outside the game window: x and y must be within the latest screenshot's width and height.");
  if (
    action.type === "drag" &&
    (action.endX >= frame.width || action.endY >= frame.height)
  )
    throw new Error("Drag outside the game window: both ends must be within the latest screenshot's width and height.");
}

/** Map a pointer into the visible image, excluding object-fit letterboxing. */
export function imagePoint(
  frame: { width: number; height: number },
  rect: { left: number; top: number; width: number; height: number },
  client: { clientX: number; clientY: number },
): { x: number; y: number } | null {
  if (
    client.clientX < rect.left ||
    client.clientY < rect.top ||
    client.clientX >= rect.left + rect.width ||
    client.clientY >= rect.top + rect.height
  )
    return null;
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const left = rect.left + (rect.width - frame.width * scale) / 2;
  const top = rect.top + (rect.height - frame.height * scale) / 2;
  const x = Math.floor((client.clientX - left) / scale);
  const y = Math.floor((client.clientY - top) / scale);
  return x >= 0 && y >= 0 && x < frame.width && y < frame.height
    ? { x, y }
    : null;
}

export function runNameFor(model: string, benchmark: string, at = Date.now()) {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return `${model} · ${benchmark} · ${stamp}`;
}
