/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Federated CLI connectors: an agent's cloud CLI (gcloud) gets short-lived
// credentials through workload identity federation. CoCalc signs a short
// OIDC assertion for one lease; the cloud provider exchanges it for an access
// token of one service account. No long-lived cloud credential is stored in
// CoCalc or in a project.
//
// Unlike gh/cf (cli-connectors.ts), the token reaches the CLI through a
// private configuration directory, never an environment variable, so these
// connectors are kept apart from CLI_CONNECTORS and its PATH wrappers.

export const FEDERATED_CLI_CONNECTORS = ["gcloud"] as const;
export type FederatedCliConnector = (typeof FEDERATED_CLI_CONNECTORS)[number];

/** Site setting that turns federated connectors on (the gate). */
export const FEDERATED_GATE_SETTING = "federated_cli_connectors";

/**
 * The federated connectors the site gate lists: known names only, unique and
 * sorted, from a comma- or space-separated value. Public: names only.
 */
export function parseFederatedGate(value: unknown): FederatedCliConnector[] {
  const names = `${value ?? ""}`.split(/[\s,]+/).filter(Boolean);
  return FEDERATED_CLI_CONNECTORS.filter((c) => names.includes(c));
}

export function isFederatedCliConnector(
  value: unknown,
): value is FederatedCliConnector {
  return (
    typeof value === "string" &&
    (FEDERATED_CLI_CONNECTORS as readonly string[]).includes(value)
  );
}

/** Use cases of a connection: operating this site, or a user's own compute. */
export const FEDERATED_CONNECTION_USE_CASES = ["ops", "compute"] as const;
export type FederatedConnectionUseCase =
  (typeof FEDERATED_CONNECTION_USE_CASES)[number];

/** Connections and grants are created disabled and enabled after setup tests. */
export const FEDERATED_RECORD_STATES = [
  "pending",
  "enabled",
  "disabled",
] as const;
export type FederatedRecordState = (typeof FEDERATED_RECORD_STATES)[number];

// ---------------------------------------------------------------------------
// Identifier formats. Everything that reaches a cloud API, a gcloud property
// or an IAM member string is checked against one of these first.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A Google Cloud project id. */
export const GCP_PROJECT_ID_RE = /^[a-z][-a-z0-9]{4,28}[a-z0-9]$/;
/** A Google Cloud project number. */
export const GCP_PROJECT_NUMBER_RE = /^[1-9][0-9]{0,19}$/;
/** A workload identity pool or provider id (4-32 characters). */
export const WIF_POOL_OR_PROVIDER_ID_RE = /^[a-z][a-z0-9-]{2,30}[a-z0-9]$/;
/** A service account email (shown to admins only, never in claims). */
export const GCP_SERVICE_ACCOUNT_RE =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][-a-z0-9]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
/** A display label for the service account, chosen at grant creation. */
export const SA_LABEL_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** A permission profile id (e.g. "read-only"). */
export const PERMISSION_PROFILE_RE = /^[a-z][a-z0-9-]{0,39}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function matches(re: RegExp, value: unknown): value is string {
  return typeof value === "string" && re.test(value);
}

export const isGcpProjectId = (v: unknown): v is string =>
  matches(GCP_PROJECT_ID_RE, v);
export const isGcpProjectNumber = (v: unknown): v is string =>
  matches(GCP_PROJECT_NUMBER_RE, v);
export const isWifPoolOrProviderId = (v: unknown): v is string =>
  matches(WIF_POOL_OR_PROVIDER_ID_RE, v);
export const isGcpServiceAccount = (v: unknown): v is string =>
  matches(GCP_SERVICE_ACCOUNT_RE, v);
export const isSaLabel = (v: unknown): v is string => matches(SA_LABEL_RE, v);
export const isPermissionProfile = (v: unknown): v is string =>
  matches(PERMISSION_PROFILE_RE, v);

// ---------------------------------------------------------------------------
// The OIDC assertion.

/** Path of the issuer below the site's public origin. */
export const FEDERATION_ISSUER_PATH = "/_cocalc/oidc/connectors";
/** An assertion is valid for at most this long. */
export const MAX_ASSERTION_LIFETIME_S = 300;
/** Access tokens are requested for this long. */
export const ACCESS_TOKEN_LIFETIME_S = 900;

/**
 * The assertion's identity attributes, mapped one to one to provider
 * attributes (`attribute.<name>=assertion.<name>`). Opaque ids only: never
 * an email, name or title.
 */
export const FEDERATION_ATTRIBUTE_CLAIMS = [
  "site_id",
  "account_id",
  "agent_id",
  "project_id",
  "connection_id",
  "grant_id",
  "grant_revision",
  "lease_id",
] as const;
export type FederationAttributeClaim =
  (typeof FEDERATION_ATTRIBUTE_CLAIMS)[number];

export type FederationAttributes = Record<FederationAttributeClaim, string>;

/** The issuer URL for a site's public origin (no trailing slash). */
export function federationIssuer(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw Error("invalid site origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw Error("the site origin must be a bare https origin");
  }
  return `${url.origin}${FEDERATION_ISSUER_PATH}`;
}

