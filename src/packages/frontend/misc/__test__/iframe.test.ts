/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { download_file } from "../iframe";

describe("download_file", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("surfaces a blocked download message from the response header", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        get: (name: string) =>
          name === "X-CoCalc-Download-Error"
            ? encodeURIComponent("Managed download limit reached.")
            : null,
      },
    })) as typeof fetch;

    await expect(download_file("/download/me")).rejects.toThrow(
      "Managed download limit reached.",
    );
    expect(global.fetch).toHaveBeenCalledWith("/download/me", {
      method: "HEAD",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("falls back to the HTTP status when no detailed message is available", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "",
      headers: {
        get: () => null,
      },
    })) as typeof fetch;

    await expect(download_file("/download/me")).rejects.toThrow(
      "Unable to start download (HTTP 500)",
    );
  });
});
