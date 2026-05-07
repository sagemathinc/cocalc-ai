import { Command } from "commander";

import type {
  ClaimableMembershipPackage,
  MembershipPackageAssignment,
  MembershipPackageDetails,
  MembershipPackageKind,
  MembershipPackageQuote,
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

function normalizePackageKind(
  raw: string | undefined,
): MembershipPackageKind | undefined {
  const value = `${raw ?? ""}`.trim().toLowerCase();
  if (!value) return;
  if (value === "team" || value === "course") {
    return value;
  }
  if (value === "domain" || value === "domain-license") {
    return "domain";
  }
  if (value === "site" || value === "site-license") {
    return "site";
  }
  throw new Error(
    `invalid package kind '${raw}'; expected course, team, domain, or site`,
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
    includeAssignments?: boolean;
  } = {},
) {
  const activeAssignments = membershipPackage.assignments.filter(
    (assignment) => !assignment.revoked_at,
  );
  const result: Record<string, unknown> = {
    package_id: membershipPackage.id,
    owner_account_id: membershipPackage.owner_account_id,
    kind: membershipPackage.kind,
    membership_class: membershipPackage.membership_class,
    seat_count: membershipPackage.seat_count,
    purchase_id: membershipPackage.purchase_id ?? null,
    starts_at: toIso(membershipPackage.starts_at),
    expires_at: toIso(membershipPackage.expires_at),
    interval: `${membershipPackage.metadata?.interval ?? ""}`.trim() || null,
    seat_price:
      typeof membershipPackage.metadata?.seat_price === "number"
        ? membershipPackage.metadata.seat_price
        : null,
    active_assignment_count: membershipPackage.active_assignment_count,
    available_seat_count: membershipPackage.available_seat_count,
    assignment_targets: activeAssignments
      .map(formatAssignmentTarget)
      .join(", "),
    assignment_emails: activeAssignments
      .map((assignment) => `${assignment.email_address ?? ""}`.trim())
      .filter(Boolean),
    allowed_domains: getAllowedDomains(membershipPackage),
    course_project_id:
      `${membershipPackage.metadata?.course_project_id ?? ""}`.trim() || null,
    created: toIso(membershipPackage.created),
    updated: toIso(membershipPackage.updated),
  };
  if (opts.includeAssignments) {
    result.assignments = membershipPackage.assignments.map((assignment) =>
      serializeAssignment(assignment, toIso),
    );
    result.metadata = membershipPackage.metadata ?? null;
  }
  return result;
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
    metadata: claimablePackage.metadata ?? null,
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
    .option("--full", "include full metadata and assignment details")
    .action(
      async (
        accountIdentifier: string | undefined,
        opts: { full?: boolean },
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
          return packages.map((membershipPackage: MembershipPackageDetails) =>
            serializeMembershipPackage(membershipPackage, toIso, {
              includeAssignments: !!opts.full,
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
    .option("--kind <kind>", "package kind: course, team, domain, or site")
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
    .option("--kind <kind>", "package kind: course, team, domain, or site")
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
    .description("claim a reserved or domain-matched membership package seat")
    .action(async (packageId: string, command: Command) => {
      await withContext(command, "membership claim", async (ctx) => {
        const package_id = `${packageId ?? ""}`.trim();
        if (!package_id) {
          throw new Error("package id must be non-empty");
        }
        return serializeAssignment(
          await ctx.hub.purchases.claimMembershipPackageSeat({
            account_id: ctx.accountId,
            package_id,
          }),
          toIso,
        );
      });
    });

  return membership;
}
