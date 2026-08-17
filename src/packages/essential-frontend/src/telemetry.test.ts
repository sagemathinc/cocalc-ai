/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  markUltraliteBackend,
  markUltralitePhase,
  recordUltraliteFailure,
  recordUltraliteOutcome,
  ultraliteTelemetryDetails,
} from "./telemetry";

test("reports content-free backend phase timing separately", () => {
  const marks = new Map<string, { startTime: number }[]>();
  let now = 10;
  Object.defineProperties(performance, {
    clearMarks: {
      configurable: true,
      value: (name: string) => marks.delete(name),
    },
    getEntriesByName: {
      configurable: true,
      value: (name: string) => marks.get(name) ?? [],
    },
    mark: {
      configurable: true,
      value: (name: string) => marks.set(name, [{ startTime: now }]),
    },
  });

  markUltraliteBackend("files", "start");
  now = 86;
  markUltraliteBackend("files", "end");
  now = 90;
  markUltralitePhase("files", "project-host-connect", "start");
  now = 115;
  markUltralitePhase("files", "project-host-connect", "end");

  expect(ultraliteTelemetryDetails("files")).toMatchObject({
    backend_duration_ms: 76,
    project_host_connect_duration_ms: 25,
    surface: "files",
  });
});

test("emits only content-free constrained-client fields", async () => {
  const request = jest.fn(async (_input: unknown, _options?: RequestInit) => ({
    ok: true,
  }));
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: request,
  });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: jest.fn(() => false),
  });

  recordUltraliteOutcome("file", "file_open");
  await Promise.resolve();

  expect(request).toHaveBeenCalledTimes(1);
  const options = request.mock.calls[0][1];
  expect(options).toBeDefined();
  const payload = JSON.parse(`${options?.body}`);
  expect(payload).toMatchObject({
    metric: "constrained_outcome_v1",
    segment: "file",
    details: { client: "ultralite", outcome: "file_open", surface: "file" },
  });
  expect(JSON.stringify(payload)).not.toMatch(
    /project_id|host_id|path|filename|prompt|content|token/i,
  );
});

test("summarizes browser capabilities without route identifiers", () => {
  const details = ultraliteTelemetryDetails("projects");
  expect(details).toMatchObject({ client: "ultralite", surface: "projects" });
  expect(details).not.toHaveProperty("project_id");
  expect(details).not.toHaveProperty("path");
});

test("classifies timeouts without sending the error message", async () => {
  const request = jest.fn(async (_input: unknown, _options?: RequestInit) => ({
    ok: true,
  }));
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: request,
  });
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: jest.fn(() => false),
  });

  recordUltraliteFailure(
    "files",
    new Error("timed out while reading /home/user/private.txt"),
  );
  await Promise.resolve();

  const payload = JSON.parse(`${request.mock.calls[0][1]?.body}`);
  expect(payload.details).toMatchObject({
    outcome: "timeout",
    surface: "files",
  });
  expect(JSON.stringify(payload)).not.toContain("private.txt");
});
