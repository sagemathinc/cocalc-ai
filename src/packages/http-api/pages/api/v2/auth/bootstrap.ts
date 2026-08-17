/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { HOME_BAY_ID_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOriginForRequest } from "@cocalc/server/bay-public-origin";
import { getImpersonationBootstrapInfo } from "@cocalc/server/auth/impersonation";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import isPost from "@cocalc/http-api/lib/api/is-post";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import basePath from "@cocalc/backend/base-path";
import { clientProtocolCapabilities } from "@cocalc/util/client-capabilities";
import { listAccountProjectWindow } from "@cocalc/server/projects/list-account-window";

const PROJECT_WINDOW_MAX_LIMIT = 100;

function projectWindowRequest(body: unknown):
  | {
      limit: number;
      offset: number;
      project_id?: string;
      search?: string;
    }
  | undefined {
  const value = (body as any)?.project_window;
  if (value == null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw Error("project_window must be an object");
  }
  const limit = value.limit ?? 50;
  const offset = value.offset ?? 0;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("project window limit must be a positive integer");
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw Error("project window offset must be a nonnegative integer");
  }
  const search = `${value.search ?? ""}`.trim().slice(0, 200) || undefined;
  const project_id = `${value.project_id ?? ""}`.trim() || undefined;
  return {
    limit: Math.min(limit, PROJECT_WINDOW_MAX_LIMIT),
    offset,
    project_id,
    search,
  };
}

export default async function bootstrap(req, res) {
  if (!isPost(req, res)) {
    return;
  }

  if (req.header("Authorization")) {
    res.json({ error: "API keys are not allowed to use browser bootstrap" });
    return;
  }
  const account_id = await getAccountId(req);
  const client_capabilities = clientProtocolCapabilities(basePath);
  if (!account_id) {
    const hinted_home_bay_id =
      `${req.cookies?.[HOME_BAY_ID_COOKIE_NAME] ?? ""}`.trim() ||
      getConfiguredBayId();
    res.json({
      signed_in: false,
      home_bay_id: hinted_home_bay_id,
      home_bay_url: await getBayPublicOriginForRequest(req, hinted_home_bay_id),
      client_capabilities,
    });
    return;
  }
  const account = await getClusterAccountById(account_id);
  const home_bay_id =
    `${account?.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  const display_name = displayNameFromAccount(account) || undefined;
  let requestedProjectWindow;
  try {
    requestedProjectWindow = projectWindowRequest(req.body);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : `${err}`,
    });
    return;
  }
  let projectWindow:
    | {
        project_window: Awaited<ReturnType<typeof listAccountProjectWindow>>;
        project_window_has_more: boolean;
      }
    | undefined;
  // The projection is authoritative only on the account's home bay. A client
  // that reaches another bay first follows home_bay_url and repeats bootstrap.
  if (requestedProjectWindow && home_bay_id === getConfiguredBayId()) {
    const rows = await listAccountProjectWindow({
      account_id,
      hidden: false,
      limit: requestedProjectWindow.limit + 1,
      offset: requestedProjectWindow.offset,
      project_id: requestedProjectWindow.project_id,
      search: requestedProjectWindow.search,
      sort: "last_edited",
    });
    projectWindow = {
      project_window: rows.slice(0, requestedProjectWindow.limit),
      project_window_has_more: rows.length > requestedProjectWindow.limit,
    };
  }
  res.json({
    signed_in: true,
    account_id,
    email_address: account?.email_address,
    email_address_verified: account?.email_address_verified === true,
    display_name,
    home_bay_id,
    home_bay_url: await getBayPublicOriginForRequest(req, home_bay_id),
    impersonation: await getImpersonationBootstrapInfo({ req, account_id }),
    client_capabilities,
    ...projectWindow,
  });
}
