/*
Start the Conat services.
*/

import "./connection";
import { getLogger } from "@cocalc/project/logger";
import { init as initAPI } from "./api";
import { init as initWebsocketApi } from "./browser-websocket-api";
import { init as initRead } from "./files/read";
import { init as initWrite } from "./files/write";
import { init as initLocalFilesystem } from "./files/fs";
import { init as initProjectStatus } from "@cocalc/project/project-status/server";
import { init as initUsageInfo } from "@cocalc/project/usage-info";
import { init as initJupyter } from "./jupyter";
import { init as initTerminalServer } from "./terminal-server";
import { init as initClaudeMcp } from "./claude-mcp";
import { getIdentity } from "./connection";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import { init as initExecStream } from "@cocalc/project/exec-stream";
import { init as initExecJobWatch } from "@cocalc/project/exec-job-watch";
import { update as initAuthorizedKeys } from "./authorized-keys";
import { startProjectConatAdmissionSettingsRefresh } from "./admission-settings";

const logger = getLogger("project:conat:index");

export default async function init(opts?: {
  client?: ConatClient;
  project_id?: string;
}) {
  opts = getIdentity(opts);
  const enableProjectInfo = process.env.COCALC_ENABLE_PROJECT_INFO !== "0";
  logger.debug("starting Conat project services", {
    project_id: opts.project_id,
    address: opts.client?.options.address,
    enableProjectInfo,
  });

  startProjectConatAdmissionSettingsRefresh();
  initTerminalServer(opts);
  initClaudeMcp(opts);
  await initAPI(opts);
  await initJupyter(opts);
  initWebsocketApi(opts);
  if (process.env.COCALC_PROJECT_FS === "local") {
    await initLocalFilesystem();
  }
  await initRead(opts);
  await initWrite(opts);
  if (enableProjectInfo) {
    initProjectStatus(opts);
    initUsageInfo(opts);
  } else {
    logger.debug(
      "project info services disabled by COCALC_ENABLE_PROJECT_INFO=0",
    );
  }
  initExecStream(opts);
  await initExecJobWatch(opts);
  await initAuthorizedKeys(opts);
}
