/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { act, renderHook } from "@testing-library/react";
import { useClaudeRuntimeDefault } from "./use-claude-runtime-default";

type Check = { claudeConnected: boolean; claudeIncluded: boolean };

function deferred() {
  let resolve: (value: Check) => void = () => {};
  const promise = new Promise<Check>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(
  overrides: Partial<Parameters<typeof useClaudeRuntimeDefault>[0]> = {},
) {
  const check = deferred();
  let chosen = false;
  const onClaude = jest.fn();
  const props = {
    codexRuntime: true,
    runtimeChosen: () => chosen,
    codexOwnPlan: false as boolean | undefined,
    accountId: "a",
    checkClaude: jest.fn(() => check.promise),
    onClaude,
    ...overrides,
  };
  const hook = renderHook((p: typeof props) => useClaudeRuntimeDefault(p), {
    initialProps: props,
  });
  return {
    hook,
    props,
    check,
    onClaude,
    choose: () => {
      chosen = true;
      act(() => hook.result.current.settle());
    },
  };
}

describe("the Claude runtime default", () => {
  it("holds creation until the Claude check settles, then switches", async () => {
    const { hook, check, onClaude } = setup();
    expect(hook.result.current.settled).toBe(false);
    await act(async () => {
      check.resolve({ claudeConnected: false, claudeIncluded: true });
      await check.promise;
    });
    expect(onClaude).toHaveBeenCalledTimes(1);
    expect(hook.result.current.settled).toBe(true);
  });

  it("settles as Codex when Claude cannot run the agent", async () => {
    const { hook, check, onClaude } = setup();
    await act(async () => {
      check.resolve({ claudeConnected: false, claudeIncluded: false });
      await check.promise;
    });
    expect(onClaude).not.toHaveBeenCalled();
    expect(hook.result.current.settled).toBe(true);
  });

  it("waits for the Codex payment source before checking", async () => {
    const { hook, props } = setup({ codexOwnPlan: undefined });
    expect(props.checkClaude).not.toHaveBeenCalled();
    expect(hook.result.current.settled).toBe(false);
    hook.rerender({ ...props, codexOwnPlan: false });
    expect(props.checkClaude).toHaveBeenCalledTimes(1);
  });

  it("lets the user's own choice win over a check still running", async () => {
    const { hook, check, onClaude, choose } = setup();
    choose();
    expect(hook.result.current.settled).toBe(true);
    await act(async () => {
      check.resolve({ claudeConnected: true, claudeIncluded: true });
      await check.promise;
    });
    expect(onClaude).not.toHaveBeenCalled();
  });

  it("starts settled for a source agent's runtime or a non-Codex form", () => {
    expect(
      setup({ runtimeChosen: () => true }).hook.result.current.settled,
    ).toBe(true);
    expect(setup({ codexRuntime: false }).hook.result.current.settled).toBe(
      true,
    );
  });

  it("gives up on a check that takes too long, staying Codex", () => {
    jest.useFakeTimers();
    try {
      const { hook, onClaude } = setup({ timeoutMs: 1_000 });
      act(() => {
        jest.advanceTimersByTime(1_000);
      });
      expect(hook.result.current.settled).toBe(true);
      expect(onClaude).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
