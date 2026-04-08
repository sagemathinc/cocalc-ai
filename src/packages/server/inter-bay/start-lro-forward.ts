/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { conat } from "@cocalc/backend/conat";
import getLogger from "@cocalc/backend/logger";
import { get as getLroStream } from "@cocalc/conat/lro/client";
import type { LroEvent } from "@cocalc/conat/hub/api/lro";
import type { DStream } from "@cocalc/conat/sync/dstream";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";

const log = getLogger("server:inter-bay:start-lro-forward");

type CloseFn = () => Promise<void>;

export async function forwardRemoteStartLroProgress({
  project_id,
  op_id,
  source_bay_id,
}: {
  project_id: string;
  op_id?: string;
  source_bay_id?: string;
}): Promise<CloseFn> {
  if (!op_id || !source_bay_id || source_bay_id === getConfiguredBayId()) {
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
    log.warn("unable to open remote start lro stream", {
      project_id,
      op_id,
      source_bay_id,
      err: `${err}`,
    });
    return async () => {};
  }

  const bridge = getInterBayBridge().projectLro(source_bay_id);
  let lastIndex = 0;
  let lastProgressTs = -1;
  let closed = false;
  let pending = Promise.resolve();

  const forwardProgress = (
    event: Extract<LroEvent, { type: "progress" }>,
  ): void => {
    if (closed || event.ts <= lastProgressTs) {
      return;
    }
    lastProgressTs = event.ts;
    pending = pending
      .then(async () => {
        await bridge.publishProgress({
          project_id,
          op_id,
          event,
        });
      })
      .catch((err) => {
        log.warn("unable to forward remote start lro progress", {
          project_id,
          op_id,
          source_bay_id,
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
      log.warn("unable to read remote start lro stream", {
        project_id,
        op_id,
        source_bay_id,
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
        forwardProgress(event);
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
