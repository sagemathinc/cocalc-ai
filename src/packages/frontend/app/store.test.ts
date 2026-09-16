/** @jest-environment jsdom */

import { redux } from "@cocalc/frontend/app-framework";
import { init_store } from "./store";

let mockTarget = "projects";
jest.mock("@cocalc/frontend/client/handle-target", () => ({
  __esModule: true,
  get default() {
    return mockTarget;
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  Store: class {},
  redux: { createStore: jest.fn() },
}));

const PROJECT = "00000000-0000-4000-8000-000000000002";

function initialState(target: string) {
  mockTarget = target;
  jest.mocked(redux.createStore).mockClear();
  init_store();
  return jest.mocked(redux.createStore).mock.calls[0][2] as any;
}

describe("initial project navigation context", () => {
  it("seeds context from a direct project URL without changing startup routing", () => {
    const state = initialState(`projects/${PROJECT}/files/example.txt`);
    expect(state.active_top_tab).toBe("project");
    expect(state.last_project_tab).toBe(PROJECT);
  });

  it.each(["projects", "settings", "admin", "auth/sign-in"])(
    "does not invent context on an initial %s route",
    (target) => {
      expect(initialState(target).last_project_tab).toBeUndefined();
    },
  );

  it.each(["not-a-project", "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"])(
    "ignores malformed project identifier %s",
    (id) => {
      expect(
        initialState(`projects/${id}/files/`).last_project_tab,
      ).toBeUndefined();
    },
  );

  it("does not persist a previous page instance's remembered project", () => {
    initialState(`projects/${PROJECT}/files/`);
    expect(initialState("settings").last_project_tab).toBeUndefined();
  });
});
