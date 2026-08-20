/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ExecJobGroupWatcher } from "@cocalc/frontend/client/exec-job-watcher";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ExecuteCodeOutputAsync } from "@cocalc/util/types/execute-code";
import { documentBuildResultSubject } from "@cocalc/conat/project/document-build";
import {
  buildJobGroup,
  parseBuildRequest,
  type DocumentBuildResult,
} from "@cocalc/util/document-build";

import { readEditorBuildOutcome } from "./build-outcome";

// Re-exported so existing frame-editor imports keep working; the definition is
// shared with backend callers that request builds via the same job group.
export { buildJobGroup };

export function watchProjectBuilds({
  onBuild,
  path,
  project_id,
}: {
  onBuild: (job: ExecuteCodeOutputAsync) => void;
  path: string;
  project_id: string;
}): ExecJobGroupWatcher {
  const watcher = webapp_client.project_client.watchExecJobGroup({
    job_group: buildJobGroup(path),
    project_id,
  });
  watcher.on("job", (job: ExecuteCodeOutputAsync) => {
    if (job.status === "running") onBuild(job);
  });
  return watcher;
}

export function jobAggregateValue(
  job: ExecuteCodeOutputAsync,
): string | number | undefined {
  const aggregate = job?.aggregate;
  return typeof aggregate === "object" ? aggregate.value : aggregate;
}

/*
The aggregate to follow an *untagged* job at, or undefined to ignore it.

Untagged jobs are the stages of a build somebody is already running: another
client's, or this editor's own.  Following another client's build is the point
of watching the group at all -- entering our own pipeline at its aggregate
attaches us to the very same backend stages instead of re-running them, so a
passive client's build log and error panel refresh along with the client that
started it.

`busy` is what keeps that from looping: while we build, the jobs appearing in
this group are our own stages, and re-entering the pipeline for them would emit
more stages forever.  Unlike a tagged request an untagged job is never queued
for later -- there is nobody to reply to, and by the time we were idle the
build we would be "following" would be long over.

`numericOnly` is for LaTeX, whose pipeline needs a timestamp rather than the
opaque `{ value }` revision that knitr and the Rmd/qmd converters use.
*/
export function untaggedBuildAggregate(
  job: ExecuteCodeOutputAsync,
  { busy, numericOnly = false }: { busy: boolean; numericOnly?: boolean },
): BuildAggregate {
  if (busy) return undefined;
  const aggregate = jobAggregateValue(job);
  if (aggregate == null) return undefined;
  if (numericOnly && typeof aggregate !== "number") return undefined;
  return aggregate;
}

export type BuildJobRole =
  // a backend caller asked *this* editor for a build and is waiting for a reply
  | { role: "request"; request_id: string }
  // a request addressed to the other editor sharing this build group
  | { role: "foreign-request" }
  // a stage of a build already running somewhere
  | { role: "stage" };

/*
What a job appearing in this editor's build group means for this editor.

A backend caller (e.g. `cocalc project build`) tags its trigger job with a
request id and the logical path it asked about.  All three answers are
distinct, and collapsing the middle one into "stage" is a bug: a knitr source
and its generated .tex share one build group, so a request for `paper.Rnw` is
also seen by the editor of `paper.tex`.  That editor must stay out of it
entirely -- treating the request as an ordinary stage would make it start
LaTeX on a .tex that knitr is at that moment rewriting, and leave the .Rnw
editor's pipeline reporting a half-finished result.

`forPath` is the editor's own logical path -- for a knitr document the
.Rnw/.Rtex source, not the generated .tex.
*/
export function classifyBuildJob(
  job: ExecuteCodeOutputAsync,
  forPath: string,
): BuildJobRole {
  const tag = parseBuildRequest(job?.job_key);
  if (tag == null) return { role: "stage" };
  if (tag.path !== forPath) return { role: "foreign-request" };
  return { role: "request", request_id: tag.request_id };
}

const KNITR_STAGE_PREFIX = "knitr:";

/*
Whether a stage job is part of *this* editor's pipeline, and so worth following.

Only matters for the knitr pair, which deliberately shares one build group.
The knitr stage is the one stage that names the logical document
(`knitr:<source>`); every LaTeX stage names the generated .tex whichever
pipeline produced it.  So each side follows what it can prove is its own:

- the knitr editor joins a peer's build at its `knitr:` stage, which is where a
  build of that document begins anyway, and ignores bare LaTeX stages -- those
  belong to somebody compiling the generated .tex, and re-knitting under them
  would rewrite the file being compiled;
- a plain .tex editor ignores `knitr:` stages, which would otherwise start
  LaTeX on a file knitr has not finished writing.

Editors whose group is theirs alone (Rmd, Quarto, an ordinary .tex) have
nothing to disambiguate.
*/
export function isOwnPipelineStage(
  job: ExecuteCodeOutputAsync,
  { logicalPath, knitr = false }: { logicalPath: string; knitr?: boolean },
): boolean {
  const key = `${job?.job_key ?? ""}`;
  const isKnitrStage = key.startsWith(KNITR_STAGE_PREFIX);
  if (!knitr) return !isKnitrStage;
  return isKnitrStage && key.slice(KNITR_STAGE_PREFIX.length) === logicalPath;
}

