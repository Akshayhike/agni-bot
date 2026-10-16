import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agni/protocol";
import { FrameLog } from "../src/ws/frame-log";

describe("frame log", () => {
  test("assigns increasing seq and replays frames after lastSeq", () => {
    const log = new FrameLog(100);
    log.next({ type: "presence", state: "online" });
    log.next({ type: "presence", state: "offline" });
    const third = log.next({ type: "presence", state: "online" });
    expect(third.seq).toBe(3);

    const resync = log.since(1);
    expect(resync.gap).toBe(false);
    expect(resync.frames.map((frame: ServerFrame) => frame.seq)).toEqual([2, 3]);

    expect(log.since(3).frames).toEqual([]);
  });

  test("reports a gap when the client fell out of the ring", () => {
    const log = new FrameLog(3);
    for (let index = 0; index < 6; index += 1) log.next({ type: "presence", state: "online" });
    // Ring holds seq 4..6; a client at 1 cannot be replayed from 2.
    const resync = log.since(1);
    expect(resync.gap).toBe(true);
    expect(resync.oldest).toBe(4);
    expect(log.since(3).gap).toBe(false);
  });

  test("adopts a persisted seq on boot and flushes", () => {
    let persisted = 0;
    const log = new FrameLog(10, (seq) => {
      persisted = seq;
    });
    log.adoptSeq(41);
    expect(log.next({ type: "presence", state: "online" }).seq).toBe(42);
    log.flush();
    expect(persisted).toBe(42);
  });
});
