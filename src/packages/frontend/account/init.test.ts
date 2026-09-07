/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

const mockWebappClient = new EventEmitter() as EventEmitter & {
  idle_client: { set_standby_timeout_m: jest.Mock };
};
mockWebappClient.idle_client = { set_standby_timeout_m: jest.fn() };

const mockGetControlPlaneAuthBootstrap = jest.fn();
const mockAlertMessage = jest.fn();
const mockLogWarn = jest.fn();
const mockWaitForExamModeConfiguration = jest.fn(async () => false);
const mockLiteState = { lite: false };
const mockWaitForAccountTableConnected = jest.fn(async () => undefined);

jest.mock("../webapp-client", () => ({ webapp_client: mockWebappClient }));
jest.mock("@cocalc/frontend/client/handle-target", () => ({
  __esModule: true,
  default: "",
}));
jest.mock("@cocalc/frontend/page-routing", () => ({
  getInitialAccountPageState: jest.fn(() => null),
  parsePageTarget: jest.fn(() => ({})),
}));
jest.mock("./appearance", () => ({ initAccountAppearance: jest.fn() }));
jest.mock("../client/password-reset", () => ({
  reset_password_key: jest.fn(() => undefined),
}));
jest.mock("@cocalc/frontend/misc/remember-me", () => ({
  hasRememberMe: jest.fn(() => false),
}));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));
jest.mock("./table-bootstrap", () => ({ initAccountTable: jest.fn() }));
jest.mock("@cocalc/frontend/purchases/managed-egress-blocked", () => ({
  parseManagedEgressBlockedError: jest.fn(() => null),
}));
jest.mock("@cocalc/frontend/auth/api", () => ({
  getControlPlaneAuthBootstrap: (...args: any[]) =>
    mockGetControlPlaneAuthBootstrap(...args),
}));
jest.mock("./wait-for-account-table-connected", () => ({
  waitForAccountTableConnectedForSignIn: (...args: any[]) =>
    mockWaitForAccountTableConnected(...args),
}));
jest.mock("@cocalc/frontend/customize/exam-mode", () => ({
  waitForExamModeConfiguration: (...args: any[]) =>
    mockWaitForExamModeConfiguration(...args),
}));
jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: (...args: any[]) => mockAlertMessage(...args),
}));
jest.mock("@cocalc/frontend/logger", () => ({
  getLogger: () => ({ warn: (...args: any[]) => mockLogWarn(...args) }),
}));
jest.mock("@cocalc/frontend/lite", () => mockLiteState);

import { init } from "./init";

function createRedux({
  emitStoreChangeOnSignIn = false,
  accountTableState = "connected",
}: {
  emitStoreChangeOnSignIn?: boolean;
  accountTableState?: string;
} = {}) {
  const state: Record<string, any> = emitStoreChangeOnSignIn
    ? { account_id: "account-1" }
    : {};
  const store = Object.assign(new EventEmitter(), {
    get: jest.fn((key: string) => state[key]),
  });
  const actions = {
    _init: jest.fn(),
    setState: jest.fn((patch: Record<string, any>) =>
      Object.assign(state, patch),
    ),
    set_user_type: jest.fn((userType: string) => {
      if (!emitStoreChangeOnSignIn) {
        return;
      }
      state.is_logged_in = userType === "signed_in";
      store.emit("change");
    }),
  };
  const redux = {
    createStore: jest.fn(() => store),
    createActions: jest.fn(() => actions),
    getActions: jest.fn(() => actions),
    getTable: jest.fn(() => ({
      _table: { get_state: () => accountTableState },
    })),
  };
  return { actions, redux };
}

