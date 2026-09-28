import type { Socket } from "socket.io-client";
import { ConatError } from "@cocalc/conat/util";
import { abortable } from "./abort";

interface DeadlineOptions {
  deadline: number;
  timeout: number;
  signal?: AbortSignal;
  isReady: () => boolean;
  isClosed: () => boolean;
}

// Admission, not delivery cancellation: after emitWithAck hands a packet to
// the transport, timeout/abort means unknown outcome. In particular, never
// remove Engine.IO buffers, which can contain only part of a binary message.
export async function emitWithDeadline(
  socket: Socket,
  event: string,
  data: (remaining: number) => unknown,
  { deadline, timeout, signal, isReady, isClosed }: DeadlineOptions,
): Promise<any> {
  deadline = Math.min(deadline, Date.now() + timeout);
  for (;;) {
    signal?.throwIfAborted();
    if (isClosed()) throw new ConatError("closed", { code: 408 });
    if (!(deadline > Date.now())) {
      throw new ConatError("timeout", { code: 408 });
    }
    const engine = socket.io.engine;
    // Socket.IO 4.x can buffer even volatile packets when connected is stale
    // but the transport is writable. Use its own heartbeat check as well.
    const liveEngine = engine as typeof engine & {
      _hasPingExpired(): boolean;
    };
    if (
      isReady() &&
      socket.connected &&
      engine?.readyState === "open" &&
      engine.transport.writable &&
      !liveEngine._hasPingExpired()
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ConatError("timeout", { code: 408 });
      const payload = data(remaining);
      signal?.throwIfAborted();
      const ackTimeout = deadline - Date.now();
      if (ackTimeout <= 0) throw new ConatError("timeout", { code: 408 });
      // No await between readiness and emit. Each concurrent sender rechecks
      // writability, rather than waking together and dropping valid RPCs.
      // Volatile also bypasses Socket.IO's automatic retry queue.
      const bufferStart = socket.sendBuffer.length;
      const pending = socket
        .timeout(ackTimeout)
        .volatile.emitWithAck(event, payload);
      if (retractUnsentPacket(socket, bufferStart, event, payload)) {
        await pending.catch(() => undefined);
        continue;
      }
      return await abortable(pending, signal);
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("connect", wake);
        engine?.off("drain", wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      // Also recheck sign-in and replacement transports, without changing
      // shared readiness or retaining listeners on an old engine indefinitely.
      const timer = setTimeout(wake, Math.min(25, deadline - Date.now()));
      socket.on("connect", wake);
      engine?.on("drain", wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}

// Socket.IO 4.x's volatile check only tests writability. A heartbeat can expire
// between our check and emit's check, sending this packet to sendBuffer instead
// of the transport. Retract only our synchronously queued, never-handed-off
// packet, and settle its ACK to clear its timer. Never touch Engine.IO buffers.
function retractUnsentPacket(
  socket: Socket,
  bufferStart: number,
  event: string,
  payload: unknown,
): boolean {
  const packet = socket.sendBuffer[bufferStart];
  if (packet?.data?.[0] !== event || packet.data[1] !== payload) return false;
  socket.sendBuffer.splice(bufferStart, 1);
  const { acks } = socket as unknown as {
    acks: Record<number, (err: Error) => void>;
  };
  const ack = acks[packet.id!];
  delete acks[packet.id!];
  ack(new Error("socket became disconnected before transport handoff"));
  return true;
}
