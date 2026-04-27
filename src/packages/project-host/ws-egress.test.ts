/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import {
  attachManagedWsEgressRecorder,
  setManagedWsEgressContext,
} from "./ws-egress";

class MockSocket extends EventEmitter {
  destroyed = false;
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
    this.emit("end");
    this.emit("close");
    return this;
  });
  destroy = jest.fn(() => {
    this.destroyed = true;
    this.emit("close");
    return this;
  });
}

describe("project-host managed websocket egress recorder", () => {
  it("records delivered websocket bytes on close", async () => {
    const req = {
      url: "/project-id/apps/demo/socket?x=1",
    } as IncomingMessage;
    const socket = new MockSocket() as unknown as Duplex;
    const record = jest.fn().mockResolvedValue(undefined);
    const checkAllowed = jest.fn().mockResolvedValue({ allowed: true });

    setManagedWsEgressContext(req, {
      project_id: "project-id",
      app_id: "demo",
      exposure_mode: "private",
    });
    attachManagedWsEgressRecorder({
      req,
      socket,
      record,
      checkAllowed,
    });

    socket.write("hello");
    socket.write(Buffer.from(" world"));
    socket.emit("close");
    await new Promise(setImmediate);

    expect(record).toHaveBeenCalledWith({
      project_id: "project-id",
      app_id: "demo",
      exposure_mode: "private",
      bytes: 11,
      request_path: "/project-id/apps/demo/socket",
      partial: true,
    });
    expect(checkAllowed).toHaveBeenCalled();
  });

  it("destroys the socket when policy later blocks the connection", async () => {
    const req = {
      url: "/project-id/proxy/9000/ws",
    } as IncomingMessage;
    const socket = new MockSocket() as unknown as Duplex;
    const record = jest.fn().mockResolvedValue(undefined);
    const checkAllowed = jest
      .fn()
      .mockResolvedValueOnce({ allowed: false, message: "blocked" });

    setManagedWsEgressContext(req, {
      project_id: "project-id",
      exposure_mode: "public",
    });
    attachManagedWsEgressRecorder({
      req,
      socket,
      record,
      checkAllowed,
    });

    socket.write("payload");
    socket.emit("close");
    await new Promise(setImmediate);

    expect(record).toHaveBeenCalledWith({
      project_id: "project-id",
      exposure_mode: "public",
      bytes: 7,
      request_path: "/project-id/proxy/9000/ws",
      partial: true,
    });
    expect((socket as unknown as MockSocket).destroy).toHaveBeenCalled();
  });
});
