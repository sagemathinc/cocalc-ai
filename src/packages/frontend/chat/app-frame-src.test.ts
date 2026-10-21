/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, renderHook, waitFor } from "@testing-library/react";

const getProjectAppFrameUrl = jest.fn();
jest.mock("@cocalc/frontend/project/app-server-open", () => ({
  ...jest.requireActual("@cocalc/frontend/project/app-server-open"),
  getProjectAppFrameUrl: (opts: any) => getProjectAppFrameUrl(opts),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/project/host-url", () => ({
  withProjectHostBase: (_p: string, url?: string) => url,
}));

import { useAppFrameSrc } from "./app-frame-src";

const P = "11111111-1111-4111-8111-111111111111";
const HOST_URL = `https://host-1.example/${P}/proxy/8000/?cocalc_project_host_token=t`;
const FRAME_ORIGIN = "https://ap8000-x.h-y.content.test";

function post(origin: string, data: any) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { origin, data }));
  });
}

describe("useAppFrameSrc", () => {
  beforeEach(() => {
    getProjectAppFrameUrl.mockReset();
    let n = 0;
    getProjectAppFrameUrl.mockImplementation(
      async () => `${FRAME_ORIGIN}/_af/CAP${++n}?next=x`,
    );
  });

  it("asks for its own frame link for the app's path, without the host token", async () => {
    const { result } = renderHook(() =>
      useAppFrameSrc({ projectId: P, appId: "a", hostUrl: HOST_URL }),
    );
    await waitFor(() =>
      expect(result.current.src).toBe(`${FRAME_ORIGIN}/_af/CAP1?next=x`),
    );
    expect(getProjectAppFrameUrl).toHaveBeenCalledWith({
      project_id: P,
      path: `/${P}/proxy/8000/`,
      app_id: "a",
    });
    expect(result.current.openUrl).toBe(`/app-open/${P}/proxy/8000/?app=a`);
  });

  it("uses the host URL on sites without app origins", async () => {
    getProjectAppFrameUrl.mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAppFrameSrc({ projectId: P, appId: "a", hostUrl: HOST_URL }),
    );
    await waitFor(() => expect(result.current.src).toBe(HOST_URL));
  });

  it("bootstraps once more when the frame has no session, then gives up", async () => {
    const { result } = renderHook(() =>
      useAppFrameSrc({ projectId: P, appId: "a", hostUrl: HOST_URL }),
    );
    await waitFor(() => expect(result.current.src).toContain("CAP1"));
    const msg = { type: "cocalc-app-frame", status: "no-session" };
    // Other origins and other messages are ignored.
    post("https://evil.example", msg);
    post(FRAME_ORIGIN, { type: "other" });
    expect(result.current.blocked).toBe(false);
    post(FRAME_ORIGIN, msg);
    await waitFor(() => expect(result.current.src).toContain("CAP2"));
    expect(result.current.blocked).toBe(false);
    post(FRAME_ORIGIN, msg);
    await waitFor(() => expect(result.current.blocked).toBe(true));
  });
});
