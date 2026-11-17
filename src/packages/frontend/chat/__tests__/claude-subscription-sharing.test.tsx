/** @jest-environment jsdom */
import { fromJS } from "immutable";
import { Modal } from "antd";
import {
  SHARING_TITLE,
  claudeSubscriptionSharingRisk,
  confirmClaudeSubscriptionSharing,
} from "../claude-subscription-sharing";

let projectMap: any;
let runtime: string | undefined;
let loaded = true;
let readFails = false;

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) =>
      name === "projects"
        ? {
            getIn: (path: string[]) => {
              if (readFails) throw Error("not loaded");
              return projectMap?.getIn(path.slice(1));
            },
          }
        : name === "customize"
          ? // only the public site-settings name: the one /customize sends
            {
              get: (key: string) =>
                key === "claude_subscription_runtime"
                  ? runtime
                  : key === "_is_configured"
                    ? loaded
                    : undefined,
            }
          : undefined,
  },
}));

const ME = "account-a";
const OTHER = "account-b";
const PROJECT = "project-a";
const subscription = {
  version: 1,
  provider: "anthropic",
  mode: "account-subscription",
  credentialId: "00000000-0000-4000-8000-000000000001",
} as const;

function users(...ids: string[]) {
  projectMap = fromJS({
    [PROJECT]: {
      users: Object.fromEntries(ids.map((id) => [id, { group: "owner" }])),
    },
  });
}

let confirmSpy: jest.SpyInstance;
let answer: "ok" | "cancel";
beforeEach(() => {
  localStorage.clear();
  runtime = "project";
  loaded = true;
  readFails = false;
  answer = "ok";
  confirmSpy = jest.spyOn(Modal, "confirm").mockImplementation((props: any) => {
    if (answer === "ok") props.onOk?.();
    else props.onCancel?.();
    return { destroy: jest.fn(), update: jest.fn() } as any;
  });
});
afterEach(() => confirmSpy.mockRestore());

const confirm = (credential: any = subscription, pool = false) =>
  confirmClaudeSubscriptionSharing({
    accountId: ME,
    projectId: PROJECT,
    credential,
    pool,
  });

test("alone in the project: no warning", async () => {
  users(ME);
  expect(await confirm()).toBe(true);
  expect(confirmSpy).not.toHaveBeenCalled();
});

test("with a collaborator: the full warning before the turn, once for that set", async () => {
  users(ME, OTHER);
  expect(await confirm()).toBe(true);
  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(confirmSpy.mock.calls[0][0].title).toBe(SHARING_TITLE);
  // the next turn, same collaborators: already acknowledged
  expect(await confirm()).toBe(true);
  expect(confirmSpy).toHaveBeenCalledTimes(1);
});

test("declined: the turn does not start, and it asks again next time", async () => {
  users(ME, OTHER);
  answer = "cancel";
  expect(await confirm()).toBe(false);
  expect(await confirm()).toBe(false);
  expect(confirmSpy).toHaveBeenCalledTimes(2);
});

test("a collaborator added between turns: shown again at the next turn", async () => {
  users(ME, OTHER);
  expect(await confirm()).toBe(true);
  users(ME, OTHER, "account-c");
  expect(await confirm()).toBe(true);
  expect(confirmSpy).toHaveBeenCalledTimes(2);
});

test("collaborators that cannot be read: always shown", async () => {
  readFails = true;
  expect(await confirm()).toBe(true);
  expect(await confirm()).toBe(true);
  expect(confirmSpy).toHaveBeenCalledTimes(2);
  projectMap = undefined;
  readFails = false;
  expect(
    claudeSubscriptionSharingRisk({ accountId: ME, projectId: PROJECT }),
  ).toEqual({ show: true, key: "unknown" });
});

test("not a subscription, or the controller runtime: no warning", async () => {
  users(ME, OTHER);
  expect(
    await confirm({
      version: 1,
      provider: "anthropic",
      mode: "project-secret",
    }),
  ).toBe(true);
  expect(
    await confirmClaudeSubscriptionSharing({
      accountId: ME,
      projectId: PROJECT,
    }),
  ).toBe(true);
  runtime = "controller";
  expect(await confirm()).toBe(true);
  expect(confirmSpy).not.toHaveBeenCalled();
});

test("an unknown or unset runtime is the controller, as on the backend: no warning", async () => {
  users(ME, OTHER);
  for (const value of ["something-else", "controller", undefined]) {
    runtime = value;
    expect(
      claudeSubscriptionSharingRisk({ accountId: ME, projectId: PROJECT }).show,
    ).toBe(false);
    expect(await confirm()).toBe(true);
    expect(await confirm(subscription, true)).toBe(true);
  }
  expect(confirmSpy).not.toHaveBeenCalled();
});

test("before /customize has loaded: shown with a collaborator (fails toward showing)", async () => {
  users(ME, OTHER);
  loaded = false;
  for (const value of [undefined, "controller"]) {
    runtime = value;
    expect(
      claudeSubscriptionSharingRisk({ accountId: ME, projectId: PROJECT }).show,
    ).toBe(true);
  }
  expect(await confirm()).toBe(true);
  expect(confirmSpy).toHaveBeenCalledTimes(1);
  // alone in the project: still nothing to warn about
  users(ME);
  expect(
    claudeSubscriptionSharingRisk({ accountId: ME, projectId: PROJECT }).show,
  ).toBe(false);
});

test("the project runtime and no project id: shown, and never remembered", async () => {
  users(ME, OTHER);
  runtime = "project";
  expect(
    await confirmClaudeSubscriptionSharing({
      accountId: ME,
      credential: subscription,
    }),
  ).toBe(true);
  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(
    await confirmClaudeSubscriptionSharing({
      accountId: ME,
      credential: subscription,
    }),
  ).toBe(true);
  expect(confirmSpy).toHaveBeenCalledTimes(2);
});

test("Auto (a subscription the host picks): warned like a subscription", async () => {
  users(ME, OTHER);
  expect(
    await confirmClaudeSubscriptionSharing({
      accountId: ME,
      projectId: PROJECT,
      pool: true,
    }),
  ).toBe(true);
  expect(confirmSpy).toHaveBeenCalledTimes(1);
});
