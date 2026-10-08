/** Reader availability rows: kept for the run's journal, never shown to the agent. */
const isReaderRow = (data: Record<string, unknown>) =>
  data.kind === "reader_gap" || data.kind === "reader_boundary";
/** An unavailable stretch this long can hide a short-lived message from polling. */
const OFFLINE_REPORT_MS = 2000;
const OFFLINE_RETENTION_MS = 600_000;

/** Retain reader events between model observations without treating old stats as live. */
export class GameEvents {
  private next = 1;
  private listeners = new Set<(row: Record<string, unknown>) => void>();
  subscribe(listener: (row: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private rows: {
    cursor: number;
    receivedAt: number;
    data: Record<string, unknown>;
  }[] = [];
  private identity = "";
  private status = "";
  private seen = new Set<string>();
  /** Cursors of messages evicted before every consumer read them (bounded). */
  private evictedMessages: number[] = [];
  /** Stretches without a valid reader sample; `to` is null while one lasts. */
  private offline: { from: number; to: number | null }[] = [];
  constructor(
    private capacity = 128,
    private maxAgeMs = 120_000,
  ) {}
  cursor() {
    return this.next - 1;
  }
  private append(data: Record<string, unknown>, now: number) {
    const row = { cursor: this.next++, receivedAt: now, data };
    this.rows.push(row);
    for (const listener of this.listeners)
      listener({ ...data, cursor: row.cursor, receivedAt: now });
    this.trim(now);
  }
  private trim(now: number) {
    while (this.rows.length && now - this.rows[0].receivedAt > this.maxAgeMs)
      this.evict(0);
    // A run produces hundreds of reader gap/boundary rows (about 5% of samples fail the reader's
    // double-read check), so a full buffer drops those before any game message.
    while (this.rows.length > this.capacity) {
      const reader = this.rows.findIndex((row) => isReaderRow(row.data));
      this.evict(reader >= 0 ? reader : 0);
    }
    while (
      this.offline.length &&
      this.offline[0].to !== null &&
      now - this.offline[0].to > OFFLINE_RETENTION_MS
    )
      this.offline.shift();
  }
  private evict(index: number) {
    const [row] = this.rows.splice(index, 1);
    if (typeof row.data.id === "string") this.seen.delete(row.data.id);
    if (!isReaderRow(row.data)) {
      this.evictedMessages.push(row.cursor);
      if (this.evictedMessages.length > 1024) this.evictedMessages.shift();
    }
  }
  private goOffline(now: number) {
    const last = this.offline.at(-1);
    if (!last || last.to !== null) this.offline.push({ from: now, to: null });
  }
  private goOnline(now: number) {
    const last = this.offline.at(-1);
    if (last && last.to === null) last.to = now;
  }
  ingest(record: any, now = Date.now()) {
    if (!record || typeof record.status !== "string") return;
    const identity = `${record.session}:${record.generation}`;
    if (record.status !== "ok") {
      if (this.status !== record.status)
        this.append({ kind: "reader_gap", status: record.status }, now);
      this.goOffline(now);
      this.status = record.status;
      return;
    }
    this.goOnline(now);
    if (identity !== this.identity || this.status !== "ok") {
      this.append(
        {
          kind: "reader_boundary",
          session: record.session,
          generation: record.generation,
        },
        now,
      );
      this.identity = identity;
    }
    this.status = "ok";
    this.trim(now);
    for (const event of Array.isArray(record.events) ? record.events : []) {
      if (
        event?.kind !== "visible_message_observed" ||
        typeof event.id !== "string" ||
        typeof event.channel !== "string" ||
        typeof event.text !== "string" ||
        this.seen.has(event.id)
      )
        continue;
      this.seen.add(event.id);
      this.append(
        {
          kind: event.kind,
          id: event.id,
          channel: event.channel,
          text: event.text,
          capturedAt: record.captured_unix_ms,
          session: record.session,
          generation: record.generation,
          provenance: "game_ui_text",
        },
        now,
      );
    }
  }
  disconnect(now = Date.now()) {
    this.status = "disconnected";
    this.append({ kind: "reader_gap", status: "disconnected" }, now);
    this.goOffline(now);
  }
  /**
   * What the agent sees: each distinct game message after the cursor once, at its newest receipt
   * (the reader reports a message still on screen again after every brief gap), messages evicted
   * before this read, and how long the reader was down in stretches long enough to miss one.
   */
  messagesSince(cursor: number, sinceMs: number, now = Date.now()) {
    this.trim(now);
    const newest = new Map<string, number>();
    for (const row of this.rows)
      if (
        row.cursor > cursor &&
        row.data.kind === "visible_message_observed" &&
        typeof row.data.text === "string"
      ) {
        const text = row.data.text.trim();
        newest.delete(text);
        newest.set(text, row.receivedAt);
      }
    const dropped = this.evictedMessages.filter((c) => c > cursor).length;
    const unavailableMs = this.offline.reduce((sum, { from, to }) => {
      const end = to ?? now;
      return end - from < OFFLINE_REPORT_MS
        ? sum
        : sum + Math.max(0, Math.min(end, now) - Math.max(from, sinceMs));
    }, 0);
    return {
      cursor: this.cursor(),
      messages: [...newest].map(([text, at]) => ({
        text,
        seconds_ago: Math.round(Math.max(0, now - at) / 1000),
      })),
      dropped,
      unavailableSeconds:
        unavailableMs >= OFFLINE_REPORT_MS ? Math.round(unavailableMs / 1000) : 0,
    };
  }
  since(cursor: number, now = Date.now()) {
    this.trim(now);
    // Rows can leave from the middle (reader rows go first), so count what is missing after the cursor.
    const kept = this.rows.filter((row) => row.cursor > cursor).length;
    return {
      cursor: this.cursor(),
      dropped: Math.max(0, this.cursor() - cursor - kept),
      coverage:
        "reader-observed UI events only; polling can miss messages; historical events are not current state",
      events: this.rows
        .filter((row) => row.cursor > cursor)
        .map(
          (
            row,
          ): Record<string, unknown> & {
            receivedAt: number;
            ageMs: number;
          } => ({
            ...row.data,
            receivedAt: row.receivedAt,
            ageMs: Math.max(0, now - row.receivedAt),
          }),
        ),
    };
  }
}
