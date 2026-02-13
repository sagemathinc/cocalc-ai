/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
TimeTravel Frame Editor Actions

path/to/file.foo --> path/to/.file.foo.time-travel

Right now the file path/to/.file.foo.time-travel is empty, but we plan to use it later.

IMPORTANT:
(1) Jupyter classic still uses the old history viewer, and
(2) If you open an old .sage-history file from a project log, that also still opens
the old viewer, which is a convenient fallback if somebody needs it for some reason.

*/
import { debounce } from "lodash";
import { List } from "immutable";
import { once } from "@cocalc/util/async-utils";
import {
  filename_extension,
  history_path,
  path_split,
} from "@cocalc/util/misc";
import { SyncDoc } from "@cocalc/sync/editor/generic/sync-doc";
import { exec } from "@cocalc/frontend/frame-editors/generic/client";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { ViewDocument } from "./view-document";
import {
  BaseEditorActions as CodeEditorActions,
  CodeEditorState,
} from "../base-editor/actions-base";
import { FrameTree } from "../frame-tree/types";
import { export_to_json } from "./export-to-json";
import type { Document } from "@cocalc/sync/editor/generic/types";
import LRUCache from "lru-cache";
import { until } from "@cocalc/util/async-utils";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";
type PatchId = string;
interface GitCommitEntry {
  hash: string;
  name: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  timestampMs: number;
  version: number;
}

const EXTENSION = ".time-travel";

// const log = (...args) => console.log("time-travel", ...args);

// We use a global cache so if user closes and opens file
// later it is fast.
const gitShowCache = new LRUCache<string, string>({
  maxSize: 10 * 10 ** 6, // 10MB
  sizeCalculation: (value, _key) => {
    return value.length + 1; // must be positive
  },
});

/*interface FrameState {
  // date.valueOf() in non-range mode
  version: number;
  // date of left handle in range mode
  version0: number;
  // date of right handle in range mode
  version1: number;
  changes_mode: boolean;
  git_mode: boolean;
}*/

export interface TimeTravelState extends CodeEditorState {
  versions: List<PatchId>;
  git_versions: List<number>;
  snapshot_versions: List<string>;
  backup_versions: List<string>;
  loading: boolean;
  has_full_history: boolean;
  docpath: string;
  docext: string;
  // true if in a git repo
  git?: boolean;
  //frame_states: Map<string, any>; // todo: really map from frame_id to FrameState as immutable map.
  // timetravel has own error state
  error: string;
  // first loaded versions. This changes when you load more.
  first_version: number;
}

export class TimeTravelActions extends CodeEditorActions<TimeTravelState> {
  protected doctype: string = "none"; // actual document is managed elsewhere
  private docpath: string;
  private docext: string;
  syncdoc?: SyncDoc;
  private first_load: boolean = true;
  ambient_actions?: CodeEditorActions;
  private gitCommits: GitCommitEntry[] = [];
  private gitCommitByVersion: { [version: number]: GitCommitEntry } = {};
  private gitCommitByHash: { [hash: string]: GitCommitEntry } = {};
  private gitFilesByHash: { [hash: string]: string[] } = {};
  private gitProjectPathPrefix?: string;
  private backupTimeById: { [id: string]: number } = {};

  _init2(): void {
    const { head, tail } = path_split(this.path);
    this.docpath = tail.slice(1, tail.length - EXTENSION.length);
    if (head != "") {
      this.docpath = head + "/" + this.docpath;
    }
    // log("init", { path: this.path });
    this.docext = filename_extension(this.docpath);
    this.setState({
      versions: List([]),
      snapshot_versions: List([]),
      backup_versions: List([]),
      loading: true,
      has_full_history: false,
      docpath: this.docpath,
      docext: this.docext,
    });
    this.init_syncdoc();
    this.updateGitVersions();
  }

  _raw_default_frame_tree(): FrameTree {
    return { type: "time_travel" };
  }

  init_frame_tree = () => {};

  set_error = (error) => {
    this.setState({ error });
  };

