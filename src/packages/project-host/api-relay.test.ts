import type { IncomingMessage } from "node:http";
import {
  API_RELAY_PROJECT_HEADER,
  API_RELAY_SECRET_HEADER,
} from "@cocalc/conat/project-host/api-relay";
import { authenticateApiRelay } from "./api-relay";
import { getProject } from "./sqlite/projects";

jest.mock("./sqlite/projects", () => ({ getProject: jest.fn() }));

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
  (getProject as jest.Mock).mockReset().mockReturnValue({ ...project });
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
