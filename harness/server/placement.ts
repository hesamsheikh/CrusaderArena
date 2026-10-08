import type { GameAction } from "../shared/protocol.js";
import type { GameDevice } from "./device.js";
import {
  buildingCost,
  confirmPlacement,
  menuClicks,
  placementFeedback,
  placementOf,
  placementStatus,
  selectionConfirmed,
  snapshotOf,
  visiblePlacementFeedback,
  type Snapshot,
} from "./construction-ui.js";

// A terrain click's cost, new structure or rejection text was in the first reader sample after the
// click acknowledgement (+0 to +70 ms at 10 Hz sampling, live 2026-09-28); 120 ms leaves a margin.
export const SETTLE_MS = 120;
// How often tools look for a new reader sample (the reader samples every 100 ms by default).
export const SAMPLE_POLL_SECONDS = 0.025;

export type Ack = { at?: number } | undefined;
export type Observation = Record<string, unknown>;

/**
 * Construction-menu selection and terrain clicks for one targeting image,
 * confirmed from reader samples. Shared by build_structure and the anchor tools.
 */
export class Placer {
  private openCategory?: string;
  private selected?: string;
  /** Whether reader samples confirm selections and placements; see init(). */
  readerReady: boolean;
  constructor(
    private device: GameDevice,
    private io: {
      send: (action: GameAction) => Promise<Ack>;
      pause: (seconds: number) => Promise<unknown>;
      frame: { width: number; height: number };
    },
  ) {
    this.readerReady = device.currentStats().status === "ok";
  }
  /** A live stream has brief unavailable samples: wait up to 1 s for a valid one before deciding. */
  async init() {
    for (let i = 0; !this.readerReady && i < 1 / SAMPLE_POLL_SECONDS; i++) {
      await this.io.pause(SAMPLE_POLL_SECONDS);
      this.readerReady = this.device.currentStats().status === "ok";
    }
    return this;
  }
  ackTime(ack: Ack) {
    return typeof ack?.at === "number" ? ack.at : Date.now();
  }
  /** Wait for a reader sample captured at or after `after` (same Ubuntu clock as the ack) that satisfies `done`. */
  async sampleAfter(after: number, done: (o: Observation) => boolean, seconds: number) {
    for (let i = 0; i < seconds / SAMPLE_POLL_SECONDS; i++) {
      const stats = this.device.currentStats();
      if (stats.status === "ok" && stats.observation && (stats.captured_unix_ms ?? 0) >= after && done(stats.observation))
        return stats.observation as Observation;
      await this.io.pause(SAMPLE_POLL_SECONDS);
    }
    return null;
  }
  /**
   * The settle sample for a terrain click is the first captured SETTLE_MS after the ack, or an
   * earlier post-click one that already confirms the placement (a new structure or the exact cost).
   */
  private async settle(ack: Ack, cost: ReturnType<typeof buildingCost>, before: Snapshot | null) {
    const at = this.ackTime(ack);
    for (let i = 0; i < 2 / SAMPLE_POLL_SECONDS; i++) {
      const stats = this.device.currentStats();
      const captured = stats.captured_unix_ms ?? 0;
      if (stats.status === "ok" && stats.observation && captured >= at &&
          (captured >= at + SETTLE_MS || confirmPlacement("unverified", cost, before, snapshotOf(stats.observation)).status === "placed"))
        return stats.observation as Observation;
      await this.io.pause(SAMPLE_POLL_SECONDS);
    }
    return null;
  }
  /** Select the building; with a reader, confirm placement mode switched to it, retrying once. */
  async select(name: string): Promise<"confirmed" | "unchecked" | "failed"> {
    const [category, button] = menuClicks(this.io.frame, name);
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = this.readerReady ? placementOf(this.device.currentStats().observation) : null;
      await this.io.send(category);
      // A newly opened tray page fades in for ~0.5–0.7 s and ignores building clicks meanwhile (live 2026-09-25).
      const categoryKey = JSON.stringify(category);
      if (categoryKey !== this.openCategory || attempt > 0) await this.io.pause(0.8);
      this.openCategory = categoryKey;
      const ack = await this.io.send(button);
      if (!before) return "unchecked";
      const now = await this.sampleAfter(this.ackTime(ack), (o) => {
        const p = placementOf(o);
        return !!p && selectionConfirmed(before, p, this.selected === name);
      }, 1.5);
      if (now) {
        this.selected = name;
        return "confirmed";
      }
      this.openCategory = undefined;
    }
    this.selected = undefined;
    return "failed";
  }
  /** One terrain click in the active placement mode, classified from feedback events since `eventStart`. */
  async click(name: string, point: { x: number; y: number }, carried: string[], eventStart: number) {
    const cost = buildingCost(name);
    const before = this.readerReady ? snapshotOf(this.device.currentStats().observation) : null;
    const ack = await this.io.send({ type: "click", x: point.x, y: point.y, button: 1 });
    const after = this.readerReady ? await this.settle(ack, cost, before) : await this.io.pause(0.3).then(() => null);
    const feedback = placementFeedback(this.device.events.since(eventStart));
    const visible = visiblePlacementFeedback(this.device.currentStats().observation);
    const outcome = confirmPlacement(placementStatus(feedback, visible, carried), cost, before, snapshotOf(after));
    return { outcome, feedback, visible, after };
  }
}
