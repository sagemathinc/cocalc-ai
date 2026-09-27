/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";

export interface JupyterInputPrompt {
  id: string;
  prompt: string;
  password?: boolean;
}

export interface JupyterInputRequest extends JupyterInputPrompt {
  request_id: string;
  expires_at: number;
  sequence: number;
}

export const MAX_INPUT_PROMPT_BYTES = 16 * 1024;
export const MAX_INPUT_ANSWER_BYTES = 64 * 1024;
const INPUT_TIMEOUT_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();

function boundedString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    encoder.encode(value).byteLength <= max
  );
}

// One instance per admitted run; nothing here is written to replay storage.
export class JupyterRunInput {
  private pending?: {
    request: JupyterInputRequest;
    resolve: (answer: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private accepted?: string;
  private closed = false;
  private sequence = 0;

  constructor(private readonly timeoutMs = INPUT_TIMEOUT_MS) {
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > INPUT_TIMEOUT_MS
    )
      throw Error("invalid input timeout");
  }

  request(prompt: JupyterInputPrompt): Promise<string> {
    if (this.closed) throw Error("run input is closed");
    if (this.pending) throw Error("run already has pending input");
    if (
      !boundedString(prompt.id, 256) ||
      !prompt.id ||
      !boundedString(prompt.prompt, MAX_INPUT_PROMPT_BYTES) ||
      (prompt.password != null && typeof prompt.password !== "boolean")
    )
      throw Error("invalid input prompt");
    const request: JupyterInputRequest = {
      id: prompt.id,
      prompt: prompt.prompt,
      password: prompt.password,
      request_id: uuid(),
      expires_at: Date.now() + this.timeoutMs,
      sequence: ++this.sequence,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(Error("run input expired"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = { request, resolve, reject, timer };
    });
  }

  get(): JupyterInputRequest | null {
    this.expire();
    return this.pending ? { ...this.pending.request } : null;
  }

  answer(requestId: string, answer: string): "accepted" | "already-accepted" {
    if (this.closed) throw Error("run input is closed");
    if (!boundedString(requestId, 256) || !requestId)
      throw Error("invalid input request id");
    if (!boundedString(answer, MAX_INPUT_ANSWER_BYTES))
      throw Error("invalid input answer");
    this.expire();
    // Retain only the most recent accepted ID, never the answer itself.
    if (requestId === this.accepted) return "already-accepted";
    const pending = this.pending;
    if (!pending || requestId !== pending.request.request_id)
      throw Error("input request is not pending");
    clearTimeout(pending.timer);
    this.pending = undefined;
    this.accepted = requestId;
    pending.resolve(answer);
    return "accepted";
  }

  close(): void {
    this.closed = true;
    this.accepted = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(Error("run input is closed"));
      this.pending = undefined;
    }
  }

  private expire(): void {
    if (this.pending && Date.now() >= this.pending.request.expires_at) {
      clearTimeout(this.pending.timer);
      this.pending.reject(Error("run input expired"));
      this.pending = undefined;
    }
  }
}