describe("account initialization", () => {
  beforeEach(() => {
    mockWebappClient.removeAllListeners();
    mockGetControlPlaneAuthBootstrap.mockReset();
    mockAlertMessage.mockReset();
    mockLogWarn.mockReset();
    mockWaitForExamModeConfiguration.mockClear();
    mockLiteState.lite = false;
    mockWaitForAccountTableConnected.mockReset();
    mockWaitForAccountTableConnected.mockResolvedValue(undefined);
  });

  it("loads routing metadata before exposing signed-in state", async () => {
    let resolveBootstrap: (value: any) => void = () => undefined;
    mockGetControlPlaneAuthBootstrap.mockReturnValue(
      new Promise((resolve) => {
        resolveBootstrap = resolve;
      }),
    );
    const { actions, redux } = createRedux();
    init(redux);
    const signedIn = mockWebappClient.listeners("signed_in")[0] as (message: {
      account_id: string;
    }) => Promise<void>;

    const signInPromise = signedIn({ account_id: "account-1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGetControlPlaneAuthBootstrap).toHaveBeenCalledTimes(1);
    expect(actions.set_user_type).not.toHaveBeenCalledWith("signed_in");

    resolveBootstrap({
      signed_in: true,
      home_bay_id: "bay-1",
      impersonation: null,
    });
    await signInPromise;

    expect(actions.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        home_bay_id: "bay-1",
        impersonation: null,
      }),
    );
    expect(actions.set_user_type).toHaveBeenCalledWith("signed_in");
  });

  it("loads routing metadata while waiting for the account snapshot", async () => {
    let resolveAccountTable: () => void = () => undefined;
    mockWaitForAccountTableConnected.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAccountTable = resolve;
      }),
    );
    mockGetControlPlaneAuthBootstrap.mockResolvedValue({
      signed_in: true,
      home_bay_id: "bay-1",
      impersonation: null,
    });
    const { actions, redux } = createRedux({
      accountTableState: "connecting",
    });
    init(redux);
    const signedIn = mockWebappClient.listeners("signed_in")[0] as (message: {
      account_id: string;
    }) => Promise<void>;

    const signInPromise = signedIn({ account_id: "account-1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGetControlPlaneAuthBootstrap).toHaveBeenCalledTimes(1);
    expect(actions.set_user_type).not.toHaveBeenCalledWith("signed_in");

    resolveAccountTable();
    await signInPromise;

    expect(actions.set_user_type).toHaveBeenCalledWith("signed_in");
  });

  it("loads routing metadata only once when signed-in state changes", async () => {
    mockGetControlPlaneAuthBootstrap.mockResolvedValue({
      signed_in: true,
      home_bay_id: "bay-1",
      impersonation: null,
    });
    const { redux } = createRedux({ emitStoreChangeOnSignIn: true });
    init(redux);
    const signedIn = mockWebappClient.listeners("signed_in")[0] as (message: {
      account_id: string;
    }) => Promise<void>;

    await signedIn({ account_id: "account-1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGetControlPlaneAuthBootstrap).toHaveBeenCalledTimes(1);
  });

  it("warns when control-plane bootstrap fails", async () => {
    mockGetControlPlaneAuthBootstrap.mockRejectedValue(
      new Error("bootstrap unavailable"),
    );
    const { actions, redux } = createRedux();
    init(redux);
    const signedIn = mockWebappClient.listeners("signed_in")[0] as (message: {
      account_id: string;
    }) => Promise<void>;

    await signedIn({ account_id: "account-1" });
    await Promise.resolve();

    expect(mockLogWarn).toHaveBeenCalledWith(
      "failed to load account routing information",
      expect.any(Error),
    );
    expect(mockAlertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining(
          "could not load account routing information",
        ),
      }),
    );
    expect(actions.set_user_type).toHaveBeenCalledWith("signed_in");
  });

  it("does not show the routing warning in lite mode", async () => {
    mockLiteState.lite = true;
    mockGetControlPlaneAuthBootstrap.mockRejectedValue(
      new Error("bootstrap unavailable"),
    );
    const { actions, redux } = createRedux();
    init(redux);
    const signedIn = mockWebappClient.listeners("signed_in")[0] as (message: {
      account_id: string;
    }) => Promise<void>;

    await signedIn({ account_id: "account-1" });
    await Promise.resolve();

    expect(mockLogWarn).toHaveBeenCalledWith(
      "failed to load account routing information",
      expect.any(Error),
    );
    expect(mockAlertMessage).not.toHaveBeenCalled();
    expect(actions.set_user_type).toHaveBeenCalledWith("signed_in");
  });

  it("ignores a bootstrap failure after sign-out", async () => {
    let rejectBootstrap: (reason: Error) => void = () => undefined;
    mockGetControlPlaneAuthBootstrap.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectBootstrap = reject;
      }),
    );
    const { actions, redux } = createRedux();
    init(redux);
    const signedIn = mockWebappClient.listeners("signed_in")[0] as (message: {
      account_id: string;
    }) => Promise<void>;
    const signedOut = mockWebappClient.listeners("signed_out")[0] as () => void;

    const signInPromise = signedIn({ account_id: "account-1" });
    await Promise.resolve();
    await Promise.resolve();
    signedOut();
    rejectBootstrap(new Error("bootstrap unavailable"));
    await signInPromise;

    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockAlertMessage).not.toHaveBeenCalled();
    expect(actions.set_user_type).not.toHaveBeenCalledWith("signed_in");
  });

  it("ignores sign-in invalidated before routing bootstrap starts", async () => {
    let resolveExamMode: (value: boolean) => void = () => undefined;
    mockWaitForExamModeConfiguration.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveExamMode = resolve;
      }),
    );
    mockGetControlPlaneAuthBootstrap.mockResolvedValue({
      signed_in: true,
      home_bay_id: "bay-1",
      impersonation: null,
    });
    const { actions, redux } = createRedux();
    init(redux);
    const signedIn = mockWebappClient.listeners("signed_in")[0] as (message: {
      account_id: string;
    }) => Promise<void>;
    const signedOut = mockWebappClient.listeners("signed_out")[0] as () => void;

    const signInPromise = signedIn({ account_id: "account-1" });
    await Promise.resolve();
    signedOut();
    resolveExamMode(false);
    await signInPromise;

    expect(mockGetControlPlaneAuthBootstrap).not.toHaveBeenCalled();
    expect(actions.set_user_type).not.toHaveBeenCalledWith("signed_in");
  });
});
