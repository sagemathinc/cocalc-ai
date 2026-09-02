/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ClientRequest, IncomingMessage } from "node:http";

import { sanitizeAppUpstreamRequest } from "./upstream-auth-boundary";

describe("application upstream auth boundary", () => {
  it("strips CoCalc credentials while preserving application auth", () => {
    const headers = new Map<string, string>([
      ["authorization", "Bearer application-token"],
      ["x-cocalc-project-secret", "internal-secret"],
      ["x-cocalc-project-account-id", "account-id"],
      ["x-cocalc-app-exposure", "private"],
      ["x-cocalc-public-app-host", "demo.example.invalid"],
      [
        "cookie",
        [
          "cocalc_project_host_http_bearer=bearer",
          "cocalc_project_host_http_session=http-session",
          "cocalc_project_host_session=browser-session",
          "app_session=keep-me",
        ].join("; "),
      ],
    ]);
    const proxyReq = {
      removeHeader: (name: string) => headers.delete(name.toLowerCase()),
      setHeader: (name: string, value: string) =>
        headers.set(name.toLowerCase(), value),
    } as unknown as ClientRequest;
    const req = {
      headers: {
        cookie: headers.get("cookie"),
      },
    } as IncomingMessage;

    sanitizeAppUpstreamRequest(proxyReq, req);

    expect(headers.get("authorization")).toBe("Bearer application-token");
    expect(headers.get("cookie")).toBe("app_session=keep-me");
    expect(headers.has("x-cocalc-project-secret")).toBe(false);
    expect(headers.has("x-cocalc-project-account-id")).toBe(false);
    expect(headers.has("x-cocalc-app-exposure")).toBe(false);
    expect(headers.has("x-cocalc-public-app-host")).toBe(false);
  });
});
