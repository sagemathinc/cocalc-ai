/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockSettings = jest.fn();
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => mockSettings(),
}));
const mockReserve = jest.fn();
jest.mock("./board-decide-funding", () => ({
  siteFundedDecideFunding: () => ({ reserve: mockReserve }),
}));

import { boardDecideEnabled, boardDecideLocal } from "./board-decide-service";

const request = {
  account_id: "11111111-1111-4111-8111-111111111111",
  request_id: "00000000-0000-4000-8000-000000000001",
  question: {
    prompt: "What does transitive mean?",
    options: [
      { name: "one-orbit-correct" },
      { name: "confuses-with-faithful" },
    ],
  },
  answer: "every point can reach every other",
};

beforeEach(() => jest.clearAllMocks());

test("off by default: refused, and nothing is reserved or sent", async () => {
  mockSettings.mockResolvedValue({
    board_decide_enabled: false,
    openrouter_api_key: "k",
  });
  await expect(boardDecideLocal(request)).rejects.toMatchObject({ code: 503 });
  expect(mockReserve).not.toHaveBeenCalled();
});

test("on without a key: refused, and nothing is reserved or sent", async () => {
  mockSettings.mockResolvedValue({
    board_decide_enabled: true,
    openrouter_api_key: "  ",
  });
  expect(await boardDecideEnabled()).toBe(false);
  await expect(boardDecideLocal(request)).rejects.toMatchObject({ code: 503 });
  expect(mockReserve).not.toHaveBeenCalled();
});

test("not signed in: refused", async () => {
  mockSettings.mockResolvedValue({
    board_decide_enabled: true,
    openrouter_api_key: "k",
  });
  await expect(
    boardDecideLocal({ ...request, account_id: undefined }),
  ).rejects.toMatchObject({
    code: 401,
  });
});

test("on with a key: enabled", async () => {
  mockSettings.mockResolvedValue({
    board_decide_enabled: true,
    openrouter_api_key: "k",
  });
  expect(await boardDecideEnabled()).toBe(true);
});
