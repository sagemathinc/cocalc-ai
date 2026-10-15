/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The script behind the one-line setup commands shown in CoCalc, e.g.
//
//   curl -fsSL '<site>/api/v2/cli/setup?action=ssh&project=<id>' | sh
//   curl -fsSL '<home bay>/api/v2/cli/setup?action=computer&request=R-...' | sh
//
// GET with query parameters, unlike other routes: curl fetches it, it changes
// nothing, it is plain text (never rendered), and only a fixed set of actions
// with validated arguments exists. Everything else in the script (the site,
// the installer) comes from this server, never from the request. See
// server/cli-setup/setup-script.ts.

import type { Request, Response } from "express";
import siteURL from "@cocalc/database/settings/site-url";
import {
  cliInstaller,
  errorScript,
  SetupActionError,
  setupScript,
  sshPlan,
} from "@cocalc/server/cli-setup/setup-script";
import { configuredReleaseSource } from "@cocalc/server/cli-distribution/releases";
import { computerConnectPlan } from "@cocalc/server/computers/setup-plan";

function param(req: Request, name: string): string {
  const value = req.query?.[name];
  return typeof value === "string" ? value : "";
}

export default async function handle(req: Request, res: Response) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.status(405).send(errorScript("use GET"));
    return;
  }
  try {
    const action = param(req, "action");
    const site = new URL(await siteURL()).href.replace(/\/+$/, "");
    // This site's own installer when it serves CLI releases.
    const installer = cliInstaller(site, configuredReleaseSource() != null);
    if (action === "ssh") {
      res.send(setupScript(sshPlan(site, param(req, "project")), installer));
      return;
    }
    if (action === "computer") {
      res.send(
        setupScript(
          await computerConnectPlan(param(req, "request")),
          installer,
        ),
      );
      return;
    }
    throw new SetupActionError("unknown setup action");
  } catch (err) {
    // A script that says what is wrong: with `| sh` the person sees it.
    res.send(
      errorScript(
        err instanceof SetupActionError
          ? err.message
          : "this setup line isn't available right now; try again",
      ),
    );
  }
}