  private init_syncdoc = async (): Promise<void> => {
    await until(async () => {
      if (this.isClosed()) {
        return true;
      }
      const mainFileActions = this.redux.getEditorActions(
        this.project_id,
        this.docpath,
      );
      if (mainFileActions == null) {
        // open the file that we're showing timetravel for, so that the
        // actions are available
        try {
          await this.open_file({ foreground: false, explicit: false });
        } catch (err) {
          console.warn(err);
        }
        // will try again above in the next loop
        return false;
      } else {
        const doc = getSyncDocFromEditorActions(mainFileActions);
        if (doc == null || doc.get_state() == "closed") {
          // file maybe closing
          return false;
        }
        // got it!
        this.syncdoc = doc;
        return true;
      }
    });
    if (this.isClosed() || !this.syncdoc) {
      return;
    }

    if (
      this.syncdoc.get_state() == "closed" ||
      // @ts-ignore
      this.syncdoc.is_fake
    ) {
      return;
    }
    if (this.syncdoc.get_state() == "init") {
      try {
        await once(this.syncdoc, "ready");
      } catch {
        return;
      }
    }
    this.syncdoc.on("change", debounce(this.syncdoc_changed, 750));
    // cause initial load -- we could be plugging into an already loaded syncdoc,
    // so there wouldn't be any change event, so we have to trigger this.
    this.syncdoc_changed();
    this.syncdoc.on("close", () => {
      // in the actions in this file, we don't check if the state is closed, but instead
      // that this.syncdoc is not null:
      delete this.syncdoc;
      this.init_syncdoc();
    });

    this.setState({
      loading: false,
      has_full_history: this.syncdoc.hasFullHistory(),
    });
  };

  loadMoreHistory = async (): Promise<void> => {
    // log("loadMoreHistory");
    if (
      this.store.get("has_full_history") ||
      this.syncdoc == null ||
      this.store.get("git_mode") ||
      this.syncdoc == null
    ) {
      return;
    }
    await this.syncdoc.loadMoreHistory();
    this.setState({ has_full_history: this.syncdoc.hasFullHistory() });
    this.syncdoc_changed(); // load new versions list.
  };

  private syncdoc_changed = (): void => {
    //  log("syncdoc_changed");
    if (this.syncdoc == null) return;
    if (this.syncdoc?.get_state() != "ready") {
      return;
    }
    let versions;
    try {
      // syncdoc_changed -- can get called at any time, so have to be extra careful
      versions = List<PatchId>(this.syncdoc.versions());
    } catch (err) {
      this.setState({ versions: List([]) });
      return;
    }
    const first_version =
      this.patchTime(this.syncdoc.historyFirstVersion()) ?? 0;
    this.setState({ versions, first_version });
    if (this.first_load) {
      this.first_load = false;
    }
  };

  patchTime = (id?: PatchId): number | undefined => {
    if (!id) return;
    return this.syncdoc?.patchTime(id);
  };

  versionNumber = (version: PatchId): number | undefined => {
    return this.syncdoc?.historyVersionNumber(version);
  };

  wallTime = (version: PatchId): number | undefined => {
    return this.syncdoc?.wallTime(version);
  };

  // Get the given version of the document.
  get_doc = (version: PatchId): Document | undefined => {
    // log("get_doc", version);
    if (this.syncdoc == null) {
      return;
    }
    const state = this.syncdoc.get_state();
    if (state != "ready") {
      return;
    }
    try {
      return this.syncdoc.version(version);
    } catch (_) {
      console.log(
        "TimeTravel: unknown or not loaded version",
        new Date(this.patchTime(version) ?? 0),
      );
      return;
    }
  };

  get_account_ids = (version0: PatchId, version1: PatchId): string[] => {
    //    log("get_account_ids", version0, version1);
    if (this.syncdoc == null) {
      return [];
    }
    const account_ids = new Set<string>();
    for (const version of Array.from(new Set([version0, version1]))) {
      if (version == null) {
        continue;
      }
      try {
        const account_id = this.syncdoc.account_id(version);
        if (account_id) {
          account_ids.add(account_id);
        }
      } catch (err) {
        // fails if version is not actually known.
        continue;
      }
    }
    return Array.from(account_ids);
  };

  getUser = (version: PatchId): number | undefined => {
    if (this.syncdoc == null) {
      return;
    }
    try {
      return this.syncdoc.user_id(version);
    } catch {
      return;
    }
  };

  open_file = async (opts?): Promise<void> => {
    // log("open_file");
    const actions = this.redux.getProjectActions(this.project_id);
    await actions.open_file({ path: this.docpath, foreground: true, ...opts });
  };

