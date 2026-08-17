/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FrontendUpdateNotice, isFrontendUpdate } from "./frontend-update";

const fetchMock = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  global.fetch = fetchMock;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  jest.useRealTimers();
});

test("recognizes only a valid different build", () => {
  expect(isFrontendUpdate({ schema: 1, fingerprint: "new" }, "old")).toBe(true);
  expect(isFrontendUpdate({ schema: 1, fingerprint: "same" }, "same")).toBe(
    false,
  );
  expect(isFrontendUpdate({ schema: 1, fingerprint: "new" }, "")).toBe(false);
});

test("checks after the interval and offers a dismissible refresh", async () => {
  fetchMock.mockResolvedValue({
    json: async () => ({ schema: 1, fingerprint: "new" }),
    ok: true,
  });
  render(
    <FrontendUpdateNotice localFingerprint="old" checkIntervalMs={1_000} />,
  );

  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(1_000));
  expect(
    await screen.findByRole("button", { name: "Refresh to upgrade" }),
  ).toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith("/static/frontend-build.json", {
    cache: "no-store",
    credentials: "same-origin",
    signal: expect.any(AbortSignal),
  });

  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss frontend update notice" }),
  );
  expect(
    screen.queryByRole("button", { name: "Refresh to upgrade" }),
  ).not.toBeInTheDocument();

  await act(async () => jest.advanceTimersByTime(5_000));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("does not fetch while hidden and checks when the tab returns", async () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  fetchMock.mockResolvedValue({
    json: async () => ({ schema: 1, fingerprint: "same" }),
    ok: true,
  });
  render(
    <FrontendUpdateNotice localFingerprint="same" checkIntervalMs={1_000} />,
  );

  await act(async () => jest.advanceTimersByTime(1_000));
  expect(fetchMock).not.toHaveBeenCalled();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
});
