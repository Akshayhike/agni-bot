/**
 * Sequence-numbered, replayable log of outbound frames. `resync` replays
 * frames newer than the client's lastSeq; a client that lagged past the
 * ring's capacity gets `resync_gap` and reloads state instead (messages are
 * already on disk, so nothing is lost).
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

export class FrameLog {
  private frames: ServerFrame[] = [];
  private lastSeqValue = 0;

  constructor(
    private readonly capacity: number,
    private readonly persist?: (seq: number) => void,
  ) {}

  /** Seed the counter from the last persisted value at boot. */
  adoptSeq(seq: number): void {
    if (Number.isFinite(seq) && seq > this.lastSeqValue) this.lastSeqValue = seq;
  }

  next(body: ServerFrameBody): ServerFrame {
    const frame = { ...body, seq: ++this.lastSeqValue } as ServerFrame;
    this.frames.push(frame);
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity);
    if (this.persist && this.lastSeqValue % 32 === 0) this.persist(this.lastSeqValue);
    return frame;
  }

  since(lastSeq: number): ResyncResult {
    const oldest = this.frames[0]?.seq ?? this.lastSeqValue + 1;
    const gap = lastSeq < oldest - 1;
    return {
      frames: gap ? [] : this.frames.filter((frame) => frame.seq > lastSeq),
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
