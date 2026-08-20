/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { DOCUMENT_BUILD_RESULT_SERVICE, projectSubject } from "../names";

/*
Where a frame editor reports the outcome of a build it was asked to run.

Keyed by request id rather than by document path on purpose.  Build *groups*
are canonicalized (a .Rnw and its generated .tex share one), so a path-keyed
subject would let two different editors answer the same request and the faster
one would win.  The request id is unique to one caller, and the reply carries
the responding editor's own logical path so the caller can confirm it is
hearing from the editor it meant to ask.
*/
export function documentBuildResultSubject({
  project_id,
  request_id,
}: {
  project_id: string;
  request_id: string;
}): string {
  return projectSubject({
    project_id,
    service: DOCUMENT_BUILD_RESULT_SERVICE,
    path: request_id,
  });
}
