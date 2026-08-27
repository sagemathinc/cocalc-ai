/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
R Markdown Editor Actions
*/

// cSpell:ignore rnorm

import type { Set } from "immutable";
import { debounce } from "lodash";
import type { DocumentBuildSnapshot } from "@cocalc/app-document-build";
import type { AccountStore } from "@cocalc/frontend/account";
import type { DocumentBuildWatcher } from "@cocalc/frontend/client/document-build-watcher";
import {
  documentBuildApi,
  documentBuildSnapshotToEditorState,
  formatDocumentBuildError,
  isDocumentBuildActive,
} from "@cocalc/frontend/client/document-build-watcher";
import { openProjectDocs } from "@cocalc/frontend/docs/navigation";
import { markdown_to_html_frontmatter } from "@cocalc/frontend/markdown";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import {
  Actions as BaseActions,
  type CodeEditorState,
} from "../base-editor/actions-text";
import type { FrameTree } from "../frame-tree/types";
import { Actions as MarkdownActions } from "../markdown-editor/actions";
import { checkProducedFiles } from "./utils";
const HELP_SLUG = "editors/r-markdown";

const MINIMAL = `---
title: "Title"
output:
  html_document:
    toc: true
---

## Title

\`\`\`{r}
summary(rnorm(100))
\`\`\`
`;

const custom_pdf_error_message: string = `
To create a PDF document from R Markdown, you specify the \`pdf_document\` output format in the
YAML metadata by putting this code at the top of your file:

\`\`\`
---
title: "My Document"
author: CoCalc User
date: Sept 27, 2019
output: pdf_document
---
\`\`\`

Within a document that generates PDF output, you can use raw LaTeX, and even define LaTeX macros.

Once you make the above change, the HTML output will no longer be updated.  If you would
like to switch back to HTML output, delete the output line or replace it with
\`\`\`
output: html_document
\`\`\`
`;

export class Actions extends MarkdownActions {
  private _last_rmd_hash: number | undefined = undefined;
  private active_build_id?: string;
  private build_watcher?: DocumentBuildWatcher;
  private explicit_build = false;
  private last_snapshot_seq = new Map<string, number>();
  private starting_build = false;
  public run_rmd_converter: Function;

  _init2(): void {
    super._init2(); // that's the one in markdown-editor/actions.ts
    this.build = this.build.bind(this);
    // one extra thing after markdown.
    this._syncstring.once("ready", () => {
      this._init_build_watcher();
      this._init_rmd_converter();
    });
    this._check_produced_files();
    this.setState({ custom_pdf_error_message });
    this._syncstring.on(
      "change",
      debounce(this.ensureNonempty.bind(this), 1500),
    );
  }

  private do_build_on_save(): boolean {
    const account: AccountStore | undefined = this.redux.getStore("account");
    // Default to false until the account settings are confirmed loaded.  The
    // store is populated with the schema defaults (build_on_save: true) before
    // "is_ready" fires, so checking editor_settings != null is not enough --
    // without the is_ready check we would build based on the default rather
    // than the user's actual preference.
    if (!account?.get("is_ready")) return false;
    const settings = account.get("editor_settings");
    if (settings == null) return false;
    return settings.get("build_on_save") ?? true;
  }

  _init_rmd_converter(): void {
    // one build takes min. a few seconds up to a minute or more
    this.run_rmd_converter = debounce(
      async (hash?: number) => await this._run_rmd_converter(hash),
      5 * 1000,
      { leading: true, trailing: false },
    );

    const do_build = reuseInFlight(async () => {
      if (this.explicit_build) return;
      if (!this.do_build_on_save()) return;
      if (this._syncstring == null) return;
      const hash = this._syncstring.hash_of_saved_version();
      if (this._last_rmd_hash != hash) {
        this._last_rmd_hash = hash;
        await this.run_rmd_converter(hash);
      }
    });

    this._syncstring.on("save-to-disk", do_build);
    this._syncstring.on("after-change", do_build);
    // Opening a browser is not itself a build request. The watcher hydrates any
    // active build, and a later persisted source change advances this hash.
    this._last_rmd_hash = this._syncstring.hash_of_saved_version();
  }

  private _init_build_watcher(): void {
    this.build_watcher = webapp_client.project_client.watchDocumentBuild({
      path: this.path,
      project_id: this.project_id,
    });
    this.build_watcher.on("snapshot", (snapshot: DocumentBuildSnapshot) => {
      void this.apply_build_snapshot(snapshot);
    });
    this.build_watcher.on(
      "active-change",
      (snapshot: DocumentBuildSnapshot | undefined) => {
        this.active_build_id = snapshot?.build_id;
        this.setState({ building: snapshot != null });
        if (snapshot == null) this.set_status("");
      },
    );
    this.build_watcher.on("watch-error", (err) => {
      this.set_error(formatDocumentBuildError(err), "monospace");
    });
  }

  close(): void {
    this.build_watcher?.close();
    this.build_watcher = undefined;
    super.close();
  }

