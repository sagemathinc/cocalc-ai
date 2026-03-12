/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render, screen } from "@testing-library/react";
import { EventEmitter } from "events";

let currentAccountId: string | undefined;
let currentReady = false;

class FakeAccountStore extends EventEmitter {
  get(key: string) {
    if (key === "is_ready") return currentReady;
    return undefined;
  }
}

const store = new FakeAccountStore();

jest.mock("@cocalc/frontend/app-framework", () => {
  const React = require("react");
  return {
    redux: {
      getStore: () => store,
    },
    useEffect: React.useEffect,
    useState: React.useState,
    useTypedRedux: (_store: string, field: string) => {
      if (field === "account_id") return currentAccountId;
      if (field === "is_ready") return currentReady;
      throw new Error(`Unexpected field: ${field}`);
    },
  };
});

import { useAccountStoreReady } from "./account-store-ready";

function Probe() {
  return <div>{useAccountStoreReady() ? "ready" : "waiting"}</div>;
}

describe("useAccountStoreReady", () => {
  beforeEach(() => {
    currentAccountId = "account-1";
    currentReady = false;
    store.removeAllListeners();
  });

  it("resets readiness when the account changes and waits for the new store to be ready", () => {
    const view = render(<Probe />);
    expect(screen.getByText("waiting")).toBeTruthy();

    currentReady = true;
    act(() => {
      store.emit("is_ready");
    });
    expect(screen.getByText("ready")).toBeTruthy();

    currentAccountId = "account-2";
    currentReady = false;
    view.rerender(<Probe />);
    expect(screen.getByText("waiting")).toBeTruthy();

    currentReady = true;
    act(() => {
      store.emit("is_ready");
    });
    expect(screen.getByText("ready")).toBeTruthy();
  });
});
