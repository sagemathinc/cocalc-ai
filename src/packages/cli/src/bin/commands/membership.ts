import { Command } from "commander";

import type {
  ClaimableMembershipPackage,
  MembershipPackageAssignment,
  MembershipPackageDetails,
  MembershipPackageKind,
  MembershipPackageQuote,
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

function parseMetadataJson(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  const trimmed = `${raw ?? ""}`.trim();
  if (!trimmed) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`invalid --metadata-json: ${err}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--metadata-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
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
      'JSON array of pool configs, e.g. [{"pool_name":"Students","membership_class":"student","seat_count":5000,"requires_approval":false,"verification_policy":"email-domain"}]',
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

  return membership;
}