  // Revert the live version of the document to a specific version */
  revert = async ({
    version,
    doc,
    gitMode,
  }: {
    version: PatchId;
    doc: Document;
    gitMode?: boolean;
  }): Promise<void> => {
    const { syncdoc } = this;
    if (syncdoc == null) {
      return;
    }
    syncdoc.commit();
    if (gitMode) {
      syncdoc.from_str(doc.to_str());
    } else {
      syncdoc.revert(version);
    }
    await syncdoc.commit({ emitChangeImmediately: true });
    if (this.docpath.endsWith(".ipynb")) {
      const a = this.redux.getEditorActions(
        this.project_id,
        this.docpath,
      )?.jupyter_actions;
      if (a != null) {
        // make sure nothing is running or appears to be (due to it being running in history)
        a.clear_all_cell_run_state();
        a.signal("SIGINT");
        a.refreshKernelStatus();
      }
    }

    // Some editors, e.g., the code text editor, only update Codemirror when
    // "after-change" is emitted (not just "change"), and commit does NOT result
    // in an after-change on this client (because usually you don't want that).
    // So we do it manually here.  Without this, revert when editing code would
    // not work.
    syncdoc.emit("after-change");

    await this.open_file();
  };

  open_snapshots = (): void => {
    // log("open_snapshots");
    this.redux.getProjectActions(this.project_id).open_directory(SNAPSHOTS);
  };

  exportEditHistory = async (): Promise<string> => {
    // log("exportEditHistory");
    const path = await export_to_json(
      this.syncdoc,
      this.docpath,
      this.project_id,
    );
    const actions = this.redux.getProjectActions(this.project_id);
    await actions.open_file({ path, foreground: true });
    return path;
  };

  purgeHistory = async ({
    keep_current_state = true,
  }: {
    keep_current_state?: boolean;
  } = {}): Promise<{
    deleted: number;
    seeded: boolean;
    history_epoch: number;
  }> => {
    const result = await webapp_client.conat_client.hub.sync.purgeHistory({
      project_id: this.project_id,
      path: this.docpath,
      keep_current_state,
    });
    // This state is conservative until syncdoc metadata change propagates.
    this.setState({ has_full_history: true });
    this.syncdoc_changed();
    return result;
  };

  // We have not implemented any way to do programmatical_goto_line this for time travel yet.
  // It will be very interesting and useful, because it will allow for
  // linking to a specific line/cell at a **specific point in time**.
  // async programmatical_goto_line() {}

  private gitCommand = async (args: string[], commit?: string) => {
    // log("gitCommand", { args, commit });
    const { head, tail } = path_split(this.docpath);
    return await exec(
      {
        command: "git",
        args: args.concat([`${commit ? commit + ":./" : ""}${tail}`]),
        path: head,
        project_id: this.project_id,
        err_on_exit: true,
      },
      this.path,
    );
  };

  private gitRepoCommand = async (args: string[]) => {
    const { head } = path_split(this.docpath);
    return await exec(
      {
        command: "git",
        args,
        path: head,
        project_id: this.project_id,
        err_on_exit: true,
      },
      this.path,
    );
  };

  private gitEntryForVersion = (
    version: number | string | undefined,
  ): GitCommitEntry | undefined => {
    if (version == null) return;
    const n = typeof version === "number" ? version : Number(version);
    if (!Number.isFinite(n)) return;
    return this.gitCommitByVersion[n];
  };

  private resetGitCommits = (): void => {
    this.gitCommits = [];
    this.gitCommitByVersion = {};
    this.gitCommitByHash = {};
    this.gitFilesByHash = {};
    this.gitProjectPathPrefix = undefined;
  };

