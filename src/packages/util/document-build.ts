/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Shared vocabulary for document builds (LaTeX, R Markdown, Quarto).

The build pipeline itself lives in the frame editors: they know the configured
build command, parse the logs and own the build-log / error panels.  Backend
callers therefore *request* a build rather than running one, and the editor
reports back what happened.

Three names are shared:

- buildJobGroup(path) -- the async exec job group of a document.  Every open
  editor for that document watches it, so starting a job there is what asks for
  a rebuild.
- documentBuildResultSubject (see @cocalc/conat/project/document-build) -- where
  the editor publishes the outcome of a requested build.
- buildStageJobKey(...) -- the key of one stage of a build pipeline, which
  names the logical document that pipeline belongs to.

A request carries both an id and the logical path it was made for in the
trigger job's job_key:

- the id correlates the reply, because a build group can contain unrelated
  builds and, for LaTeX, several stages (knitr, latex, bibtex, sagetex,
  pythontex) whose individual exit codes are not the outcome of the pipeline;
- the path tells the editors which of them the request is for, because a knitr
  source and its generated .tex deliberately share a build group and would
  otherwise both run a pipeline over the same generated files.
*/

export const BUILD_JOB_GROUP_PREFIX = "build:";
export const BUILD_REQUEST_JOB_KEY_PREFIX = "build-request:";

// Extensions whose frame editor exposes a build() action; keep in sync with the
// latex (KNITR_EXTS + tex), rmd and qmd editor registrations.
export const BUILDABLE_EXTENSIONS: readonly string[] = [
  "tex",
  "rnw",
  "rtex",
  "rmd",
  "qmd",
];

// Knitr sources are compiled to a derived .tex file, and the LaTeX editor
// rewrites its own path to that .tex before it starts watching for builds
// (see init_ext_path in the latex editor actions).  Every name derived from a
// document path must therefore agree on the .tex form, or a request for
// "paper.Rnw" would be published to a group nobody is listening on.
export const KNITR_EXTENSIONS: readonly string[] = ["rnw", "rtex"];

export function documentExtension(path: string): string {
  const clean = `${path ?? ""}`;
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

export function canonicalBuildPath(path: string): string {
  const clean = `${path ?? ""}`;
  if (!KNITR_EXTENSIONS.includes(documentExtension(clean))) {
    return clean;
  }
  return `${clean.slice(0, clean.lastIndexOf("."))}.tex`;
}

export function buildJobGroup(path: string): string {
  return `${BUILD_JOB_GROUP_PREFIX}${canonicalBuildPath(path)}`;
}

export function isBuildableDocument(path: string): boolean {
  return BUILDABLE_EXTENSIONS.includes(documentExtension(path));
}

export type BuildRequestTag = {
  request_id: string;
  // the document the caller named, which for a knitr pair distinguishes the
  // .Rnw source from its generated .tex
  path: string;
};

export function buildRequestJobKey({
  request_id,
  path,
}: BuildRequestTag): string {
  return `${BUILD_REQUEST_JOB_KEY_PREFIX}${request_id}:${encodeURIComponent(path)}`;
}

export function parseBuildRequest(
  job_key: unknown,
): BuildRequestTag | undefined {
  const clean = `${job_key ?? ""}`;
  if (!clean.startsWith(BUILD_REQUEST_JOB_KEY_PREFIX)) return undefined;
  const rest = clean.slice(BUILD_REQUEST_JOB_KEY_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return undefined;
  const request_id = rest.slice(0, sep).trim();
  if (!request_id) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(rest.slice(sep + 1));
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  return { request_id, path };
}

/*
The stages of the LaTeX build pipeline, in the order they can run.

Each stage runs as one keyed exec job in the document's build group, and the
key names the *logical* document the pipeline is for -- for a knitr document
the .Rnw/.Rtex source, even though every stage after knitr operates on the
generated .tex.  That is what lets an editor joining a build already in
progress tell its own pipeline from a plain build of the generated .tex, which
shares the same group and the same files.

Rmd and Quarto have a single converter stage in a group of their own, so they
have nothing to disambiguate and do not use this vocabulary.
*/
export const BUILD_STAGE_NAMES = [
  "knitr",
  "latex",
  "sagetex",
  "pythontex",
] as const;

export type BuildStageName = (typeof BUILD_STAGE_NAMES)[number];

export type BuildStageTag = {
  stage: BuildStageName;
  // the editor's logical path, *not* the file the stage's command operates on
  path: string;
};

export function buildStageJobKey({ stage, path }: BuildStageTag): string {
  return `${stage}:${path}`;
}

export function parseBuildStage(job_key: unknown): BuildStageTag | undefined {
  const clean = `${job_key ?? ""}`;
  // a path may itself contain ":", so only the first separator counts
  const sep = clean.indexOf(":");
  if (sep <= 0) return undefined;
  const stage = clean.slice(0, sep) as BuildStageName;
  if (!BUILD_STAGE_NAMES.includes(stage)) return undefined;
  const path = clean.slice(sep + 1);
  if (!path) return undefined;
  return { stage, path };
}

// What the editor reports once a requested build pipeline has finished.
export type DocumentBuildResult = {
  request_id: string;
  path: string;
  // overall outcome of the pipeline, not of any single stage
  exit_code?: number;
  error?: string;
  error_count?: number;
  log?: string;
  jobs?: { name: string; exit_code?: number }[];
};
