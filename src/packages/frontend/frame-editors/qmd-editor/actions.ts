/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Quarto Editor Actions
*/

import { debounce } from "lodash";
import type { ExecJobGroupWatcher } from "@cocalc/frontend/client/exec-job-watcher";
import { markdown_to_html_frontmatter } from "@cocalc/frontend/markdown";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import {
  Actions as BaseActions,
  type CodeEditorState,
} from "../base-editor/actions-text";
import type { FrameTree } from "../frame-tree/types";
import { cancel_exec_job, type ExecOutput } from "../generic/client";
import {
  watchProjectBuilds,
  classifyBuildJob,
  jobAggregateValue,
  publishDocumentBuildResult,
  untaggedBuildAggregate,
  BuildRequestQueue,
  type BuildAggregate,
} from "../generic/project-builds";
import type { ExecuteCodeOutputAsync } from "@cocalc/util/types/execute-code";
import { Actions as MarkdownActions } from "../markdown-editor/actions";
import { checkProducedFiles } from "../rmd-editor/utils";
import { convert, qmdRenderCommand } from "./qmd-converter";

const custom_pdf_error_message: string = `
No PDF file has been generated.
`;

const MINIMAL = `---
title: "Title"
---

## Test

Example plot

\`\`\`{r}
plot(rnorm(100))
\`\`\`
`;

export class Actions extends MarkdownActions {
  private _last_qmd_hash: number | undefined = undefined;
  private is_building: boolean = false;
  private build_request_queue?: BuildRequestQueue;
  private build_job_watcher?: ExecJobGroupWatcher;
  private run_qmd_converter: Function;

  _init2(): void {
    super._init2(); // that's the one in markdown-editor/actions.ts
    // one extra thing after markdown.
    this._syncstring.once("ready", () => {
      this._init_qmd_converter();
      this._init_build_job_watcher();
    });
    this._check_produced_files();
    this.setState({ custom_pdf_error_message });
    this._syncstring.on(
      "change",
      debounce(this.ensureNonempty.bind(this), 1500),
    );
  }

  private do_build_on_save(): boolean {
    const account: any = this.redux.getStore("account");
    if (account != null) {
      return !!account.getIn(["editor_settings", "build_on_save"]);
    }
    return true;
  }

  _init_qmd_converter(): void {
    // one build takes min. a few seconds up to a minute or more
    this.run_qmd_converter = debounce(
      async (hash?) => await this._run_qmd_converter(hash),
      5 * 1000,
      { leading: true, trailing: false },
    );

    const do_build = reuseInFlight(async () => {
      if (!this.do_build_on_save()) return;
      if (this._syncstring == null) return;
      const hash = this._syncstring.hash_of_saved_version();
      if (this._last_qmd_hash != hash) {
        this._last_qmd_hash = hash;
        await this.run_qmd_converter(hash);
      }
    });

    this._syncstring.on("save-to-disk", do_build);
    this._syncstring.on("after-change", do_build);
    // Initial run with current hash if available
    const initial_hash = this._syncstring.hash_of_saved_version();
    this.run_qmd_converter(initial_hash);
  }

  private _init_build_job_watcher(): void {
    this.build_job_watcher = watchProjectBuilds({
      onBuild: (job) => void this.follow_project_build(job),
      path: this.path,
      project_id: this.project_id,
    });
  }

  private async follow_project_build(
    job: ExecuteCodeOutputAsync,
  ): Promise<void> {
    const classified = classifyBuildJob(job, this.path);
    // this editor's group is its own; a request can only be for it or absent
    if (classified.role === "foreign-request") return;
    if (classified.role === "stage") {
      await this.follow_untagged_build(job);
      return;
    }
    this.build_request_queue ??= new BuildRequestQueue(
      async (aggregate: BuildAggregate) => {
        this.is_building = true;
        try {
          // the requesting job's aggregate is shared by every client that saw
          // it, so concurrent editors attach to one backend execution
          await this._run_qmd_converter(aggregate ?? Date.now());
        } finally {
          this.is_building = false;
        }
      },
      async (request_id: string) => {
        await publishDocumentBuildResult({
          project_id: this.project_id,
          path: this.path,
          request_id,
          store: this.store,
        });
      },
      () => this.is_building || !!this.store.get("building"),
    );
    await this.build_request_queue.handleJob(
      classified.request_id,
      jobAggregateValue(job),
    );
  }

