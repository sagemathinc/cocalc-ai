/**
 * Viewers reach the shared browser over conat, on the project's subject, as
 * terminals do: with the user's own authenticated connection, so only the
 * project's collaborators can, and nothing else can act for them (another
 * site, a page in this browser).  See @cocalc/util/shared-browser-protocol.
 */
import type { Client } from "@cocalc/conat/core/client";
import {
  FRAME_HEADER,
  FRAMES_IN_FLIGHT,
  sharedBrowserSubject,
} from "@cocalc/util/shared-browser-protocol";

import type { SharedBrowserServer, ViewerChannel } from "./server";

// Frames unacknowledged this long are written off (e.g. a lost viewer), so
// the stream never stalls for good.
const ACK_TIMEOUT_MS = 10_000;

/**
 * At most `max` frames unacknowledged; while that many are, a new frame
 * waits, and a newer one replaces it: a slow link gets fewer frames rather
 * than a growing backlog, and always the latest picture.
 */
export class FrameWindow {
  private seq = 0;
  private sent = new Map<number, number>(); // seq -> when
  private waiting: Buffer | null = null;

  constructor(
    private readonly write: (frame: Buffer, seq: number) => void,
    private readonly max = FRAMES_IN_FLIGHT,
    private readonly now: () => number = Date.now,
  ) {}

  send(frame: Buffer): void {
    this.expire();
    if (this.sent.size >= this.max) {
      this.waiting = frame;
      return;
    }
    this.seq += 1;
    this.sent.set(this.seq, this.now());
    this.write(frame, this.seq);
  }

  ack(seq: number): void {
    if (!this.sent.delete(seq)) return;
    const next = this.waiting;
    if (next) {
      this.waiting = null;
      this.send(next);
    }
  }

  /** Start over, e.g. when the viewer reconnects. */
  reset(): void {
    this.sent.clear();
    this.waiting = null;
  }

  get inFlight(): number {
    return this.sent.size;
  }

  private expire(): void {
    const cutoff = this.now() - ACK_TIMEOUT_MS;
    for (const [seq, at] of this.sent) if (at < cutoff) this.sent.delete(seq);
  }
}

export function serveViewers({
  client,
  server,
  projectId,
  appId,
  log = () => {},
}: {
  client: Client;
  server: SharedBrowserServer;
  projectId: string;
  appId: string;
  log?: (message: string) => void;
}): { close: () => void } {
  const subject = sharedBrowserSubject(projectId, appId);
  const listener = client.socket.listen(subject, {
    desc: "shared browser viewers",
  });
  log(`viewers on conat ${subject}`);
  listener.on("connection", (socket) => {
    const frames = new FrameWindow((frame, seq) => {
      try {
        socket.write(frame, { headers: { [FRAME_HEADER]: seq } });
      } catch {
        // closed, or too much queued: the viewer catches up on the next one
      }
    });
    const channel: ViewerChannel = {
      send: (message) => {
        try {
          socket.write(message);
        } catch {}
      },
      sendFrame: (frame) => frames.send(frame),
    };
    let greeted = false;
    socket.on("data", (data: any) => {
      if (data?.type === "hello") {
        greeted = true;
        frames.reset();
        server.addViewer(channel, data);
        return;
      }
      if (!greeted) return;
      if (data?.type === "ack") {
        frames.ack(Number(data.seq));
        return;
      }
      void server.viewerMessage(channel, data);
    });
    socket.on("request", async (mesg) => {
      try {
        mesg.respondSync(
          (await server.viewerRequest(channel, mesg.data)) ?? null,
        );
      } catch (err: any) {
        mesg.respondSync(null, {
          headers: { error: `${err?.message ?? err}` },
        });
      }
    });
    socket.on("closed", () => {
      frames.reset();
      server.removeViewer(channel);
    });
  });
  return { close: () => listener.close() };
}
