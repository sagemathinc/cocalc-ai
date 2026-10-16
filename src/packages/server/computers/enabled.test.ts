/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The site's computers switch: which owner calls stay available while it is
// off (cleanup), and that everything else is refused before reaching the
// home bay.

const settings = { computers_enabled: false };
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => settings,
}));

const calls: string[] = [];
const homeApi = new Proxy(
  {},
  {
    // Not a thenable: `await` must return the proxy itself.
    get: (_target, name: string) =>
      name === "then"
        ? undefined
        : async () => {
            calls.push(name);
            return {};
          },
  },
);
jest.mock("@cocalc/server/computers/routing", () => ({
  computersAtAccountHome: async () => homeApi,
  accountHomeBay: async () => {
    calls.push("accountHomeBay");
    throw Error("not reached");
  },
  computersAtBay: () => homeApi,
}));

import { randomUUID } from "node:crypto";
import * as api from "@cocalc/server/conat/api/computers";
import { COMPUTERS_DISABLED } from "./enabled";

const account_id = randomUUID();
const computer_id = randomUUID();
const request_id = "R-0123456789";

beforeEach(() => {
  calls.length = 0;
  settings.computers_enabled = false;
});

describe("the computers switch", () => {
  it("leaves listing, declining and revoking available while off", async () => {
    await api.listComputers({ account_id });
    await api.listComputerRequests({ account_id });
    await api.declineComputerRequest({ account_id, request_id });
    await api.revokeComputer({ account_id, computer_id });
    expect(calls).toEqual(["list", "listRequests", "declineRequest", "revoke"]);
  });

  it("refuses requesting, approving and renaming while off", async () => {
    const refused: Promise<unknown>[] = [
      api.createComputerRequest({
        account_id,
        name: "laptop",
        project_id: randomUUID(),
      }),
      api.approveComputerRequest({
        account_id,
        request_id,
        pairing_phrase: "a-b-c-d",
      }),
      api.renameComputer({ account_id, computer_id, name: "x" }),
    ];
    for (const call of refused) {
      await expect(call).rejects.toThrow(COMPUTERS_DISABLED);
    }
    expect(calls).toEqual([]);
  });

  it("lets calls through once on", async () => {
    settings.computers_enabled = true;
    await api.createComputerRequest({
      account_id,
      name: "laptop",
      project_id: randomUUID(),
    });
    expect(calls).toEqual(["createRequest"]);
  });
});
