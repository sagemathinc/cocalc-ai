/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { fromJS } from "immutable";
import { EventEmitter } from "events";
import { createIntl, createIntlCache } from "react-intl";
import { useNavigationData } from "./use-data";
import { labels } from "@cocalc/frontend/i18n";
import { searchCandidates } from "./search";
import { ACCOUNT_PREFERENCES_EDITOR_PAGE } from "@cocalc/frontend/account/account-preferences-editor";
jest.mock("@cocalc/frontend/account/editor-settings/editor-settings", () => ({
  EditorSettings: () => null,
}));
const intl = createIntl({ locale: "en", messages: {} }, createIntlCache());
class Store extends EventEmitter {
  state: any;
  constructor(state) {
    super();
    this.state = fromJS(state);
  }
  get(key) {
    return this.state.get(key);
  }
  getIn(keys) {
    return this.state.getIn(keys);
  }
}
let projects: any;
let page: any;
let account: any;
let closedSession: Record<string, string[]>;
let stores: Record<string, Store>;
let dkv: any;
const getProjectStore = jest.fn((id) => stores[id]);
jest.mock("react-intl", () => ({
  ...jest.requireActual("react-intl"),
  useIntl: () => intl,
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    hasProjectStore: (id) => !!stores[id],
    getProjectStore: (id) => getProjectStore(id),
    getStore: (id) => stores[id],
    getActions: (name) =>
      name === "page"
        ? { closed_session_files: () => closedSession }
        : undefined,
  },
  useTypedRedux: (store, key) =>
    store === "projects"
      ? projects.get(key)
      : store === "page"
        ? page.get(key)
        : store === "account"
          ? account.get(key)
          : undefined,
}));
jest.mock("@cocalc/frontend/conat/account-dkv", () => ({
  getSharedAccountDkv: async () => dkv,
}));
jest.mock("@cocalc/frontend/account/settings-navigation", () => ({
  getVisibleSettingsNavigation: () => [
    {
      type: "group",
      label: labels.preferences,
      pages: [{ type: "page", page: "editor" }],
    },
  ],
  useSettingsNavigationContext: () => ({}),
}));
jest.mock("@cocalc/frontend/account/settings-page-registry", () => ({
  getRegisteredSettingsPageDefinition: () => ACCOUNT_PREFERENCES_EDITOR_PAGE,
}));
jest.mock("@cocalc/frontend/projects/use-bookmarked-projects", () => ({
  useBookmarkedProjects: () => ({ bookmarkedProjects: ["closed"] }),
}));
jest.mock("@cocalc/frontend/project/page/file-tab", () => ({
  FIXED_PROJECT_TABS: {
    files: { label: "Files" },
    rootfs: { label: "Image", noLite: true },
    agents: { label: "Agents" },
  },
}));
jest.mock("@cocalc/frontend/project/runtime-capabilities", () => ({
  useProjectRuntimeCapabilities: () => ({ mode: "workspace", rootfs: false }),
}));
jest.mock("@cocalc/frontend/lite", () => ({ lite: false }));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));
jest.mock("@cocalc/frontend/frame-editors/frame-tree/register", () => ({
  get_file_editor: () => undefined,
}));
import { noteActivity, resetRecentActivityForTests } from "./recent-activity";
jest.mock("@cocalc/frontend/logger", () => ({
  getLogger: () => ({ debug: jest.fn() }),
}));
beforeEach(() => {
  window.localStorage.clear();
  resetRecentActivityForTests();
  projects = fromJS({
    project_map: {
      active: { title: "Active" },
      other: { title: "Other" },
      closed: { title: "Bookmarked" },
    },
    open_projects: ["active", "other"],
  });
  page = fromJS({ active_top_tab: "active" });
  closedSession = {};
  account = fromJS({
    account_id: "account",
    user_type: "signed_in",
    groups: [],
  });
  stores = {
    active: new Store({ open_files_order: [] }),
    other: new Store({
      open_files_order: ["notes.tex"],
      open_files: { "notes.tex": { component: { redux_name: "editor" } } },
      project_log: {
        a: {
          time: new Date(),
          event: { event: "open", filename: "recent.tex" },
        },
        b: {
          time: new Date(),
          event: { event: "open", filename: "notes.tex" },
        },
      },
    }),
    editor: new Store({
      local_view_state: {
        active_id: "source",
        frame_tree: { id: "source", type: "cm" },
      },
    }),
  };
  dkv = new EventEmitter();
  dkv.getAll = () => ({ other: ["notes.tex"], closed: ["starred.tex"] });
  getProjectStore.mockClear();
});
it("combines open/recent/starred files across loaded projects without opening closed projects", async () => {
  const { result, unmount } = renderHook(() => useNavigationData());
  await waitFor(() =>
    expect(result.current.items.some((x) => x.title === "starred.tex")).toBe(
      true,
    ),
  );
  expect(
    result.current.items.filter((x) => x.id === "file:other:notes.tex"),
  ).toHaveLength(1);
  expect(result.current.items.some((x) => x.title === "recent.tex")).toBe(true);
  expect(getProjectStore).not.toHaveBeenCalledWith("closed");
  expect(dkv.listenerCount("change")).toBe(1);
  unmount();
  expect(dkv.listenerCount("change")).toBe(0);
  for (const store of Object.values(stores))
    expect(store.listenerCount("change")).toBe(0);
});
it("updates the preview frames when an inactive project's layout changes, without listing frames", async () => {
  const { result } = renderHook(() => useNavigationData());
  const file = () =>
    result.current.items.find((x) => x.id === "file:other:notes.tex")!;
  expect(file().editor?.frames.map((frame) => frame.id)).toEqual(["source"]);
  expect(file().keywords).toBeUndefined();
  expect(
    result.current.items.filter((x) => x.id.startsWith("file:other:notes.tex")),
  ).toHaveLength(1);
  act(() => {
    stores.editor.state = fromJS({
      local_view_state: {
        active_id: "pdf",
        frame_tree: { id: "pdf", type: "pdf" },
      },
    });
    stores.editor.emit("change");
  });
  await waitFor(() =>
    expect(file().editor?.frames.map((frame) => frame.id)).toEqual(["pdf"]),
  );
  expect(file().editor?.activeId).toBe("pdf");
});

