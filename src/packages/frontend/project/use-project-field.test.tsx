/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { createProjectFieldState, useProjectField } from "./use-project-field";

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    useAsyncEffect: (
      fn: (isMounted: () => boolean) => Promise<void> | void,
      deps: React.DependencyList,
    ) => {
      React.useEffect(() => {
        let mounted = true;
        void fn(() => mounted);
        return () => {
          mounted = false;
        };
      }, deps);
    },
    useCallback: React.useCallback,
    useEffect: React.useEffect,
    useRef: React.useRef,
    useState: React.useState,
    useTypedRedux: jest.fn(() => undefined),
  };
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolve0) => {
    resolve = resolve0;
  });
  return { promise, resolve };
}

function FieldConsumer({
  state,
  fetch,
  onRefresh,
}: {
  state: ReturnType<typeof createProjectFieldState<string>>;
  fetch: (project_id: string) => Promise<string | null>;
  onRefresh: (refresh: () => void) => void;
}) {
  const { refresh } = useProjectField({
    state,
    project_id: "project-1",
    projectMapField: "field",
    fetch,
  });

  React.useEffect(() => {
    onRefresh(refresh);
  }, [onRefresh, refresh]);

  return null;
}

describe("useProjectField", () => {
  it("deduplicates inflight fetches across subscribers and refreshes", async () => {
    const state = createProjectFieldState<string>(
      `field-dedupe-${Date.now()}-${Math.random()}`,
    );
    const first = createDeferred<string | null>();
    const second = createDeferred<string | null>();
    const fetch = jest
      .fn<Promise<string | null>, [string]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    let refreshA: (() => void) | undefined;
    let refreshB: (() => void) | undefined;

    render(
      <>
        <FieldConsumer
          state={state}
          fetch={fetch}
          onRefresh={(refresh) => {
            refreshA = refresh;
          }}
        />
        <FieldConsumer
          state={state}
          fetch={fetch}
          onRefresh={(refresh) => {
            refreshB = refresh;
          }}
        />
      </>,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    await act(async () => {
      first.resolve("first");
      await first.promise;
    });

    act(() => {
      refreshA?.();
      refreshB?.();
    });

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve("second");
      await second.promise;
    });
  });
});
