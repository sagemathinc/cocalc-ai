/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What a program the project runs (a terminal, an app) needs to use the
// CoCalc CLI as the project: where to connect, which project, and the path
// of its secret token (any process in the project can read that file; the
// variable only names it).

import { join } from "path";
import { conatServer, data } from "@cocalc/backend/data";
import { project_id } from "@cocalc/project/data";
import {
  PROJECT_SECRETS_ENV,
  PROJECT_SECRETS_MOUNT_PATH,
} from "@cocalc/util/project-secrets";

export function projectScopedCliEnv(): Record<string, string> {
  const env = {
    COCALC_API_URL: conatServer,
    COCALC_PROJECT_ID: project_id,
    COCALC_SECRET_TOKEN: join(data, "secret-token"),
    [PROJECT_SECRETS_ENV]: PROJECT_SECRETS_MOUNT_PATH,
  };
  const siteUrl = normalizeSiteUrl(process.env.COCALC_SITE_URL);
  return siteUrl ? { ...env, COCALC_SITE_URL: siteUrl } : env;
}

export function normalizeSiteUrl(value?: string): string | undefined {
  const raw = `${value ?? ""}`.trim();
  if (!raw) return;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return;
  }
}