  // Follow a build another client is running, at its own aggregate, so we
  // attach to its conversion instead of starting a competing one.
  private async follow_untagged_build(
    job: ExecuteCodeOutputAsync,
  ): Promise<void> {
    const aggregate = untaggedBuildAggregate(job, {
      busy:
        this.is_building ||
        !!this.store.get("building") ||
        !!this.build_request_queue?.isRunning(),
    });
    if (aggregate == null) return;
    this.is_building = true;
    try {
      await this._run_qmd_converter(aggregate);
    } finally {
      this.is_building = false;
    }
  }

  close(): void {
    this.build_request_queue?.cancel();
    this.build_request_queue = undefined;
    this.build_job_watcher?.close();
    this.build_job_watcher = undefined;
    super.close();
  }

  async build(id?: string, force: boolean = false): Promise<void> {
    if (id) {
      const cm = this._get_cm(id);
      if (cm) {
        cm.focus();
      }
    }
    // initiating a build. if one is running & forced, we stop the build
    if (this.is_building) {
      if (force) {
        await this.stop_build("");
      } else {
        return;
      }
    }
    this.is_building = true;
    try {
      const actions = this.redux.getEditorActions(this.project_id, this.path);
      if (actions == null) {
        // opening/close a newly created file can trigger build when actions aren't
        // ready yet.  https://github.com/sagemathinc/cocalc/issues/7249
        return;
      }
      await (actions as BaseActions<CodeEditorState>).save(false);
      // For force builds, bypass the debounced function to ensure immediate execution
      if (force) {
        await this._run_qmd_converter(Date.now());
      } else {
        await this.run_qmd_converter(Date.now());
      }
    } finally {
      this.is_building = false;
    }
  }

  // supports the "Force Rebuild" button.
  async force_build(id: string): Promise<void> {
    await this.build(id, true);
  }

  // This stops the current QMD build process and resets the state.
  async stop_build(_id: string): Promise<void> {
    const job_info = this.store.get("job_info")?.toJS() as
      | ExecuteCodeOutputAsync
      | undefined;

    if (
      job_info &&
      job_info.type === "async" &&
      job_info.status === "running" &&
      typeof job_info.job_id === "string"
    ) {
      const output = await cancel_exec_job({
        project_id: this.project_id,
        job: job_info,
      });
      if (output.type === "async") {
        this.setState({ job_info: output });
      }
    }
    this.set_status("");
    this.setState({ building: false });
  }

  async _check_produced_files(): Promise<void> {
    await checkProducedFiles(this);
  }

  private set_log(output?: ExecOutput | undefined): void {
    this.setState({
      build_err: output?.stderr?.trim(),
      build_log: output?.stdout?.trim(),
      build_exit: output?.exit_code,
    });
  }

  private set_job_info(job_info: ExecuteCodeOutputAsync): void {
    if (!job_info) return;
    this.setState({
      build_log: (job_info.stdout ?? "").toString().trim(),
      build_err: (job_info.stderr ?? "").toString().trim(),
      build_exit: job_info.exit_code,
      job_info,
    });
  }

  // use this.run_qmd_converter
  private async _run_qmd_converter(hash?): Promise<void> {
    // TODO: should only run knitr if at least one frame is visible showing preview?
    // maybe not, since might want to show error.
    if (this._syncstring == null || this._syncstring.get_state() != "ready") {
      // do not run if not ready -- important due to the debounce, which could
      // fire this at any time.
      return;
    }
    if (this._last_qmd_hash == null) {
      this._last_qmd_hash = this._syncstring.hash_of_saved_version();
    }
    const md = this._syncstring.to_str();
    if (md == null) return;
    this.set_status("Running Quarto...");
    this.setState({ building: true });
    this.set_error("");
    this.setState({ build_log: "", build_err: "" });
    let markdown = "";
    let output: ExecOutput | undefined = undefined;
    try {
      const { frontmatter, html } = markdown_to_html_frontmatter(md);
      markdown = html;
      // remembered so the build log can tell the agent exactly what ran
      this.setState({ build_command: qmdRenderCommand(this.path) });
      output = await convert({
        project_id: this.project_id,
        path: this.path,
        frontmatter,
        hash: hash || this._last_qmd_hash || Date.now(),
        set_job_info: this.set_job_info.bind(this),
      });
      this.set_log(output);
      if (output == null || output.exit_code != 0) {
        this.set_error(
          "Error compiling file using Quarto. Please check the Build Log!",
        );
      } else {
        this.reload();
        await this._check_produced_files();
      }
    } catch (err) {
      this.set_error(err, "monospace");
      this.set_log(output);
      return;
    } finally {
      this.set_status("");
      this.setState({ building: false });
    }
    this.setState({ value: markdown });
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

  private ensureNonempty() {
    if (this.store && !this.store.get("value")?.trim()) {
      this.set_value(MINIMAL);
      this.build();
    }
  }
}
