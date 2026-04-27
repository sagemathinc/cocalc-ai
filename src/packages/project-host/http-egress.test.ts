/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import { attachManagedHttpEgressRecorder } from "./http-egress";

class MockResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  writableEnded = false;
  write = jest.fn((_chunk?: unknown, _encoding?: unknown, cb?: () => void) => {
    cb?.();
    return true;
  });
  end = jest.fn((chunk?: unknown, cb?: () => void) => {
    if (typeof chunk === "function") {
      (chunk as () => void)();
    } else {
      cb?.();
    }
    this.writableFinished = true;
    this.writableEnded = true;
    this.emit("finish");
    this.emit("close");
    return this;
  });
}

describe("project-host managed http egress recorder", () => {
  it("records delivered response bytes on finish", async () => {
    const res = new MockResponse() as unknown as ServerResponse;
    const record = jest.fn().mockResolvedValue(undefined);
    const req = {
      method: "GET",
      url: "/project-id/port/5000/index.html?x=1",
    } as IncomingMessage;

    attachManagedHttpEgressRecorder({
      req,
      res,
      exposure_mode: "private",
      record,
    });

    res.write("hello");
    res.write(Buffer.from(" world"));
    res.end();
    await new Promise(setImmediate);

    expect(record).toHaveBeenCalledWith({
      bytes: 11,
      request_path: "/project-id/port/5000/index.html",
      method: "GET",
      status_code: 200,
      exposure_mode: "private",
      partial: false,
    });
  });

  it("records partial bytes on socket close before finish", async () => {
    const res = new MockResponse() as unknown as ServerResponse;
    const record = jest.fn().mockResolvedValue(undefined);
    const req = {
      method: "POST",
      url: "/project-id/port/5000/api/run",
    } as IncomingMessage;

    attachManagedHttpEgressRecorder({
      req,
      res,
      exposure_mode: "public",
      record,
    });

    res.write("abc");
    (res as unknown as MockResponse).emit("close");
    await new Promise(setImmediate);

    expect(record).toHaveBeenCalledWith({
      bytes: 3,
      request_path: "/project-id/port/5000/api/run",
      method: "POST",
      status_code: 200,
      exposure_mode: "public",
      partial: true,
    });
  });
});
