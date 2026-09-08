/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";
import { fromJS } from "immutable";
const stores: Record<string, any> = {};
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name: string) => stores[name],
    hasProjectStore: (id: string) => !!stores[`project-${id}`],
    getProjectStore: (id: string) => stores[`project-${id}`],
  },
}));
import {
  noteActivity,
  recentActivity,
  resetRecentActivityForTests,
  trackRecentActivity,
} from "./recent-activity";

class Store extends EventEmitter {
  state: any;
  constructor(state: any) {
    super();
    this.state = fromJS(state);
  }
  get(key: string) {
    return this.state.get(key);
  }
  set(state: any) {
    this.state = fromJS(state);
    this.emit("change");
  }
}
beforeEach(() => {
  window.localStorage.clear();
  resetRecentActivityForTests();
  for (const key of Object.keys(stores)) delete stores[key];
});

it("keeps the newest entries and persists them", () => {
  for (let i = 0; i < 205; i++) noteActivity("p", `f${i}.txt`, i);
  const activity = recentActivity();
  expect(Object.keys(activity.p)).toHaveLength(200);
  expect(activity.p["f4.txt"]).toBeUndefined();
  expect(activity.p["f204.txt"]).toBe(204);
  resetRecentActivityForTests();
  expect(recentActivity().p["f204.txt"]).toBe(204);
});

it("records the active editor tab of the foreground project only", () => {
  stores.page = new Store({ active_top_tab: "a" });
  stores.projects = new Store({ open_projects: ["a", "b"] });
  stores["project-a"] = new Store({ active_project_tab: "editor-x.md" });
  stores["project-b"] = new Store({ active_project_tab: "editor-y.md" });
  const stop = trackRecentActivity();
  expect(Object.keys(recentActivity())).toEqual(["a"]);
  expect(recentActivity().a["x.md"]).toBeDefined();
  stores["project-b"].set({ active_project_tab: "editor-z.md" });
  expect(recentActivity().b).toBeUndefined();
  stores["project-a"].set({ active_project_tab: "files" });
  stores["project-a"].set({ active_project_tab: "editor-w.md" });
  expect(Object.keys(recentActivity().a)).toEqual(["x.md", "w.md"]);
  stores.page.set({ active_top_tab: "b" });
  expect(recentActivity().b["z.md"]).toBeDefined();
  stop();
  stores["project-b"].set({ active_project_tab: "editor-q.md" });
  expect(recentActivity().b["q.md"]).toBeUndefined();
  expect(stores["project-a"].listenerCount("change")).toBe(0);
});
