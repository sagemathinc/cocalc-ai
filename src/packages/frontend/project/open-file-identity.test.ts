import { fromJS } from "immutable";

import {
  canonicalPath,
  findOpenDisplayPathForSyncPath,
  log_file_open,
  log_opened_time,
  mark_open_phase,
} from "./open-file";
import { termPath } from "@cocalc/util/terminal/names";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

describe("canonicalPath", () => {
  it("keeps ipynb path unchanged", () => {
    expect(canonicalPath("/root/notebook.ipynb")).toBe("/root/notebook.ipynb");
  });

  it("maps non-hidden term files to numbered term identity", () => {
    expect(canonicalPath("/root/shell.term")).toBe(
      termPath({ path: "/root/shell.term", cmd: "", number: 0 }),
    );
  });

  it("keeps hidden term files unchanged", () => {
    expect(canonicalPath("/root/.shell.term")).toBe("/root/.shell.term");
  });
});

describe("findOpenDisplayPathForSyncPath", () => {
  function mkActions(openFilesObj) {
    return {
      get_store: () =>
        fromJS({
          open_files: openFilesObj,
        }),
    } as any;
  }

  it("finds an already-open alias tab by matching sync_path", () => {
    const actions = mkActions({
      "/root/link.txt": { sync_path: "/root/real.txt" },
      "/root/other.txt": { sync_path: "/root/other.txt" },
    });
    expect(findOpenDisplayPathForSyncPath(actions, "/root/real.txt")).toBe(
      "/root/link.txt",
    );
  });

  it("ignores the excluded display path", () => {
    const actions = mkActions({
      "/root/link.txt": { sync_path: "/root/real.txt" },
    });
    expect(
      findOpenDisplayPathForSyncPath(actions, "/root/real.txt", "/root/link.txt"),
    ).toBeUndefined();
  });

  it("ignores tabs that do not have a sync_path", () => {
    const actions = mkActions({
      "/root/link.txt": { ext: "txt" },
      "/root/other.txt": { sync_path: "/root/other.txt" },
    });
    expect(findOpenDisplayPathForSyncPath(actions, "/root/real.txt")).toBeUndefined();
  });
});

describe("open-file logging updates", () => {
  const PROJECT_ID = "00000000-0000-4000-8000-000000000123";
  const PATH = "/root/open-log-test.txt";

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps filename/action in open update writes", () => {
    const log = jest.fn().mockReturnValue("open-log-entry-id");
    const mark_file = jest.fn();
    jest.spyOn(redux as any, "getProjectActions").mockReturnValue({ log });
    jest.spyOn(redux as any, "getActions").mockReturnValue({ mark_file });
    jest.spyOn(webapp_client.file_client as any, "is_deleted").mockReturnValue(false);

    log_file_open(PROJECT_ID, PATH);
    mark_open_phase(PROJECT_ID, PATH, "optimistic_ready", { bytes: 12 });
    log_opened_time(PROJECT_ID, PATH);

    expect(log).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: "open",
        action: "open",
        filename: PATH,
      }),
    );
    expect(log).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: "open",
        action: "open",
        filename: PATH,
        open_phase: "optimistic_ready",
      }),
      "open-log-entry-id",
    );
    expect(log).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        event: "open",
        action: "open",
        filename: PATH,
        time: expect.any(Number),
      }),
      "open-log-entry-id",
    );
  });
});
