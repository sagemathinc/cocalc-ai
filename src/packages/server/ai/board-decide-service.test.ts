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
  board: {
    project_id: "44444444-4444-4444-8444-444444444444",
    path: "/home/user/plan.board.json",
  },
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

test("one configuration read per call: the key that admitted it is the key it uses", async () => {
  // The key is removed right after the first read: the call must still use
  // the key that admitted it, and never read the settings again.
  mockSettings
    .mockResolvedValueOnce({
      board_decide_enabled: true,
      openrouter_api_key: "k1",
    })
    .mockResolvedValue({ board_decide_enabled: true, openrouter_api_key: "" });
  const commit = jest.fn(async () => {});
  mockReserve.mockResolvedValue({ commit, release: jest.fn(async () => {}) });
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      answers: {
        reader_answer: {
          type: "choice",
          choice: "one-orbit-correct",
          probabilities: {
            "one-orbit-correct": 0.9,
            "confuses-with-faithful": 0.1,
          },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 100, output_tokens: 0, cost: 0.0000042 },
    }),
  }));
  const realFetch = global.fetch;
  (global as any).fetch = fetchMock;
  try {
    const result = await boardDecideLocal(request);
    expect(result.options[0].name).toBe("one-orbit-correct");
  } finally {
    (global as any).fetch = realFetch;
  }
  expect(mockSettings).toHaveBeenCalledTimes(1);
  expect((fetchMock.mock.calls[0] as any)[1].headers.Authorization).toBe(
    "Bearer k1",
  );
  expect(commit).toHaveBeenCalledWith(5);
});
