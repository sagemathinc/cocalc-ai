/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

const changefeedMock = jest.fn();

jest.mock("@cocalc/conat/hub/changefeeds", () => ({
  changefeed: (...args) => changefeedMock(...args),
}));

import { ConatChangefeed } from "../changefeed-conat";

describe("ConatChangefeed", () => {
  beforeEach(() => {
    changefeedMock.mockReset();
  });

  it("requires an explicit client", () => {
    expect(
      () =>
        new ConatChangefeed({
          account_id: "6aae57c6-08f1-4bb5-848b-3ceb53e61ede",
          query: { accounts: [{ account_id: null }] },
        } as any),
    ).toThrow("changefeed must provide an explicit Conat client");
  });

  it("uses an explicit client when provided", async () => {
    const explicitClient = { id: "explicit" } as any;
    const cf = Object.assign(new EventEmitter(), {
      next: jest.fn().mockResolvedValue({
        done: false,
        value: { accounts: [{ account_id: "a" }] },
      }),
      close: jest.fn(),
      [Symbol.asyncIterator]: async function* () {},
    });
    changefeedMock.mockReturnValue(cf);

    const changefeed = new ConatChangefeed({
      account_id: "6aae57c6-08f1-4bb5-848b-3ceb53e61ede",
      query: { accounts: [{ account_id: null }] },
      client: explicitClient,
    });

    const init = await changefeed.connect();

    expect(changefeedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client: explicitClient,
      }),
    );
    expect(init).toEqual([{ account_id: "a" }]);
  });
});
