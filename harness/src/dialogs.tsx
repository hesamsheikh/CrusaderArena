import { useState, type ChangeEvent, type ReactNode } from "react";
import { Play, Settings2, X } from "lucide-react";
import type { ModelProfile, ReasoningLevel, TokenPrices, TokenRates } from "../shared/protocol";
import {
  costProblem,
  isMoonshot,
  isOpenRouter,
  modelSettings,
  reasoningLevels,
  runNameFor,
} from "../shared/protocol";
import { request } from "./api";

const rateFields = [
  ["input", "Input"],
  ["output", "Output"],
  ["cacheRead", "Cache read"],
  ["cacheWrite", "Cache write"],
] as const;
type RateText = Record<keyof TokenRates, string>;
const rateText = (rates?: TokenRates): RateText => ({
  input: rates ? String(rates.input) : "",
  output: rates ? String(rates.output) : "",
  cacheRead: rates ? String(rates.cacheRead) : "",
  cacheWrite: rates ? String(rates.cacheWrite) : "",
});
/** The four rates as numbers; null when all are blank. */
function ratesOf(text: RateText): TokenRates | null {
  const given = rateFields.filter(([key]) => text[key].trim());
  if (!given.length) return null;
  if (given.length < rateFields.length) throw new Error("Enter all four prices, or leave them all blank.");
  return Object.fromEntries(rateFields.map(([key]) => [key, Number(text[key])])) as TokenRates;
}
function RateFields({ legend, value, change }: { legend: string; value: RateText; change: (value: RateText) => void }) {
  return (
    <fieldset className="budgets prices">
      <legend>{legend}</legend>
      {rateFields.map(([key, label]) => (
        <label key={key} className="field">
          <span>{label}</span>
          <input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={value[key]}
            onChange={(e) => change({ ...value, [key]: e.target.value })}
          />
        </label>
      ))}
    </fieldset>
  );
}

