/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetRememberMeHash = jest.fn();
const mockGetServerSettings = jest.fn();
const mockRecordUxLatencyEvent = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockGetAccountId(...args),
}));
jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHash: (...args: unknown[]) => mockGetRememberMeHash(...args),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: unknown[]) => mockGetServerSettings(...args),
}));
jest.mock("@cocalc/server/monitoring/ux-latency", () => ({
  recordUxLatencyEvent: (...args: unknown[]) =>
    mockRecordUxLatencyEvent(...args),
}));

beforeEach(() => {
  mockGetAccountId
    .mockReset()
    .mockResolvedValue("14a0013f-5cb5-45a0-9836-c94963076a87");
  mockGetRememberMeHash.mockReset().mockReturnValue("remember-me-hash");
  mockGetServerSettings.mockReset().mockResolvedValue({
    ux_latency_telemetry_enabled: true,
  });
  mockRecordUxLatencyEvent.mockReset().mockResolvedValue(undefined);
});

test("records a bounded browser startup diagnostic", async () => {
  const { req, res } = createMocks({
    method: "POST",
    body: {
      metric: "signed_in_app_incomplete_v1",
      duration_ms: 30_001,
      client_event_id: "trace-1",
      started_at: "2026-08-11T00:00:00.000Z",
      segment: "projects",
      details: { long_task_count: 4 },
    },
  });
  const { default: handler } = await import("./startup");
  await handler(req, res);

  expect(res.statusCode).toBe(204);
  expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith({
    account_id: "14a0013f-5cb5-45a0-9836-c94963076a87",
    event: {
      event_type: "app_bootstrap",
      metric: "signed_in_app_incomplete_v1",
      duration_ms: 30_001,
      client_event_id: "trace-1",
      started_at: "2026-08-11T00:00:00.000Z",
      sample_rate: 1,
      segment: "projects",
      details: { long_task_count: 4 },
    },
  });
});

test("records allowlisted constrained-client telemetry", async () => {
  const { req, res } = createMocks({
    method: "POST",
    body: {
      metric: "constrained_surface_ready_v1",
      duration_ms: 4_200,
      client_event_id: "ultralite-1",
      started_at: "2026-08-15T00:00:00.000Z",
      segment: "files",
      details: {
        surface: "files",
        request_count: 7,
        backend_duration_ms: 812,
        project_id: "should-not-be-recorded",
        path: "/home/user/private.txt",
      },
    },
  });
  const { default: handler } = await import("./startup");
  await handler(req, res);

  expect(res.statusCode).toBe(204);
  expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith({
    account_id: "14a0013f-5cb5-45a0-9836-c94963076a87",
    event: expect.objectContaining({
      event_type: "constrained_client",
      metric: "constrained_surface_ready_v1",
      segment: "files",
      details: {
        surface: "files",
        request_count: 7,
        backend_duration_ms: 812,
      },
    }),
  });
});

test("silently ignores disabled telemetry and unknown metrics", async () => {
  const { default: handler } = await import("./startup");
  mockGetServerSettings.mockResolvedValueOnce({
    ux_latency_telemetry_enabled: false,
  });
  const disabled = createMocks({
    method: "POST",
    body: { metric: "signed_in_app_incomplete_v1" },
  });
  await handler(disabled.req, disabled.res);

  const unknown = createMocks({
    method: "POST",
    body: { metric: "arbitrary_metric" },
  });
  await handler(unknown.req, unknown.res);

  expect(disabled.res.statusCode).toBe(204);
  expect(unknown.res.statusCode).toBe(204);
  expect(mockRecordUxLatencyEvent).not.toHaveBeenCalled();
});

test("rejects API-key use", async () => {
  const { req, res } = createMocks({
    method: "POST",
    headers: { Authorization: "Bearer cocalc_api_key_test" },
  });
  const { default: handler } = await import("./startup");
  await handler(req, res);

  expect(res._getJSONData()).toEqual({
    error: "API keys are not allowed to record browser startup",
  });
  expect(mockGetAccountId).not.toHaveBeenCalled();
});
