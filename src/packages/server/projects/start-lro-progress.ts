/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import type { LroEvent } from "@cocalc/conat/hub/api/lro";
import { get as getLroStream } from "@cocalc/conat/lro/client";
import { publishLroSummary } from "@cocalc/conat/lro/stream";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { updateLro } from "@cocalc/server/lro/lro-db";

const log = getLogger("server:projects:start-lro-progress");

type CloseFn = () => Promise<void>;

function toProgressSummary(event: Extract<LroEvent, { type: "progress" }>) {
  return {
    phase: event.phase,
    message: event.message,
    ...(event.progress != null ? { progress: event.progress } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  };
}

export async function mirrorStartLroProgress({
  project_id,
  op_id,
}: {
  project_id: string;
  op_id?: string;
}): Promise<CloseFn> {
  if (!op_id) {
    return async () => {};
  }

  let stream: DStream<LroEvent> | undefined;
  try {
    stream = await getLroStream({
      op_id,
      scope_type: "project",
      scope_id: project_id,
      client: conat(),
    });
  } catch (err) {
    log.warn("unable to open project-start lro stream", {
      project_id,
      op_id,
      err: `${err}`,
    });
    return async () => {};
  }

  let lastIndex = 0;
  let lastProgressTs = -1;
  let lastSummaryKey = "";
  let closed = false;
  let pending = Promise.resolve();

  const persistProgress = (
    event: Extract<LroEvent, { type: "progress" }>,
  ): void => {
    if (closed || event.ts <= lastProgressTs) {
      return;
    }
    lastProgressTs = event.ts;
    const progress_summary = toProgressSummary(event);
    const nextKey = JSON.stringify(progress_summary);
    if (nextKey === lastSummaryKey) {
      return;
    }
    lastSummaryKey = nextKey;
    pending = pending
      .then(async () => {
        const updated = await updateLro({
          op_id,
          progress_summary,
        });
        if (updated) {
          await publishLroSummary({
            scope_type: updated.scope_type,
            scope_id: updated.scope_id,
            summary: updated,
          });
        }
      })
      .catch((err) => {
        log.warn("unable to persist project-start progress", {
          project_id,
          op_id,
          err: `${err}`,
        });
      });
  };

  const drain = (): void => {
    if (!stream || closed) {
      return;
    }
    let events: LroEvent[];
    try {
      events = stream.getAll();
    } catch (err) {
      log.warn("unable to read project-start lro stream", {
        project_id,
        op_id,
        err: `${err}`,
      });
      return;
    }
    if (events.length < lastIndex) {
      lastIndex = 0;
    }
    for (let i = lastIndex; i < events.length; i += 1) {
      const event = events[i];
      if (event.type === "progress") {
        persistProgress(event);
      }
    }
    lastIndex = events.length;
  };

  const onChange = () => drain();
  const onReset = () => drain();
  const onClosed = () => {
    closed = true;
  };

  stream.on("change", onChange);
  stream.on("reset", onReset);
  stream.on("closed", onClosed);
  drain();

  return async () => {
    closed = true;
    stream?.removeListener("change", onChange);
    stream?.removeListener("reset", onReset);
    stream?.removeListener("closed", onClosed);
    stream?.close();
    try {
      await pending;
    } catch {
      // already logged
    }
  };
}
