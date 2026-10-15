/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The delivery poll runs on every hub: with computers off (the
// default) a pass must not touch the database.

const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
const connect = jest.fn(async () => ({
  query,
  release: jest.fn(),
}));
let settings: { computers_enabled?: boolean } = {};

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query, connect }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => settings,
}));
jest.mock("./relay", () => ({ HUB_PROCESS: "hub-test", hubClient: jest.fn() }));
jest.mock("./state", () => ({ computerStateSnapshot: jest.fn() }));

import {
  kickComputerStateDelivery,
  startComputerStateDelivery,
  stopComputerStateDelivery,
} from "./delivery";

describe("computer state delivery gate", () => {
  beforeAll(() => startComputerStateDelivery());
  afterAll(() => stopComputerStateDelivery());
  beforeEach(() => {
    query.mockClear();
    connect.mockClear();
  });

  it("makes no database query while computers are off", async () => {
    for (const value of [{}, { computers_enabled: false }]) {
      settings = value;
      await kickComputerStateDelivery();
    }
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("delivers once computers are on", async () => {
    settings = { computers_enabled: true };
    await kickComputerStateDelivery();
    expect(query).toHaveBeenCalled();
  });
});
