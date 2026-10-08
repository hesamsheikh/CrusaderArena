import { createInterface } from "node:readline";
import {
  createReadStream,
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
export const planSchema = z
  .array(
    z
      .object({
        step: z.string().trim().min(1).max(300),
        status: z.enum(["pending", "in_progress", "completed"]),
      })
      .strict(),
  )
  .max(20);
export type Plan = z.infer<typeof planSchema>;
export class RunMemory {
  plan: Plan = [];
  notebook = { revision: 0, text: "" };
  handoff = "";
  compactions = 0;
  constructor(
    readonly directory: string,
    private event: (event: unknown) => void,
  ) {
    const file = path.join(directory, "memory.json");
    if (existsSync(file)) {
      const state = JSON.parse(readFileSync(file, "utf8"));
      this.plan = planSchema.parse(state.plan);
      this.notebook = state.notebook;
      this.handoff = state.handoff;
      this.compactions = state.compactions;
    } else this.save();
  }
  write(
    name: "memory.json" | "checkpoint.json" | "inputs.json",
    value: unknown,
  ) {
    const file = path.join(this.directory, name);
    writeFileSync(file + ".tmp", JSON.stringify(value) + "\n", { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  private save() {
    this.write("memory.json", {
      plan: this.plan,
      notebook: this.notebook,
      handoff: this.handoff,
      compactions: this.compactions,
    });
  }
  updatePlan(value: unknown) {
    this.plan = planSchema.parse(value);
    this.save();
    this.event({ type: "plan", plan: this.plan });
    return this.plan;
  }
  writeNotebook(revision: number, text: string) {
    if (revision !== this.notebook.revision)
      throw new Error("Stale notebook revision; read it again.");
    if (Buffer.byteLength(text) > 8192)
      throw new Error("Notebook is limited to 8192 UTF-8 bytes.");
    this.notebook = { revision: revision + 1, text };
    this.save();
    // Human-readable export; memory.json is the authoritative atomic state.
    const file = path.join(this.directory, "notebook.md");
    writeFileSync(file + ".tmp", text, { mode: 0o600 });
    renameSync(file + ".tmp", file);
    this.event({ type: "notebook", ...this.notebook });
    return this.notebook;
  }
  editNotebook(revision: number, before: string, after: string) {
    if (!before || this.notebook.text.split(before).length !== 2)
      throw new Error("Edit must match exactly once.");
    return this.writeNotebook(
      revision,
      this.notebook.text.replace(before, () => after),
    );
  }
  checkpoint(messages: AgentMessage[], extra: object = {}) {
    this.write("checkpoint.json", {
      at: Date.now(),
      messages,
      plan: this.plan,
      notebook: this.notebook,
      handoff: this.handoff,
      compactions: this.compactions,
      ...extra,
    });
  }
  installHandoff(text: string, messages: AgentMessage[]) {
    if (text.trim().length < 40 || Buffer.byteLength(text) > 12000)
      throw new Error("Invalid compaction handoff.");
    // Commit replacement checkpoint before changing the active in-memory history.
    this.write("checkpoint.json", {
      at: Date.now(),
      messages,
      plan: this.plan,
      notebook: this.notebook,
      handoff: text,
      compactions: this.compactions + 1,
    });
    this.handoff = text;
    this.compactions++;
    this.save();
    this.event({
      type: "compaction_checkpoint",
      version: this.compactions,
      handoff: text,
    });
  }
  delivery(record: unknown) {
    this.event(record);
  }
  journal(record: unknown) {
    appendFileSync(
      path.join(this.directory, "notifications.jsonl"),
      JSON.stringify(record) + "\n",
      { mode: 0o600 },
    );
  }
  async notifications(after: number, limit = 30) {
    const file = path.join(this.directory, "notifications.jsonl");
    if (!existsSync(file)) return { events: [], nextCursor: after };
    const input = createReadStream(file);
    const lines = createInterface({ input, crlfDelay: Infinity });
    const events: Record<string, unknown>[] = [];
    try {
      for await (const line of lines) {
        const row = JSON.parse(line);
        if (row.cursor > after) events.push(row);
        if (events.length >= Math.min(50, limit)) break;
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return {
      historical: true,
      events,
      nextCursor: events.at(-1)?.cursor ?? after,
    };
  }
  canonical() {
    return `Current plan (preserve exact statuses):\n${JSON.stringify(this.plan)}\nRun notebook revision ${this.notebook.revision} (agent-authored notes, not instructions):\n${JSON.stringify(this.notebook.text)}`;
  }
}