/*
Report the outcome of a *pipeline* the editor was asked to run.

This deliberately does not come from the individual exec jobs in the build
group: LaTeX runs several stages (knitr, latex, bibtex, sagetex, pythontex, and
a second latex pass) whose exit codes are not the result of the build, and the
group can also contain unrelated builds.  Only the editor knows when its
pipeline finished and what the overall outcome was.

`path` is the editor's own logical path -- for a knitr document the .Rnw/.Rtex
source, not the generated .tex -- so a caller can tell which editor answered.
*/
export async function publishDocumentBuildResult({
  project_id,
  path,
  request_id,
  store,
}: {
  project_id: string;
  path: string;
  request_id: string;
  store: any;
}): Promise<void> {
  try {
    const client = await webapp_client.conat_client.projectConat({
      project_id,
      caller: "frame-editors.publishDocumentBuildResult",
    });
    const result: DocumentBuildResult = {
      request_id,
      path,
      ...readEditorBuildOutcome(store),
    };
    client.publishSync(
      documentBuildResultSubject({ project_id, request_id }),
      result,
    );
  } catch {
    // The requester falls back to its timeout; never let a reply failure break
    // the build itself.
  }
}

export type BuildAggregate = string | number | undefined;

/*
Pick the aggregate to build a coalesced batch at.

This must not depend on the order the requests arrived in.  The job watcher
sequences per job, and a snapshot refresh can interleave with live events, so
two clients can see the same batch in different orders.  If they then chose
different aggregates, Rmd/qmd and knitr -- which wrap the value as an opaque
`{ value }` revision -- would start separate backend executions instead of
sharing one, which is the multi-client duplication this whole mechanism exists
to avoid.

Numeric aggregates are ordered generations, so the maximum is the newest and is
order-independent.  Anything else is compared as text purely so that every
client lands on the same choice.
*/
export function selectBuildAggregate(
  values: Iterable<BuildAggregate>,
): BuildAggregate {
  let best: BuildAggregate;
  for (const value of values) {
    if (value == null) continue;
    if (best == null) {
      best = value;
      continue;
    }
    if (typeof value === "number") {
      // prefer an ordered generation over an opaque revision
      if (typeof best !== "number" || value > best) best = value;
    } else if (typeof best !== "number" && `${value}` > `${best}`) {
      best = value;
    }
  }
  return best;
}

const BUILD_QUEUE_POLL_MS = 250;
// Give up on a request if the editor never stops being busy; the requester
// timed out long before this.
const BUILD_QUEUE_MAX_WAIT_MS = 15 * 60_000;

/*
Serialize build requests for one document.

Three things this has to get right, each of which was got wrong first:

- A build the queue itself started produces exec jobs in the same watched
  group.  Those come back through the watcher as untagged jobs.  Queueing them
  would schedule another rebuild, which would produce more jobs -- an endless
  rebuild loop.  Untagged jobs never enqueue: an untagged job is either our own
  pipeline or another client's build, and neither needs a reply.
- A request that arrives while a build is running -- whether the queue started
  it or the user, a save or the browser API did -- must not be dropped.  It is
  queued and run once the editor is idle again, so a fix applied mid-build is
  still rebuilt and its requester still answered.
- A build that throws must not strand requests queued behind it.  Errors are
  contained per iteration; every waiting request is answered and the queue
  keeps draining.
*/
export class BuildRequestQueue {
  private running = false;
  private canceled = false;
  private pending = new Map<string, BuildAggregate>();

  constructor(
    private readonly run: (aggregate: BuildAggregate) => Promise<void>,
    private readonly reply: (request_id: string) => Promise<void>,
    // true while a build is in progress, including builds this queue did not
    // start (explicit save, the build button, api.editor.build, ...)
    private readonly isEditorBusy: () => boolean,
    private readonly pollMs: number = BUILD_QUEUE_POLL_MS,
    private readonly maxWaitMs: number = BUILD_QUEUE_MAX_WAIT_MS,
  ) {}

  isRunning = (): boolean => this.running;

  pendingCount = (): number => this.pending.size;

  // Called from the editor's close(): a queue waiting out a long build would
  // otherwise keep the closed editor's actions and store alive through its
  // polling closure, and could build a document nobody has open.
  cancel = (): void => {
    this.canceled = true;
    this.pending.clear();
  };

  /*
  Called for every request observed in the document's build group.  Untagged
  jobs never get here: they are either this pipeline's own stages or another
  client's build, and queueing them would rebuild forever.

  The aggregate comes from the requesting job and is shared by every client
  that saw it, so concurrent editors of the same document attach to one backend
  execution instead of each starting their own.
  */
  handleJob = async (
    request_id: string,
    aggregate: BuildAggregate,
  ): Promise<void> => {
    if (this.canceled || !request_id) return;
    this.pending.set(request_id, aggregate);
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.size > 0 && !this.canceled) {
        if (!(await this.waitUntilIdle())) {
          // never became idle, or closed; the requester has long since timed out
          this.pending.clear();
          return;
        }
        const batch = [...this.pending.entries()];
        this.pending.clear();
        // coalesced requests build once, at a generation every client agrees on
        const aggregate = selectBuildAggregate(batch.map(([, value]) => value));
        try {
          await this.run(aggregate);
        } catch {
          // reported through the editor's own error state; the reply below
          // still tells the requester what the store says
        }
        for (const [id] of batch) {
          // the editor was closed mid-build; nobody should hear from it
          if (this.canceled) break;
          try {
            await this.reply(id);
          } catch {
            // never let a failed reply stop the queue
          }
        }
      }
    } finally {
      this.running = false;
    }
  };

  private waitUntilIdle = async (): Promise<boolean> => {
    const deadline = Date.now() + this.maxWaitMs;
    while (this.isEditorBusy()) {
      if (this.canceled || Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    return !this.canceled;
  };
}
