/*
The restart of a notebook's history from its saved .ipynb owns the
SyncClient it makes for a request and releases it, however the request
ends: each SyncClient listens to the project's long-lived conat client
("closed") until released, so repeated requests must leave no listeners
behind (the leak LIMIT-H1B3C-1 found in the live-writer seed, here in the
restart).
*/

import { EventEmitter } from "node:events";

jest.mock("@cocalc/jupyter/nbgrader/jupyter-parse", () => ({}));
jest.mock("@cocalc/jupyter/nbgrader/jupyter-run", () => ({}));
jest.mock("../../jupyter/convert", () => ({}));
jest.mock("../../formatters", () => ({}));
jest.mock("@cocalc/jupyter/kernel/logo", () => ({}));
jest.mock("@cocalc/jupyter/kernel/kernel-data", () => ({}));
jest.mock("@cocalc/jupyter/stateless-api/execute", () => ({}));
jest.mock("@cocalc/project/client", () => ({ getClient: () => mockClient }));
jest.mock("@cocalc/project/data", () => ({ project_id: "test-project" }));
jest.mock("@cocalc/jupyter/control", () => ({
  isRunning: jest.fn(() => false),
  createJupyterSyncFilesystem: jest.fn((fs) => fs),
}));

const mockConat = new EventEmitter();
const mockClient = { conat: () => mockConat };

describe("the restart from the saved .ipynb releases its SyncClient", () => {
  const N = 30;
  let api: typeof import("./jupyter");

  beforeEach(async () => {
    jest.resetModules();
    api = await import("./jupyter");
    const { resetHistoryRestartState } =
      await import("@cocalc/jupyter/history-restart");
    resetHistoryRestartState();
  });

  const listeners = () => mockConat.listenerCount("closed");

  it("refused, or failed, repeatedly: no listener is left behind", async () => {
    const before = listeners();
    for (let i = 0; i < N; i++) {
      // invalid: refused before any work
      expect(
        await api.restartHistoryFromIpynb({
          path: "/home/user/a.ipynb",
          epoch: -1,
          revision: { seq: 0, count: 0 },
        }),
      ).toMatchObject({ restarted: false, reason: "invalid" });
      // valid, but the history can't be reached: refused, never thrown
      const result = await api.restartHistoryFromIpynb({
        path: "/home/user/a.ipynb",
        epoch: 0,
        revision: { seq: 0, count: 0 },
      });
      expect(result.restarted).toBe(false);
      expect(listeners()).toBe(before);
    }
  });
});