  updateSnapshotVersions = async (): Promise<List<string>> => {
    try {
      const fs = webapp_client.conat_client.conat().fs({
        project_id: this.project_id,
      });
      const { tail } = path_split(this.docpath);
      const docDepth = this.docpath.split("/").filter(Boolean).length + 1;
      // Find candidate files in one RPC, then exact-match relative path in JS.
      // This avoids tricky glob escaping and N per-snapshot stat calls.
      const { stdout } = await fs.find(SNAPSHOTS, {
        options: [
          "-mindepth",
          `${docDepth}`,
          "-maxdepth",
          `${docDepth}`,
          "-type",
          "f",
          "-name",
          tail,
          "-printf",
          "%T@\t%P\n",
        ],
      });
      const existingBySnapshot = new Map<string, number>();
      for (const row of Buffer.from(stdout).toString().split("\n")) {
        if (!row) continue;
        const i = row.indexOf("\t");
        if (i <= 0) continue;
        const mtime = Number(row.slice(0, i));
        if (!Number.isFinite(mtime)) continue;
        const rel = row.slice(i + 1);
        const j = rel.indexOf("/");
        if (j <= 0) continue;
        const snapshot = rel.slice(0, j).trim();
        const docpath = rel.slice(j + 1);
        if (!snapshot || docpath !== this.docpath) continue;
        const mtimeMs = Math.round(mtime * 1000);
        const prev = existingBySnapshot.get(snapshot);
        if (prev == null || mtimeMs > prev) {
          existingBySnapshot.set(snapshot, mtimeMs);
        }
      }
      const existing = Array.from(existingBySnapshot.entries())
        .map(([snapshot, mtimeMs]) => ({ snapshot, mtimeMs }))
        .sort((a, b) => a.snapshot.localeCompare(b.snapshot));
      // Keep only versions where file timestamp changes; this matches "git log <file>"
      // behavior better by eliding runs of snapshots with unchanged file content timestamp.
      const filtered: string[] = [];
      let lastMtimeMs: number | undefined = undefined;
      for (const { snapshot, mtimeMs } of existing) {
        if (lastMtimeMs !== mtimeMs) {
          filtered.push(snapshot);
          lastMtimeMs = mtimeMs;
        }
      }
      const snapshot_versions = List<string>(filtered);
      this.setState({ snapshot_versions });
      return snapshot_versions;
    } catch (_err) {
      const snapshot_versions = List<string>([]);
      this.setState({ snapshot_versions });
      return snapshot_versions;
    }
  };

  snapshotWallTime = (
    version: number | string | undefined,
  ): number | undefined => {
    if (version == null) return;
    const t = Date.parse(`${version}`);
    if (!Number.isFinite(t)) return;
    return t;
  };

  snapshotDoc = async (
    version: number | string | undefined,
  ): Promise<ViewDocument | undefined> => {
    if (version == null) return;
    try {
      const resp =
        await webapp_client.conat_client.hub.projects.getSnapshotFileText({
          project_id: this.project_id,
          snapshot: `${version}`,
          path: this.docpath,
        });
      return new ViewDocument(this.docpath, resp.content);
    } catch (err) {
      this.set_error(`${err}`);
      return;
    }
  };

  updateBackupVersions = async (): Promise<List<string>> => {
    try {
      // Use indexed backup search in one RPC with exact path match.
      const raw = await webapp_client.conat_client.hub.projects.findBackupFiles(
        {
          project_id: this.project_id,
          glob: [this.docpath],
        },
      );
      const rows = raw
        .filter((x) => !x.isDir && x.path === this.docpath)
        .map((x) => {
          const t = new Date(x.time as any).getTime();
          return {
            id: x.id,
            timeMs: Number.isFinite(t) ? t : 0,
            mtime: x.mtime ?? 0,
            size: x.size ?? 0,
          };
        })
        .sort((a, b) =>
          a.timeMs !== b.timeMs
            ? a.timeMs - b.timeMs
            : a.id.localeCompare(b.id),
        );
      // Keep only versions where file mtime/size changed, similar to git log per-file behavior.
      const filteredIds: string[] = [];
      const backup_times: { [id: string]: number } = {};
      let lastSig: string | undefined = undefined;
      for (const row of rows) {
        const sig = `${row.mtime}:${row.size}`;
        if (sig === lastSig) continue;
        lastSig = sig;
        filteredIds.push(row.id);
        backup_times[row.id] = row.timeMs;
      }
      const backup_versions = List<string>(filteredIds);
      this.backupTimeById = backup_times;
      this.setState({ backup_versions });
      return backup_versions;
    } catch (_err) {
      const backup_versions = List<string>([]);
      this.backupTimeById = {};
      this.setState({ backup_versions });
      return backup_versions;
    }
  };

  backupWallTime = (
    version: number | string | undefined,
  ): number | undefined => {
    if (version == null) return;
    const id = `${version}`;
    const t = this.backupTimeById[id];
    if (t == null || !Number.isFinite(t)) return;
    return t;
  };

  backupDoc = async (
    version: number | string | undefined,
  ): Promise<ViewDocument | undefined> => {
    if (version == null) return;
    try {
      const resp =
        await webapp_client.conat_client.hub.projects.getBackupFileText({
          project_id: this.project_id,
          id: `${version}`,
          path: this.docpath,
        });
      return new ViewDocument(this.docpath, resp.content);
    } catch (err) {
      this.set_error(`${err}`);
      return;
    }
  };

