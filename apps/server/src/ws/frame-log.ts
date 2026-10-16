/**
 * Sequence-numbered, replayable log of outbound frames. `resync` replays
 * frames newer than the client's lastSeq; a client that lagged past the
 * ring's capacity gets `resync_gap` and reloads state instead (messages are
 * already on disk, so nothing is lost).
 *
 * Frames marked `replay: false` are answers to one connection (e.g. `hello.ok`,
 * `thread.history.ok`). They consume a seq like everything else, but they are
 * not part of the shared stream: a client never "missed" a reply addressed to
 * someone else, and a gap is only reported when a *shared* frame is no longer
 * available.
 *
 * The counter is persisted (throttled) so ids stay unique across restarts;
 * after a crash the client may see a gap and reload — acceptable at v0.
 */
import type { ServerFrame, ServerFrameBody } from "@agni/protocol";

export interface ResyncResult {
  frames: ServerFrame[];
  gap: boolean;
  oldest: number;
}

interface LoggedFrame {
  frame: ServerFrame;
  replay: boolean;
}

export class FrameLog {
  private entries: LoggedFrame[] = [];
  private lastSeqValue = 0;
  /**
   * Highest seq of a shared frame this process can no longer produce: evicted
   * from the ring, or adopted from a previous process at boot. A client behind
   * it lost shared frames for good.
   */
  private lastEvictedShared: number | null = null;

  constructor(
    private readonly capacity: number,
    private readonly persist?: (seq: number) => void,
  ) {}

  /** Seed the counter from the last persisted value at boot. */
  adoptSeq(seq: number): void {
    if (Number.isFinite(seq) && seq > this.lastSeqValue) {
      this.lastSeqValue = seq;
      // Nothing before the adopted counter is retained, and the ring is empty.
      if (this.entries.length === 0) this.lastEvictedShared = seq;
    }
  }

  next(body: ServerFrameBody, options: { replay?: boolean } = {}): ServerFrame {
    const frame = { ...body, seq: ++this.lastSeqValue } as ServerFrame;
    this.entries.push({ frame, replay: options.replay ?? true });
    while (this.entries.length > this.capacity) {
      const evicted = this.entries.shift();
      if (evicted?.replay) this.lastEvictedShared = Math.max(this.lastEvictedShared ?? 0, evicted.frame.seq);
    }
    if (this.persist && this.lastSeqValue % 32 === 0) this.persist(this.lastSeqValue);
    return frame;
  }

  since(lastSeq: number): ResyncResult {
    const shared = this.entries.filter((entry) => entry.replay).map((entry) => entry.frame);
    const oldest =
      shared[0]?.seq ?? (this.lastEvictedShared !== null ? this.lastEvictedShared + 1 : this.lastSeqValue + 1);
    const gap = this.lastEvictedShared !== null && lastSeq < this.lastEvictedShared;
    return {
      frames: gap ? [] : shared.filter((frame) => frame.seq > lastSeq),
      gap,
      oldest,
    };
  }

  flush(): void {
    if (this.persist) this.persist(this.lastSeqValue);
  }

  get seq(): number {
    return this.lastSeqValue;
  }
}
