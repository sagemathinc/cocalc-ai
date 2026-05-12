/*
Project-side exec-stream service that handles streaming execution requests.
Similar to how the project API service works, but specifically for streaming exec.
*/

import { executeStream, StreamEvent } from "@cocalc/backend/exec-stream";
import { Message, Subscription } from "@cocalc/conat/core/client";
import { projectSubject, EXEC_STREAM_SERVICE } from "@cocalc/conat/names";
import { getProjectConatClient } from "@cocalc/project/conat/runtime-client";
import { project_id } from "@cocalc/project/data";
import { getLogger } from "@cocalc/project/logger";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import { recordServiceAdmissionDenial } from "@cocalc/conat/admission/denials";

const logger = getLogger("project:exec-stream");

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? "", 10);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  return fallback;
}

const MAX_ACTIVE_EXEC_STREAMS = parsePositiveInt(
  process.env.COCALC_PROJECT_EXEC_STREAM_MAX_ACTIVE,
  16,
);

let activeExecStreams = 0;

export function init(opts?: {
  client?: ConatClient;
  maxActiveExecStreams?: number;
}) {
  void serve(opts).catch((err) => {
    logger.warn("exec-stream service failed during startup", err);
  });
}

async function serve(opts?: {
  client?: ConatClient;
  maxActiveExecStreams?: number;
}) {
  logger.debug("serve: create project exec-stream service");
  const cn = opts?.client ?? getProjectConatClient();
  const subject = projectSubject({
    project_id,
    service: EXEC_STREAM_SERVICE,
  });

  logger.debug(
    `serve: creating exec-stream service for project ${project_id} and subject='${subject}'`,
  );
  const api = await cn.subscribe(subject, { queue: "q" });
  await listen(
    api,
    subject,
    opts?.maxActiveExecStreams ?? MAX_ACTIVE_EXEC_STREAMS,
  );
}

async function listen(
  api: Subscription,
  subject: string,
  maxActiveExecStreams: number,
) {
  logger.debug(`Listening on subject='${subject}'`);

  for await (const mesg of api) {
    if (activeExecStreams >= maxActiveExecStreams) {
      const error = "project exec-stream service is busy";
      recordServiceAdmissionDenial({
        surface: "project-exec-stream",
        source: "project-service",
        limit: "COCALC_PROJECT_EXEC_STREAM_MAX_ACTIVE",
        current: activeExecStreams,
        maximum: maxActiveExecStreams,
        reason: error,
        project_id,
        subject,
      });
      logger.warn(error, {
        active: activeExecStreams,
        max: maxActiveExecStreams,
        subject,
      });
      mesg.respondSync({ error });
      mesg.respondSync(null);
      continue;
    }
    activeExecStreams += 1;
    void handleMessage(mesg).finally(() => {
      activeExecStreams -= 1;
    });
  }
}

async function handleMessage(mesg: Message) {
  const options = mesg.data;

  let seq = 0;
  const respond = ({ type, data, error }: StreamEvent) => {
    mesg.respondSync({ type, data, error, seq });
    seq += 1;
  };

  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    // end response stream with null payload.
    mesg.respondSync(null);
  };

  const stream = (event: StreamEvent) => {
    if (done) return;
    if (event != null) {
      respond(event);
    } else {
      end();
    }
  };

  try {
    // SECURITY: verify that the project_id claimed in options matches
    // with our actual project_id
    if (options.project_id != project_id) {
      throw Error("project_id is invalid");
    }

    const { stream: _, project_id: reqProjectId, ...opts } = options;

    // Call the backend executeStream function
    await executeStream({
      ...opts,
      project_id: reqProjectId,
      stream,
    });
  } catch (err) {
    if (!done) {
      respond({ error: `${err}` });
      end();
    }
  }
}
