/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A pseudo-terminal: node-pty on Node, and Bun.Terminal on Bun (node-pty's native
addon loads in Bun, but its shells hang up at once).  BunPty implements the part
of node-pty's IPty that the terminal server uses: the "data" and "exit" events,
write, resize, pause/resume, kill and destroy.
*/

import { EventEmitter } from "node:events";
import { constants } from "node:os";

export function spawn(file: string, args: string[] = [], options: any = {}) {
  if (process.versions.bun) {
    return new BunPty(file, args, options);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node-pty").spawn(file, args, options);
}

export class BunPty extends EventEmitter {
  readonly pid: number;
  readonly process: string;
  cols: number;
  rows: number;
  private readonly proc: any;
  private readonly terminal: any;
  private readonly decoder = new TextDecoder();
  private paused = false;
  // Bun.Terminal has no backpressure: while paused, output waits here
  private queued: string[] = [];

  constructor(file: string, args: string[], options: any) {
    super();
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    const env = { ...(options.env ?? process.env) };
    if (options.name) env.TERM = options.name;
    this.proc = (globalThis as any).Bun.spawn([file, ...args], {
      cwd: options.cwd,
      env,
      terminal: {
        cols: this.cols,
        rows: this.rows,
        data: (_terminal: unknown, bytes: Uint8Array) => this.onBytes(bytes),
      },
    });
    this.pid = this.proc.pid;
    this.process = file;
    this.terminal = this.proc.terminal;
    this.proc.exited.then((exitCode: number | null) => {
      const name = this.proc.signalCode;
      const signal = name ? (constants.signals[name] ?? 0) : 0;
      // let the last output through before the exit
      setTimeout(() => {
        this.flush();
        this.emit("exit", exitCode ?? 0, signal);
      }, 10);
    });
  }

  private onBytes(bytes: Uint8Array) {
    const text = this.decoder.decode(bytes, { stream: true });
    if (!text) return;
    if (this.paused) {
      this.queued.push(text);
    } else {
      this.emit("data", text);
    }
  }

  private flush() {
    while (!this.paused && this.queued.length > 0) {
      this.emit("data", this.queued.shift());
    }
  }

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.on("data", listener);
    return { dispose: () => this.removeListener("data", listener) };
  }

  onExit(listener: (e: { exitCode: number; signal: number }) => void): {
    dispose: () => void;
  } {
    const f = (exitCode: number, signal: number) =>
      listener({ exitCode, signal });
    this.on("exit", f);
    return { dispose: () => this.removeListener("exit", f) };
  }

  write(data: string) {
    if (!this.terminal.closed) this.terminal.write(data);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    if (!this.terminal.closed) this.terminal.resize(cols, rows);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.flush();
  }

  kill(signal: NodeJS.Signals = "SIGHUP") {
    try {
      this.proc.kill(signal);
    } catch {}
  }

  destroy() {
    this.kill("SIGHUP");
    try {
      this.terminal.close();
    } catch {}
  }
}