function Dialog({
  id,
  title,
  lede,
  close,
  children,
  wide = false,
}: {
  id: string;
  title: string;
  lede?: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header className="modal-head">
          <div>
            <h2 id={id}>{title}</h2>
            {lede && <p>{lede}</p>}
          </div>
          <button className="icon-button" aria-label="Close" onClick={close}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function ModelForm({
  model,
  close,
  saved,
}: {
  model?: ModelProfile;
  close: () => void;
  saved: (model: ModelProfile) => void;
}) {
  const [name, setName] = useState(model?.name || "");
  const [modelId, setModelId] = useState(model?.modelId || "");
  const [baseUrl, setBaseUrl] = useState(
    model?.baseUrl || "https://api.moonshot.ai/v1",
  );
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState("");
  const initial = modelSettings({ ...model, baseUrl: model?.baseUrl || baseUrl });
  const [reasoning, setReasoning] = useState<ReasoningLevel>(initial.reasoning);
  const [maxTokens, setMaxTokens] = useState(initial.maxTokens);
  const [providers, setProviders] = useState(initial.providers.join(", "));
  const [allowFallbacks, setAllowFallbacks] = useState(initial.allowFallbacks);
  const [rates, setRates] = useState(rateText(model?.prices));
  const [longPrompt, setLongPrompt] = useState(!!model?.prices?.longPrompt);
  const [longRates, setLongRates] = useState(rateText(model?.prices?.longPrompt));
  const [above, setAbove] = useState(String(model?.prices?.longPrompt?.above ?? 100000));
  const prices = (): TokenPrices | null => {
    const base = ratesOf(rates);
    const long = longPrompt ? ratesOf(longRates) : null;
    if (longPrompt && !long) throw new Error("Enter the long-prompt prices, or turn them off.");
    if (long && !base) throw new Error("Enter the standard prices as well.");
    return base && (long ? { ...base, longPrompt: { above: Number(above), ...long } } : base);
  };
  const endpoint = (() => {
    try {
      return { openRouter: isOpenRouter(baseUrl), moonshot: isMoonshot(baseUrl) };
    } catch {
      return { openRouter: false, moonshot: false };
    }
  })();
  // Moonshot takes no reasoning setting; "off" exists only on OpenRouter.
  const levels = reasoningLevels.filter((level) =>
    endpoint.moonshot ? level === "default" : level !== "off" || endpoint.openRouter,
  );
  const effectiveReasoning = levels.includes(reasoning) ? reasoning : "default";
  const providerList = providers.split(",").map((p) => p.trim()).filter(Boolean);
  return (
    <Dialog
      id="model-title"
      title={model ? "Model settings" : "Add a model"}
      lede="Moonshot or any OpenAI-compatible API with image and tool support."
      close={close}
    >
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError("");
          try {
            const m = await request<ModelProfile>("models", {
              id: model?.id,
              name,
              modelId,
              baseUrl,
              apiKey: key,
              reasoning: effectiveReasoning,
              maxTokens,
              providers: endpoint.openRouter ? providerList : [],
              allowFallbacks,
              // OpenRouter reports what it bills; other endpoints' requests are priced with these.
              prices: endpoint.openRouter ? null : prices(),
            });
            setKey("");
            saved(m);
            close();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="field-row">
          <label className="field">
            <span>Display name</span>
            <input
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kimi K3"
            />
          </label>
          <label className="field">
            <span>Model ID</span>
            <input
              required
              maxLength={150}
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder="kimi-k3"
            />
          </label>
        </div>
        <label className="field">
          <span>API endpoint</span>
          <input
            type="url"
            required
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label className="field">
          <span>API key</span>
          <input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              model?.keyConfigured
                ? "Saved · leave blank to keep"
                : "Enter API key"
            }
          />
          <small>
            Stored privately on this host. Your existing .env key remains
            available for Kimi K3.
          </small>
        </label>
        <div className="field-row">
          <label className="field">
            <span>Reasoning</span>
            <select
              value={effectiveReasoning}
              disabled={levels.length === 1}
              onChange={(e) => setReasoning(e.target.value as ReasoningLevel)}
            >
              {levels.map((level) => (
                <option key={level} value={level}>
                  {level === "default" ? "Endpoint default" : level[0].toUpperCase() + level.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Max output tokens</span>
            <input
              type="number"
              required
              min={1024}
              max={131072}
              step={1024}
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
            />
          </label>
        </div>
        {endpoint.openRouter && (
          <>
            <label className="field">
              <span>OpenRouter providers</span>
              <input
                value={providers}
                onChange={(e) => setProviders(e.target.value)}
                placeholder="z-ai, deepinfra/fp8"
              />
              <small>
                Provider slugs in order of preference. Blank lets OpenRouter choose
                per request, which can change the serving deployment between turns.
              </small>
            </label>
            {providerList.length > 0 && (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={allowFallbacks}
                  onChange={() => setAllowFallbacks(!allowFallbacks)}
                />
                <span aria-hidden />
                Allow other providers when these are unavailable
              </label>
            )}
          </>
        )}
        {!endpoint.openRouter && (
          <>
            <RateFields legend="Prices (US$ per million tokens)" value={rates} change={setRates} />
            <label className="switch">
              <input
                type="checkbox"
                checked={longPrompt}
                onChange={() => setLongPrompt(!longPrompt)}
              />
              <span aria-hidden />
              Higher prices for long prompts
            </label>
            {longPrompt && (
              <>
                <label className="field">
                  <span>Long prompts are over</span>
                  <div className="input-unit">
                    <input
                      type="number"
                      required
                      min={1}
                      step={1000}
                      value={above}
                      onChange={(e) => setAbove(e.target.value)}
                    />
                    <em>tokens</em>
                  </div>
                </label>
                <RateFields
                  legend="Long-prompt prices (US$ per million tokens)"
                  value={longRates}
                  change={setLongRates}
                />
              </>
            )}
            <p className="muted small">
              This endpoint does not report what it bills, so each request is priced
              from its tokens with the provider's list prices. Cache write is the
              5-minute rate. A prompt counts input, cache reads and cache writes. Runs
              need prices to start.
            </p>
          </>
        )}
        <p className="muted small">
          Reasoning and output limit apply to every request in a run, and each run
          records the settings it used.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {result && (
          <p role="status" className="form-ok">
            {result}
          </p>
        )}
        <footer className="modal-foot">
          {model?.keyConfigured && (
            <button
              type="button"
              className="button ghost"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setError("");
                try {
                  await request("model/test", { modelId: model.id });
                  setResult("Connection ready.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              Test saved model
            </button>
          )}
          <button className="button primary" disabled={saving}>
            {saving ? "Saving…" : "Save model"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export type RunDraft = {
  benchmarkType: string;
  prompt: string;
  gameMinutes: number;
  wallLimitMinutes: number;
  waitSeconds: number;
  minTurnSeconds: number;
  contextBudget: number;
  recordVideo: boolean;
  modelId: string;
};

export function NewRunDialog({
  draft,
  update,
  models,
  close,
  start,
  configure,
  blocker,
  busy,
  now,
}: {
  draft: RunDraft;
  update: (patch: Partial<RunDraft>) => void;
  models: ModelProfile[];
  close: () => void;
  start: () => void;
  configure: (model?: ModelProfile) => void;
  /** Why the run cannot start yet, or null when it can. */
  blocker: string | null;
  busy: boolean;
  now: number;
}) {
  const model = models.find((m) => m.id === draft.modelId) || models[0];
  const number = (key: keyof RunDraft) => (e: ChangeEvent<HTMLInputElement>) =>
    update({ [key]: Number(e.target.value) });
  return (
    <Dialog
      id="run-title"
      title="New run"
      lede="The agent plays the connected game window until a budget runs out."
      close={close}
      wide
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div className="field-row">
          <label className="field">
            <span>Benchmark</span>
            <input
              required
              autoFocus
              maxLength={60}
              placeholder="e.g. Economy, Combat, Custom"
              value={draft.benchmarkType}
              onChange={(e) => update({ benchmarkType: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Model</span>
            <div className="select-with-action">
              <select
                value={model?.id || ""}
                onChange={(e) => update({ modelId: e.target.value })}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="icon-button"
                aria-label="Model settings"
                title="Model settings"
                onClick={() => configure(model)}
              >
                <Settings2 size={16} />
              </button>
            </div>
            <small className={model?.keyConfigured && !costProblem(model) ? "" : "warn-text"}>
              {model
                ? `${model.modelId} · ${model.keyConfigured ? "API key saved" : "API key needed"}${costProblem(model) ? " · prices needed" : ""}`
                : "Add a model to begin"}
              {" · "}
              <button
                type="button"
                className="link"
                onClick={() => configure()}
              >
                Add model
              </button>
            </small>
          </label>
        </div>
        <label className="field">
          <span>Instruction</span>
          <textarea
            required
            rows={7}
            value={draft.prompt}
            onChange={(e) => update({ prompt: e.target.value })}
            placeholder="What should the agent do?"
          />
        </label>
        <fieldset className="budgets">
          <legend>Budgets</legend>
          <label className="field">
            <span>Game time</span>
            <div className="input-unit">
              <input
                type="number"
                min={0.5}
                max={120}
                step={0.5}
                value={draft.gameMinutes}
                onChange={number("gameMinutes")}
              />
              <em>game min</em>
            </div>
          </label>
          <label className="field">
            <span>Real-time limit</span>
            <div className="input-unit">
              <input
                type="number"
                min={1}
                max={720}
                value={draft.wallLimitMinutes}
                onChange={number("wallLimitMinutes")}
              />
              <em>min</em>
            </div>
          </label>
          <label className="field">
            <span>Context budget</span>
            <div className="input-unit">
              <input
                type="number"
                min={32000}
                max={200000}
                step={1000}
                value={draft.contextBudget}
                onChange={number("contextBudget")}
              />
              <em>tokens</em>
            </div>
          </label>
          <label className="field">
            <span>Screenshot wait</span>
            <div className="input-unit">
              <input
                type="number"
                min={0}
                max={300}
                value={draft.waitSeconds}
                onChange={number("waitSeconds")}
              />
              <em>game s</em>
            </div>
          </label>
          <label className="field">
            <span>Minimum turn</span>
            <div className="input-unit">
              <input
                type="number"
                min={0}
                max={60}
                value={draft.minTurnSeconds}
                onChange={number("minTurnSeconds")}
              />
              <em>game s</em>
            </div>
          </label>
        </fieldset>
        <label className="switch record-video">
          <input
            type="checkbox"
            checked={draft.recordVideo}
            onChange={(e) => update({ recordVideo: e.target.checked })}
          />
          <span aria-hidden />
          Record video
          <small>
            Screen-records the game with the agent's reasoning and tools. Idle
            play is fast-forwarded and thinking pauses become short reasoning
            cards. Saved as video.mp4 in the run folder.
          </small>
        </label>
        <footer className="modal-foot">
          <p className="run-name" title="Generated when the run starts">
            {blocker ??
              runNameFor(
                model?.name || "Model",
                draft.benchmarkType || "Custom",
                now,
              )}
          </p>
          <button className="button primary" disabled={!!blocker || busy}>
            <Play size={14} />
            Start run
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
