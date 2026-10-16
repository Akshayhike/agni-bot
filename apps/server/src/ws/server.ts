/**
 * HTTP + WebSocket entry. Binds to AGNI_HOST only (loopback in dev, the
 * Tailscale interface on bb-1) — nothing listens on the public internet.
 *
 * Routes: GET /health (JSON), GET /ws (WebSocket upgrade).
 */
import type { Database } from "bun:sqlite";
import { PROTOCOL_VERSION, encodeFrame, type ServerFrame, type ServerFrameBody } from "@agni/protocol";
import type { Config } from "../config";
import { readMeta, writeMeta } from "../db";
import { log } from "../log";
import type { Router } from "../models/router";
import { dayTotals } from "../stores/usage";
import { dispatch, newSession, type Session } from "./dispatch";
import { FrameLog } from "./frame-log";

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  stop(): void;
}

export function startServer(config: Config, db: Database, router: Router, startedAt = Date.now()): RunningServer {
  const frameLog = new FrameLog(config.frameLogCapacity, (seq) => writeMeta(db, "seq", String(seq)));
  frameLog.adoptSeq(Number.parseInt(readMeta(db, "seq") ?? "0", 10) || 0);

  const sessions = new Map<Bun.ServerWebSocket<Session>, Session>();

  const emit = (body: ServerFrameBody): ServerFrame => {
    const frame = frameLog.next(body);
    for (const [socket, session] of sessions) {
      if (session.authed) socket.send(encodeFrame(frame));
    }
    return frame;
  };

  const server = Bun.serve<Session>({
    hostname: config.host,
    port: config.port,
    fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({
          ok: true,
          v: PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          uptimeMs: Date.now() - startedAt,
          seq: frameLog.seq,
          providers: router.status(),
          usageToday: dayTotals(db),
        });
      }
      if (url.pathname === "/ws") {
        if (srv.upgrade(request, { data: newSession() })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        sessions.set(socket, socket.data);
        socket.data.helloTimer = setTimeout(() => {
          if (!socket.data.authed) socket.close(4001, "hello timeout");
        }, config.helloTimeoutMs);
        log.debug(`connection ${socket.data.id} opened (${sessions.size} open)`);
      },
      async message(socket, message) {
        if (typeof message !== "string") return;
        const session = socket.data;
        await dispatch(
          {
            config,
            db,
            router,
            frameLog,
            emit,
            send: (frame) => socket.send(encodeFrame(frame)),
            close: (code, reason) => socket.close(code, reason),
          },
          session,
          message,
        );
      },
      close(socket) {
        const session = socket.data;
        if (session.helloTimer !== undefined) clearTimeout(session.helloTimer);
        for (const controller of session.aborts.values()) controller.abort();
        session.aborts.clear();
        sessions.delete(socket);
        log.debug(`connection ${session.id} closed (${sessions.size} open)`);
      },
    },
  });

  return {
    port: server.port ?? config.port,
    url: `ws://${config.host}:${server.port ?? config.port}/ws`,
    stop() {
      server.stop(true);
      frameLog.flush();
    },
  };
}
