/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { HUB_PASSWORD_COOKIE_NAME } from "@cocalc/backend/auth/cookie-names";
import getAccountId from "@cocalc/http-api/lib/account/get-account";
import getParams from "@cocalc/http-api/lib/api/get-params";
import { getRememberMeHash } from "@cocalc/server/auth/remember-me";
import { approveDevCliElevate } from "@cocalc/server/auth/cli-auth";

function getCookie(req: any, name: string): string {
  const direct = `${req.cookies?.[name] ?? ""}`.trim();
  if (direct) return direct;
  const header =
    typeof req.header === "function"
      ? `${req.header("cookie") ?? ""}`
      : `${req.headers?.cookie ?? ""}`;
  for (const part of header.split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (rawName?.trim() === name) {
      return rest.join("=").trim();
    }
  }
  return "";
}

export default async function cliElevateDev(req: any, res: any) {
  try {
    const account_id = await getAccountId(req);
    const session_hash = getRememberMeHash(req);
    if (!account_id || !session_hash) {
      throw new Error("interactive CLI sign-in is required");
    }
    const { duration } = getParams(req);
    res.json(
      await approveDevCliElevate({
        account_id,
        session_hash,
        hub_password:
          getCookie(req, HUB_PASSWORD_COOKIE_NAME) ||
          getCookie(req, "hub_password"),
        duration:
          `${duration ?? ""}`.trim() === "extended" ? "extended" : "default",
      }),
    );
  } catch (err) {
    res.json({
      error:
        err instanceof Error
          ? err.message
          : "Problem approving dev CLI elevation.",
    });
  }
}
