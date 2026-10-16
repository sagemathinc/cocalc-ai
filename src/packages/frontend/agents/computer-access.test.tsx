import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serializeComputerMention } from "@cocalc/util/computer-mentions";

const ID = "1a057860-889d-461a-9073-4b8c69d65123";

let mockComputers: any[] = [];
let mockLoadFails = false;
let mockRelease: (() => void) | undefined;
jest.mock("../account/use-computers", () => ({
  loadComputersStrict: async () => {
    if (mockRelease !== undefined) {
      await new Promise<void>((resolve) => (mockRelease = resolve));
    }
    if (mockLoadFails) throw Error("hub unreachable");
    return mockComputers;
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => undefined },
  useTypedRedux: () => "account-1",
}));
jest.mock("../account/computer-pairing", () => ({
  errorText: (err) => `${err}`,
  ConnectComputer: () => <div>connect steps</div>,
}));

import { agentComputers, useComputerMentionCheck } from "./computer-access";

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadFails = false;
  mockRelease = undefined;
});

const m1 = (extra: object = {}) => ({
  computer_id: ID,
  name: "m1",
  hostname: "studio.local",
  machine_user: "sage",
  project_id: "p1",
  online: true,
  revoked_at: null,
  ...extra,
});

test("an agent can use a computer exactly when it serves the agent's project", () => {
  expect(agentComputers([m1()] as any, "p1")[0]).toMatchObject({
    state: "connected",
    canUse: true,
  });
  expect(agentComputers([m1()] as any, "p2")[0].canUse).toBe(false);
  expect(agentComputers([m1()] as any, undefined)[0].canUse).toBe(false);
  expect(
    agentComputers([m1({ revoked_at: Date.now() })] as any, "p1")[0].state,
  ).toBe("ended");
});

function useCheck({ threadId = "t1" }: { threadId?: string } = {}) {
  return useComputerMentionCheck({
    projectId: "p1",
    path: "a.chat",
    threadId,
    agentLabel: "@claude-1",
    enabled: true,
  });
}
const message = `disk on ${serializeComputerMention({ version: 1, computer_id: ID, name: "m1" })}?`;

test("sends at once when every mentioned computer is connected and serves this project", async () => {
  mockComputers = [m1()];
  const send = jest.fn();
  const { result } = renderHook(useCheck);
  await act(() => result.current.preflight(message, send));
  expect(send).toHaveBeenCalledTimes(1);
});

test("messages without computers are untouched", async () => {
  const send = jest.fn();
  const { result } = renderHook(useCheck);
  await act(() => result.current.preflight("no computers here", send));
  expect(send).toHaveBeenCalledTimes(1);
});

test("says when the computer serves another project; Send anyway still sends", async () => {
  mockComputers = [m1({ project_id: "p2", online: false })];
  const send = jest.fn();
  const { result } = renderHook(useCheck);
  await act(() => result.current.preflight(message, send));
  expect(send).not.toHaveBeenCalled();
  render(<>{result.current.ui}</>);
  expect(
    screen.getByText("The computers in this message need attention"),
  ).toBeTruthy();
  expect(screen.getByText("Offline")).toBeTruthy();
  expect(screen.getByText("@claude-1 can't use it")).toBeTruthy();
  expect(document.body.textContent).toContain("serves another project");
  await userEvent.click(screen.getByRole("button", { name: "Send anyway" }));
  expect(send).toHaveBeenCalledTimes(1);
});

test("an offline computer of this project: how to bring it back", async () => {
  mockComputers = [m1({ online: false })];
  const send = jest.fn();
  const { result } = renderHook(useCheck);
  await act(() => result.current.preflight(message, send));
  render(<>{result.current.ui}</>);
  expect(screen.getByText("@claude-1 can use it")).toBeTruthy();
  expect(document.body.textContent).toContain("cocalc computer daemon");
});

test("switching threads closes the dialog; the old send can't run", async () => {
  mockComputers = [m1({ online: false })];
  const send = jest.fn();
  const view = renderHook(useCheck, { initialProps: { threadId: "t1" } });
  await act(() => view.result.current.preflight(message, send));
  const shown = render(<>{view.result.current.ui}</>);
  expect(screen.getByRole("button", { name: "Send anyway" })).toBeTruthy();
  shown.unmount();
  view.rerender({ threadId: "t2" });
  render(<>{view.result.current.ui}</>);
  expect(screen.queryByRole("button", { name: "Send anyway" })).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test("a switch while the lookup is pending: no dialog, no send", async () => {
  mockComputers = [m1()];
  mockRelease = () => {};
  const send = jest.fn();
  const view = renderHook(useCheck, { initialProps: { threadId: "t1" } });
  let pending: Promise<unknown> = Promise.resolve();
  act(() => {
    pending = view.result.current.preflight(message, send);
  });
  view.rerender({ threadId: "t2" });
  await act(async () => {
    mockRelease?.();
    await pending;
  });
  expect(send).not.toHaveBeenCalled();
  render(<>{view.result.current.ui}</>);
  expect(screen.queryByRole("button", { name: "Send anyway" })).toBeNull();
});

test("a failed computer refresh is an error, never a stale ready", async () => {
  mockComputers = [m1()];
  mockLoadFails = true;
  const send = jest.fn();
  const { result } = renderHook(useCheck);
  await act(() => result.current.preflight(message, send));
  expect(send).not.toHaveBeenCalled();
  render(<>{result.current.ui}</>);
  expect(
    screen
      .getAllByRole("alert")
      .some((e) => /hub unreachable/.test(e.textContent ?? "")),
  ).toBe(true);
});
