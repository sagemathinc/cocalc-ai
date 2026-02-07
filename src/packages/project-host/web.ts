import express from "express";
import getLogger from "@cocalc/backend/logger";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import { account_id } from "@cocalc/backend/data";
import compression from "compression";

const logger = getLogger("project-host:web");

/*
Routing contract for project-host:

- Keep this HTTP surface tiny and mostly static. Treat HTTP request bodies/params
  as untrusted hints only.
- Do NOT add project/account scoped mutating APIs here (anything that depends on
  who the user is, what projects they collaborate on, or account-level policy).
- Implement those APIs via hub conat RPC in:
    - src/packages/conat/hub/api/projects.ts (API + transform/auth mapping)
    - src/packages/project-host/hub/projects.ts (host-local implementation)
  so identity/project authorization flows through transformArgs and subject
  routing instead of ad-hoc HTTP fields.
*/
const DEFAULT_CONFIGURATION = {
  lite: false,
  project_host: true,
  site_name: "CoCalc Project Host",
};

export async function initHttp({
  app,
  conatClient: _, // reserved for future use
}: {
  app: express.Application;
  conatClient: ConatClient;
}) {
  app.use(compression());

  app.get("/customize", async (_req, res) => {
    res.json({
      configuration: {
        ...DEFAULT_CONFIGURATION,
        account_id,
      },
      registration: false,
      strategies: [],
      software: null,
      ollama: {},
      custom_openai: {},
    });
  });
}

export function addCatchAll(app: express.Application) {
  app.get("*", (req, res) => {
    if (req.url.endsWith("__webpack_hmr")) return;
    logger.debug("no static frontend available for", req.url);
    res.status(404).json({
      error: "Not Found",
      detail: "Static assets are not served from project-host.",
    });
  });
}
