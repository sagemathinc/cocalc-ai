/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The viewer's connection to a shared browser: a conat socket on the
// project's subject, over the user's own connection to the project's host,
// as a terminal has (see @cocalc/util/shared-browser-protocol).

import { EventEmitter } from "events";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  FRAME_HEADER,
  sharedBrowserSubject,
  type FaviconData,
  type ServiceMessage,
  type StartPageData,
  type ViewerMessage,
  type ViewerRequest,
} from "@cocalc/util/shared-browser-protocol";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

export interface Hello {
  view?: string;
  client?: string;
  site?: string;
}

/**
 * Events: "status" (ConnectionStatus), "state", "selection", "copied",
 * "error" (ServiceMessage contents), and "frame" (bytes, done), where done()
 * acknowledges the frame once it is drawn.
 */
export class SharedBrowserConnection extends EventEmitter {
  status: ConnectionStatus = "connecting";
  private socket: any = null;
  private closed = false;

  constructor(
    private readonly project_id: string,
    private readonly appId: string,
    private readonly hello: Hello,
  ) {
    super();
    void this.open();
  }

  private async open(): Promise<void> {
    try {
      const client = await webapp_client.conat_client.projectConat({
        project_id: this.project_id,
        caller: "sharedBrowserViewer",
      });
      if (this.closed) return;
      const socket = client.socket.connect(
        sharedBrowserSubject(this.project_id, this.appId),
        { reconnection: true, desc: "shared browser viewer" },
      );
      this.socket = socket;
      socket.on("ready", this.onReady);
      socket.on("disconnected", () => this.setStatus("reconnecting"));
      socket.on("data", this.onData);
      if (socket.state === "ready") this.onReady();
    } catch (err) {
      if (this.closed) return;
      this.emit("error", `${(err as Error)?.message ?? err}`);
      setTimeout(() => {
        if (!this.closed) void this.open();
      }, 3000);
    }
  }

  // On connecting, and again after a reconnect (to a restarted browser too).
  private onReady = (): void => {
    try {
      this.socket.write({ type: "hello", ...this.hello });
    } catch {}
    this.setStatus("live");
  };

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.emit("status", status);
  }

  private onData = (data: any, headers?: Record<string, any>): void => {
    const seq = headers?.[FRAME_HEADER];
    if (seq != null) {
      this.emit("frame", toBytes(data), () =>
        this.send({ type: "ack", seq: Number(seq) }),
      );
      return;
    }
    const msg = data as ServiceMessage;
    switch (msg?.type) {
      case "state":
        this.emit("state", msg.state);
        return;
      case "selection":
        this.emit("selection", msg.text ?? "");
        return;
      case "copied":
        this.emit("copied", msg.text ?? "");
        return;
      case "error":
        this.emit("error", msg.message);
        return;
    }
  };

  /** Dropped while disconnected: input is for now, not for later. */
  send(msg: ViewerMessage): void {
    if (this.socket?.state !== "ready") return;
    try {
      this.socket.write(msg);
    } catch {}
  }

  async startPage(): Promise<StartPageData> {
    return (
      (await this.request({ type: "start" })) ?? { servers: [], recent: [] }
    );
  }

  async favicon(url: string): Promise<FaviconData> {
    return (await this.request({ type: "favicon", url })) ?? null;
  }

  private async request(request: ViewerRequest): Promise<any> {
    if (!this.socket) throw Error("not connected");
    const response = await this.socket.request(request, { timeout: 15_000 });
    return response?.data;
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
    this.removeAllListeners();
  }
}

function toBytes(data: any): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data?.type === "Buffer" && Array.isArray(data.data))
    return new Uint8Array(data.data);
  return new Uint8Array(0);
}