it("lists a file once even when tabs, stars and the log spell its path differently", async () => {
  stores.other = new Store({
    open_files_order: ["/home/user/notes.tex"],
    open_files: {
      "/home/user/notes.tex": { component: { redux_name: "editor" } },
    },
    project_log: {
      a: {
        time: new Date(5000),
        event: { event: "open", filename: "notes.tex" },
      },
    },
  });
  dkv.getAll = () => ({ other: ["notes.tex"] });
  const { result } = renderHook(() => useNavigationData());
  await waitFor(() =>
    expect(
      result.current.items.some(
        (x) => x.detail.includes("Starred") || x.detail.includes("Open"),
      ),
    ).toBe(true),
  );
  const entries = result.current.items.filter((x) => x.title === "notes.tex");
  expect(entries).toHaveLength(1);
  expect(entries[0].id).toBe("file:other:/home/user/notes.tex");
  expect(entries[0].detail).toContain("Open");
  expect(entries[0].recent).toBe(5000);
  expect(entries[0].editor?.frames).toHaveLength(1);
});

it.each(["pre font", "pref size", "pref autosave", "pref line wrap"])(
  "finds preference controls from their shared labels for %s",
  async (query) => {
    const { result } = renderHook(() => useNavigationData());
    await waitFor(() =>
      expect(result.current.items.some((x) => x.title === "starred.tex")).toBe(
        true,
      ),
    );
    const [match] = searchCandidates(result.current.items, query);
    expect(match.item.destination).toEqual({
      kind: "settings",
      page: "editor",
    });
    expect(match.item.detail).toBe("Account › Preferences");
    expect(match.item.keywords).toContain("font");
    expect(match.item.keywords).toContain("size");
  },
);

