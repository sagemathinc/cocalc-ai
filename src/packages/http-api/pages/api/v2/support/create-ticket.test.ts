/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockCreateSupportTicket = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/support/create-ticket", () => ({
  __esModule: true,
  default: (...args) => mockCreateSupportTicket(...args),
}));

describe("/api/v2/support/create-ticket", () => {
  beforeEach(() => {
    mockGetAccountId.mockReset().mockResolvedValue(undefined);
    mockCreateSupportTicket
      .mockReset()
      .mockResolvedValue("https://support.example.com/requests/1");
  });

  it("never passes an internal policy, whatever the body says", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: {
        options: {
          email: "user@example.com",
          subject: "Help please",
          body: "Something is broken here.",
          source: "sagebrush-intake",
          skip_email_rules: true,
          extra_tags: ["sagebrush", "sb-no-email"],
        },
      },
    });

    const { default: handler } = await import("./create-ticket");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      url: "https://support.example.com/requests/1",
    });
    expect(mockCreateSupportTicket).toHaveBeenCalledTimes(1);
    // one argument only: the forged keys stay inside options, which
    // createTicket's normalization drops
    expect(mockCreateSupportTicket.mock.calls[0]).toHaveLength(1);
  });
});
