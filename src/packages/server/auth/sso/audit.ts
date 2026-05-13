/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type { PostgreSQL } from "@cocalc/database/postgres/types";
import type { PassportStrategyDB } from "@cocalc/database/settings/auth-sso-types";
import { isSAML } from "@cocalc/database/settings/auth-sso-types";
import { getEmailDomain } from "@cocalc/server/auth/sso/check-required-sso";

const logger = getLogger("server:auth:sso:audit");

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function ssoAuditProviderType(
  strategy: PassportStrategyDB | undefined,
): "google_oidc" | "saml" | "legacy_sso" {
  const type = strategy?.conf?.type;
  if (strategy?.strategy === "google") return "google_oidc";
  if (type != null && isSAML(type)) return "saml";
  return "legacy_sso";
}

export function ssoAuditEmailDomain(
  emailAddress: string | undefined,
): string | undefined {
  const domain = getEmailDomain(`${emailAddress ?? ""}`.trim().toLowerCase());
  return domain || undefined;
}

export function sanitizeSsoAuditReason(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : `${err}`;
  return raw
    .replace(EMAIL_RE, "<email>")
    .replace(UUID_RE, "<uuid>")
    .slice(0, 300);
}

export async function logSsoAuditEvent({
  database,
  event,
  value,
}: {
  database: PostgreSQL;
  event: "sso_sign_in_allowed" | "sso_sign_in_denied";
  value: Record<string, unknown>;
}): Promise<void> {
  try {
    await (database.log({
      event,
      value,
    }) as any);
  } catch (err) {
    logger.warn(`failed to write ${event}: ${err}`);
  }
}
