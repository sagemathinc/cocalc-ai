import { randomUUID, sign as signData } from "node:crypto";
import { readFileSync } from "node:fs";

import { Command } from "commander";

import type {
  ClaimableMembershipPackage,
  MembershipPackageAssignment,
  MembershipPackageDetails,
  MembershipPackageKind,
  MembershipPackageQuote,
  SiteLicenseExternalClaimConsumption,
  SiteLicenseExternalClaimKey,
  SiteLicenseExternalClaimPool,
  SiteLicenseExternalClaimSigningAlgorithm,
  SiteLicenseOverview,
  SiteLicensePoolConfig,
  SiteLicensePoolRequest,
} from "@cocalc/conat/hub/api/purchases";

export type MembershipCommandDeps = {
  withContext: any;
  toIso: any;
  resolveAccountByIdentifier: any;
  resolveProject: any;
};

function parsePositiveInteger(value: string | undefined, flagName: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  flagName: string,
): number | undefined {
  if (`${value ?? ""}`.trim() === "") return;
  return parsePositiveInteger(value, flagName);
}

function parseJsonObject(
  raw: string | undefined,
  flagName: string,
): Record<string, unknown> | undefined {
  const trimmed = `${raw ?? ""}`.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`invalid ${flagName}: ${err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flagName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseMetadataJson(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  return parseJsonObject(raw, "--metadata-json");
}

function parseJsonArray<T>(raw: string | undefined, flagName: string): T[] {
  const trimmed = `${raw ?? ""}`.trim();
  if (!trimmed) {
    throw new Error(`${flagName} is required`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`invalid ${flagName}: ${err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${flagName} must be a JSON array`);
  }
  return parsed as T[];
}

function readTextFile(path: string | undefined, flagName: string): string {
  const normalizedPath = `${path ?? ""}`.trim();
  if (!normalizedPath) {
    throw new Error(`${flagName} is required`);
  }
  try {
    return readFileSync(normalizedPath, "utf8");
  } catch (err) {
    throw new Error(`unable to read ${flagName}: ${err}`);
  }
}

function parseExternalClaimPublicKey(opts: {
  jwkJson?: string;
  jwkFile?: string;
  pem?: string;
  pemFile?: string;
}): {
  public_key_jwk?: Record<string, unknown> | null;
  public_key_pem?: string | null;
} {
  const candidates = [
    `${opts.jwkJson ?? ""}`.trim() ? "--jwk-json" : undefined,
    `${opts.jwkFile ?? ""}`.trim() ? "--jwk-file" : undefined,
    `${opts.pem ?? ""}`.trim() ? "--pem" : undefined,
    `${opts.pemFile ?? ""}`.trim() ? "--pem-file" : undefined,
  ].filter(Boolean);
  if (candidates.length === 0) {
    throw new Error(
      "one of --jwk-json, --jwk-file, --pem, or --pem-file is required",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      "only one of --jwk-json, --jwk-file, --pem, or --pem-file may be used",
    );
  }
  if (`${opts.jwkJson ?? ""}`.trim()) {
    return {
      public_key_jwk: parseJsonObject(opts.jwkJson, "--jwk-json"),
      public_key_pem: null,
    };
  }
  if (`${opts.jwkFile ?? ""}`.trim()) {
    return {
      public_key_jwk: parseJsonObject(
        readTextFile(opts.jwkFile, "--jwk-file"),
        "--jwk-file",
      ),
      public_key_pem: null,
    };
  }
  return {
    public_key_jwk: null,
    public_key_pem:
      `${opts.pem ?? readTextFile(opts.pemFile, "--pem-file")}`.trim(),
  };
}

function normalizeExternalClaimAlg(
  raw: string | undefined,
): SiteLicenseExternalClaimSigningAlgorithm {
  const value = `${raw ?? ""}`.trim();
  if (value === "EdDSA" || value === "ES256") {
    return value;
  }
  throw new Error("--alg must be EdDSA or ES256");
}

function dateToNumericDate(value: Date): number {
  return Math.floor(value.valueOf() / 1000);
}

function parseIsoDate(value: string | undefined, flagName: string): Date {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) {
    throw new Error(`${flagName} is required`);
  }
  const date = new Date(normalized);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`${flagName} must be an ISO date`);
  }
  return date;
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createExternalClaimSampleToken({
  alg,
  kid,
  privateKeyPem,
  payload,
}: {
  alg: SiteLicenseExternalClaimSigningAlgorithm;
  kid: string;
  privateKeyPem: string;
  payload: Record<string, unknown>;
}): string {
  if (alg !== "EdDSA") {
    throw new Error("sample-token currently supports --alg EdDSA");
  }
  const encodedHeader = encodeBase64UrlJson({ alg, kid, typ: "JWT" });
  const encodedPayload = encodeBase64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signData(null, Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function normalizeStringList(values: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .flatMap((value) => `${value ?? ""}`.split(/[\s,;]+/))
        .map((value) => value.trim().toLowerCase().replace(/^@+/, ""))
        .filter(Boolean),
    ),
  ).sort();
}

function parseSiteLicensePoolsJson(
  raw: string | undefined,
): SiteLicensePoolConfig[] {
  const pools = parseJsonArray<Record<string, unknown>>(raw, "--pools-json");
  if (pools.length === 0) {
    throw new Error("--pools-json must contain at least one pool");
  }
  return pools.map((pool, index) => {
    const pool_name = `${pool.pool_name ?? pool.name ?? ""}`.trim();
    const membership_class = `${pool.membership_class ?? ""}`.trim();
    const seat_count = Number(pool.seat_count);
    const verification_policy = `${pool.verification_policy ?? ""}`.trim();
    if (!pool_name) {
      throw new Error(`pool ${index + 1} is missing pool_name`);
    }
    if (!membership_class) {
      throw new Error(`pool ${index + 1} is missing membership_class`);
    }
    if (
      !Number.isFinite(seat_count) ||
      !Number.isInteger(seat_count) ||
      seat_count <= 0
    ) {
      throw new Error(
        `pool ${index + 1} seat_count must be a positive integer`,
      );
    }
    if (
      verification_policy !== "email-domain" &&
      verification_policy !== "manager-approval" &&
      verification_policy !== "sso-affiliation"
    ) {
      throw new Error(
        `pool ${index + 1} verification_policy must be email-domain, manager-approval, or sso-affiliation`,
      );
    }
    return {
      pool_name,
      membership_class,
      seat_count,
      requires_approval: pool.requires_approval === true,
      verification_policy,
      exclusive_group: `${pool.exclusive_group ?? ""}`.trim() || undefined,
      affiliation_reverification_days:
        typeof pool.affiliation_reverification_days === "number"
          ? pool.affiliation_reverification_days
          : undefined,
      affiliation_reverification_grace_days:
        typeof pool.affiliation_reverification_grace_days === "number"
          ? pool.affiliation_reverification_grace_days
          : undefined,
      allowed_domains: Array.isArray(pool.allowed_domains)
        ? normalizeStringList(pool.allowed_domains as string[])
        : undefined,
      metadata:
        pool.metadata && typeof pool.metadata === "object"
          ? (pool.metadata as Record<string, unknown>)
          : undefined,
    };
  });
}

function normalizePackageKind(
  raw: string | undefined,
): MembershipPackageKind | undefined {
  const value = `${raw ?? ""}`.trim().toLowerCase();
  if (!value) return;
  if (value === "team" || value === "course") {
    return value;
  }
  if (
    value === "site" ||
    value === "site-license" ||
    value === "domain" ||
    value === "domain-license"
  ) {
    return "site";
  }
  throw new Error(
    `invalid package kind '${raw}'; expected course, team, or site`,
  );
}

function getAllowedDomains(
  membershipPackage: MembershipPackageDetails,
): string[] | null {
  const candidates = [
    membershipPackage.metadata?.allowed_domains,
    membershipPackage.metadata?.domains,
    membershipPackage.metadata?.email_domains,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const values = candidate.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
      return values.length ? values : null;
    }
  }
  return null;
}

function formatAssignmentTarget(
  assignment: MembershipPackageAssignment,
): string {
  const accountId = `${assignment.account_id ?? ""}`.trim();
  if (accountId) {
    return accountId;
  }
  const email = `${assignment.email_address ?? ""}`.trim();
  if (email) {
    return `email:${email}`;
  }
  return assignment.id;
}

function serializeAssignment(
  assignment: MembershipPackageAssignment,
  toIso: MembershipCommandDeps["toIso"],
) {
  return {
    assignment_id: assignment.id,
    package_id: assignment.package_id,
    account_id: assignment.account_id ?? null,
    email_address: assignment.email_address ?? null,
    assigned_by_account_id: assignment.assigned_by_account_id ?? null,
    assigned_at: toIso(assignment.assigned_at),
    revoked_at: toIso(assignment.revoked_at),
    active: !assignment.revoked_at,
    grant_id: assignment.grant_id ?? null,
    grant_source: assignment.grant_source ?? null,
    grant_purchase_id: assignment.grant_purchase_id ?? null,
    metadata: assignment.metadata ?? null,
  };
}

function serializeMembershipPackage(
  membershipPackage: MembershipPackageDetails,
  toIso: MembershipCommandDeps["toIso"],
  opts: {
    mode?: "narrow" | "wide" | "full";
    includeAssignments?: boolean;
  } = {},
) {
  const activeAssignments = membershipPackage.assignments.filter(
    (assignment) => !assignment.revoked_at,
  );
  const mode = opts.mode ?? (opts.includeAssignments ? "full" : "wide");
  const result: Record<string, unknown> = {
    package_id: membershipPackage.id,
    kind: membershipPackage.kind,
    membership_class: membershipPackage.membership_class,
    seat_count: membershipPackage.seat_count,
    active_assignment_count: membershipPackage.active_assignment_count,
    available_seat_count: membershipPackage.available_seat_count,
    starts_at: toIso(membershipPackage.starts_at),
    expires_at: toIso(membershipPackage.expires_at),
  };
  if (mode !== "narrow") {
    result.owner_account_id = membershipPackage.owner_account_id;
    result.purchase_id = membershipPackage.purchase_id ?? null;
    result.interval =
      `${membershipPackage.metadata?.interval ?? ""}`.trim() || null;
    result.seat_price =
      typeof membershipPackage.metadata?.seat_price === "number"
        ? membershipPackage.metadata.seat_price
        : null;
    result.assignment_targets = activeAssignments
      .map(formatAssignmentTarget)
      .join(", ");
    result.assignment_emails = activeAssignments
      .map((assignment) => `${assignment.email_address ?? ""}`.trim())
      .filter(Boolean);
    result.allowed_domains = getAllowedDomains(membershipPackage);
    result.course_project_id =
      `${membershipPackage.metadata?.course_project_id ?? ""}`.trim() || null;
    result.created = toIso(membershipPackage.created);
    result.updated = toIso(membershipPackage.updated);
  }
  if (mode === "full" || opts.includeAssignments) {
    result.assignments = membershipPackage.assignments.map((assignment) =>
      serializeAssignment(assignment, toIso),
    );
    result.metadata = membershipPackage.metadata ?? null;
  }
  return result;
}

function wantsStructuredOutput(ctx: {
  globals?: { json?: boolean; output?: "table" | "json" | "yaml" };
}): boolean {
  return !!ctx.globals?.json || ctx.globals?.output === "json";
}

function serializeClaimablePackage(
  claimablePackage: ClaimableMembershipPackage,
  toIso: MembershipCommandDeps["toIso"],
) {
  return {
    package_id: claimablePackage.package_id,
    assignment_id: claimablePackage.assignment_id ?? null,
    kind: claimablePackage.kind,
    membership_class: claimablePackage.membership_class,
    owner_account_id: claimablePackage.owner_account_id,
    starts_at: toIso(claimablePackage.starts_at),
    expires_at: toIso(claimablePackage.expires_at),
    available_seat_count: claimablePackage.available_seat_count,
    matched_email_address: claimablePackage.matched_email_address,
    reason: claimablePackage.reason,
    requires_approval: claimablePackage.requires_approval ?? false,
    site_license_id: claimablePackage.site_license_id ?? null,
    pool_name: claimablePackage.pool_name ?? null,
    verification_policy: claimablePackage.verification_policy ?? null,
    exclusive_group: claimablePackage.exclusive_group ?? null,
    pending_request_id: claimablePackage.pending_request_id ?? null,
    pending_request_state: claimablePackage.pending_request_state ?? null,
    custom_terms_url: claimablePackage.custom_terms_url ?? null,
    custom_policy_url: claimablePackage.custom_policy_url ?? null,
    terms_version_label: claimablePackage.terms_version_label ?? null,
    requires_terms_acceptance:
      claimablePackage.requires_terms_acceptance ?? false,
    metadata: claimablePackage.metadata ?? null,
  };
}

function serializeSiteLicenseRequest(
  request: SiteLicensePoolRequest,
  toIso: MembershipCommandDeps["toIso"],
) {
  return {
    request_id: request.id,
    site_license_id: request.site_license_id,
    package_id: request.package_id,
    account_id: request.account_id,
    matched_email_address: request.matched_email_address,
    canonical_identity: request.canonical_identity,
    requested_membership_class: request.requested_membership_class,
    state: request.state,
    requester_note: request.requester_note ?? null,
    reviewer_account_id: request.reviewer_account_id ?? null,
    review_note: request.review_note ?? null,
    requested_at: toIso(request.requested_at),
    reviewed_at: toIso(request.reviewed_at),
    expires_at: toIso(request.expires_at),
    metadata: request.metadata ?? null,
  };
}

function serializeSiteLicenseOverview(
  overview: SiteLicenseOverview,
  toIso: MembershipCommandDeps["toIso"],
) {
  return {
    site_license: {
      ...overview.site_license,
      starts_at: toIso(overview.site_license.starts_at),
      expires_at: toIso(overview.site_license.expires_at),
      created: toIso(overview.site_license.created),
      updated: toIso(overview.site_license.updated),
    },
    pools: overview.pools.map((pool) => ({
      ...serializeMembershipPackage(pool, toIso, {
        mode: "full",
        includeAssignments: true,
      }),
      pool_name: pool.pool_name,
      requires_approval: pool.requires_approval,
      verification_policy: pool.verification_policy,
      exclusive_group: pool.exclusive_group,
      affiliation_reverification_days:
        pool.affiliation_reverification_days ?? null,
      affiliation_reverification_grace_days:
        pool.affiliation_reverification_grace_days ?? null,
      pending_request_count: pool.pending_request_count,
    })),
    managers: overview.managers.map((manager) => ({
      manager_id: manager.id,
      site_license_id: manager.site_license_id,
      account_id: manager.account_id,
      role: manager.role,
      created_by_account_id: manager.created_by_account_id ?? null,
      revoked_at: toIso(manager.revoked_at),
      metadata: manager.metadata ?? null,
      created: toIso(manager.created),
      updated: toIso(manager.updated),
    })),
    pending_requests: overview.pending_requests.map((request) =>
      serializeSiteLicenseRequest(request, toIso),
    ),
  };
}

function serializeSiteLicenseExternalClaimPool(
  claimPool: SiteLicenseExternalClaimPool,
  toIso: MembershipCommandDeps["toIso"],
) {
  return {
    pool_id: claimPool.id,
    slug: claimPool.slug ?? null,
    site_license_id: claimPool.site_license_id,
    package_id: claimPool.package_id,
    name: claimPool.name,
    issuer: claimPool.issuer,
    audience: claimPool.audience,
    default_membership_class: claimPool.default_membership_class ?? null,
    allow_membership_class_override: claimPool.allow_membership_class_override,
    default_membership_duration_days:
      claimPool.default_membership_duration_days ?? null,
    default_membership_expires_at: toIso(
      claimPool.default_membership_expires_at,
    ),
    allow_membership_expires_at_override:
      claimPool.allow_membership_expires_at_override,
    min_membership_duration_days:
      claimPool.min_membership_duration_days ?? null,
    max_membership_duration_days:
      claimPool.max_membership_duration_days ?? null,
    max_membership_expires_at: toIso(claimPool.max_membership_expires_at),
    default_rootfs_id: claimPool.default_rootfs_id ?? null,
    max_claims: claimPool.max_claims ?? null,
    max_claims_per_account: claimPool.max_claims_per_account ?? null,
    starts_at: toIso(claimPool.starts_at),
    expires_at: toIso(claimPool.expires_at),
    disabled_at: toIso(claimPool.disabled_at),
    created_by_account_id: claimPool.created_by_account_id ?? null,
    metadata: claimPool.metadata ?? null,
    created: toIso(claimPool.created),
    updated: toIso(claimPool.updated),
  };
}

function serializeSiteLicenseExternalClaimKey(
  key: SiteLicenseExternalClaimKey,
  toIso: MembershipCommandDeps["toIso"],
) {
  return {
    key_id: key.id,
    pool_id: key.pool_id,
    kid: key.kid,
    alg: key.alg,
    public_key_type: key.public_key_jwk ? "jwk" : "pem",
    starts_at: toIso(key.starts_at),
    expires_at: toIso(key.expires_at),
    revoked_at: toIso(key.revoked_at),
    created_by_account_id: key.created_by_account_id ?? null,
    metadata: key.metadata ?? null,
    created: toIso(key.created),
    updated: toIso(key.updated),
  };
}

function serializeSiteLicenseExternalClaimConsumption(
  consumption: SiteLicenseExternalClaimConsumption,
  toIso: MembershipCommandDeps["toIso"],
) {
  return {
    consumption_id: consumption.id,
    pool_id: consumption.pool_id,
    site_license_id: consumption.site_license_id,
    package_id: consumption.package_id,
    jti: consumption.jti,
    issuer: consumption.issuer,
    kid: consumption.kid ?? null,
    account_id: consumption.account_id,
    status: consumption.status,
    assignment_id: consumption.assignment_id ?? null,
    membership_grant_id: consumption.membership_grant_id ?? null,
    membership_class: consumption.membership_class,
    membership_expires_at: toIso(consumption.membership_expires_at),
    rootfs_id: consumption.rootfs_id ?? null,
    external_subject: consumption.external_subject ?? null,
    token_expires_at: toIso(consumption.token_expires_at),
    error_code: consumption.error_code ?? null,
    error_message: consumption.error_message ?? null,
    retry_count: consumption.retry_count,
    metadata: consumption.metadata ?? null,
    consumed_at: toIso(consumption.consumed_at),
    updated: toIso(consumption.updated),
  };
}

function serializeQuote(
  quote: MembershipPackageQuote,
  toIso: MembershipCommandDeps["toIso"],
) {
  return {
    package_id: quote.package_id ?? null,
    kind: quote.kind,
    membership_class: quote.membership_class,
    seat_count: quote.seat_count,
    seat_price: quote.seat_price,
    total_price: quote.total_price,
    starts_at: toIso(quote.starts_at),
    expires_at: toIso(quote.expires_at),
    interval: quote.interval ?? null,
    metadata: quote.metadata ?? null,
  };
}

async function resolveProjectIdentifier(
  ctx: any,
  resolveProject: MembershipCommandDeps["resolveProject"],
  identifier: string | undefined,
): Promise<string | undefined> {
  const trimmed = `${identifier ?? ""}`.trim();
  if (!trimmed) return;
  const project = await resolveProject(ctx, trimmed);
  const project_id = `${project?.project_id ?? ""}`.trim();
  if (!project_id) {
    throw new Error(`unable to resolve project '${trimmed}'`);
  }
  return project_id;
}

async function resolveTargetAccountIdentifier(
  ctx: any,
  resolveAccountByIdentifier: MembershipCommandDeps["resolveAccountByIdentifier"],
  identifier: string | undefined,
): Promise<string | undefined> {
  const trimmed = `${identifier ?? ""}`.trim();
  if (!trimmed) return;
  const resolved = await resolveAccountByIdentifier(ctx, trimmed);
  const account_id = `${resolved?.account_id ?? ""}`.trim();
  if (!account_id) {
    throw new Error(`unable to resolve account '${trimmed}'`);
  }
  return account_id;
}

function assertPurchaseConfirmed(opts: { yes?: boolean }) {
  if (!opts.yes) {
    throw new Error(
      "refusing to create a purchase without --yes; rerun with --yes if you intend to spend funds",
    );
  }
}

export function registerMembershipCommand(
  program: Command,
  deps: MembershipCommandDeps,
): Command {
  const { withContext, toIso, resolveAccountByIdentifier, resolveProject } =
    deps;

  const membership = program
    .command("membership")
    .description("membership package and seat operations");

  membership
    .command("list [account]")
    .description("list membership packages owned by an account")
    .option(
      "--wide",
      "include wider package summary fields in table output (default in json)",
    )
    .option("--full", "include full metadata and assignment details")
    .action(
      async (
        accountIdentifier: string | undefined,
        opts: { wide?: boolean; full?: boolean },
        command: Command,
      ) => {
        await withContext(command, "membership list", async (ctx) => {
          const target = accountIdentifier?.trim()
            ? await resolveAccountByIdentifier(ctx, accountIdentifier.trim())
            : { account_id: ctx.accountId };
          const owner_account_id = `${target?.account_id ?? ""}`.trim();
          if (!owner_account_id) {
            throw new Error("unable to resolve target account");
          }
          const packages = await ctx.hub.purchases.getMembershipPackages({
            account_id: ctx.accountId,
            ...(owner_account_id === ctx.accountId
              ? {}
              : { user_account_id: owner_account_id }),
          });
          const mode = opts.full
            ? "full"
            : opts.wide || wantsStructuredOutput(ctx)
              ? "wide"
              : "narrow";
          return packages.map((membershipPackage: MembershipPackageDetails) =>
            serializeMembershipPackage(membershipPackage, toIso, {
              mode,
              includeAssignments: mode === "full",
            }),
          );
        });
      },
    );

  membership
    .command("show <packageId>")
    .description("show one owned membership package with assignment details")
    .option(
      "--account <account>",
      "owner account identifier when inspecting another account as an admin",
    )
    .action(
      async (
        packageId: string,
        opts: { account?: string },
        command: Command,
      ) => {
        await withContext(command, "membership show", async (ctx) => {
          const package_id = `${packageId ?? ""}`.trim();
          if (!package_id) {
            throw new Error("package id must be non-empty");
          }
          const target = `${opts.account ?? ""}`.trim()
            ? await resolveAccountByIdentifier(ctx, opts.account!.trim())
            : { account_id: ctx.accountId };
          const owner_account_id = `${target?.account_id ?? ""}`.trim();
          if (!owner_account_id) {
            throw new Error("unable to resolve target account");
          }
          const packages = await ctx.hub.purchases.getMembershipPackages({
            account_id: ctx.accountId,
            ...(owner_account_id === ctx.accountId
              ? {}
              : { user_account_id: owner_account_id }),
          });
          const membershipPackage = (
            packages as MembershipPackageDetails[]
          ).find((entry) => entry.id === package_id);
          if (!membershipPackage) {
            throw new Error(`membership package '${package_id}' not found`);
          }
          return serializeMembershipPackage(membershipPackage, toIso, {
            includeAssignments: true,
          });
        });
      },
    );

  membership
    .command("quote")
    .description("quote a membership package purchase or seat expansion")
    .option("--package <packageId>", "existing package id to expand")
    .option("--kind <kind>", "package kind: course, team, or site")
    .option("--membership-class <class>", "membership class for the package")
    .option("--seat-count <n>", "seat count to buy or add")
    .option("--interval <interval>", "billing interval: month or year")
    .option(
      "--course-project <project>",
      "course project identifier for course packages",
    )
    .option("--starts-at <iso>", "explicit start time")
    .option("--expires-at <iso>", "explicit expiry time")
    .option("--metadata-json <json>", "package metadata as a JSON object")
    .action(
      async (
        opts: {
          package?: string;
          kind?: string;
          membershipClass?: string;
          seatCount?: string;
          interval?: "month" | "year";
          courseProject?: string;
          startsAt?: string;
          expiresAt?: string;
          metadataJson?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "membership quote", async (ctx) => {
          const course_project_id = await resolveProjectIdentifier(
            ctx,
            resolveProject,
            opts.courseProject,
          );
          return serializeQuote(
            await ctx.hub.purchases.getMembershipPackageQuote({
              account_id: ctx.accountId,
              package_id: `${opts.package ?? ""}`.trim() || undefined,
              kind: normalizePackageKind(opts.kind),
              membership_class:
                `${opts.membershipClass ?? ""}`.trim() || undefined,
              seat_count: `${opts.seatCount ?? ""}`.trim()
                ? parsePositiveInteger(opts.seatCount, "--seat-count")
                : undefined,
              interval: `${opts.interval ?? ""}`.trim()
                ? opts.interval
                : undefined,
              course_project_id,
              starts_at: `${opts.startsAt ?? ""}`.trim() || undefined,
              expires_at: `${opts.expiresAt ?? ""}`.trim() || undefined,
              metadata: parseMetadataJson(opts.metadataJson) ?? null,
            }),
            toIso,
          );
        });
      },
    );

  membership
    .command("buy")
    .description("buy a membership package or add seats to an existing package")
    .option("--yes", "confirm that this should create a purchase")
    .option("--package <packageId>", "existing package id to expand")
    .option("--kind <kind>", "package kind: course, team, or site")
    .option("--membership-class <class>", "membership class for the package")
    .option("--seat-count <n>", "seat count to buy or add")
    .option("--interval <interval>", "billing interval: month or year")
    .option(
      "--course-project <project>",
      "course project identifier for course packages",
    )
    .option("--starts-at <iso>", "explicit start time")
    .option("--expires-at <iso>", "explicit expiry time")
    .option("--metadata-json <json>", "package metadata as a JSON object")
    .action(
      async (
        opts: {
          yes?: boolean;
          package?: string;
          kind?: string;
          membershipClass?: string;
          seatCount?: string;
          interval?: "month" | "year";
          courseProject?: string;
          startsAt?: string;
          expiresAt?: string;
          metadataJson?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "membership buy", async (ctx) => {
          assertPurchaseConfirmed(opts);
          const course_project_id = await resolveProjectIdentifier(
            ctx,
            resolveProject,
            opts.courseProject,
          );
          return await ctx.hub.purchases.purchaseMembershipPackage({
            account_id: ctx.accountId,
            package_id: `${opts.package ?? ""}`.trim() || undefined,
            kind: normalizePackageKind(opts.kind),
            membership_class:
              `${opts.membershipClass ?? ""}`.trim() || undefined,
            seat_count: `${opts.seatCount ?? ""}`.trim()
              ? parsePositiveInteger(opts.seatCount, "--seat-count")
              : undefined,
            interval: `${opts.interval ?? ""}`.trim()
              ? opts.interval
              : undefined,
            course_project_id,
            starts_at: `${opts.startsAt ?? ""}`.trim() || undefined,
            expires_at: `${opts.expiresAt ?? ""}`.trim() || undefined,
            metadata: parseMetadataJson(opts.metadataJson) ?? null,
          });
        });
      },
    );

  membership
    .command("assign")
    .description("assign a seat to an account or reserve it by email")
    .requiredOption("--package <packageId>", "membership package id")
    .option("--target-account <account>", "target account identifier")
    .option("--target-email <email>", "reserve for an exact email address")
    .option(
      "--project <project>",
      "project identifier to attach as assignment metadata",
    )
    .option("--metadata-json <json>", "assignment metadata as a JSON object")
    .action(
      async (
        opts: {
          package: string;
          targetAccount?: string;
          targetEmail?: string;
          project?: string;
          metadataJson?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "membership assign", async (ctx) => {
          const package_id = `${opts.package ?? ""}`.trim();
          if (!package_id) {
            throw new Error("--package is required");
          }
          const target_account_id = await resolveTargetAccountIdentifier(
            ctx,
            resolveAccountByIdentifier,
            opts.targetAccount,
          );
          const target_email_address =
            `${opts.targetEmail ?? ""}`.trim() || undefined;
          if (!target_account_id && !target_email_address) {
            throw new Error(
              "one of --target-account or --target-email is required",
            );
          }
          if (target_account_id && target_email_address) {
            throw new Error(
              "use exactly one of --target-account or --target-email",
            );
          }
          const metadata = parseMetadataJson(opts.metadataJson) ?? {};
          const project_id = await resolveProjectIdentifier(
            ctx,
            resolveProject,
            opts.project,
          );
          if (project_id) {
            metadata.project_id = project_id;
          }
          return serializeAssignment(
            await ctx.hub.purchases.assignMembershipPackageSeat({
              account_id: ctx.accountId,
              package_id,
              target_account_id,
              target_email_address,
              metadata,
            }),
            toIso,
          );
        });
      },
    );

  membership
    .command("revoke")
    .description("revoke a seat assignment or email reservation")
    .requiredOption("--package <packageId>", "membership package id")
    .option("--target-account <account>", "target account identifier")
    .option("--target-email <email>", "target reserved email address")
    .action(
      async (
        opts: {
          package: string;
          targetAccount?: string;
          targetEmail?: string;
        },
        command: Command,
      ) => {
        await withContext(command, "membership revoke", async (ctx) => {
          const package_id = `${opts.package ?? ""}`.trim();
          if (!package_id) {
            throw new Error("--package is required");
          }
          const target_account_id = await resolveTargetAccountIdentifier(
            ctx,
            resolveAccountByIdentifier,
            opts.targetAccount,
          );
          const target_email_address =
            `${opts.targetEmail ?? ""}`.trim() || undefined;
          if (!target_account_id && !target_email_address) {
            throw new Error(
              "one of --target-account or --target-email is required",
            );
          }
          if (target_account_id && target_email_address) {
            throw new Error(
              "use exactly one of --target-account or --target-email",
            );
          }
          return await ctx.hub.purchases.revokeMembershipPackageSeat({
            account_id: ctx.accountId,
            package_id,
            target_account_id,
            target_email_address,
          });
        });
      },
    );

  membership
    .command("claimable")
    .description("list membership packages claimable by the current account")
    .action(async (command: Command) => {
      await withContext(command, "membership claimable", async (ctx) => {
        const claimables =
          await ctx.hub.purchases.getClaimableMembershipPackages({
            account_id: ctx.accountId,
          });
        return claimables.map((entry: ClaimableMembershipPackage) =>
          serializeClaimablePackage(entry, toIso),
        );
      });
    });

  membership
    .command("claim <packageId>")
    .description(
      "claim a reserved or site-license matched membership package seat",
    )
    .option(
      "--accepted-terms",
      "confirm custom site-license terms and policies when required",
    )
    .action(
      async (
        packageId: string,
        opts: { acceptedTerms?: boolean },
        command: Command,
      ) => {
        await withContext(command, "membership claim", async (ctx) => {
          const package_id = `${packageId ?? ""}`.trim();
          if (!package_id) {
            throw new Error("package id must be non-empty");
          }
          return serializeAssignment(
            await ctx.hub.purchases.claimMembershipPackageSeat({
              account_id: ctx.accountId,
              package_id,
              ...(opts.acceptedTerms ? { accepted_terms: true } : {}),
            }),
            toIso,
          );
        });
      },
    );

  const siteLicense = membership
    .command("site-license")
    .description("site-license pool and approval operations");

  siteLicense
    .command("provision")
    .description("admin provision a seed-bay site license with named pools")
    .option("--owner <account>", "optional legacy owner account identifier")
    .requiredOption("--name <name>", "site license name")
    .requiredOption("--organization-name <name>", "organization name")
    .requiredOption(
      "--domain <domain...>",
      "allowed institutional email domain; repeat or pass comma-separated values",
    )
    .requiredOption(
      "--pools-json <json>",
      'JSON array of pool configs, e.g. [{"pool_name":"Student","membership_class":"student","seat_count":5000,"requires_approval":false,"verification_policy":"email-domain"}]',
    )
    .option("--custom-terms-url <url>", "custom negotiated terms URL")
    .option("--custom-policy-url <url>", "custom organization policy URL")
    .option("--terms-version-label <label>", "custom terms version label")
    .option("--renewal-policy <policy>", "site-license renewal policy")
    .option("--overage-policy <policy>", "site-license overage policy")
    .option("--starts-at <iso>", "explicit start time")
    .option("--expires-at <iso>", "explicit expiry time")
    .option("--metadata-json <json>", "site license metadata as a JSON object")
    .action(
      async (
        opts: {
          owner?: string;
          name: string;
          organizationName: string;
          domain: string[];
          poolsJson: string;
          customTermsUrl?: string;
          customPolicyUrl?: string;
          termsVersionLabel?: string;
          renewalPolicy?: string;
          overagePolicy?: string;
          startsAt?: string;
          expiresAt?: string;
          metadataJson?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license provision",
          async (ctx) => {
            const owner =
              opts.owner == null
                ? undefined
                : await resolveAccountByIdentifier(ctx, opts.owner);
            const owner_account_id = `${owner?.account_id ?? ""}`.trim();
            if (opts.owner && !owner_account_id) {
              throw new Error("unable to resolve owner account");
            }
            const allowed_domains = normalizeStringList(opts.domain);
            if (allowed_domains.length === 0) {
              throw new Error("at least one --domain is required");
            }
            return serializeSiteLicenseOverview(
              await ctx.hub.purchases.adminProvisionSiteLicense({
                account_id: ctx.accountId,
                owner_account_id: owner_account_id || undefined,
                name: `${opts.name ?? ""}`.trim(),
                organization_name: `${opts.organizationName ?? ""}`.trim(),
                allowed_domains,
                pools: parseSiteLicensePoolsJson(opts.poolsJson),
                custom_terms_url:
                  `${opts.customTermsUrl ?? ""}`.trim() || undefined,
                custom_policy_url:
                  `${opts.customPolicyUrl ?? ""}`.trim() || undefined,
                terms_version_label:
                  `${opts.termsVersionLabel ?? ""}`.trim() || undefined,
                renewal_policy:
                  `${opts.renewalPolicy ?? ""}`.trim() || undefined,
                overage_policy:
                  `${opts.overagePolicy ?? ""}`.trim() || undefined,
                starts_at: `${opts.startsAt ?? ""}`.trim() || undefined,
                expires_at: `${opts.expiresAt ?? ""}`.trim() || undefined,
                metadata: parseMetadataJson(opts.metadataJson) ?? null,
              }),
              toIso,
            );
          },
        );
      },
    );

  siteLicense
    .command("overview <siteLicenseId>")
    .description("show a site-license manager overview")
    .requiredOption(
      "--owner <account>",
      "site-license owner account identifier for bay routing",
    )
    .action(
      async (
        siteLicenseId: string,
        opts: { owner: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license overview",
          async (ctx) => {
            const owner = await resolveAccountByIdentifier(ctx, opts.owner);
            const owner_account_id = `${owner?.account_id ?? ""}`.trim();
            if (!owner_account_id) {
              throw new Error("unable to resolve owner account");
            }
            const site_license_id = `${siteLicenseId ?? ""}`.trim();
            if (!site_license_id) {
              throw new Error("site license id must be non-empty");
            }
            return serializeSiteLicenseOverview(
              await ctx.hub.purchases.getSiteLicenseOverview({
                account_id: ctx.accountId,
                owner_account_id,
                site_license_id,
              }),
              toIso,
            );
          },
        );
      },
    );

  siteLicense
    .command("request")
    .description("request access to an approval-required site-license pool")
    .requiredOption("--package <packageId>", "site-license pool package id")
    .requiredOption(
      "--owner <account>",
      "site-license owner account identifier for bay routing",
    )
    .option("--note <text>", "requester note for managers")
    .option(
      "--accepted-terms",
      "confirm custom site-license terms and policies when required",
    )
    .action(
      async (
        opts: {
          package: string;
          owner: string;
          note?: string;
          acceptedTerms?: boolean;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license request",
          async (ctx) => {
            const owner = await resolveAccountByIdentifier(ctx, opts.owner);
            const owner_account_id = `${owner?.account_id ?? ""}`.trim();
            if (!owner_account_id) {
              throw new Error("unable to resolve owner account");
            }
            const package_id = `${opts.package ?? ""}`.trim();
            if (!package_id) {
              throw new Error("--package is required");
            }
            return serializeSiteLicenseRequest(
              await ctx.hub.purchases.requestSiteLicensePool({
                account_id: ctx.accountId,
                owner_account_id,
                package_id,
                requester_note: `${opts.note ?? ""}`.trim() || undefined,
                ...(opts.acceptedTerms ? { accepted_terms: true } : {}),
              }),
              toIso,
            );
          },
        );
      },
    );

  siteLicense
    .command("review <requestId>")
    .description("approve or reject a site-license pool request")
    .requiredOption(
      "--owner <account>",
      "site-license owner account identifier for bay routing",
    )
    .requiredOption("--action <action>", "review action: approve or reject")
    .option("--note <text>", "manager review note")
    .action(
      async (
        requestId: string,
        opts: {
          owner: string;
          action: string;
          note?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license review",
          async (ctx) => {
            const action = `${opts.action ?? ""}`.trim().toLowerCase();
            if (action !== "approve" && action !== "reject") {
              throw new Error("--action must be approve or reject");
            }
            const owner = await resolveAccountByIdentifier(ctx, opts.owner);
            const owner_account_id = `${owner?.account_id ?? ""}`.trim();
            if (!owner_account_id) {
              throw new Error("unable to resolve owner account");
            }
            const request_id = `${requestId ?? ""}`.trim();
            if (!request_id) {
              throw new Error("request id must be non-empty");
            }
            return serializeSiteLicenseRequest(
              await ctx.hub.purchases.reviewSiteLicensePoolRequest({
                account_id: ctx.accountId,
                owner_account_id,
                request_id,
                action,
                review_note: `${opts.note ?? ""}`.trim() || undefined,
              }),
              toIso,
            );
          },
        );
      },
    );

  const externalPool = siteLicense
    .command("external-pool")
    .description("admin operations for external site-license claim pools");

  externalPool
    .command("list")
    .description("admin list external token claim pools")
    .option("--site-license <siteLicenseId>", "filter by site license id")
    .option("--package <packageId>", "filter by site-license package/pool id")
    .option("--pool <poolId>", "filter by external claim pool id")
    .option("--limit <n>", "maximum rows to return")
    .action(
      async (
        opts: {
          siteLicense?: string;
          package?: string;
          pool?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license external-pool list",
          async (ctx) => {
            return (
              await ctx.hub.purchases.listSiteLicenseExternalClaimPools({
                account_id: ctx.accountId,
                site_license_id:
                  `${opts.siteLicense ?? ""}`.trim() || undefined,
                package_id: `${opts.package ?? ""}`.trim() || undefined,
                pool_id: `${opts.pool ?? ""}`.trim() || undefined,
                limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
              })
            ).map((pool: SiteLicenseExternalClaimPool) =>
              serializeSiteLicenseExternalClaimPool(pool, toIso),
            );
          },
        );
      },
    );

  externalPool
    .command("create")
    .description("admin create or update an external token claim pool")
    .requiredOption("--site-license <siteLicenseId>", "site license id")
    .requiredOption("--package <packageId>", "site-license package/pool id")
    .requiredOption("--name <name>", "external claim pool name")
    .requiredOption("--issuer <issuer>", "expected token issuer")
    .option("--slug <slug>", "stable external claim pool slug")
    .option("--audience <aud>", "expected token audience")
    .option(
      "--default-membership-class <class>",
      "default membership class granted by tokens",
    )
    .option(
      "--allow-membership-class-override",
      "allow tokens to choose membership_class",
    )
    .option(
      "--default-membership-duration-days <days>",
      "default membership duration in days",
    )
    .option(
      "--default-membership-expires-at <iso>",
      "default absolute membership expiry",
    )
    .option(
      "--allow-membership-expires-at-override",
      "allow tokens to choose membership expiry",
    )
    .option(
      "--min-membership-duration-days <days>",
      "minimum token-selected membership duration in days",
    )
    .option(
      "--max-membership-duration-days <days>",
      "maximum token-selected membership duration in days",
    )
    .option(
      "--max-membership-expires-at <iso>",
      "maximum token-selected absolute membership expiry",
    )
    .option("--default-rootfs-id <id>", "default rootfs id granted by tokens")
    .option("--max-claims <n>", "pool-wide maximum token consumptions")
    .option(
      "--max-claims-per-account <n>",
      "per-account maximum token consumptions",
    )
    .option("--starts-at <iso>", "pool activation time")
    .option("--expires-at <iso>", "pool expiry time")
    .option("--disabled-at <iso>", "pool disabled time")
    .option("--metadata-json <json>", "pool metadata as a JSON object")
    .action(
      async (
        opts: {
          siteLicense: string;
          package: string;
          name: string;
          issuer: string;
          slug?: string;
          audience?: string;
          defaultMembershipClass?: string;
          allowMembershipClassOverride?: boolean;
          defaultMembershipDurationDays?: string;
          defaultMembershipExpiresAt?: string;
          allowMembershipExpiresAtOverride?: boolean;
          minMembershipDurationDays?: string;
          maxMembershipDurationDays?: string;
          maxMembershipExpiresAt?: string;
          defaultRootfsId?: string;
          maxClaims?: string;
          maxClaimsPerAccount?: string;
          startsAt?: string;
          expiresAt?: string;
          disabledAt?: string;
          metadataJson?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license external-pool create",
          async (ctx) => {
            return serializeSiteLicenseExternalClaimPool(
              await ctx.hub.purchases.createSiteLicenseExternalClaimPool({
                account_id: ctx.accountId,
                site_license_id: `${opts.siteLicense ?? ""}`.trim(),
                package_id: `${opts.package ?? ""}`.trim(),
                name: `${opts.name ?? ""}`.trim(),
                issuer: `${opts.issuer ?? ""}`.trim(),
                slug: `${opts.slug ?? ""}`.trim() || undefined,
                audience: `${opts.audience ?? ""}`.trim() || undefined,
                default_membership_class:
                  `${opts.defaultMembershipClass ?? ""}`.trim() || undefined,
                allow_membership_class_override:
                  opts.allowMembershipClassOverride === true,
                default_membership_duration_days: parseOptionalPositiveInteger(
                  opts.defaultMembershipDurationDays,
                  "--default-membership-duration-days",
                ),
                default_membership_expires_at:
                  `${opts.defaultMembershipExpiresAt ?? ""}`.trim() ||
                  undefined,
                allow_membership_expires_at_override:
                  opts.allowMembershipExpiresAtOverride === true,
                min_membership_duration_days: parseOptionalPositiveInteger(
                  opts.minMembershipDurationDays,
                  "--min-membership-duration-days",
                ),
                max_membership_duration_days: parseOptionalPositiveInteger(
                  opts.maxMembershipDurationDays,
                  "--max-membership-duration-days",
                ),
                max_membership_expires_at:
                  `${opts.maxMembershipExpiresAt ?? ""}`.trim() || undefined,
                default_rootfs_id:
                  `${opts.defaultRootfsId ?? ""}`.trim() || undefined,
                max_claims: parseOptionalPositiveInteger(
                  opts.maxClaims,
                  "--max-claims",
                ),
                max_claims_per_account: parseOptionalPositiveInteger(
                  opts.maxClaimsPerAccount,
                  "--max-claims-per-account",
                ),
                starts_at: `${opts.startsAt ?? ""}`.trim() || undefined,
                expires_at: `${opts.expiresAt ?? ""}`.trim() || undefined,
                disabled_at: `${opts.disabledAt ?? ""}`.trim() || undefined,
                metadata: parseMetadataJson(opts.metadataJson) ?? null,
              }),
              toIso,
            );
          },
        );
      },
    );

  externalPool
    .command("disable <poolId>")
    .description("admin disable an external token claim pool")
    .option("--disabled-at <iso>", "explicit disabled timestamp")
    .action(
      async (
        poolId: string,
        opts: { disabledAt?: string },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license external-pool disable",
          async (ctx) => {
            return serializeSiteLicenseExternalClaimPool(
              await ctx.hub.purchases.disableSiteLicenseExternalClaimPool({
                account_id: ctx.accountId,
                pool_id: `${poolId ?? ""}`.trim(),
                disabled_at: `${opts.disabledAt ?? ""}`.trim() || undefined,
              }),
              toIso,
            );
          },
        );
      },
    );

  const externalKey = siteLicense
    .command("external-key")
    .description("admin operations for external site-license claim keys");

  externalKey
    .command("list")
    .description("admin list external token verification keys")
    .requiredOption("--pool <poolId>", "external claim pool id")
    .option("--limit <n>", "maximum rows to return")
    .action(
      async (
        opts: {
          pool: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license external-key list",
          async (ctx) => {
            return (
              await ctx.hub.purchases.listSiteLicenseExternalClaimKeys({
                account_id: ctx.accountId,
                pool_id: `${opts.pool ?? ""}`.trim(),
                limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
              })
            ).map((key: SiteLicenseExternalClaimKey) =>
              serializeSiteLicenseExternalClaimKey(key, toIso),
            );
          },
        );
      },
    );

  externalKey
    .command("add")
    .description("admin add or update an external token verification key")
    .requiredOption("--pool <poolId>", "external claim pool id")
    .requiredOption("--kid <kid>", "token key id")
    .requiredOption("--alg <alg>", "signing algorithm: EdDSA or ES256")
    .option("--jwk-json <json>", "public key JWK JSON")
    .option("--jwk-file <path>", "file containing public key JWK JSON")
    .option("--pem <pem>", "public key PEM")
    .option("--pem-file <path>", "file containing public key PEM")
    .option("--starts-at <iso>", "key activation time")
    .option("--expires-at <iso>", "key expiry time")
    .option("--revoked-at <iso>", "key revocation time")
    .option("--metadata-json <json>", "key metadata as a JSON object")
    .action(
      async (
        opts: {
          pool: string;
          kid: string;
          alg: string;
          jwkJson?: string;
          jwkFile?: string;
          pem?: string;
          pemFile?: string;
          startsAt?: string;
          expiresAt?: string;
          revokedAt?: string;
          metadataJson?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license external-key add",
          async (ctx) => {
            const publicKey = parseExternalClaimPublicKey(opts);
            return serializeSiteLicenseExternalClaimKey(
              await ctx.hub.purchases.addSiteLicenseExternalClaimKey({
                account_id: ctx.accountId,
                pool_id: `${opts.pool ?? ""}`.trim(),
                kid: `${opts.kid ?? ""}`.trim(),
                alg: normalizeExternalClaimAlg(opts.alg),
                ...publicKey,
                starts_at: `${opts.startsAt ?? ""}`.trim() || undefined,
                expires_at: `${opts.expiresAt ?? ""}`.trim() || undefined,
                revoked_at: `${opts.revokedAt ?? ""}`.trim() || undefined,
                metadata: parseMetadataJson(opts.metadataJson) ?? null,
              }),
              toIso,
            );
          },
        );
      },
    );

  externalKey
    .command("revoke")
    .description("admin revoke an external token verification key")
    .requiredOption("--pool <poolId>", "external claim pool id")
    .requiredOption("--kid <kid>", "token key id")
    .option("--revoked-at <iso>", "explicit revocation timestamp")
    .action(
      async (
        opts: {
          pool: string;
          kid: string;
          revokedAt?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license external-key revoke",
          async (ctx) => {
            return serializeSiteLicenseExternalClaimKey(
              await ctx.hub.purchases.revokeSiteLicenseExternalClaimKey({
                account_id: ctx.accountId,
                pool_id: `${opts.pool ?? ""}`.trim(),
                kid: `${opts.kid ?? ""}`.trim(),
                revoked_at: `${opts.revokedAt ?? ""}`.trim() || undefined,
              }),
              toIso,
            );
          },
        );
      },
    );

  siteLicense
    .command("external-claim-list")
    .description("admin list external site-license claim consumptions")
    .option("--pool <poolId>", "filter by external claim pool id")
    .option("--site-license <siteLicenseId>", "filter by site license id")
    .option("--account <accountId>", "filter by consuming account id")
    .option(
      "--status <status>",
      "filter by status: pending-side-effect, granted, failed-retryable, or failed-terminal",
    )
    .option("--limit <n>", "maximum rows to return")
    .action(
      async (
        opts: {
          pool?: string;
          siteLicense?: string;
          account?: string;
          status?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license external-claim-list",
          async (ctx) => {
            const status = `${opts.status ?? ""}`.trim();
            if (
              status &&
              status !== "pending-side-effect" &&
              status !== "granted" &&
              status !== "failed-retryable" &&
              status !== "failed-terminal"
            ) {
              throw new Error("--status is not a valid external claim status");
            }
            return (
              await ctx.hub.purchases.listSiteLicenseExternalClaimConsumptions({
                account_id: ctx.accountId,
                pool_id: `${opts.pool ?? ""}`.trim() || undefined,
                site_license_id:
                  `${opts.siteLicense ?? ""}`.trim() || undefined,
                target_account_id: `${opts.account ?? ""}`.trim() || undefined,
                status: status || undefined,
                limit: parseOptionalPositiveInteger(opts.limit, "--limit"),
              })
            ).map((consumption: SiteLicenseExternalClaimConsumption) =>
              serializeSiteLicenseExternalClaimConsumption(consumption, toIso),
            );
          },
        );
      },
    );

  siteLicense
    .command("sample-token")
    .description("locally generate a signed external site-license claim token")
    .requiredOption("--kid <kid>", "token key id")
    .requiredOption("--private-key-file <path>", "private signing key PEM file")
    .option("--alg <alg>", "signing algorithm; currently EdDSA", "EdDSA")
    .option("--jti <jti>", "explicit token id; defaults to a random UUID")
    .option("--expires-at <iso>", "token expiration time")
    .option(
      "--expires-in-days <days>",
      "token lifetime when --expires-at is omitted",
      "1",
    )
    .option("--not-before <iso>", "optional token not-before time")
    .option("--membership-class <class>", "optional membership class override")
    .option(
      "--membership-expires-at <iso>",
      "optional membership expiration override",
    )
    .option("--rootfs-id <id>", "optional rootfs context")
    .option("--subject <subject>", "optional external subject")
    .option("--label <label>", "optional human-readable label")
    .option("--metadata-json <json>", "token metadata as a JSON object")
    .action(
      async (
        opts: {
          kid: string;
          privateKeyFile: string;
          alg: string;
          jti?: string;
          expiresAt?: string;
          expiresInDays?: string;
          notBefore?: string;
          membershipClass?: string;
          membershipExpiresAt?: string;
          rootfsId?: string;
          subject?: string;
          label?: string;
          metadataJson?: string;
        },
        command: Command,
      ) => {
        await withContext(
          command,
          "membership site-license sample-token",
          async (ctx) => {
            const alg = normalizeExternalClaimAlg(opts.alg);
            const expiresAt = `${opts.expiresAt ?? ""}`.trim()
              ? parseIsoDate(opts.expiresAt, "--expires-at")
              : new Date(
                  Date.now() +
                    parsePositiveInteger(
                      opts.expiresInDays,
                      "--expires-in-days",
                    ) *
                      24 *
                      60 *
                      60 *
                      1000,
                );
            const payload: Record<string, unknown> = {
              jti: `${opts.jti ?? ""}`.trim() || randomUUID(),
              exp: dateToNumericDate(expiresAt),
            };
            const notBefore = `${opts.notBefore ?? ""}`.trim();
            if (notBefore) {
              payload.nbf = dateToNumericDate(
                parseIsoDate(notBefore, "--not-before"),
              );
            }
            const membershipClass =
              `${opts.membershipClass ?? ""}`.trim() || undefined;
            if (membershipClass) {
              payload.membership_class = membershipClass;
            }
            const membershipExpiresAt =
              `${opts.membershipExpiresAt ?? ""}`.trim() || undefined;
            if (membershipExpiresAt) {
              payload.membership_expires_at = membershipExpiresAt;
            }
            const rootfsId = `${opts.rootfsId ?? ""}`.trim() || undefined;
            if (rootfsId) {
              payload.rootfs_id = rootfsId;
            }
            const subject = `${opts.subject ?? ""}`.trim() || undefined;
            if (subject) {
              payload.subject = subject;
            }
            const label = `${opts.label ?? ""}`.trim() || undefined;
            if (label) {
              payload.label = label;
            }
            const metadata = parseMetadataJson(opts.metadataJson);
            if (metadata) {
              payload.metadata = metadata;
            }
            const token = createExternalClaimSampleToken({
              alg,
              kid: `${opts.kid ?? ""}`.trim(),
              privateKeyPem: readTextFile(
                opts.privateKeyFile,
                "--private-key-file",
              ),
              payload,
            });
            return `${ctx.apiBaseUrl.replace(/\/+$/, "")}/claim/site-license?token=${encodeURIComponent(token)}`;
          },
        );
      },
    );

  siteLicense
    .command("claim-token <token>")
    .description("consume an external site-license claim token")
    .action(async (token: string, _opts: {}, command: Command) => {
      await withContext(
        command,
        "membership site-license claim-token",
        async (ctx) => {
          const normalizedToken = `${token ?? ""}`.trim();
          if (!normalizedToken) {
            throw new Error("token must be non-empty");
          }
          return serializeSiteLicenseExternalClaimConsumption(
            await ctx.hub.purchases.consumeSiteLicenseExternalClaimToken({
              account_id: ctx.accountId,
              token: normalizedToken,
            }),
            toIso,
          );
        },
      );
    });

  return membership;
}