  updateGitVersions = async () => {
    // log("updateGitVersions");
    // versions is an ordered list of Date objects, one for each commit that involves this file.
    try {
      const { stdout } = await this.gitCommand([
        "log",
        "--format=%at%x00%H%x00%an%x00%ae%x00%s",
        "--",
      ]);
      this.resetGitCommits();
      const parsed: Array<Omit<GitCommitEntry, "version">> = [];
      for (const x of stdout.split("\n")) {
        if (!x) continue;
        const parts = x.split("\x00");
        if (parts.length < 5) continue;
        const [t0, hashRaw, authorNameRaw, authorEmailRaw, ...subjectParts] =
          parts;
        const hash = (hashRaw ?? "").trim();
        const authorName = (authorNameRaw ?? "").trim();
        const authorEmail = (authorEmailRaw ?? "").trim();
        const subject = subjectParts.join("\x00").trim();
        const name = authorEmail
          ? `${authorName} <${authorEmail}>`
          : authorName;
        if (!t0 || !hash) {
          continue;
        }
        const t = parseInt(t0, 10) * 1000;
        if (!Number.isFinite(t)) continue;
        parsed.push({
          hash,
          name,
          subject,
          authorName,
          authorEmail,
          timestampMs: t,
        });
      }

      // git log output is newest->oldest; TimeTravel sliders are oldest->newest.
      parsed.reverse();
      const usedVersions = new Set<number>();
      for (const entry of parsed) {
        let version = entry.timestampMs;
        // Preserve all commits even when two commits share the same second timestamp.
        while (usedVersions.has(version)) {
          version += 1;
        }
        usedVersions.add(version);
        const commit: GitCommitEntry = { ...entry, version };
        this.gitCommits.push(commit);
        this.gitCommitByVersion[version] = commit;
        this.gitCommitByHash[commit.hash] = commit;
      }

      const git_versions = List<number>(this.gitCommits.map((x) => x.version));
      this.setState({
        git: this.gitCommits.length > 0,
        git_versions,
      });
      return git_versions;
    } catch (_err) {
      // Do NOT report error -- instead, disable git mode.  This should
      // happen if the file is not in a git repo.
      this.setState({ git: false });
      return;
    }
  };

  private gitShow = async (version: number): Promise<string | undefined> => {
    // log("gitShow", { version });
    const entry = this.gitEntryForVersion(version);
    if (entry == null) {
      return;
    }
    const key = `${entry.hash}:${this.docpath}`;
    if (gitShowCache.has(key)) {
      return gitShowCache.get(key);
    }
    try {
      const { stdout } = await this.gitCommand(["show"], entry.hash);
      gitShowCache.set(key, stdout);
      return stdout;
    } catch (err) {
      this.set_error(`${err}`);
      return;
    }
  };

  gitNames = (v0: number | undefined, v1: number | undefined): string[] => {
    // log("gitNames", { version0, version1 });
    if (v0 == null || v1 == null) {
      return [];
    }
    if (v0 == v1) {
      const d = this.gitEntryForVersion(v0);
      if (d) {
        return [d.name];
      } else {
        return [];
      }
    }
    const lo = Math.min(v0, v1);
    const hi = Math.max(v0, v1);
    const names: string[] = [];
    for (const commit of this.gitCommits) {
      if (lo < commit.version && commit.version <= hi) {
        names.push(commit.name);
      }
    }
    return names;
  };

  gitSubject = (version: number): string | undefined => {
    return this.gitEntryForVersion(version)?.subject;
  };

  gitCommit = (
    version: number | string | undefined,
  ):
    | {
        hash: string;
        shortHash: string;
        subject: string;
        authorName: string;
        authorEmail: string;
        timestampMs: number;
      }
    | undefined => {
    const entry = this.gitEntryForVersion(version);
    if (entry == null) return;
    return {
      hash: entry.hash,
      shortHash: entry.hash.slice(0, 7),
      subject: entry.subject,
      authorName: entry.authorName,
      authorEmail: entry.authorEmail,
      timestampMs: entry.timestampMs,
    };
  };

