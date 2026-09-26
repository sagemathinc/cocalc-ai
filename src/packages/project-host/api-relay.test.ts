import type { IncomingMessage } from "node:http";
import {
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
} from "@cocalc/conat/project-host/api-relay";
import { authenticateApiRelay, resolveApiRelayHubUrl } from "./api-relay";
import callHub from "@cocalc/conat/hub/call-hub";
import { getProject } from "./sqlite/projects";

jest.mock("./sqlite/projects", () => ({ getProject: jest.fn() }));
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const project = {
  project_id: projectId,
  secret_token: "the-local-project-secret",
  state: "running",
};
function request(headers = {}, address = "127.0.0.1"): IncomingMessage {
  return {
    socket: { remoteAddress: address },
    headers: {
      [API_RELAY_PROJECT_HEADER]: projectId,
      [API_RELAY_SECRET_HEADER]: project.secret_token,
      ...headers,
    },
  } as IncomingMessage;
}

beforeEach(() => {
  (callHub as jest.Mock).mockReset();
  (getProject as jest.Mock).mockReset().mockReturnValue({ ...project });
});

it("uses the canonical site, never the source host's master bay", async () => {
  const opts = { siteUrl: "https://site.test", hostId: projectId };
  await expect(resolveApiRelayHubUrl(undefined, opts)).resolves.toBe(
    opts.siteUrl,
  );
  await expect(resolveApiRelayHubUrl("https://site.test/", opts)).resolves.toBe(
    opts.siteUrl,
  );
  expect(callHub).not.toHaveBeenCalled();
});

it("requires trusted cluster resolution for an account's different home-bay URL", async () => {
  const opts = {
    siteUrl: "https://site.test",
    hostId: projectId,
    masterClient: {} as any,
  };
  const url = "https://home-bay.test";
  (callHub as jest.Mock).mockResolvedValue({ url });
  await expect(resolveApiRelayHubUrl(url, opts)).resolves.toBe(url);
  expect(callHub).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "hosts.resolveProjectApiRelayHub",
      host_id: projectId,
      args: [{ url }],
    }),
  );
  (callHub as jest.Mock).mockRejectedValue(Error("not configured"));
  await expect(
    resolveApiRelayHubUrl("https://arbitrary.test", opts),
  ).rejects.toThrow("not configured");
  (callHub as jest.Mock).mockResolvedValue({ url: "https://wrong-bay.test" });
  await expect(resolveApiRelayHubUrl(url, opts)).rejects.toThrow(
    "identity mismatch",
  );
});

it("fails closed when the canonical site is absent", async () => {
  await expect(
    resolveApiRelayHubUrl(undefined, { hostId: projectId }),
  ).rejects.toThrow("site URL is not configured");
});

it("admits a local running project's own secret, not an upstream account credential", () => {
  const admission = authenticateApiRelay(
    request({ authorization: "Bearer account-token" }),
  );
  expect(admission.projectId).toBe(projectId);
  expect(admission.stillAuthorized()).toBe(true);
  expect(() =>
    authenticateApiRelay(
      request({ [API_RELAY_SECRET_HEADER]: "account-token" }),
    ),
  ).toThrow();
});

it.each(["203.0.113.10", "10.0.0.4", ""])(
  "rejects requests from nonlocal peer %s",
  (peer) => {
    expect(() => authenticateApiRelay(request({}, peer))).toThrow();
  },
);

it.each([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "cf-connecting-ip",
])("rejects public ingress header %s", (header) => {
  expect(() =>
    authenticateApiRelay(request({ [header]: "127.0.0.1" })),
  ).toThrow();
});

it.each([
  undefined,
  { ...project, state: "stopped" },
  { ...project, exam_run_id: "exam" },
  { ...project, secret_token: "rotated" },
])(
  "rechecks project lifecycle and secret rotation on existing connections",
  (updated) => {
    const admission = authenticateApiRelay(request());
    (getProject as jest.Mock).mockReturnValue(updated);
    expect(admission.stillAuthorized()).toBe(false);
    expect(() => authenticateApiRelay(request())).toThrow();
  },
);

it("rejects missing, duplicate and malformed admission fields", () => {
  for (const headers of [
    { [API_RELAY_PROJECT_HEADER]: "invalid" },
    { [API_RELAY_SECRET_HEADER]: "" },
    { [API_RELAY_SECRET_HEADER]: [project.secret_token, "other"] },
    { [API_RELAY_SECRET_HEADER]: "x".repeat(4097) },
  ])
    expect(() => authenticateApiRelay(request(headers))).toThrow();
});