it("lists the current project's open files first, most recently used first, before the project itself", async () => {
  stores.active = new Store({
    open_files_order: ["b.tex", "a.tex", "c.tex"],
    active_project_tab: "editor-a.tex",
  });
  const { result } = renderHook(() => useNavigationData());
  const titles = () =>
    searchCandidates(result.current.items, "")
      .map((match) => match.item.title)
      .slice(0, 4);
  // Tab order until something was used.
  expect(titles()).toEqual(["b.tex", "a.tex", "c.tex", "Active"]);
  noteActivity("active", "c.tex", 1000);
  noteActivity("active", "a.tex", 2000);
  const { result: fresh } = renderHook(() => useNavigationData());
  expect(
    searchCandidates(fresh.current.items, "")
      .map((match) => match.item.title)
      .slice(0, 4),
  ).toEqual(["a.tex", "c.tex", "b.tex", "Active"]);
  expect(fresh.current.currentEditor?.path).toBe("a.tex");
});

it("previews the persisted layout of a tab that has no editor store yet", async () => {
  stores.active = new Store({
    open_files_order: ["rnw.rnw"],
    open_files: { "rnw.rnw": { component: {} } },
  });
  window.localStorage.setItem(
    "editor-active-rnw.rnw",
    JSON.stringify({
      active_id: "pdf",
      frame_tree: {
        type: "node",
        direction: "col",
        children: [
          { id: "src", type: "cm" },
          { id: "pdf", type: "pdfjs_canvas" },
        ],
      },
    }),
  );
  const { result } = renderHook(() => useNavigationData());
  const file = result.current.items.find((x) => x.id === "file:active:rnw.rnw");
  expect(file?.editor?.activeId).toBe("pdf");
  expect(file?.editor?.frames.map((frame) => frame.label)).toEqual([
    "Source",
    "Pdfjs canvas",
  ]);
});

it("offers only the project pages the activity bar can open", async () => {
  const { result } = renderHook(() => useNavigationData());
  const pages = result.current.items
    .filter((x) => x.destination.kind === "project-page")
    .map((x) => x.id);
  // No rootfs runtime, no agent model configured: those pages render nothing.
  expect(pages).toEqual(["page:active:files", "page:other:files"]);
});

it("offers the top navigation pages, with Admin only for admins", async () => {
  const appPages = (items: any[]) =>
    items.filter((x) => x.destination.kind === "app-page").map((x) => x.id);
  const { result } = renderHook(() => useNavigationData());
  expect(appPages(result.current.items)).toEqual([
    "app:projects",
    "app:hosts",
    "app:notifications",
  ]);
  const [hosts] = searchCandidates(result.current.items, "hosts");
  expect(hosts.item.id).toBe("app:hosts");
  account = account.set("groups", fromJS(["admin"]));
  const { result: admin } = renderHook(() => useNavigationData());
  expect(appPages(admin.current.items)).toContain("app:admin");
  account = account.set("user_type", "public");
  const { result: signedOut } = renderHook(() => useNavigationData());
  expect(appPages(signedOut.current.items)).toEqual([]);
});

it("lists remembered tabs and recently used files of closed projects after a refresh", async () => {
  closedSession = { closed: ["old.tex", "starred.tex"] };
  noteActivity("closed", "used.rnw", 7000);
  const { result } = renderHook(() => useNavigationData());
  // The remembered tab list is available immediately; stars load later.
  await waitFor(() =>
    expect(
      result.current.items.find((x) => x.title === "starred.tex")?.detail,
    ).toContain("Starred"),
  );
  const closed = result.current.items.filter(
    (x) =>
      x.destination.kind === "file" && x.destination.projectId === "closed",
  );
  expect(closed.map((x) => x.title).sort()).toEqual([
    "old.tex",
    "starred.tex",
    "used.rnw",
  ]);
  const used = closed.find((x) => x.title === "used.rnw")!;
  expect(used.detail).toContain("Recent");
  expect(used.recent).toBe(7000);
  expect(closed.find((x) => x.title === "starred.tex")!.detail).toContain(
    "Starred",
  );
  expect(getProjectStore).not.toHaveBeenCalledWith("closed");
  expect(searchCandidates(result.current.items, "usde")[0].item.title).toBe(
    "used.rnw",
  );
});