  gitCommitRange = (
    v0: number | string | undefined,
    v1: number | string | undefined,
  ): Array<{
    hash: string;
    shortHash: string;
    subject: string;
    authorName: string;
    authorEmail: string;
    timestampMs: number;
  }> => {
    if (v0 == null || v1 == null) return [];
    const t0 = typeof v0 === "number" ? v0 : Number(v0);
    const t1 = typeof v1 === "number" ? v1 : Number(v1);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return [];
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    const commits: Array<{
      hash: string;
      shortHash: string;
      subject: string;
      authorName: string;
      authorEmail: string;
      timestampMs: number;
    }> = [];
    for (const entry of this.gitCommits) {
      if (entry.version < lo || entry.version > hi) {
        continue;
      }
      const commit = this.gitCommit(entry.version);
      if (commit != null) {
        commits.push(commit);
      }
    }
    commits.sort((a, b) => a.timestampMs - b.timestampMs);
    return commits;
  };

  gitVersionForHash = (hash: string | undefined): number | undefined => {
    if (hash == null || hash === "") return;
    return this.gitCommitByHash[hash]?.version;
  };

  private async gitProjectPrefix(): Promise<string> {
    if (this.gitProjectPathPrefix != null) {
      return this.gitProjectPathPrefix;
    }
    try {
      const { head, tail } = path_split(this.docpath);
      const { stdout } = await exec(
        {
          command: "git",
          args: ["ls-files", "--full-name", "--", tail],
          path: head,
          project_id: this.project_id,
          err_on_exit: true,
        },
        this.path,
      );
      const repoRelativeCurrent = (stdout.split("\n")[0] ?? "").trim();
      if (
        repoRelativeCurrent !== "" &&
        this.docpath.endsWith(repoRelativeCurrent)
      ) {
        this.gitProjectPathPrefix = this.docpath.slice(
          0,
          this.docpath.length - repoRelativeCurrent.length,
        );
      } else {
        this.gitProjectPathPrefix = "";
      }
    } catch (_err) {
      this.gitProjectPathPrefix = "";
    }
    return this.gitProjectPathPrefix;
  }

  gitChangedFiles = async (
    version: number | string | undefined,
  ): Promise<string[]> => {
    const entry = this.gitEntryForVersion(version);
    if (entry == null) {
      return [];
    }
    const cached = this.gitFilesByHash[entry.hash];
    if (cached != null) {
      return cached;
    }
    try {
      const { stdout } = await this.gitRepoCommand([
        "show",
        "--name-only",
        "--pretty=format:",
        "--no-color",
        entry.hash,
      ]);
      const prefix = await this.gitProjectPrefix();
      const files = stdout
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => (prefix ? `${prefix}${x}` : x))
        .map((x) => x.replace(/^\.\/+/, ""));
      const unique = Array.from(new Set(files));
      this.gitFilesByHash[entry.hash] = unique;
      return unique;
    } catch (_err) {
      this.gitFilesByHash[entry.hash] = [];
      return [];
    }
  };

  openGitCommitFile = async (path: string, hash: string): Promise<void> => {
    const projectActions = this.redux.getProjectActions(this.project_id);
    const ttPath = history_path(path);
    await projectActions.open_file({ path: ttPath, foreground: true });
    let refreshed = false;
    try {
      await until(
        async () => {
          const target: any = this.redux.getEditorActions(
            this.project_id,
            ttPath,
          );
          if (target == null) {
            return false;
          }
          if (!refreshed && typeof target.updateGitVersions === "function") {
            await target.updateGitVersions();
            refreshed = true;
          }
          const targetVersion =
            typeof target.gitVersionForHash === "function"
              ? target.gitVersionForHash(hash)
              : undefined;
          const id =
            typeof target._active_id === "function"
              ? target._active_id()
              : undefined;
          if (targetVersion == null || id == null) {
            return false;
          }
          target.set_frame_tree({
            id,
            source: "git",
            gitMode: true,
            changesMode: false,
            version: targetVersion,
          });
          return true;
        },
        { timeout: 7000, start: 100, max: 400, min: 50 },
      );
    } catch (_err) {
      this.set_error("Unable to open selected file at that commit.");
    }
  };

  gitDoc = async (version: number): Promise<ViewDocument | undefined> => {
    // log("gitDoc", { version });
    const str = await this.gitShow(version);
    if (str == null) {
      return undefined;
    }
    return new ViewDocument(this.docpath, str);
  };
}

export { TimeTravelActions as Actions };

function getSyncDocFromEditorActions(actions) {
  if (actions.path.endsWith(".course")) {
    return actions.course_actions.syncdb;
  }
  return actions._syncstring;
}
