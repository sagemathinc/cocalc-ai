/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { AppRedux } from "./AppRedux";
import { project_redux_name, redux_name } from "@cocalc/util/redux/name";

class TestAppRedux extends AppRedux {
  getProjectTable(_project_id: string, _name: string) {
    return undefined;
  }

  getTable(_name: string) {
    return undefined;
  }

  removeTable(_name: string): void {}
}

const projectId = "00000000-1000-4000-8000-000000000000";

describe("AppRedux editor path fallback", () => {
  it("returns sync-path actions when only display_path is open", () => {
    const app = new TestAppRedux();
    const displayPath = "/tmp/b.txt";
    const syncPath = "/tmp/a.txt";

    app.createStore(project_redux_name(projectId), undefined, {
      open_files: {
        [displayPath]: {
          sync_path: syncPath,
        },
      },
    });
    const syncActions = app.createActions(redux_name(projectId, syncPath));

    expect(app.getEditorActions(projectId, displayPath)).toBe(syncActions);
  });

  it("returns sync-path store when only display_path is open", () => {
    const app = new TestAppRedux();
    const displayPath = "/tmp/b.txt";
    const syncPath = "/tmp/a.txt";

    app.createStore(project_redux_name(projectId), undefined, {
      open_files: {
        [displayPath]: {
          sync_path: syncPath,
        },
      },
    });
    const syncStore = app.createStore(redux_name(projectId, syncPath));

    expect(app.getEditorStore(projectId, displayPath)).toBe(syncStore);
  });

  it("prefers direct path actions when both direct and sync actions exist", () => {
    const app = new TestAppRedux();
    const displayPath = "/tmp/b.txt";
    const syncPath = "/tmp/a.txt";

    app.createStore(project_redux_name(projectId), undefined, {
      open_files: {
        [displayPath]: {
          sync_path: syncPath,
        },
      },
    });
    const directActions = app.createActions(redux_name(projectId, displayPath));
    app.createActions(redux_name(projectId, syncPath));

    expect(app.getEditorActions(projectId, displayPath)).toBe(directActions);
  });

  it("returns undefined when display_path has no sync mapping and no direct entry", () => {
    const app = new TestAppRedux();
    app.createStore(project_redux_name(projectId), undefined, {
      open_files: {},
    });
    expect(app.getEditorActions(projectId, "/tmp/missing.txt")).toBeUndefined();
    expect(app.getEditorStore(projectId, "/tmp/missing.txt")).toBeUndefined();
  });
});
