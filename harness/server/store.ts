import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  readdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { ModelProfile, Run, LogEntry } from "../shared/protocol.js";
const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(u.hostname)))
    );
  }, "Use an HTTPS API endpoint (or localhost HTTP), without credentials or query parameters.");
export const profileSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80),
    modelId: z.string().trim().min(1).max(150),
    baseUrl: endpoint,
    apiKey: z.string().trim().max(4096).optional(),
    envKey: z.enum(["MOONSHOT_API_KEY", "OPENROUTER_API_KEY"]).optional(),
  })
  .strict();
type PrivateProfile = Omit<ModelProfile, "keyConfigured"> & {
  apiKey?: string;
  envKey?: string;
};
export class Store {
  private profiles: PrivateProfile[];
  private runs = new Map<string, Run>();
  constructor(
    readonly root: string,
    private env: Record<string, string | undefined> = process.env,
  ) {
    mkdirSync(path.join(root, "runs"), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(root, "config"), { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const config = path.join(root, "config/models.json");
    this.profiles = existsSync(config)
      ? JSON.parse(readFileSync(config, "utf8"))
      : [
          {
            id: randomUUID(),
            name: "Kimi K3",
            modelId: env.MOONSHOT_MODEL || "kimi-k3",
            baseUrl: env.MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1",
            envKey: "MOONSHOT_API_KEY",
          },
        ];
    this.saveConfig();
    for (const dir of readdirSync(path.join(root, "runs"), {
      withFileTypes: true,
    })) {
      if (!dir.isDirectory()) continue;
      const file = path.join(root, "runs", dir.name, "run.json");
      if (!existsSync(file)) continue;
      const run: Run = JSON.parse(readFileSync(file, "utf8"));
      run.folder = dir.name;
      this.runs.set(run.id, run);
      if (run.legacySource && run.status === "imported")
        this.finish(run.id, "imported");
      if (run.status === "running") {
        if (run.progress) {
          run.progress.phase = "interrupted";
          run.progress.stopReason = "host_restart";
        }
        this.finish(run.id, "interrupted");
        this.log(run.id, {
          id: randomUUID(),
          at: Date.now(),
          kind: "system",
          text: "Host restarted before this run finished.",
        });
      }
    }
    this.importLegacy();
  }
  private atomic(file: string, data: unknown) {
    writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", {
      mode: 0o600,
    });
    chmodSync(file + ".tmp", 0o600);
    renameSync(file + ".tmp", file);
  }
  private saveConfig() {
    this.atomic(path.join(this.root, "config/models.json"), this.profiles);
  }
  models(): ModelProfile[] {
    return this.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      modelId: p.modelId,
      baseUrl: p.baseUrl,
      keyConfigured: !!this.key(p.id),
    }));
  }
  model(id: string) {
    const p = this.models().find((p) => p.id === id);
    if (!p) throw new Error("Model not found.");
    return p;
  }
  key(id: string) {
    const p = this.profiles.find((p) => p.id === id);
    return p?.apiKey || (p?.envKey ? this.env[p.envKey] : undefined);
  }
  saveModel(input: unknown) {
    const data = profileSchema.parse(input);
    if (data.envKey) {
      const host = new URL(data.baseUrl).hostname;
      if (
        (data.envKey === "OPENROUTER_API_KEY" && host !== "openrouter.ai") ||
        (data.envKey === "MOONSHOT_API_KEY" && host !== "api.moonshot.ai")
      ) throw new Error("Environment key does not match the model endpoint.");
    }
    if (
      !data.id &&
      this.profiles.some(
        (p) => p.modelId === data.modelId && p.baseUrl === data.baseUrl,
      )
    )
      throw new Error(
        "This model already exists. Open its settings to update the API key.",
      );
    const old = data.id
      ? this.profiles.find((p) => p.id === data.id)
      : undefined;
    if (data.id && !old) throw new Error("Model not found.");
    if (
      old &&
      this.list().some((r) => r.modelId === old.id) &&
      (old.modelId !== data.modelId || old.baseUrl !== data.baseUrl)
    )
      throw new Error(
        "This model has saved runs. Add a new model profile to use a different model ID or endpoint.",
      );
    // A stored credential must never silently follow a changed destination.
    if (old && old.baseUrl !== data.baseUrl && !data.apiKey && !data.envKey)
      throw new Error("Enter an API key when changing the endpoint.");
    const profile: PrivateProfile = {
      id: old?.id || randomUUID(),
      name: data.name,
      modelId: data.modelId,
      baseUrl: data.baseUrl,
      ...(data.apiKey
        ? { apiKey: data.apiKey }
        : data.envKey
          ? { envKey: data.envKey }
          : { apiKey: old?.apiKey, envKey: old?.envKey }),
    };
    if (old) this.profiles[this.profiles.indexOf(old)] = profile;
    else this.profiles.push(profile);
    this.saveConfig();
    return this.model(profile.id);
  }
  redact(value: unknown): any {
    if (typeof value === "string") {
      for (const key of [
        ...this.profiles.map((p) => this.key(p.id)),
        this.env.MOONSHOT_API_KEY,
        this.env.OPENROUTER_API_KEY,
      ].filter(Boolean) as string[])
        value = (value as string).replaceAll(key, "[redacted]");
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          /^(apiKey|api_key|authorization)$/i.test(k)
            ? "[redacted]"
            : this.redact(v),
        ]),
      );
    return value;
  }
  list(): Run[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => ({ ...r }));
  }
  get(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found.");
    return run;
  }
  file(id: string, filename: "run.json" | "logs.jsonl" | "events.jsonl") {
    return path.join(this.root, "runs", this.get(id).folder, filename);
  }
  create(
    name: string,
    modelId: string,
    prompt: string,
    maxTurns: number | null,
    startedAt = Date.now(),
    legacySource?: string,
  ) {
    const id = randomUUID();
    const slug =
      name
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 70) || "run";
    const folder = `${slug}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}`;
    const model = this.model(modelId);
    const run: Run = {
      id,
      name: this.redact(name),
      modelId,
      model: {
        name: model.name,
        modelId: model.modelId,
        baseUrl: model.baseUrl,
      },
      prompt: this.redact(prompt),
      maxTurns,
      folder,
      startedAt,
      endedAt: null,
      status: "running",
      turns: 0,
      tokens: 0,
      logCount: 0,
      eventCount: 0,
      ...(legacySource ? { legacySource } : {}),
    };
    mkdirSync(path.join(this.root, "runs", folder), { mode: 0o700 });
    this.runs.set(id, run);
    this.atomic(this.file(id, "run.json"), run);
    for (const file of ["logs.jsonl", "events.jsonl"] as const)
      writeFileSync(this.file(id, file), "", { mode: 0o600 });
    return run;
  }
  setBenchmark(id: string, benchmarkType: string) {
    this.get(id).benchmarkType = this.redact(benchmarkType);
    this.update(id, {});
  }
  update(
    id: string,
    patch: Partial<Pick<Run, "turns" | "tokens" | "config" | "progress">>,
  ) {
    Object.assign(this.get(id), patch);
    this.atomic(this.file(id, "run.json"), this.get(id));
  }
  finish(id: string, status: Run["status"]) {
    Object.assign(this.get(id), {
      status,
      endedAt:
        status === "imported"
          ? (this.logs(id).at(-1)?.at ?? Date.now())
          : Date.now(),
    });
    this.atomic(this.file(id, "run.json"), this.get(id));
  }
  log(id: string, entry: LogEntry) {
    appendFileSync(
      this.file(id, "logs.jsonl"),
      JSON.stringify(this.redact(entry)) + "\n",
    );
    this.get(id).logCount++;
    this.update(id, {});
  }
  event(id: string, event: unknown) {
    appendFileSync(
      this.file(id, "events.jsonl"),
      JSON.stringify(this.redact({ at: Date.now(), event })) + "\n",
    );
    this.get(id).eventCount++;
  }
  logs(id: string): LogEntry[] {
    return readFileSync(this.file(id, "logs.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => this.redact(JSON.parse(line)));
  }
  private importLegacy() {
    for (const filename of readdirSync(this.root).filter((f) =>
      f.endsWith(".jsonl"),
    )) {
      const entries: LogEntry[] = readFileSync(
        path.join(this.root, filename),
        "utf8",
      )
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      let run: Run | undefined;
      let skip = false;
      let model = this.models()[0];
      for (const entry of entries) {
        if (
          entry.kind === "system" &&
          entry.text.startsWith("Model connected: ")
        ) {
          const modelId = entry.text.slice(17).split(".")[0];
          model =
            this.models().find((p) => p.modelId === modelId) ||
            this.saveModel({
              name: modelId,
              modelId,
              baseUrl: "https://api.moonshot.ai/v1",
            });
        }
        if (entry.kind === "user") {
          if (run) this.finish(run.id, "imported");
          const source = createHash("sha256")
            .update(filename + entry.id)
            .digest("hex");
          skip = this.list().some((r) => r.legacySource === source);
          run = skip
            ? undefined
            : this.create(
                `Previous run ${new Date(entry.at).toISOString().slice(0, 19).replace("T", " ")}`,
                model.id,
                entry.text,
                null,
                entry.at,
                source,
              );
        }
        if (run && !skip) {
          this.log(run.id, entry);
          if (entry.text.startsWith("Run finished.")) {
            this.finish(run.id, "imported");
            run = undefined;
          }
        }
      }
      if (run) this.finish(run.id, "imported");
    }
  }
}