export interface WifProvider {
  pool_project_number: string;
  pool_id: string;
  provider_id: string;
}

function wifProviderPath({
  pool_project_number,
  pool_id,
  provider_id,
}: WifProvider): string {
  if (!isGcpProjectNumber(pool_project_number))
    throw Error("invalid pool project number");
  if (!isWifPoolOrProviderId(pool_id)) throw Error("invalid pool id");
  if (!isWifPoolOrProviderId(provider_id)) throw Error("invalid provider id");
  return `iam.googleapis.com/projects/${pool_project_number}/locations/global/workloadIdentityPools/${pool_id}/providers/${provider_id}`;
}

/**
 * The assertion's `aud`: the provider's https URL, which is the provider's
 * default (and only) allowed audience. Provisional until the staging
 * audience test pins it.
 */
export function wifAssertionAudience(provider: WifProvider): string {
  return `https://${wifProviderPath(provider)}`;
}

/** The `audience` of the token-exchange request: the provider's name. */
export function wifExchangeAudience(provider: WifProvider): string {
  return `//${wifProviderPath(provider)}`;
}

/** The only member a grant's service account trusts. */
export function wifGrantPrincipalSet({
  pool_project_number,
  pool_id,
  grant_id,
}: {
  pool_project_number: string;
  pool_id: string;
  grant_id: string;
}): string {
  if (!isGcpProjectNumber(pool_project_number))
    throw Error("invalid pool project number");
  if (!isWifPoolOrProviderId(pool_id)) throw Error("invalid pool id");
  if (!isUuid(grant_id)) throw Error("invalid grant id");
  return `principalSet://iam.googleapis.com/projects/${pool_project_number}/locations/global/workloadIdentityPools/${pool_id}/attribute.grant_id/${grant_id}`;
}

/**
 * Checks the identity attributes of one assertion: exactly the listed
 * claims, all opaque ids (UUIDs, and a positive decimal grant revision).
 */
export function validateFederationAttributes(
  value: unknown,
): FederationAttributes {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw Error("invalid federation attributes");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== FEDERATION_ATTRIBUTE_CLAIMS.length ||
    !FEDERATION_ATTRIBUTE_CLAIMS.every((k) => keys.includes(k))
  ) {
    throw Error("federation attributes must be exactly the listed claims");
  }
  const attrs = value as Record<string, unknown>;
  for (const claim of FEDERATION_ATTRIBUTE_CLAIMS) {
    const v = attrs[claim];
    const ok =
      claim === "grant_revision"
        ? typeof v === "string" && /^[1-9][0-9]{0,9}$/.test(v)
        : isUuid(v);
    if (!ok) throw Error(`invalid federation attribute ${claim}`);
  }
  return attrs as FederationAttributes;
}

// ---------------------------------------------------------------------------
// Turn delivery: what the hub hands the project host for a turn.

export const GCLOUD_TURN_STATUSES = [
  "active",
  "degraded",
  "recovery_only",
] as const;
export type GcloudTurnStatus = (typeof GCLOUD_TURN_STATUSES)[number];

export interface GcloudTurnLease {
  /** Milliseconds since epoch: when the access token expires. */
  provider_expires_at: number;
  /**
   * Milliseconds since epoch: the lease's fixed hard deadline, set when the
   * lease is created and never moved by renewal; null when the lease has
   * none (turn leases).
   */
  lease_max_expires_at: number | null;
  status: GcloudTurnStatus;
  /** Default project, written as core/project. */
  project: string;
  /** Display label only, never the service account email. */
  sa_label: string;
  /** Opaque lease id (the assertion's subject), for runner evidence. */
  lease_id: string;
  connection_id: string;
  grant_revision: number;
}

/** Why a renewal ended a lease: every one deletes the lease's files at once. */
export const GCLOUD_LEASE_END_REASONS = [
  "deny",
  "revoke",
  "revision",
  "expired",
] as const;
export type GcloudLeaseEndReason = (typeof GCLOUD_LEASE_END_REASONS)[number];

export interface GcloudLeaseEnded {
  lease_id: string;
  reason: GcloudLeaseEndReason;
}

export interface GcloudTurnToken {
  connector: "gcloud";
  /** The access token: written to a 0600 file only. */
  token: string;
  /** = gcloud.provider_expires_at. */
  expires_at: number;
  description: string;
  gcloud: GcloudTurnLease;
}

const MAX_TOKEN_LENGTH = 8192;
const TOKEN_RE = /^[\x21-\x7e]+$/; // printable ASCII, no whitespace
const DESCRIPTION_RE = /^[\x20-\x7e]{0,200}$/; // printable ASCII and spaces
const TURN_TOKEN_KEYS = [
  "connector",
  "token",
  "expires_at",
  "description",
  "gcloud",
];
const TURN_LEASE_KEYS = [
  "provider_expires_at",
  "lease_max_expires_at",
  "status",
  "project",
  "sa_label",
  "lease_id",
  "connection_id",
  "grant_revision",
];

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The gcloud entry of a turn's connector tokens, or undefined if anything in
 * it is malformed: the project host then removes every gcloud file (fail
 * closed). Never includes the token in an error.
 */
