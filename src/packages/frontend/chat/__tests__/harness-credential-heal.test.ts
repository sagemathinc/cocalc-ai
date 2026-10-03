/** @jest-environment jsdom */
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { healedHarnessCredential } from "../harness-credential-heal";
import {
  readHarnessCredentialSelection,
  writeHarnessCredentialSelection,
} from "../harness-credential-selection";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { hub: { system: { listExternalCredentials: jest.fn() } } },
  },
}));
const list = jest.mocked(
  webapp_client.conat_client.hub.system.listExternalCredentials,
);
const where = {
  accountId: "account-a",
  projectId: "project-a",
  threadKey: "t",
};
const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-000000000002";
const subscription = (id: string, revoked: string | null = null) =>
  ({ id, kind: "claude-subscription-home-v1", revoked }) as any;

beforeEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

test("a turn on a disconnected subscription switches to the current one", async () => {
  writeHarnessCredentialSelection({
    ...where,
    credential: {
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: OLD,
    },
  });
  list.mockResolvedValue([subscription(OLD, "today"), subscription(NEW)]);
  expect(await healedHarnessCredential(where)).toMatchObject({
    mode: "account-subscription",
    credentialId: NEW,
  });
  // Saved for the thread, so the next turn needs no switch.
  expect(readHarnessCredentialSelection(where)).toMatchObject({
    credentialId: NEW,
  });
});

test("a credential connected after the cached list is confirmed, not replaced", async () => {
  list.mockResolvedValueOnce([subscription(OLD)]);
  writeHarnessCredentialSelection({
    ...where,
    credential: {
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: OLD,
    },
  });
  await healedHarnessCredential(where);
  writeHarnessCredentialSelection({
    ...where,
    credential: {
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: NEW,
    },
  });
  list.mockResolvedValueOnce([subscription(OLD), subscription(NEW)]);
  expect(await healedHarnessCredential(where)).toMatchObject({
    credentialId: NEW,
  });
});

test("never switches to the project secret and never blocks a turn", async () => {
  writeHarnessCredentialSelection({
    ...where,
    credential: {
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId: OLD,
    },
  });
  list.mockResolvedValue([subscription(OLD, "today")]);
  expect(await healedHarnessCredential(where)).toMatchObject({
    credentialId: OLD,
  });
  list.mockRejectedValue(Error("offline"));
  expect(await healedHarnessCredential(where)).toMatchObject({
    credentialId: OLD,
  });
});
