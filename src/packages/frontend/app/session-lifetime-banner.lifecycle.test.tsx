/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { act, render, screen } from "@testing-library/react";

let isLoggedIn = true;
let accountId: string | undefined = "account-a";

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store: string, field: string) => {
    if (field === "is_logged_in") return isLoggedIn;
    if (field === "account_id") return accountId;
    throw new Error(`Unexpected field: ${field}`);
  },
}));

const getSessionLifetime = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {
          getSessionLifetime: (...args) => getSessionLifetime(...args),
        },
      },
    },
  },
}));

const postAuthApi = jest.fn(
  async (_opts: any): Promise<any> => ({
    refreshed: true,
  }),
);
jest.mock("@cocalc/frontend/auth/api", () => ({
  postAuthApi: (...args) => postAuthApi(...args),
}));
jest.mock("@cocalc/frontend/control-plane-origin", () => ({
  getControlPlaneOrigin: () => "https://bay-1.example.test",
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
}));
jest.mock("@cocalc/frontend/components", () => ({
  TimeAgo: ({ date }) => <span>{`ends ${date}`}</span>,
}));

import { SessionLifetimeBanner } from "./session-lifetime-banner";

const DAY = 24 * 3600_000;

function ending(ms: number, renewable = true) {
  return {
    max_expire: new Date(Date.now() + ms).toISOString(),
    warn_before_ms: 3 * DAY,
    renewable,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  isLoggedIn = true;
  accountId = "account-a";
  getSessionLifetime.mockReset();
  postAuthApi.mockReset();
  postAuthApi.mockImplementation(async () => ({ refreshed: true }));
});

it("never shows one account's deadline to the next account", async () => {
  const a = ending(DAY);
  getSessionLifetime.mockResolvedValueOnce(a);
  const view = render(<SessionLifetimeBanner />);
  await flush();
  expect(screen.getByText(`ends ${a.max_expire}`)).toBeTruthy();

  // Sign out: the banner goes at once.
  isLoggedIn = false;
  accountId = undefined;
  view.rerender(<SessionLifetimeBanner />);
  expect(screen.queryByText(/^ends /)).toBeNull();

  // Sign in as someone else: nothing until their own answer arrives.
  const b = deferred<any>();
  getSessionLifetime.mockReturnValueOnce(b.promise);
  isLoggedIn = true;
  accountId = "account-b";
  view.rerender(<SessionLifetimeBanner />);
  await flush();
  expect(screen.queryByText(/^ends /)).toBeNull();
  const bLifetime = ending(2 * DAY);
  b.resolve(bLifetime);
  await flush();
  expect(screen.getByText(`ends ${bLifetime.max_expire}`)).toBeTruthy();
});

it("drops a late answer that belongs to an earlier account", async () => {
  const a = deferred<any>();
  getSessionLifetime.mockReturnValueOnce(a.promise);
  const view = render(<SessionLifetimeBanner />);
  await flush();

  const b = ending(5 * DAY); // not due yet
  getSessionLifetime.mockResolvedValueOnce(b);
  accountId = "account-b";
  view.rerender(<SessionLifetimeBanner />);
  await flush();

  a.resolve(ending(DAY));
  await flush();
  expect(screen.queryByText(/^ends /)).toBeNull();
});

it("clears the deadline when a refresh fails", async () => {
  jest.useFakeTimers();
  try {
    const a = ending(DAY);
    getSessionLifetime.mockResolvedValueOnce(a);
    render(<SessionLifetimeBanner />);
    await flush();
    expect(screen.getByText(`ends ${a.max_expire}`)).toBeTruthy();

    getSessionLifetime.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      jest.advanceTimersByTime(60 * 60_000);
    });
    await flush();
    expect(screen.queryByText(/^ends /)).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

it("keeps the cookie of a renewable session, at most daily", async () => {
  jest.useFakeTimers();
  try {
    getSessionLifetime.mockResolvedValue(ending(30 * DAY));
    render(<SessionLifetimeBanner />);
    await flush();
    expect(postAuthApi).toHaveBeenCalledTimes(1);
    // On the account's home bay, which has its session.
    expect(postAuthApi).toHaveBeenCalledWith({
      endpoint: "auth/refresh-session-cookie",
      body: {},
      origin: "https://bay-1.example.test",
    });
    // Hourly refreshes do not set the cookie again within a day.
    await act(async () => {
      jest.advanceTimersByTime(60 * 60_000);
    });
    await flush();
    expect(postAuthApi).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it("leaves an impersonation session's cookie alone", async () => {
  getSessionLifetime.mockResolvedValueOnce(ending(DAY / 24, false));
  render(<SessionLifetimeBanner />);
  await flush();
  expect(postAuthApi).not.toHaveBeenCalled();
  expect(screen.queryByText(/^ends /)).toBeNull();
});

it("tries the cookie again at the next refresh when it was not refreshed", async () => {
  jest.useFakeTimers();
  try {
    getSessionLifetime.mockResolvedValue(ending(30 * DAY));
    postAuthApi.mockResolvedValueOnce({ refreshed: false });
    render(<SessionLifetimeBanner />);
    await flush();
    expect(postAuthApi).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(60 * 60_000);
    });
    await flush();
    expect(postAuthApi).toHaveBeenCalledTimes(2);
    // Refreshed now: not again within the day.
    await act(async () => {
      jest.advanceTimersByTime(60 * 60_000);
    });
    await flush();
    expect(postAuthApi).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

it("never lets an older answer for the same account replace a newer one", async () => {
  jest.useFakeTimers();
  try {
    const first = ending(DAY);
    getSessionLifetime.mockResolvedValueOnce(first);
    render(<SessionLifetimeBanner />);
    await flush();
    expect(screen.getByText(`ends ${first.max_expire}`)).toBeTruthy();

    // An hourly refresh hangs; a later refresh (as after "Stay signed in")
    // answers first with the renewed deadline, which is not due yet.
    const slow = deferred<any>();
    getSessionLifetime.mockReturnValueOnce(slow.promise);
    await act(async () => {
      jest.advanceTimersByTime(60 * 60_000);
    });
    getSessionLifetime.mockResolvedValueOnce(ending(60 * DAY));
    await act(async () => {
      jest.advanceTimersByTime(60 * 60_000);
    });
    await flush();
    expect(screen.queryByText(/^ends /)).toBeNull();

    slow.resolve(first);
    await flush();
    expect(screen.queryByText(/^ends /)).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});
