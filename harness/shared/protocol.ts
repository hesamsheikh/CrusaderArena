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
  width: number;
  height: number;
  windowId: number;
  pid: number;
  capturedAt: number;
  receivedAt: number;
  scope: "game-window";
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
    /** Mono GC heap totals (memory diagnostics); null when unavailable. */
    managed_heap?: { heap_bytes: number; used_bytes: number; collections?: number; finalizers_pending?: boolean } | null;
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
      efficiency: number;
      upcoming_popularity: number;
      popularity_factors: Record<string, number>;
    } | null;
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
    [key: string]: unknown;
  } | null;
};
/**
 * Reasoning effort sent with every request. "default" sends no setting and leaves it to the
 * endpoint; "off" (OpenRouter only) asks for none.
 */
export const reasoningLevels = ["default", "off", "minimal", "low", "medium", "high"] as const;
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
export type ModelProfile = {
  id: string;
  name: string;
  modelId: string;
  baseUrl: string;
  keyConfigured: boolean;
} & Partial<ModelSettings>;
export const isOpenRouter = (baseUrl: string) => new URL(baseUrl).hostname === "openrouter.ai";
export const isMoonshot = (baseUrl: string) => /^api\.moonshot\./.test(new URL(baseUrl).hostname);
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
  if (isMoonshot(baseUrl) && settings.reasoning !== "default")
    return "Moonshot's endpoint takes no reasoning setting through this harness; choose Default.";
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
 * Reading-only replies keep the game paused, so they cost no game time. From this many in a row,
 * the host lets game time pass after each one, so reading stops being free (it used to end the run).
 */
export const READING_ONLY_LIMIT = 12;
/** Replies in a row without any tool call that end the run: the model has stopped playing. */
export const EMPTY_REPLY_LIMIT = 4;
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
    contextBudget: z.number().int().min(32000).max(200000).default(120000),
    imageTokenEstimate: z.number().int().min(1024).max(16384).default(4096),
    /** Record the game window while the agent acts (not while it thinks) for tools/video/render-video.py. */
    recordVideo: z.boolean().default(false),
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
  stopReason?: string;
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
  };
  finalPause?: string;
  /** Memory-guard extremes on the game host during the run (MiB). */
  memory?: { samples: number; maxGameRssMiB: number; maxGameSwapMiB: number; minAvailableMiB: number };
  /** Frames saved under recording/ when the run config asked for a video. */
  recording?: { frames: number; bytes: number; lastError?: string };
};
/** Enough to tell whether two runs used the same harness, prompt and tools. */
export type HarnessVersion = {
  /** Git commit the host process started from; null when git was unavailable. */
  commit: string | null;
  /** Whether the run-relevant files (harness, prompt, src, tools, package files) differed from it. */
  dirty: boolean | null;
  /** SHA-256 of those differences (tracked diff plus new files), when dirty. */
  diffSha256?: string;
  systemPromptSha256: string;
  toolsSha256: string;
};
export type Run = {
  config?: RunConfig;
  progress?: RuntimeProgress;
  benchmarkType?: string;
  id: string;
  name: string;
  modelId: string;
  /** The profile when the run started; runs before 2026-10-08 have no settings recorded. */
  model: Pick<ModelProfile, "name" | "modelId" | "baseUrl"> & Partial<ModelSettings>;
  /** The harness that ran it; runs before 2026-10-08 have none. */
  harness?: HarnessVersion;
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
  /** US dollars billed for the run's requests, from providers that report it (OpenRouter). */
  cost?: number;
  /** Set for an episode of a learning series (npm run episodes). */
  series?: RunSeries;
  logCount: number;
  eventCount: number;
  legacySource?: string;
};
/** Episodes of one series play the same save in turn, carrying the agent's playbook forward. */
export type RunSeries = { id: string; episode: number; episodes: number };
export type State = {
  /** When the dashboard server process started (ms); runs use the code loaded then. */
  serverStartedAt?: number;
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
};
export function validateFrameAction(
  action: GameAction,
  frame: Frame,
  now = Date.now(),
) {
  if (now - frame.receivedAt > 30000)
    throw new Error("Game image expired. Refresh before acting.");
  if ("x" in action && (action.x >= frame.width || action.y >= frame.height))
    throw new Error("Click outside the game window.");
  if (
    action.type === "drag" &&
    (action.endX >= frame.width || action.endY >= frame.height)
  )
    throw new Error("Drag outside the game window.");
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
