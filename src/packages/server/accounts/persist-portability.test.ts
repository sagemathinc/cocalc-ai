/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { syncFiles } from "@cocalc/conat/persist/context";

import {
  loadAccountPersistState,
  restoreAccountPersistState,
} from "./persist-portability";

describe("account persist portability", () => {
  const account_id = "22222222-2222-4222-8222-222222222222";
  const originalSyncFiles = { ...syncFiles };
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), "cocalc-account-persist-"));
    Object.assign(syncFiles, {
      local: join(temp, "source", "sync"),
      localAccounts: "",
      localProjects: "",
      localHosts: "",
      localHub: "",
      archive: join(temp, "source", "archive"),
      backup: "",
    });
  });

  afterEach(async () => {
    Object.assign(syncFiles, originalSyncFiles);
    await rm(temp, { recursive: true, force: true });
  });

  it("round-trips local and archive account persist files", async () => {
    await mkdir(join(syncFiles.local, "accounts", account_id), {
      recursive: true,
    });
    await writeFile(
      join(syncFiles.local, "accounts", account_id, "docs-state.db"),
      "local state",
    );
    await mkdir(join(syncFiles.archive, "accounts", account_id), {
      recursive: true,
    });
    await writeFile(
      join(syncFiles.archive, "accounts", account_id, "docs-state.db"),
      "archive state",
    );

    const files = await loadAccountPersistState(account_id);
    Object.assign(syncFiles, {
      ...syncFiles,
      local: join(temp, "dest", "sync"),
      archive: join(temp, "dest", "archive"),
    });

    await restoreAccountPersistState({ account_id, files });

    await expect(
      readFile(
        join(syncFiles.local, "accounts", account_id, "docs-state.db"),
        "utf8",
      ),
    ).resolves.toBe("local state");
    await expect(
      readFile(
        join(syncFiles.archive, "accounts", account_id, "docs-state.db"),
        "utf8",
      ),
    ).resolves.toBe("archive state");
  });

  it("rejects restore paths that escape the account persist root", async () => {
    await expect(
      restoreAccountPersistState({
        account_id,
        files: [
          {
            root: "local",
            relative_path: "../escape.db",
            data_base64: Buffer.from("bad").toString("base64"),
          },
        ],
      }),
    ).rejects.toThrow("invalid account persist relative path");
  });
});
