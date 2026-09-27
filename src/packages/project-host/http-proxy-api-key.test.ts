import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  issueProjectHostApiKeyHttpToken,
  issueProjectHostApiKeyAuthToken,
} from "@cocalc/conat/auth/project-host-token";
import { PROJECT_HOST_API_KEY_HTTP_HEADER } from "@cocalc/conat/auth/project-host-http";
import {
  authorizeScopedHttpProxy,
  expireScopedHttpTransport,
} from "./http-proxy-api-key";

const mockGetProject = jest.fn();
let mockPublicKey: string;
jest.mock("./sqlite/projects", () => ({
  getProject: (...args: any[]) => mockGetProject(...args),
}));
jest.mock("./auth-public-key", () => ({
  getProjectHostAuthPublicKey: () => mockPublicKey,
}));

const account_id = "00000000-0000-4000-8000-000000000001";
const project_id = "00000000-0000-4000-8000-000000000002";
const host_id = "00000000-0000-4000-8000-000000000003";
const keys = generateKeyPairSync("ed25519");
mockPublicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const options = {
  account_id,
  project_id,
  host_id,
  key_id: "test-key-1234",
  scope_revision: 1,
  placement_revision: 7,
  capabilities: ["project:exec" as const],
  private_key: keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString(),
};
const request = (token: unknown, url = `/${project_id}/proxy/8080/path`) =>
  ({
    url,
    headers: {
      [PROJECT_HOST_API_KEY_HTTP_HEADER]: token,
      cookie: "browser-secret",
      authorization: "Bearer ambient-secret",
    },
  }) as any;

beforeEach(() => {
  mockGetProject.mockReturnValue({
    runtime_lifecycle_revision: 7,
    users: { [account_id]: { group: "collaborator" } },
  });
});
afterEach(() => jest.useRealTimers());

test("admits only the signed HTTP target and consumes credentials", () => {
  const req = request(
    issueProjectHostApiKeyHttpToken({ ...options, port: 8080 }).token,
  );
  expect(
    authorizeScopedHttpProxy(req, host_id, project_id)?.api_key?.key_id,
  ).toBe(options.key_id);
  expect(req.headers).toEqual({});
});

test.each([
  "files/x",
  "proxy/8081/",
  "proxy/08080/",
  "proxy/8080junk/",
  "proxy/%38%30%38%30/",
  "proxy/8080/../../proxy/9090/",
  "proxy/8080/%2e%2e/%2e%2e/proxy/9090/",
])("rejects target substitution %s", (path) => {
  const req = request(
    issueProjectHostApiKeyHttpToken({ ...options, port: 8080 }).token,
    `/${project_id}/${path}`,
  );
  expect(() => authorizeScopedHttpProxy(req, host_id, project_id)).toThrow(
    "invalid scoped",
  );
  expect(req.headers[PROJECT_HOST_API_KEY_HTTP_HEADER]).toBeUndefined();
});

test("rejects Conat tokens, wrong host/project, expiry, and stale local authority", () => {
  const token = issueProjectHostApiKeyHttpToken({
    ...options,
    port: 8080,
  }).token;
  expect(() =>
    authorizeScopedHttpProxy(
      request(issueProjectHostApiKeyAuthToken(options).token),
      host_id,
      project_id,
    ),
  ).toThrow();
  expect(() =>
    authorizeScopedHttpProxy(request(token), account_id, project_id),
  ).toThrow();
  expect(() =>
    authorizeScopedHttpProxy(request(token), host_id, account_id),
  ).toThrow();
  mockGetProject.mockReturnValueOnce({
    runtime_lifecycle_revision: 8,
    users: { [account_id]: "owner" },
  });
  expect(() =>
    authorizeScopedHttpProxy(request(token), host_id, project_id),
  ).toThrow();
  mockGetProject.mockReturnValueOnce({
    runtime_lifecycle_revision: 7,
    users: { [account_id]: "viewer" },
  });
  expect(() =>
    authorizeScopedHttpProxy(request(token), host_id, project_id),
  ).toThrow();
  jest.useFakeTimers();
  jest.setSystemTime(Date.now() + 26_000);
  expect(() =>
    authorizeScopedHttpProxy(request(token), host_id, project_id),
  ).toThrow();
});

test.each(["", ["one", "two"], "bad-token"])(
  "rejects malformed header without browser fallback",
  (token) => {
    expect(() =>
      authorizeScopedHttpProxy(request(token), host_id, project_id),
    ).toThrow();
  },
);

test("leaves ordinary HTTP requests alone", () => {
  expect(
    authorizeScopedHttpProxy({ headers: {} } as any, host_id, project_id),
  ).toBeUndefined();
});

test("expires active responses and half-closed upgraded sockets at the deadline", () => {
  jest.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { destroy: jest.fn() });
  expireScopedHttpTransport(socket, Date.now() / 1000 + 25);
  socket.emit("end");
  socket.emit("finish");
  jest.advanceTimersByTime(24_999);
  expect(socket.destroy).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(socket.listenerCount("close")).toBe(0);
  const response = Object.assign(new EventEmitter(), { destroy: jest.fn() });
  expireScopedHttpTransport(response, Date.now() / 1000 + 1, true);
  jest.advanceTimersByTime(1_000);
  expect(response.destroy).toHaveBeenCalledTimes(1);
});

test("cleans timers on completion and rejects an already expired transport immediately", () => {
  jest.useFakeTimers();
  const response = Object.assign(new EventEmitter(), { destroy: jest.fn() });
  expireScopedHttpTransport(response, Date.now() / 1000 + 25, true);
  response.emit("finish");
  expect(jest.getTimerCount()).toBe(0);
  expect(response.listenerCount("close")).toBe(0);
  expireScopedHttpTransport(response, Date.now() / 1000);
  expect(response.destroy).toHaveBeenCalledTimes(1);
});

test("fences incoming data and writes before overdue timers run after a stall", async () => {
  jest.useFakeTimers();
  const write = jest.fn(() => true);
  const end = jest.fn();
  const writeHead = jest.fn();
  const flushHeaders = jest.fn();
  const transport = Object.assign(new EventEmitter(), {
    destroy: jest.fn(),
    write,
    end,
    writeHead,
    flushHeaders,
  });
  const data = jest.fn();
  transport.on("data", data);
  const now = Date.now();
  expireScopedHttpTransport(transport, now / 1000 + 25);
  expect(transport.write("allowed")).toBe(true);
  transport.emit("data", "allowed");
  expect(write).toHaveBeenCalledTimes(1);
  expect(data).toHaveBeenCalledTimes(1);
  // Move wall time without executing the pending expiry timer.
  jest.setSystemTime(now + 25_000);
  expect(transport.destroy).not.toHaveBeenCalled();
  expect(transport.write("denied")).toBe(false);
  const callback = jest.fn();
  (transport as any).write("denied with callback", callback);
  jest.runAllTicks();
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({ code: "ERR_AUTHORIZATION_EXPIRED" }),
  );
  transport.end("denied");
  transport.writeHead(200);
  transport.flushHeaders();
  expect(transport.emit("data", "denied")).toBe(false);
  expect(write).toHaveBeenCalledTimes(1);
  expect(end).not.toHaveBeenCalled();
  expect(writeHead).not.toHaveBeenCalled();
  expect(flushHeaders).not.toHaveBeenCalled();
  expect(data).toHaveBeenCalledTimes(1);
  expect(transport.destroy).toHaveBeenCalled();
  transport.emit("close");
  expect(jest.getTimerCount()).toBe(0);
});
