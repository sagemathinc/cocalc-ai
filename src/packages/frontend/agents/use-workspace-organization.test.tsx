import { act, renderHook, waitFor } from "@testing-library/react";
import { Map } from "immutable";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const mockSave = jest.fn();
let mockOtherSettings = Map();

jest.mock("@cocalc/frontend/logger", () => ({
  getLogger: () => ({ warn: jest.fn() }),
}));
jest.mock("@cocalc/frontend/app-framework", () => {
  const React = jest.requireActual("react");
  return {
    redux: {
      getStore: () => ({ get: () => "account" }),
      getActions: () => ({ set_other_settings_and_wait: mockSave }),
    },
    useEffect: React.useEffect,
    useMemo: React.useMemo,
    useRef: React.useRef,
    useState: React.useState,
    useTypedRedux: (_store: string, key: string) =>
      key === "account_id" ? "account" : mockOtherSettings,
  };
});

import { useAgentWorkspaceOrganization } from "./use-workspace-organization";

function agent(id: string): NamedAgent {
  return {
    account_id: "account",
    name: id,
    endpoint: { project_id: "project", agent_id: id },
    path: `${id}.chat`,
    thread_id: id,
    available: true,
    updated_at: new Date(0).toISOString(),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOtherSettings = Map();
});

it("serializes rapid organization writes and computes from optimistic state", async () => {
  const first = deferred();
  const second = deferred();
  mockSave
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const { result } = renderHook(() =>
    useAgentWorkspaceOrganization([agent("a"), agent("b"), agent("c")]),
  );

  act(() => result.current.setMode("custom"));
  act(() => result.current.move("b", -1));
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  expect(result.current.organization.mode).toBe("custom");
  expect(result.current.organization.custom).toEqual(["b", "a", "c"]);

  first.resolve();
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(2));
  expect(mockSave.mock.calls[1][1]).toMatchObject({
    mode: "custom",
    custom: '["b","a","c"]',
  });
  second.resolve();
  await act(async () => await second.promise);
});

it("persists hiding as personal workspace organization", async () => {
  const save = deferred();
  mockSave.mockReturnValue(save.promise);
  const { result } = renderHook(() =>
    useAgentWorkspaceOrganization([agent("a"), agent("b")]),
  );

  act(() => result.current.setHidden("a", true));

  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  expect(mockSave.mock.calls[0][1]).toMatchObject({
    hidden: '["a"]',
    pinned: "[]",
  });
  expect(result.current.groups.hidden.map(({ name }) => name)).toEqual(["a"]);
  save.resolve();
  await act(async () => await save.promise);
});

it("persists message activity without writing merely because an agent exists", async () => {
  const save = deferred();
  mockSave.mockReturnValue(save.promise);
  const { result } = renderHook(() =>
    useAgentWorkspaceOrganization([agent("a"), agent("b")]),
  );

  await act(async () => {});
  expect(mockSave).not.toHaveBeenCalled();

  act(() => result.current.recordActivity("b", 123));
  await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  expect(mockSave.mock.calls[0][1]).toMatchObject({
    lastOpened: '{"b":123}',
  });

  save.resolve();
  await act(async () => await save.promise);
});
