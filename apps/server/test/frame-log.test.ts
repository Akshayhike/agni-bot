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

  test("transient replies consume a seq but are not replayed", () => {
    const log = new FrameLog(100);
    log.next({ type: "presence", state: "online" }); // seq 1
    log.next({ type: "thread.history.ok", threadID: "thr_1", messages: [] }, { replay: false }); // seq 2
    log.next({ type: "presence", state: "offline" }); // seq 3

    const resync = log.since(0);
    expect(resync.gap).toBe(false);
    expect(resync.frames.map((frame) => frame.type)).toEqual(["presence", "presence"]);
    expect(resync.frames.map((frame) => frame.seq)).toEqual([1, 3]);
  });

  test("gap detection ignores transient frames when they are all that is held", () => {
    const log = new FrameLog(100);
    log.next({ type: "presence", state: "online" }); // seq 1
    log.next({ type: "thread.list.ok", threads: [] }, { replay: false }); // seq 2
    // A client at seq 1 missed only a reply aimed at someone else: no gap.
    const resync = log.since(1);
    expect(resync.gap).toBe(false);
    expect(resync.frames).toEqual([]);
  });

  test("a client at zero is not gap-flagged when only transient frames came first", () => {
    const log = new FrameLog(100);
    log.next({ type: "hello.ok", v: 1, serverTime: "now", lastSeq: 1 }, { replay: false }); // seq 1
    log.next({ type: "presence", state: "online" }); // seq 2
    const resync = log.since(0);
    expect(resync.gap).toBe(false);
    expect(resync.frames.map((frame) => frame.seq)).toEqual([2]);
  });

  test("adopting a persisted seq means frames before it are gone", () => {
    const log = new FrameLog(100);
    log.adoptSeq(41);
    expect(log.since(40).gap).toBe(true);
    expect(log.since(41).gap).toBe(false);
    expect(log.next({ type: "presence", state: "online" }).seq).toBe(42);
    // Frames from this process are replayable; the adopted span is not.
    const resync = log.since(40);
    expect(resync.gap).toBe(true);
    expect(resync.oldest).toBe(42);
  });
});