export function parseGcloudTurnToken(
  value: unknown,
): GcloudTurnToken | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return;
  if (!exactKeys(value, TURN_TOKEN_KEYS)) return;
  const entry = value as Record<string, any>;
  if (entry.connector !== "gcloud") return;
  if (
    typeof entry.token !== "string" ||
    entry.token.length > MAX_TOKEN_LENGTH ||
    !TOKEN_RE.test(entry.token)
  )
    return;
  // The description goes into the agent's turn context: printable ASCII
  // only, so it can't add lines or control characters.
  if (
    typeof entry.description !== "string" ||
    !DESCRIPTION_RE.test(entry.description)
  )
    return;
  const lease = entry.gcloud;
  if (lease == null || typeof lease !== "object" || Array.isArray(lease))
    return;
  if (!exactKeys(lease, TURN_LEASE_KEYS)) return;
  if (!isTime(lease.provider_expires_at)) return;
  if (
    lease.lease_max_expires_at !== null &&
    !isTime(lease.lease_max_expires_at)
  )
    return;
  if (entry.expires_at !== lease.provider_expires_at) return;
  if (!(GCLOUD_TURN_STATUSES as readonly string[]).includes(lease.status))
    return;
  if (!isGcpProjectId(lease.project)) return;
  if (!isSaLabel(lease.sa_label)) return;
  if (!isUuid(lease.lease_id)) return;
  if (!isUuid(lease.connection_id)) return;
  if (
    typeof lease.grant_revision !== "number" ||
    !Number.isSafeInteger(lease.grant_revision) ||
    lease.grant_revision < 1
  )
    return;
  return entry as GcloudTurnToken;
}

/** A renewal's list of ended leases, or undefined if malformed. */
export function parseGcloudLeasesEnded(
  value: unknown,
): GcloudLeaseEnded[] | undefined {
  if (!Array.isArray(value)) return;
  const out: GcloudLeaseEnded[] = [];
  for (const item of value) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return;
    if (!exactKeys(item, ["lease_id", "reason"])) return;
    const { lease_id, reason } = item as Record<string, unknown>;
    if (!isUuid(lease_id)) return;
    if (!(GCLOUD_LEASE_END_REASONS as readonly unknown[]).includes(reason))
      return;
    out.push({ lease_id, reason: reason as GcloudLeaseEndReason });
  }
  return out;
}

/**
 * What the project host writes to status.json: no token bytes. It is
 * informational only, never an authority (a project user can write it).
 */
export function gcloudLeaseStatusFile(token: GcloudTurnToken): {
  provider_expires_at: number;
  lease_max_expires_at: number | null;
  status: GcloudTurnStatus;
  lease_id: string;
  connection_id: string;
  grant_revision: number;
} {
  const lease = token.gcloud;
  return {
    provider_expires_at: lease.provider_expires_at,
    lease_max_expires_at: lease.lease_max_expires_at,
    status: lease.status,
    lease_id: lease.lease_id,
    connection_id: lease.connection_id,
    grant_revision: lease.grant_revision,
  };
}

/** A federated turn answer (contract v7): at most one entry, never revoked. */
export interface FederatedConnectorTurnResult {
  entry?: GcloudTurnToken;
  revoked: GcloudLeaseEnded[];
}

/**
 * Checks a hub answer to beginFederatedConnectorTurn: exactly
 * `{ entries, revoked }`, at most one valid entry, valid and unique revoked
 * leases, and no lease both returned and revoked. Anything else is
 * undefined (malformed): the project host then removes every gcloud file.
 */
export function parseFederatedConnectorTurnResult(
  value: unknown,
): FederatedConnectorTurnResult | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    return;
  if (!exactKeys(value, ["entries", "revoked"])) return;
  const { entries, revoked: rawRevoked } = value as Record<string, unknown>;
  if (!Array.isArray(entries) || entries.length > 1) return;
  const revoked = parseGcloudLeasesEnded(rawRevoked);
  if (revoked == null) return;
  const ids = new Set(revoked.map(({ lease_id }) => lease_id));
  if (ids.size !== revoked.length) return;
  if (entries.length === 0) return { revoked };
  const entry = parseGcloudTurnToken(entries[0]);
  if (entry == null || ids.has(entry.gcloud.lease_id)) return;
  return { entry, revoked };
}

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace, only
 * strings, finite numbers, booleans, null, arrays and plain objects (anything
 * else throws). Equal values give equal text, and because every string is
 * JSON-escaped, distinct values can't collide by embedding separators.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw Error("canonicalJson: number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw Error("canonicalJson: not a plain object");
      }
      const keys = Object.keys(value).sort();
      return `{${keys
        .map(
          (k) =>
            `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
        )
        .join(",")}}`;
    }
    default:
      throw Error(`canonicalJson: ${typeof value}`);
  }
}