  async build(id?: string, force: boolean = false): Promise<void> {
    if (id) {
      const cm = this._get_cm(id);
      if (cm) {
        cm.focus();
      }
    }
    // Initiating a build. If one is running and forced, cancel it first.
    if (this.store.get("building") || this.starting_build) {
      if (force) {
        await this.stop_build("");
      } else {
        return;
      }
    }
    const actions = this.redux.getEditorActions(this.project_id, this.path);
    if (actions == null) {
      // Opening/closing a newly created file can trigger build before actions exist.
      return;
    }
    this.explicit_build = true;
    try {
      await (actions as BaseActions<CodeEditorState>).save(false);
      await this._run_rmd_converter(undefined, force);
    } finally {
      this.explicit_build = false;
    }
  }

  // supports the "Force Rebuild" button.
  async force_build(id: string): Promise<void> {
    await this.build(id, true);
  }

  // This cancels the project-owned R Markdown build.
  async stop_build(_id: string): Promise<void> {
    if (this.active_build_id != null) {
      const snapshot = await documentBuildApi(
        webapp_client.project_client.conatApi(this.project_id),
      ).cancel(this.active_build_id);
      if (this.build_watcher != null) {
        this.build_watcher.track(snapshot);
      } else {
        await this.apply_build_snapshot(snapshot);
      }
    }
    this.active_build_id = this.build_watcher?.latestActiveBuildId();
    const building = this.active_build_id != null;
    this.set_status(building ? "Running RMarkdown..." : "");
    this.setState({ building });
  }

  // Tri-state: a Set of the produced extensions, or null if we could not
  // determine it.  null must never be treated as "no output exists".
  async _check_produced_files(): Promise<Set<string> | null> {
    return await checkProducedFiles(this);
  }

  // use this.run_rmd_converter
  private async _run_rmd_converter(
    generation?: string | number,
    force = false,
  ): Promise<void> {
    // TODO: should only run knitr if at least one frame is visible showing preview?
    // maybe not, since might want to show error.
    if (this._syncstring == null || this._syncstring.get_state() != "ready") {
      // do not run if not ready -- important due to the debounce, which could
      // fire this at any time.
      return;
    }
    if (this.starting_build) return;
    this.starting_build = true;
    this._last_rmd_hash ??= this._syncstring.hash_of_saved_version();
    const md = this._syncstring.to_str();
    if (md == null) {
      this.starting_build = false;
      return;
    }
    this.set_status("Running RMarkdown...");
    this.setState({ building: true });
    this.set_error("");
    this.setState({ build_log: "", build_err: "" });
    try {
      const { html } = markdown_to_html_frontmatter(md);
      this.setState({ value: html });
      const snapshot = await documentBuildApi(
        webapp_client.project_client.conatApi(this.project_id),
      ).start({
        path: this.path,
        ...(generation == null ? undefined : { generation: `${generation}` }),
        expected_source_hash: this._syncstring.hash_of_saved_version(),
        force,
      });
      if (this.build_watcher != null) {
        this.build_watcher.track(snapshot);
      } else {
        await this.apply_build_snapshot(snapshot);
      }
    } catch (err) {
      this.set_error(formatDocumentBuildError(err), "monospace");
      this.set_status("");
      this.setState({ building: false, build_exit: 1 });
    } finally {
      this.starting_build = false;
    }
  }

  private async apply_build_snapshot(
    snapshot: DocumentBuildSnapshot,
  ): Promise<void> {
    if (snapshot.seq <= (this.last_snapshot_seq.get(snapshot.build_id) ?? -1)) {
      return;
    }
    this.last_snapshot_seq.set(snapshot.build_id, snapshot.seq);
    const snapshotIsActive = isDocumentBuildActive(snapshot);
    this.active_build_id =
      this.build_watcher?.latestActiveBuildId() ??
      (snapshotIsActive ? snapshot.build_id : undefined);
    if (
      this.active_build_id == null ||
      this.active_build_id === snapshot.build_id
    ) {
      this.setState({
        ...documentBuildSnapshotToEditorState(snapshot),
        building: this.active_build_id != null,
      } as any);
    } else {
      this.setState({ building: true });
    }
    if (snapshotIsActive) {
      this.set_status("Running RMarkdown...");
      return;
    }
    this.set_status(this.active_build_id == null ? "" : "Running RMarkdown...");
    if (snapshot.state === "succeeded") {
      this.set_error("");
      this.reload();
      await this._check_produced_files();
    } else if (this.active_build_id == null && snapshot.state === "failed") {
      this.set_error("Error compiling RMarkdown. Please check the Build Log!");
    } else if (this.active_build_id == null && snapshot.state === "timed_out") {
      this.set_error("R Markdown build timed out. Please check the Build Log!");
    }
  }

  _raw_default_frame_tree(): FrameTree {
    return {
      direction: "col",
      type: "node",
      first: {
        type: "cm",
      },
      second: {
        type: "node",
        direction: "row",
        first: { type: "iframe" },
        second: { type: "build" },
        pos: 0.8,
      },
    };
  }

  reload(_id?: string, hash?: number) {
    // what is id supposed to be used for?
    // the html editor, which also has an iframe, calls somehow super.reload
    hash = hash || Date.now();
    ["iframe", "pdfjs_canvas", "markdown"].forEach((viewer) =>
      this.set_reload(viewer, hash),
    );
  }

  // Never delete trailing whitespace for markdown files.
  delete_trailing_whitespace(): void {}

  help(): void {
    openProjectDocs({ projectId: this.project_id, slug: HELP_SLUG });
  }

  private ensureNonempty() {
    if (this.store && !this.store.get("value")?.trim()) {
      this.set_value(MINIMAL);
      this.build();
    }
  }
}
