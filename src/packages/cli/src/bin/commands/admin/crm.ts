/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";

import { COMMERCIAL_NEXT_ACTIONS } from "@cocalc/util/commercial-orders";
import {
  CRM_DOMAIN_KINDS,
  CRM_EXTERNAL_OBJECT_KINDS,
  CRM_EXTERNAL_PROVIDERS,
  CRM_EXTERNAL_REFERENCE_VERIFICATION_STATES,
  CRM_LIFECYCLE_STAGES,
  CRM_OPPORTUNITY_KINDS,
  CRM_OPPORTUNITY_STAGES,
  CRM_ORGANIZATION_TYPES,
  CRM_PERSON_ROLES,
  CRM_TASK_PRIORITIES,
  CRM_TASK_TYPES,
} from "@cocalc/util/crm";
import {
  CRM_OUTREACH_FOLLOW_UP_POLICIES,
  CRM_OUTREACH_KINDS,
  CRM_OUTREACH_SUPPRESSION_REASONS,
  CRM_OUTREACH_SUPPRESSION_SCOPES,
} from "@cocalc/util/crm-outreach";

export type CrmCommandDeps = {
  withContext: any;
  resolveAccountByIdentifier: any;
  isValidUUID: any;
};

type Json = Record<string, unknown>;
type MutationOptions = {
  commit?: boolean;
  reason?: string;
  expectedVersion?: string;
  idempotencyKey?: string;
};

type OutreachRecipientInput = {
  person: string;
  organization?: string;
  opportunity?: string;
  email?: string;
  subject?: string;
  body_markdown?: string;
  override_reason?: string;
};

const OUTREACH_IMPORT_MAX_ROWS = 500;

function cliEnumValues(values: readonly string[]): string {
  return values.map((value) => value.replace(/_/g, "-")).join(", ");
}

function crmCliEnvelope(data: unknown): Json {
  return {
    schema_version: 1,
    provenance: {
      authority: "seed",
      service: "adminCrm",
      source: "cli",
    },
    redaction: {
      profile: "bounded_admin",
      unrestricted_provider_payloads: false,
      payment_credentials: false,
    },
    data,
  };
}

function normalizeState(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function requireReason(value: unknown): string {
  const reason = `${value ?? ""}`.trim();
  if (reason.length < 4)
    throw Error("--reason must contain at least 4 characters");
  if (reason.length > 2_000)
    throw Error("--reason must contain at most 2000 characters");
  return reason;
}

function readReason(value: unknown, fallback: string): string {
  const reason = `${value ?? ""}`.trim();
  return reason ? requireReason(reason) : fallback;
}

function positiveInteger(
  value: unknown,
  name: string,
  max?: number,
): number | undefined {
  if (value == null || `${value}`.trim() === "") return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw Error(`${name} must be a positive integer`);
  if (max != null && parsed > max)
    throw Error(`${name} must be at most ${max}`);
  return parsed;
}

function nonnegativeInteger(value: unknown, name: string): number | undefined {
  if (value == null || `${value}`.trim() === "") return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw Error(`${name} must be a nonnegative integer`);
  return parsed;
}

function csv(value: unknown): string[] | undefined {
  const values = `${value ?? ""}`
    .split(",")
    .map((x) => normalizeState(x))
    .filter(Boolean);
  return values.length ? [...new Set(values)] : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  const normalized = normalizeState(`${value ?? ""}`);
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return normalized as T;
}

function rfc3339Timestamp(value: unknown, name: string): string {
  const raw = `${value ?? ""}`.trim();
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      raw,
    )
  ) {
    throw Error(
      `${name} must be an RFC3339 timestamp with an explicit timezone, e.g. 2026-09-01T17:00:00Z`,
    );
  }
  const [hour, minute, second] = raw.slice(11, 19).split(":").map(Number);
  if (hour > 23 || minute > 59 || second > 59) {
    throw Error(`${name} must be a valid RFC3339 timestamp`);
  }
  const calendarDate = new Date(`${raw.slice(0, 10)}T00:00:00.000Z`);
  if (
    !Number.isFinite(calendarDate.valueOf()) ||
    calendarDate.toISOString().slice(0, 10) !== raw.slice(0, 10)
  ) {
    throw Error(`${name} must be a valid RFC3339 timestamp`);
  }
  const timestamp = new Date(raw);
  if (!Number.isFinite(timestamp.valueOf())) {
    throw Error(`${name} must be a valid RFC3339 timestamp`);
  }
  return timestamp.toISOString();
}

function commercialNextAction(value: unknown): string {
  const normalized = `${value ?? ""}`
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_");
  const action = COMMERCIAL_NEXT_ACTIONS.find(
    (candidate) =>
      candidate
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "_") === normalized,
  );
  if (!action) {
    throw Error(
      `--next-action must be one of: ${COMMERCIAL_NEXT_ACTIONS.join(", ")}`,
    );
  }
  return action;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Json)
        .filter(
          ([key]) =>
            !["commit", "expected_version", "idempotency_key"].includes(key),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function mutationKey(action: string, payload: Json, supplied?: string): string {
  const explicit = `${supplied ?? ""}`.trim();
  if (explicit) return explicit;
  return `cli:${action}:${createHash("sha256")
    .update(JSON.stringify(stable(payload)))
    .digest("hex")
    .slice(0, 32)}`;
}

function mutationRequest(
  action: string,
  opts: MutationOptions,
  payload: Json,
): Json {
  const reason = requireReason(opts.reason);
  const expectedVersion = opts.commit
    ? nonnegativeInteger(opts.expectedVersion, "--expected-version")
    : nonnegativeInteger(opts.expectedVersion, "--expected-version");
  if (opts.commit && expectedVersion == null) {
    throw Error(
      "--expected-version is required with --commit; use the value returned by the preview",
    );
  }
  const base = { ...payload, reason, source: "cli" as const };
  return {
    ...base,
    commit: opts.commit === true,
    expected_version: expectedVersion,
    idempotency_key: mutationKey(action, base, opts.idempotencyKey),
  };
}

function addMutationOptions(command: Command): Command {
  return command
    .option("--reason <text>", "human-readable immutable audit reason")
    .option("--expected-version <n>", "optimistic version returned by preview")
    .option("--idempotency-key <key>", "stable logical mutation key")
    .option("--commit", "apply the reviewed preview", false);
}

// Reversible mutations can intentionally restore earlier values. Let the server
// bind preview keys to its current version; bind implicit commit keys to the
// reviewed version so a later revision is distinct and a retry stays stable.
function versionedMutationRequest(
  action: string,
  opts: MutationOptions,
  payload: Json,
): Json {
  const request = mutationRequest(action, opts, payload);
  if (!`${opts.idempotencyKey ?? ""}`.trim()) {
    request.idempotency_key = opts.commit
      ? mutationKey(action, {
          ...payload,
          reason: request.reason,
          reviewed_version: request.expected_version,
        })
      : undefined;
  }
  return request;
}

function addPageOptions(command: Command): Command {
  return command
    .option("--cursor <cursor>", "pagination cursor")
    .option("--limit <n>", "maximum rows (1-500)", "100")
    .option("--max-bytes <n>", "maximum response bytes")
    .option("--reason <text>", "audit reason for this admin read");
}

function page(opts: any): Json {
  return {
    cursor: `${opts.cursor ?? ""}`.trim() || undefined,
    limit: positiveInteger(opts.limit, "--limit", 500),
    max_bytes: positiveInteger(opts.maxBytes, "--max-bytes", 5_000_000),
  };
}

async function readJson(path: string): Promise<Json> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw Error(`failed to parse JSON from ${path}: ${err}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error(`${path} must contain a JSON object`);
  }
  return value as Json;
}

function outreachRecipient(
  value: unknown,
  row: number,
): OutreachRecipientInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Error(`outreach recipient row ${row} must be a JSON object`);
  }
  const input = value as Json;
  const allowed = new Set([
    "person",
    "organization",
    "opportunity",
    "email",
    "subject",
    "body_markdown",
    "override_reason",
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw Error(
      `outreach recipient row ${row} has unsupported fields: ${unknown.join(", ")}`,
    );
  }
  const person = `${input.person ?? ""}`.trim();
  if (!person) throw Error(`outreach recipient row ${row} requires person`);
  const optional = (key: keyof OutreachRecipientInput): string | undefined => {
    if (input[key] == null) return;
    const result = `${input[key]}`.trim();
    return result || undefined;
  };
  return {
    person,
    organization: optional("organization"),
    opportunity: optional("opportunity"),
    email: optional("email"),
    subject: optional("subject"),
    body_markdown: optional("body_markdown"),
    override_reason: optional("override_reason"),
  };
}

async function readOutreachRecipients(
  path: string,
  maxRows: number,
): Promise<OutreachRecipientInput[]> {
  const text = await readFile(path, "utf8");
  let values: unknown[];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      values = parsed;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as Json).recipients)
    ) {
      values = (parsed as Json).recipients as unknown[];
    } else {
      throw Error("JSON must be an array or an object with a recipients array");
    }
  } catch (jsonError) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    try {
      values = lines.map((line) => JSON.parse(line));
    } catch (jsonlError) {
      throw Error(
        `failed to parse ${path} as recipient JSON or JSONL: ${jsonError}; ${jsonlError}`,
      );
    }
  }
  if (!values.length) throw Error(`${path} contains no outreach recipients`);
  if (values.length > maxRows) {
    throw Error(
      `${path} contains ${values.length} recipients; the effective limit is ${maxRows}`,
    );
  }
  return values.map((value, index) => outreachRecipient(value, index + 1));
}

async function resolveAccount(
  ctx: any,
  value: string,
  deps: CrmCommandDeps,
): Promise<string> {
  const identifier = `${value ?? ""}`.trim();
  if (!identifier) throw Error("account identifier is required");
  if (identifier === "me") return ctx.accountId;
  if (deps.isValidUUID(identifier)) return identifier;
  const result = await deps.resolveAccountByIdentifier(ctx, identifier);
  const accountId = `${result?.account_id ?? ""}`.trim();
  if (!accountId) throw Error(`unable to resolve account '${identifier}'`);
  return accountId;
}

function registerOrganizations(crm: Command, deps: CrmCommandDeps): void {
  const command = crm
    .command("organizations")
    .description("canonical customer organizations");
  addPageOptions(
    command
      .command("list")
      .description("list the customer queue")
      .option("--search <text>", "name, alias, or customer number")
      .option("--lifecycle <stages>", "comma-separated lifecycle stages")
      .option(
        "--status <states>",
        "comma-separated active, merged, or archived",
      )
      .option("--type <types>", "comma-separated organization types")
      .option(
        "--opportunity-kind <kinds>",
        "comma-separated active opportunity kinds",
      )
      .option("--owner <account>", "relationship owner, me, or unassigned")
      .option("--overdue", "only customers with overdue tasks")
      .option("--unassigned", "only unassigned customers"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(cmd, "admin crm organizations list", async (ctx) => {
      let owner: string | null | undefined;
      if (opts.owner)
        owner = ["unassigned", "none"].includes(normalizeState(opts.owner))
          ? null
          : await resolveAccount(ctx, opts.owner, deps);
      return await ctx.hub.adminCrm.listOrganizations({
        ...page(opts),
        reason: readReason(opts.reason, "Review CRM customer queue"),
        search: opts.search,
        lifecycle_stages: csv(opts.lifecycle),
        statuses: csv(opts.status),
        organization_types: csv(opts.type),
        opportunity_kinds: csv(opts.opportunityKind),
        owner_account_id: owner,
        has_overdue_tasks: opts.overdue || undefined,
        unassigned: opts.unassigned || undefined,
      });
    }),
  );
  addPageOptions(
    command
      .command("search")
      .description("search customers by human or external identifiers")
      .option(
        "--query <text>",
        "name, alias, domain, contact, or customer number",
      )
      .option("--domain <domain>", "institutional domain")
      .option("--email <email>", "contact email")
      .option("--account <account>", "CoCalc account or email")
      .option("--zendesk-ticket <id>", "Zendesk ticket id")
      .option("--commercial-order <id>", "order number or UUID")
      .option("--site-license <id>", "site license UUID"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm organizations search",
      async (ctx) =>
        await ctx.hub.adminCrm.searchOrganizations({
          ...page(opts),
          reason: readReason(opts.reason, "Search CRM customers"),
          query: opts.query,
          domain: opts.domain,
          email: opts.email,
          linked_account_id: opts.account
            ? await resolveAccount(ctx, opts.account, deps)
            : undefined,
          zendesk_ticket_id: positiveInteger(
            opts.zendeskTicket,
            "--zendesk-ticket",
          ),
          commercial_order: opts.commercialOrder,
          site_license_id: opts.siteLicense,
        }),
    ),
  );
  command
    .command("show <organization>")
    .description("show Customer 360")
    .option("--activity-limit <n>", "maximum recent activities", "100")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (organization: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm organizations show",
        async (ctx) =>
          await ctx.hub.adminCrm.getOrganization({
            organization,
            activity_limit: positiveInteger(
              opts.activityLimit,
              "--activity-limit",
              500,
            ),
            reason: readReason(opts.reason, "Review CRM Customer 360"),
          }),
      ),
    );
  command
    .command("metrics <organization>")
    .description("show or refresh bounded customer metrics")
    .option("--refresh", "recompute and persist a current metric snapshot")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (organization: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm organizations metrics",
        async (ctx) =>
          await ctx.hub.adminCrm.getCustomerMetrics({
            organization,
            refresh: opts.refresh || undefined,
            reason: readReason(
              opts.reason,
              opts.refresh
                ? "Refresh CRM customer metrics"
                : "Review CRM customer metrics",
            ),
          }),
      ),
    );
  addMutationOptions(
    command
      .command("create")
      .description("preview or create a customer")
      .requiredOption("--name <name>", "display name")
      .requiredOption(
        "--type <type>",
        `organization type: ${CRM_ORGANIZATION_TYPES.join(", ")}`,
      )
      .option("--legal-name <name>", "legal name")
      .option("--aliases <names>", "comma-separated reviewed aliases")
      .option("--website <url>", "organization website")
      .option("--timezone <zone>", "IANA timezone")
      .option("--lifecycle <stage>", "initial lifecycle stage", "prospect")
      .option("--owner <account>", "relationship owner")
      .option("--parent <organization>", "parent organization"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm organizations create",
      async (ctx) =>
        await ctx.hub.adminCrm.createOrganization(
          mutationRequest("organization.create", opts, {
            display_name: opts.name,
            legal_name: opts.legalName,
            aliases: `${opts.aliases ?? ""}`
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
            website: opts.website,
            timezone: opts.timezone,
            organization_type: enumValue(
              opts.type,
              CRM_ORGANIZATION_TYPES,
              "--type",
            ),
            lifecycle_stage: enumValue(
              opts.lifecycle,
              CRM_LIFECYCLE_STAGES,
              "--lifecycle",
            ),
            relationship_owner_account_id: opts.owner
              ? await resolveAccount(ctx, opts.owner, deps)
              : undefined,
            parent_organization: opts.parent,
          }),
        ),
    ),
  );
  addMutationOptions(
    command
      .command("update <organization>")
      .description("preview or update customer fields from a JSON file")
      .requiredOption(
        "--file <path>",
        "JSON object containing reviewed changes",
      ),
  ).action(async (organization: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm organizations update",
      async (ctx) =>
        await ctx.hub.adminCrm.updateOrganization(
          mutationRequest("organization.update", opts, {
            organization,
            changes: await readJson(opts.file),
          }),
        ),
    ),
  );
  addMutationOptions(
    command
      .command("archive <organization>")
      .description("preview or archive a customer"),
  ).action(async (organization: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm organizations archive",
      async (ctx) =>
        await ctx.hub.adminCrm.archiveOrganization(
          mutationRequest("organization.archive", opts, { organization }),
        ),
    ),
  );
  addMutationOptions(
    command
      .command("merge <source> <destination>")
      .description(
        "preview or merge a duplicate customer into its canonical record",
      ),
  ).action(
    async (source: string, destination: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm organizations merge",
        async (ctx) =>
          await ctx.hub.adminCrm.mergeOrganizations(
            mutationRequest("organization.merge", opts, {
              source_organization: source,
              destination_organization: destination,
            }),
          ),
      ),
  );
}

function registerDomains(crm: Command, deps: CrmCommandDeps): void {
  const domains = crm
    .command("domains")
    .description("reviewed organization domains");
  for (const action of ["add", "verify", "reject", "retire"] as const) {
    const command = addMutationOptions(
      domains
        .command(`${action} <organization> <domain>`)
        .description(`preview or ${action} an organization domain`)
        .option(
          "--kind <kind>",
          `domain kind: ${CRM_DOMAIN_KINDS.join(", ")}`,
          "secondary",
        )
        .option("--verification-method <method>", "review method")
        .option("--evidence <reference>", "bounded evidence reference"),
    );
    command.action(
      async (organization: string, domain: string, opts: any, cmd: Command) =>
        deps.withContext(
          cmd,
          `admin crm domains ${action}`,
          async (ctx) =>
            await ctx.hub.adminCrm.mutateDomain(
              mutationRequest(`domain.${action}`, opts, {
                organization,
                domain,
                action,
                kind: enumValue(opts.kind, CRM_DOMAIN_KINDS, "--kind"),
                verification_method: opts.verificationMethod,
                evidence_reference: opts.evidence,
              }),
            ),
        ),
    );
  }
  addMutationOptions(
    domains
      .command("transfer <organization> <domain> <destination>")
      .description("preview or transfer a reviewed domain"),
  ).action(
    async (
      organization: string,
      domain: string,
      destination: string,
      opts: any,
      cmd: Command,
    ) =>
      deps.withContext(
        cmd,
        "admin crm domains transfer",
        async (ctx) =>
          await ctx.hub.adminCrm.mutateDomain(
            mutationRequest("domain.transfer", opts, {
              organization,
              domain,
              action: "transfer",
              destination_organization: destination,
            }),
          ),
      ),
  );
}

function registerPeople(crm: Command, deps: CrmCommandDeps): void {
  const people = crm
    .command("people")
    .description("customer contacts and reviewed identity links");
  for (const name of ["list", "search"] as const) {
    addPageOptions(
      people
        .command(name)
        .description(`${name} customer contacts`)
        .option("--organization <customer>", "customer selector")
        .option("--search <text>", "name or email")
        .option("--status <state>", "active, merged, or archived"),
    ).action(async (opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        `admin crm people ${name}`,
        async (ctx) =>
          await ctx.hub.adminCrm[
            name === "list" ? "listPeople" : "searchPeople"
          ]({
            ...page(opts),
            organization: opts.organization,
            search: opts.search,
            status: opts.status ? normalizeState(opts.status) : undefined,
            reason: readReason(
              opts.reason,
              `${name === "list" ? "Review" : "Search"} CRM contacts`,
            ),
          }),
      ),
    );
  }
  people
    .command("show <person>")
    .description("show one contact")
    .option("--reason <text>", "audit reason")
    .action(async (person: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm people show",
        async (ctx) =>
          await ctx.hub.adminCrm.getPerson({
            person,
            reason: readReason(opts.reason, "Review CRM contact"),
          }),
      ),
    );
  addMutationOptions(
    people
      .command("create")
      .description("preview or create a customer contact")
      .requiredOption("--name <name>", "display name")
      .option("--organization <customer>", "customer relationship")
      .option(
        "--roles <roles>",
        `comma-separated roles: ${CRM_PERSON_ROLES.join(", ")}`,
      )
      .option("--title <title>", "job title")
      .option("--department <department>", "department")
      .option("--email <email>", "email address")
      .option("--account <account>", "CoCalc account or email")
      .option("--website <url>", "personal or professional website")
      .option("--linkedin <url>", "LinkedIn profile URL")
      .option("--facebook <url>", "Facebook profile URL")
      .option("--x <url>", "X (formerly Twitter) profile URL")
      .option("--note <text>", "bounded internal note; never store secrets")
      .option("--timezone <zone>", "IANA timezone"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm people create",
      async (ctx) =>
        await ctx.hub.adminCrm.createPerson(
          mutationRequest("person.create", opts, {
            display_name: opts.name,
            organization: opts.organization,
            roles: csv(opts.roles),
            title: opts.title,
            department: opts.department,
            email: opts.email,
            cocalc_account_id: opts.account
              ? await resolveAccount(ctx, opts.account, deps)
              : undefined,
            website: opts.website,
            linkedin_url: opts.linkedin,
            facebook_url: opts.facebook,
            x_url: opts.x,
            note: opts.note,
            timezone: opts.timezone,
          }),
        ),
    ),
  );
  addMutationOptions(
    people
      .command("update <person>")
      .description("preview or update a contact")
      .option("--file <path>", "JSON object containing changes")
      .option("--name <name>", "display name")
      .option("--website <url>", "personal or professional website")
      .option("--linkedin <url>", "LinkedIn profile URL")
      .option("--facebook <url>", "Facebook profile URL")
      .option("--x <url>", "X (formerly Twitter) profile URL")
      .option("--note <text>", "bounded internal note; never store secrets")
      .option("--timezone <zone>", "IANA timezone")
      .option("--status <state>", "active, merged, or archived"),
  ).action(async (person: string, opts: any, cmd: Command) =>
    deps.withContext(cmd, "admin crm people update", async (ctx) => {
      const changes = opts.file ? await readJson(opts.file) : {};
      for (const [option, field] of [
        ["name", "display_name"],
        ["website", "website"],
        ["linkedin", "linkedin_url"],
        ["facebook", "facebook_url"],
        ["x", "x_url"],
        ["note", "note"],
        ["timezone", "timezone"],
        ["status", "status"],
      ] as const) {
        if (opts[option] !== undefined) changes[field] = opts[option];
      }
      if (!Object.keys(changes).length) {
        throw Error("specify --file or at least one contact field to update");
      }
      return await ctx.hub.adminCrm.updatePerson(
        mutationRequest("person.update", opts, { person, changes }),
      );
    }),
  );
  for (const action of ["link", "unlink"] as const) {
    addMutationOptions(
      people
        .command(`${action} <person>`)
        .description(`${action} a contact to a customer, account, or email`)
        .option("--organization <customer>", "customer selector")
        .option("--account <account>", "CoCalc account or email")
        .option("--email <email>", "contact email address")
        .option(
          "--email-kind <kind>",
          "work, billing, personal, or other",
          "work",
        )
        .option("--primary", "make this the primary contact email")
        .option("--roles <roles>", "comma-separated customer roles")
        .option("--title <title>", "job title")
        .option("--department <department>", "department")
        .option("--verify", "mark an account or email link verified"),
    ).action(async (person: string, opts: any, cmd: Command) =>
      deps.withContext(cmd, `admin crm people ${action}`, async (ctx) => {
        const targets = [opts.organization, opts.account, opts.email].filter(
          Boolean,
        );
        if (targets.length !== 1)
          throw Error(
            "specify exactly one of --organization, --account, or --email",
          );
        if (opts.organization)
          return await ctx.hub.adminCrm.mutateOrganizationPerson(
            mutationRequest(`organization-person.${action}`, opts, {
              person,
              organization: opts.organization,
              action,
              roles: csv(opts.roles),
              title: opts.title,
              department: opts.department,
            }),
          );
        if (opts.email)
          return await ctx.hub.adminCrm.mutatePersonEmail(
            mutationRequest(`person-email.${action}`, opts, {
              person,
              email: opts.email,
              action: action === "unlink" ? "remove" : "add",
              kind: enumValue(
                opts.emailKind,
                ["work", "billing", "personal", "other"] as const,
                "--email-kind",
              ),
              is_primary: opts.primary || undefined,
              verified: opts.verify || undefined,
            }),
          );
        return await ctx.hub.adminCrm.mutatePersonAccount(
          mutationRequest(`person-account.${action}`, opts, {
            person,
            linked_account_id: await resolveAccount(ctx, opts.account, deps),
            action:
              action === "unlink" ? "unlink" : opts.verify ? "verify" : "link",
          }),
        );
      }),
    );
  }
}

function registerOpportunities(crm: Command, deps: CrmCommandDeps): void {
  const opportunities = crm
    .command("opportunities")
    .description("reviewed commercial pipeline");
  addPageOptions(
    opportunities
      .command("list")
      .description("list opportunities")
      .option("--organization <customer>", "customer selector")
      .option("--stage <stages>", "comma-separated stages")
      .option("--kind <kinds>", "comma-separated kinds")
      .option("--owner <account>", "owner account"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm opportunities list",
      async (ctx) =>
        await ctx.hub.adminCrm.listOpportunities({
          ...page(opts),
          reason: readReason(opts.reason, "Review CRM opportunities"),
          organization: opts.organization,
          stages: csv(opts.stage),
          kinds: csv(opts.kind),
          owner_account_id: opts.owner
            ? await resolveAccount(ctx, opts.owner, deps)
            : undefined,
        }),
    ),
  );
  opportunities
    .command("show <opportunity>")
    .description("show one opportunity")
    .option("--reason <text>", "audit reason")
    .action(async (opportunity: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm opportunities show",
        async (ctx) =>
          await ctx.hub.adminCrm.getOpportunity({
            opportunity,
            reason: readReason(opts.reason, "Review CRM opportunity"),
          }),
      ),
    );
  addMutationOptions(
    opportunities
      .command("create <organization>")
      .description("preview or create an opportunity")
      .requiredOption("--name <name>", "opportunity name")
      .requiredOption(
        "--kind <kind>",
        `kind: ${CRM_OPPORTUNITY_KINDS.join(", ")}`,
      )
      .requiredOption("--owner <account>", "owner account")
      .requiredOption("--value <amount>", "expected value")
      .requiredOption("--close-date <date>", "expected close date")
      .option("--currency <code>", "currency", "usd")
      .option("--service-start <iso>", "service start")
      .option("--service-end <iso>", "service end")
      .option("--zendesk-tickets <ids>", "comma-separated ticket ids")
      .option("--description <text>", "bounded description"),
  ).action(async (organization: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm opportunities create",
      async (ctx) =>
        await ctx.hub.adminCrm.createOpportunity(
          mutationRequest("opportunity.create", opts, {
            organization,
            name: opts.name,
            kind: enumValue(opts.kind, CRM_OPPORTUNITY_KINDS, "--kind"),
            owner_account_id: await resolveAccount(ctx, opts.owner, deps),
            expected_value: opts.value,
            currency: opts.currency,
            expected_close_date: opts.closeDate,
            service_starts_at: opts.serviceStart,
            service_ends_at: opts.serviceEnd,
            source_zendesk_ticket_ids: csv(opts.zendeskTickets)?.map(Number),
            description: opts.description,
          }),
        ),
    ),
  );
  addMutationOptions(
    opportunities
      .command("update <opportunity>")
      .description("preview or update from JSON")
      .requiredOption("--file <path>", "JSON changes"),
  ).action(async (opportunity: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm opportunities update",
      async (ctx) =>
        await ctx.hub.adminCrm.updateOpportunity(
          mutationRequest("opportunity.update", opts, {
            opportunity,
            changes: await readJson(opts.file),
          }),
        ),
    ),
  );
  addMutationOptions(
    opportunities
      .command("transition <opportunity> <stage>")
      .description("preview or transition a pipeline stage")
      .option("--loss-reason <text>", "required for lost"),
  ).action(
    async (opportunity: string, stage: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm opportunities transition",
        async (ctx) =>
          await ctx.hub.adminCrm.transitionOpportunity(
            mutationRequest("opportunity.transition", opts, {
              opportunity,
              stage: enumValue(stage, CRM_OPPORTUNITY_STAGES, "stage"),
              loss_reason: opts.lossReason,
            }),
          ),
      ),
  );
}

function registerTasks(crm: Command, deps: CrmCommandDeps): void {
  const tasks = crm
    .command("tasks")
    .description("constrained internal customer follow-up");
  addPageOptions(
    tasks
      .command("list")
      .description("list CRM tasks")
      .option("--organization <customer>", "customer selector")
      .option("--opportunity <opportunity>", "opportunity selector")
      .option("--assignee <account>", "assignee")
      .option("--state <states>", "comma-separated states")
      .option("--type <types>", "comma-separated types")
      .option("--due-before <iso>", "due before timestamp")
      .option("--overdue", "only overdue open tasks"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm tasks list",
      async (ctx) =>
        await ctx.hub.adminCrm.listTasks({
          ...page(opts),
          reason: readReason(opts.reason, "Review CRM task queue"),
          organization: opts.organization,
          opportunity: opts.opportunity,
          assignee_account_id: opts.assignee
            ? await resolveAccount(ctx, opts.assignee, deps)
            : undefined,
          states: csv(opts.state),
          types: csv(opts.type),
          due_before: opts.dueBefore,
          overdue: opts.overdue || undefined,
        }),
    ),
  );
  tasks
    .command("show <task>")
    .description("show one task")
    .option("--reason <text>", "audit reason")
    .action(async (task: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm tasks show",
        async (ctx) =>
          await ctx.hub.adminCrm.getTask({
            task,
            reason: readReason(opts.reason, "Review CRM task"),
          }),
      ),
    );
  addMutationOptions(
    tasks
      .command("create <organization>")
      .description("preview or create a task")
      .requiredOption("--type <type>", `type: ${CRM_TASK_TYPES.join(", ")}`)
      .requiredOption("--assignee <account>", "assignee")
      .requiredOption(
        "--due <iso>",
        "RFC3339 due timestamp with an explicit timezone",
      )
      .requiredOption("--subject <text>", "short subject")
      .option(
        "--priority <priority>",
        `priority: ${CRM_TASK_PRIORITIES.join(", ")}`,
        "normal",
      )
      .option("--details <text>", "bounded details")
      .option("--person <person>", "contact selector")
      .option("--opportunity <opportunity>", "opportunity selector")
      .option("--commercial-order <uuid>", "commercial order UUID")
      .option("--zendesk-ticket <id>", "Zendesk ticket id"),
  ).action(async (organization: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm tasks create",
      async (ctx) =>
        await ctx.hub.adminCrm.createTask(
          mutationRequest("task.create", opts, {
            organization,
            type: enumValue(opts.type, CRM_TASK_TYPES, "--type"),
            assignee_account_id: await resolveAccount(ctx, opts.assignee, deps),
            due_at: rfc3339Timestamp(opts.due, "--due"),
            priority: enumValue(
              opts.priority,
              CRM_TASK_PRIORITIES,
              "--priority",
            ),
            subject: opts.subject,
            details: opts.details,
            person: opts.person,
            opportunity: opts.opportunity,
            commercial_order_id: opts.commercialOrder,
            zendesk_ticket_id: positiveInteger(
              opts.zendeskTicket,
              "--zendesk-ticket",
            ),
          }),
        ),
    ),
  );
  for (const action of [
    "assign",
    "reschedule",
    "complete",
    "cancel",
  ] as const) {
    addMutationOptions(
      tasks
        .command(`${action} <task>`)
        .description(`preview or ${action} a task`)
        .option(
          "--assignee <account>",
          action === "assign" ? "new assignee (required)" : "optional assignee",
        )
        .option(
          "--due <iso>",
          "new RFC3339 due timestamp with an explicit timezone (required for reschedule)",
        ),
    ).action(async (task: string, opts: any, cmd: Command) =>
      deps.withContext(cmd, `admin crm tasks ${action}`, async (ctx) => {
        if (action === "assign" && !opts.assignee)
          throw Error("--assignee is required");
        if (action === "reschedule" && !opts.due)
          throw Error("--due is required");
        return await ctx.hub.adminCrm.transitionTask(
          mutationRequest(`task.${action}`, opts, {
            task,
            action,
            assignee_account_id: opts.assignee
              ? await resolveAccount(ctx, opts.assignee, deps)
              : undefined,
            due_at:
              action === "reschedule"
                ? rfc3339Timestamp(opts.due, "--due")
                : undefined,
          }),
        );
      }),
    );
  }
}

function registerActivities(crm: Command, deps: CrmCommandDeps): void {
  const activities = crm
    .command("activities")
    .description("append-only customer timeline");
  addPageOptions(
    activities
      .command("list <organization>")
      .description("list customer activity")
      .option("--kind <kinds>", "comma-separated activity kinds"),
  ).action(async (organization: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm activities list",
      async (ctx) =>
        await ctx.hub.adminCrm.getCustomerTimeline({
          ...page(opts),
          organization,
          kinds: csv(opts.kind),
          reason: readReason(opts.reason, "Review CRM customer timeline"),
        }),
    ),
  );
  for (const kind of ["note", "call", "meeting"] as const) {
    addMutationOptions(
      activities
        .command(`${kind} <organization>`)
        .description(`preview or append a ${kind}`)
        .requiredOption("--summary <text>", "short summary")
        .option("--details <text>", "bounded details")
        .option("--person <person>", "contact selector")
        .option("--opportunity <opportunity>", "opportunity selector")
        .option("--task <task>", "task selector")
        .requiredOption(
          "--occurred-at <iso>",
          "RFC3339 event timestamp with an explicit timezone",
        ),
    ).action(async (organization: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        `admin crm activities ${kind}`,
        async (ctx) =>
          await ctx.hub.adminCrm.addActivity(
            mutationRequest(`activity.${kind}`, opts, {
              organization,
              kind,
              summary: opts.summary,
              details: opts.details,
              person: opts.person,
              opportunity: opts.opportunity,
              task: opts.task,
              occurred_at: rfc3339Timestamp(opts.occurredAt, "--occurred-at"),
            }),
          ),
      ),
    );
  }
}

function registerLinks(crm: Command, deps: CrmCommandDeps): void {
  const links = crm
    .command("links")
    .description("reviewed external-system references");
  addPageOptions(
    links
      .command("list")
      .description("list external references with cursor-complete pagination")
      .option(
        "--provider <provider>",
        `external provider: ${cliEnumValues(CRM_EXTERNAL_PROVIDERS)}`,
      )
      .option(
        "--kind <kind>",
        `external object kind: ${cliEnumValues(CRM_EXTERNAL_OBJECT_KINDS)}`,
      )
      .option("--external-id <id>", "exact stable external identifier")
      .option(
        "--external-id-prefix <prefix>",
        "literal stable external identifier prefix",
      )
      .option("--organization <customer>", "customer selector")
      .option(
        "--verification-state <state>",
        `verification state: ${cliEnumValues(CRM_EXTERNAL_REFERENCE_VERIFICATION_STATES)}`,
      ),
  ).action(async (opts: any, cmd: Command) => {
    const externalId = `${opts.externalId ?? ""}`.trim() || undefined;
    const externalIdPrefix =
      `${opts.externalIdPrefix ?? ""}`.trim() || undefined;
    if (externalId && externalIdPrefix) {
      throw Error(
        "--external-id and --external-id-prefix are mutually exclusive",
      );
    }
    return deps.withContext(cmd, "admin crm links list", async (ctx) =>
      ctx.hub.adminCrm.listExternalReferences({
        ...page(opts),
        provider: opts.provider
          ? enumValue(opts.provider, CRM_EXTERNAL_PROVIDERS, "--provider")
          : undefined,
        object_kind: opts.kind
          ? enumValue(opts.kind, CRM_EXTERNAL_OBJECT_KINDS, "--kind")
          : undefined,
        external_id: externalId,
        external_id_prefix: externalIdPrefix,
        organization: `${opts.organization ?? ""}`.trim() || undefined,
        verification_state: opts.verificationState
          ? enumValue(
              opts.verificationState,
              CRM_EXTERNAL_REFERENCE_VERIFICATION_STATES,
              "--verification-state",
            )
          : undefined,
        reason: readReason(opts.reason, "Review CRM external references"),
      }),
    );
  });
  for (const commandName of ["add", "remove"] as const) {
    addMutationOptions(
      links
        .command(`${commandName} <organization>`)
        .description(`preview or ${commandName} an external reference`)
        .requiredOption(
          "--provider <provider>",
          `external provider: ${cliEnumValues(CRM_EXTERNAL_PROVIDERS)}`,
        )
        .requiredOption(
          "--kind <kind>",
          `external object kind: ${cliEnumValues(CRM_EXTERNAL_OBJECT_KINDS)}`,
        )
        .requiredOption("--external-id <id>", "stable external identifier")
        .option("--person <person>", "contact selector")
        .option("--opportunity <opportunity>", "opportunity selector")
        .option("--label <text>", "redacted display label")
        .option("--metadata-file <path>", "bounded JSON metadata")
        .option("--verify", "mark the link reviewed and verified")
        .option("--reject", "mark the reviewed link rejected")
        .addHelpText(
          "after",
          "\nWhen --kind is person, --person is required when adding or verifying and must belong to <organization>; reject always stores an unbound identity, and remove may omit it.\n",
        ),
    ).action(async (organization: string, opts: any, cmd: Command) =>
      deps.withContext(cmd, `admin crm links ${commandName}`, async (ctx) => {
        if (opts.verify && opts.reject) {
          throw Error("--verify and --reject are mutually exclusive");
        }
        if (commandName === "remove" && (opts.verify || opts.reject)) {
          throw Error("--verify and --reject cannot be used with links remove");
        }
        return await ctx.hub.adminCrm.mutateExternalReference(
          mutationRequest(`external-reference.${commandName}`, opts, {
            organization,
            action:
              commandName === "remove"
                ? "remove"
                : opts.reject
                  ? "reject"
                  : opts.verify
                    ? "verify"
                    : "add",
            provider: enumValue(
              opts.provider,
              CRM_EXTERNAL_PROVIDERS,
              "--provider",
            ),
            object_kind: enumValue(
              opts.kind,
              CRM_EXTERNAL_OBJECT_KINDS,
              "--kind",
            ),
            external_id: opts.externalId,
            person: opts.person,
            opportunity: opts.opportunity,
            label: opts.label,
            metadata: opts.metadataFile
              ? await readJson(opts.metadataFile)
              : undefined,
          }),
        );
      }),
    );
  }
}

function registerOrder(crm: Command, deps: CrmCommandDeps): void {
  const order = crm
    .command("order")
    .description("opportunity-to-receivables handoff");
  addMutationOptions(
    order
      .command("create <opportunity>")
      .description("preview or create a commercial order from an opportunity")
      .requiredOption(
        "--next-action <action>",
        "constrained receivables next action",
      )
      .option("--next-action-due <iso>", "next-action due timestamp")
      .option(
        "--collection-mode <mode>",
        "stripe-invoice or manual-invoice",
        "stripe-invoice",
      )
      .option("--payment-terms-days <days>", "invoice payment terms", "21")
      .option("--billing-contact <person>", "billing contact selector"),
  ).action(async (opportunity: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm order create",
      async (ctx) =>
        await ctx.hub.adminCrm.createCommercialOrderFromOpportunity(
          mutationRequest("opportunity.create-order", opts, {
            opportunity,
            next_action: commercialNextAction(opts.nextAction),
            next_action_due_at: opts.nextActionDue,
            collection_mode: normalizeState(opts.collectionMode),
            payment_terms_days: nonnegativeInteger(
              opts.paymentTermsDays,
              "--payment-terms-days",
            ),
            billing_contact_person: opts.billingContact,
          }),
        ),
    ),
  );
  addMutationOptions(
    order
      .command("link <opportunity> <order>")
      .description(
        "preview or link an existing commercial order to an opportunity",
      ),
  ).action(
    async (opportunity: string, orderId: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm order link",
        async (ctx) =>
          await ctx.hub.adminCrm.linkOpportunityCommercialOrder(
            mutationRequest("opportunity.link-order", opts, {
              opportunity,
              order: orderId,
            }),
          ),
      ),
  );
  addMutationOptions(
    order
      .command("unlink <opportunity> <order>")
      .description(
        "preview or remove an opportunity's link to a commercial order",
      ),
  ).action(
    async (opportunity: string, orderId: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm order unlink",
        async (ctx) =>
          await ctx.hub.adminCrm.unlinkOpportunityCommercialOrder(
            mutationRequest("opportunity.unlink-order", opts, {
              opportunity,
              order: orderId,
            }),
          ),
      ),
  );
}

function registerTopLevel(crm: Command, deps: CrmCommandDeps): void {
  crm
    .command("support-context")
    .description("show deterministic CRM evidence for a support requester")
    .requiredOption("--ticket <id>", "Zendesk ticket id")
    .option("--email <email>", "requester email")
    .option("--account <account>", "requester CoCalc account or email")
    .option("--reason <text>", "audit reason for this admin read")
    .action(async (opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm support-context",
        async (ctx) =>
          await ctx.hub.adminCrm.getSupportContext({
            ticket_id: positiveInteger(opts.ticket, "--ticket")!,
            requester_email: opts.email,
            requester_account_id: opts.account
              ? await resolveAccount(ctx, opts.account, deps)
              : undefined,
            reason: readReason(opts.reason, "Review CRM support context"),
          }),
      ),
    );
  addMutationOptions(
    crm
      .command("backfill")
      .description("preview or apply reviewed customer discovery candidates")
      .option(
        "--candidate <key>",
        "candidate key to apply (repeatable)",
        (value, previous: string[] = []) => [...previous, value],
        [],
      )
      .option("--limit <n>", "maximum candidates", "100"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm backfill",
      async (ctx) =>
        await ctx.hub.adminCrm.backfill(
          mutationRequest("backfill", opts, {
            candidate_keys: opts.candidate,
            limit: positiveInteger(opts.limit, "--limit", 500),
          }),
        ),
    ),
  );
  crm
    .command("digest")
    .description("show the deterministic daily customer work digest")
    .option("--as-of <iso>", "evaluate queues at this ISO timestamp")
    .option("--due-within-days <n>", "near-term follow-up window", "1")
    .option("--renewal-within-days <n>", "renewal look-ahead window", "90")
    .option("--assignee <account>", "limit work to an admin account")
    .option("--limit <n>", "maximum rows per section", "100")
    .option("--reason <text>", "audit reason")
    .action(async (opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm digest",
        async (ctx) =>
          await ctx.hub.adminCrm.getDailyDigest({
            as_of: opts.asOf,
            due_within_days: nonnegativeInteger(
              opts.dueWithinDays,
              "--due-within-days",
            ),
            renewal_within_days: nonnegativeInteger(
              opts.renewalWithinDays,
              "--renewal-within-days",
            ),
            assignee_account_id: opts.assignee
              ? await resolveAccount(ctx, opts.assignee, deps)
              : undefined,
            limit: positiveInteger(opts.limit, "--limit", 500),
            reason: readReason(opts.reason, "Review daily CRM work digest"),
          }),
      ),
    );
  crm
    .command("diagnostics")
    .description("run bounded CRM consistency diagnostics")
    .option("--limit <n>", "maximum rows per review queue", "100")
    .option("--reason <text>", "audit reason")
    .action(async (opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm diagnostics",
        async (ctx) =>
          await ctx.hub.adminCrm.getDiagnostics({
            limit: positiveInteger(opts.limit, "--limit", 500),
            reason: readReason(opts.reason, "Review CRM diagnostics"),
          }),
      ),
    );
  crm
    .command("export")
    .description("export a bounded sensitive CRM data set")
    .option("--organization <customer>", "one customer selector")
    .option("--include-people", "include contact PII", false)
    .option("--include-activities", "include customer timeline", false)
    .option("--limit <n>", "maximum customers", "100")
    .option("--max-bytes <n>", "maximum bytes", "5000000")
    .option(
      "--output-file <path>",
      "write sensitive JSON to a mode-0600 file instead of stdout",
    )
    .requiredOption("--reason <text>", "human-readable export reason")
    .action(async (opts: any, cmd: Command) =>
      deps.withContext(cmd, "admin crm export", async (ctx) => {
        const result = await ctx.hub.adminCrm.exportData({
          organization: opts.organization,
          include_people: opts.includePeople,
          include_activities: opts.includeActivities,
          limit: positiveInteger(opts.limit, "--limit", 500),
          max_bytes: positiveInteger(opts.maxBytes, "--max-bytes", 5_000_000),
          reason: requireReason(opts.reason),
        });
        if (opts.outputFile) {
          await writeFile(
            opts.outputFile,
            `${JSON.stringify(result, null, 2)}\n`,
            {
              mode: 0o600,
            },
          );
          return {
            ...result,
            organizations: undefined,
            output: opts.outputFile,
          };
        }
        return result;
      }),
    );
}

function addOutreachRecipientOptions(
  command: Command,
  includeOrganization = true,
): Command {
  command.option("--person <person>", "reviewed CRM contact or email");
  if (includeOrganization) {
    command.option(
      "--organization <customer>",
      "CRM organization when contact has several",
    );
  }
  return command
    .option("--opportunity <opportunity>", "linked CRM opportunity")
    .option("--email <email>", "specific reviewed contact email")
    .option("--subject <subject>", "custom exact subject")
    .option("--body-file <path>", "custom Markdown body file")
    .option("--override-reason <text>", "reviewed cooldown warning override");
}

async function outreachRecipientFromOptions(
  opts: any,
): Promise<OutreachRecipientInput> {
  return outreachRecipient(
    {
      person: opts.person,
      organization: opts.organization,
      opportunity: opts.opportunity,
      email: opts.email,
      subject: opts.subject,
      body_markdown: opts.bodyFile
        ? await readFile(opts.bodyFile, "utf8")
        : undefined,
      override_reason: opts.overrideReason,
    },
    1,
  );
}

function recipientMutationPayload(
  batch: string,
  recipient: OutreachRecipientInput,
): Json {
  return {
    batch,
    person: recipient.person,
    organization: recipient.organization,
    opportunity: recipient.opportunity,
    email: recipient.email,
    subject: recipient.subject,
    body_markdown: recipient.body_markdown,
    override_reason: recipient.override_reason,
  };
}

async function addOneOutreachRecipient(
  ctx: any,
  batch: string,
  opts: MutationOptions,
  recipient: OutreachRecipientInput,
): Promise<any> {
  return await ctx.hub.adminCrm.addOutreachRecipient(
    mutationRequest(
      "outreach.recipient.add",
      opts,
      recipientMutationPayload(batch, recipient),
    ),
  );
}

function organizationDraftCreatePayload(
  opts: any,
  ownerAccountId: string,
  organizationName: string,
  reason: string,
): Json {
  const kind = enumValue(
    opts.kind ?? "adoption-pilot",
    CRM_OUTREACH_KINDS,
    "--kind",
  );
  return {
    name:
      `${opts.name ?? ""}`.trim() ||
      `${organizationName} ${kind.replace(/_/g, " ")}`,
    purpose: `${opts.purpose ?? ""}`.trim() || reason,
    kind,
    owner_account_id: ownerAccountId,
    template: opts.template,
  };
}

async function addOutreachRecipientFile(
  ctx: any,
  batch: string,
  opts: any,
): Promise<Json> {
  const requestedLimit =
    positiveInteger(opts.maxRows, "--max-rows", OUTREACH_IMPORT_MAX_ROWS) ??
    OUTREACH_IMPORT_MAX_ROWS;
  const readAuditReason = readReason(
    opts.reason,
    "Review CRM outreach recipient import",
  );
  const [limits, batchDetail] = await Promise.all([
    ctx.hub.adminCrm.getOutreachLimits({ reason: readAuditReason }),
    ctx.hub.adminCrm.getOutreachBatch({
      batch,
      reason: readAuditReason,
    }),
  ]);
  const configuredLimit = Math.max(
    1,
    Math.min(
      OUTREACH_IMPORT_MAX_ROWS,
      Number(limits.max_recipients_per_batch) || OUTREACH_IMPORT_MAX_ROWS,
    ),
  );
  const existingRecipients = Math.max(
    0,
    Number(batchDetail?.batch?.recipient_count) || 0,
  );
  const remainingCapacity = configuredLimit - existingRecipients;
  if (remainingCapacity < 1) {
    throw Error(
      `outreach batch already has ${existingRecipients} recipients and its configured limit is ${configuredLimit}`,
    );
  }
  const effectiveLimit = Math.min(requestedLimit, remainingCapacity);
  const recipients = await readOutreachRecipients(opts.file, effectiveLimit);
  const reason = requireReason(opts.reason);
  const importPayload = { batch, recipients, reason, source: "cli" };
  const computedKey = mutationKey(
    "outreach.batch.recipient-import",
    importPayload,
  );
  const suppliedKey = `${opts.idempotencyKey ?? ""}`.trim();
  if (opts.commit && suppliedKey !== computedKey) {
    throw Error(
      "--idempotency-key must exactly match the composite key returned by the reviewed import preview",
    );
  }
  const startingVersion = opts.commit
    ? nonnegativeInteger(opts.expectedVersion, "--expected-version")
    : undefined;
  if (opts.commit && startingVersion == null) {
    throw Error(
      "--expected-version is required with --commit; use the composite value returned by the import preview",
    );
  }

  const results: Array<Json> = [];
  let previewVersion: number | undefined;
  for (const [index, recipient] of recipients.entries()) {
    const row = index + 1;
    try {
      const rowKey = `${computedKey}:row:${`${row}`.padStart(3, "0")}`;
      const preview = await addOneOutreachRecipient(
        ctx,
        batch,
        { reason, idempotencyKey: rowKey },
        recipient,
      );
      const expectedVersion = Number(preview?.expected_version);
      if (!preview?.preview || !Number.isInteger(expectedVersion)) {
        throw Error(`recipient row ${row} did not return a valid preview`);
      }
      previewVersion ??= expectedVersion;
      if (!opts.commit) {
        results.push({ row, recipient, preview });
        continue;
      }
      if (row === 1 && expectedVersion !== startingVersion) {
        throw Error(
          `outreach batch changed: reviewed version ${startingVersion}, current version is ${expectedVersion}; preview the import again`,
        );
      }
      const committed = await addOneOutreachRecipient(
        ctx,
        batch,
        {
          reason,
          commit: true,
          expectedVersion: `${expectedVersion}`,
          idempotencyKey: rowKey,
        },
        recipient,
      );
      results.push({ row, recipient, preview, committed });
    } catch (err) {
      if (opts.commit && results.length) {
        const detail = err instanceof Error ? err.message : `${err}`;
        throw Error(
          `recipient import stopped at row ${row} after rows 1-${results.length} committed: ${detail}`,
        );
      }
      throw err;
    }
  }
  return {
    mode: opts.commit ? "sequential_commit" : "preview",
    atomic: false,
    batch,
    row_count: recipients.length,
    hard_row_limit: OUTREACH_IMPORT_MAX_ROWS,
    configured_batch_limit: configuredLimit,
    existing_batch_recipients: existingRecipients,
    remaining_batch_capacity: remainingCapacity,
    effective_row_limit: effectiveLimit,
    expected_version: previewVersion,
    idempotency_key: computedKey,
    results,
    note: opts.commit
      ? "Recipients were previewed and committed sequentially; a failure can leave an explicitly reported prefix committed."
      : "No recipients were added. Review every rendered row, then repeat this command with the returned expected_version and idempotency_key plus --commit.",
  };
}

function registerOutreach(crm: Command, deps: CrmCommandDeps): void {
  const outreach = crm
    .command("outreach")
    .description("reviewed proactive Zendesk conversations")
    .addHelpText(
      "after",
      `\nOutreach runbook:\n  cocalc docs show admin/crm-outreach --include-admin\n  cocalc docs search "CRM outreach adoption pilot" --include-admin\n  cocalc docs skill-context --query "send reviewed prospect outreach" --include-admin\n\nQueue commits only create durable work. The seed worker performs rate-limited Zendesk calls. Full conversations remain in Zendesk; use 'cocalc admin support show|reply'.\n`,
    );

  addPageOptions(
    outreach
      .command("list")
      .description("list outreach deliveries")
      .option("--batch <batch>", "batch number or UUID")
      .option("--organization <customer>", "CRM customer")
      .option("--person <person>", "CRM contact or email")
      .option("--opportunity <opportunity>", "CRM opportunity")
      .option("--state <states>", "comma-separated delivery states")
      .option("--ticket <id>", "Zendesk ticket ID")
      .option(
        "--engagement <filter>",
        "viewed, unviewed, replied, or unreplied",
      )
      .option("--suggested-action <action>", "follow-up suggested action"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach list",
      async (ctx) =>
        await ctx.hub.adminCrm.listOutreachDeliveries({
          ...page(opts),
          batch: opts.batch,
          organization: opts.organization,
          person: opts.person,
          opportunity: opts.opportunity,
          states: csv(opts.state),
          zendesk_ticket_id: positiveInteger(opts.ticket, "--ticket"),
          engagement: opts.engagement
            ? normalizeState(opts.engagement)
            : undefined,
          suggested_action: opts.suggestedAction
            ? normalizeState(opts.suggestedAction)
            : undefined,
          reason: readReason(opts.reason, "Review CRM outreach queue"),
        }),
    ),
  );
  outreach
    .command("show <delivery>")
    .description("show an outreach delivery by UUID, provider key, or ticket")
    .option("--reason <text>", "audit reason")
    .action(async (delivery: string, opts: any, cmd: Command) =>
      deps.withContext(cmd, "admin crm outreach show", async (ctx) => {
        const reason = readReason(opts.reason, "Review CRM outreach delivery");
        const [record, operations, engagement] = await Promise.all([
          ctx.hub.adminCrm.getOutreachDelivery({ delivery, reason }),
          ctx.hub.adminCrm.listOutreachProviderOperations({
            delivery,
            reason,
            limit: 100,
          }),
          ctx.hub.adminCrm.listOutreachEngagementEvents({
            delivery,
            reason,
            limit: 100,
          }),
        ]);
        return {
          delivery: record,
          provider_operations: operations,
          engagement,
          support_show_command: record.zendesk_ticket_id
            ? `cocalc admin support show ${record.zendesk_ticket_id}`
            : undefined,
        };
      }),
    );
  outreach
    .command("preview <batch>")
    .description("render exact recipients, content, preflight, and limits")
    .option("--reason <text>", "audit reason")
    .action(async (batch: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach preview",
        async (ctx) =>
          await ctx.hub.adminCrm.previewOutreachBatch({
            batch,
            reason: readReason(opts.reason, "Preview CRM outreach batch"),
          }),
      ),
    );

  const draft = addMutationOptions(
    addOutreachRecipientOptions(
      outreach
        .command("draft <organization>")
        .description(
          "compose a new one-recipient outreach batch for a CRM customer",
        )
        .option("--name <name>", "batch name; defaults from the customer")
        .option("--purpose <purpose>", "defaults to the immutable audit reason")
        .option(
          "--kind <kind>",
          CRM_OUTREACH_KINDS.join(", "),
          "adoption-pilot",
        )
        .option("--owner <account>", "responsible admin", "me")
        .option(
          "--template <template>",
          "active template key, key@revision, or UUID",
        ),
      false,
    ),
  ).addHelpText(
    "after",
    `
This organization-first command previews creation of a new batch. Committing
that reviewed preview creates only the batch and then returns a separate
recipient preview; it never commits the second mutation unexpectedly. Commit
that recipient with 'outreach batch add' using the returned batch id,
expected_version, and idempotency_key.
`,
  );
  draft.action(async (organization: string, opts: any, cmd: Command) =>
    deps.withContext(cmd, "admin crm outreach draft", async (ctx) => {
      const reason = requireReason(opts.reason);
      const recipient = {
        ...(await outreachRecipientFromOptions(opts)),
        organization,
      };
      const customer = await ctx.hub.adminCrm.getOrganization({
        organization,
        activity_limit: 1,
        reason,
      });
      const organizationName =
        `${customer?.organization?.display_name ?? ""}`.trim();
      if (!organizationName) {
        throw Error("CRM organization lookup did not return a display name");
      }
      const createPayload = organizationDraftCreatePayload(
        opts,
        await resolveAccount(ctx, opts.owner, deps),
        organizationName,
        reason,
      );
      const batchMutation = await ctx.hub.adminCrm.createOutreachBatch(
        mutationRequest("outreach.batch.create", opts, createPayload),
      );
      if (!opts.commit) {
        return {
          mode: "organization_first",
          step: "preview_batch_creation",
          batch: batchMutation,
          recipient: {
            preview: false,
            note: "The recipient cannot be rendered until the reviewed batch exists. No recipient mutation was attempted.",
          },
        };
      }
      const createdBatch = `${batchMutation?.result?.id ?? ""}`.trim();
      if (!createdBatch) {
        throw Error(
          "committed batch creation did not return a batch id; no recipient mutation was attempted",
        );
      }
      const recipientPreview = await addOneOutreachRecipient(
        ctx,
        createdBatch,
        {
          reason: opts.reason,
          idempotencyKey: mutationKey(
            "outreach.recipient.add",
            recipientMutationPayload(createdBatch, recipient),
          ),
        },
        recipient,
      );
      return {
        mode: "organization_first",
        step: "batch_created_recipient_previewed",
        batch: batchMutation,
        recipient: recipientPreview,
        note: "The batch was created, but the recipient was only previewed. Commit the recipient as a separate reviewed mutation.",
      };
    }),
  );

  for (const action of [
    "approve",
    "queue",
    "pause",
    "resume",
    "cancel",
  ] as const) {
    addMutationOptions(
      outreach
        .command(`${action} <batch>`)
        .description(`preview or ${action} an outreach batch`),
    ).action(async (batch: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        `admin crm outreach ${action}`,
        async (ctx) =>
          await ctx.hub.adminCrm.transitionOutreachBatch(
            mutationRequest(`outreach.batch.${action}`, opts, {
              batch,
              action,
            }),
          ),
      ),
    );
  }

  for (const action of ["retry", "reconcile"] as const) {
    addMutationOptions(
      outreach
        .command(`${action} <delivery>`)
        .description(`preview or ${action} one delivery`),
    ).action(async (delivery: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        `admin crm outreach ${action}`,
        async (ctx) =>
          await ctx.hub.adminCrm.mutateOutreachDelivery(
            mutationRequest(`outreach.delivery.${action}`, opts, {
              delivery,
              action,
            }),
          ),
      ),
    );
  }

  const deliveries = outreach
    .command("delivery")
    .alias("deliveries")
    .description("individual delivery recovery and cancellation");
  for (const action of ["retry", "reconcile", "cancel"] as const) {
    addMutationOptions(
      deliveries
        .command(`${action} <delivery>`)
        .description(`preview or ${action} one outreach delivery`),
    ).action(async (delivery: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        `admin crm outreach delivery ${action}`,
        async (ctx) =>
          await ctx.hub.adminCrm.mutateOutreachDelivery(
            mutationRequest(`outreach.delivery.${action}`, opts, {
              delivery,
              action,
            }),
          ),
      ),
    );
  }

  outreach
    .command("limits")
    .description("show effective limits, rolling usage, and provider backoff")
    .option(
      "--domain <domain>",
      "include current usage for one recipient domain",
    )
    .option("--reason <text>", "audit reason")
    .action(async (opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach limits",
        async (ctx) =>
          await ctx.hub.adminCrm.getOutreachLimits({
            domain: opts.domain,
            reason: readReason(opts.reason, "Review CRM outreach limits"),
          }),
      ),
    );
  outreach
    .command("diagnostics")
    .description("show provider configuration and consistency diagnostics")
    .option("--reason <text>", "audit reason")
    .action(async (opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach diagnostics",
        async (ctx) =>
          await ctx.hub.adminCrm.getOutreachDiagnostics({
            reason: readReason(opts.reason, "Review CRM outreach diagnostics"),
          }),
      ),
    );

  const batches = outreach
    .command("batch")
    .alias("batches")
    .description("reviewed one-recipient and small-batch workflows")
    .addHelpText(
      "after",
      `
Stable batch flow: create, add, preview, approve, then queue. Mutations preview
by default. 'add --file' accepts JSON or JSONL, is capped at 500 rows and the
site batch limit, and commits sequentially rather than atomically.
`,
    );
  addPageOptions(
    batches
      .command("list")
      .description("list outreach batches")
      .option("--state <states>", "comma-separated batch states")
      .option("--kind <kinds>", "comma-separated outreach kinds")
      .option("--owner <account>", "batch owner")
      .option("--organization <customer>", "contains this customer")
      .option("--ticket <id>", "contains this Zendesk ticket"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(cmd, "admin crm outreach batch list", async (ctx) => {
      return await ctx.hub.adminCrm.listOutreachBatches({
        ...page(opts),
        states: csv(opts.state),
        kinds: csv(opts.kind),
        owner_account_id: opts.owner
          ? await resolveAccount(ctx, opts.owner, deps)
          : undefined,
        organization: opts.organization,
        zendesk_ticket_id: positiveInteger(opts.ticket, "--ticket"),
        reason: readReason(opts.reason, "Review CRM outreach batches"),
      });
    }),
  );
  batches
    .command("show <batch>")
    .description("show one batch and every recipient delivery")
    .option("--reason <text>", "audit reason")
    .action(async (batch: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach batch show",
        async (ctx) =>
          await ctx.hub.adminCrm.getOutreachBatch({
            batch,
            reason: readReason(opts.reason, "Review CRM outreach batch"),
          }),
      ),
    );
  batches
    .command("preview <batch>")
    .description("render exact recipients, content, preflight, and limits")
    .option("--reason <text>", "audit reason")
    .action(async (batch: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach batch preview",
        async (ctx) =>
          await ctx.hub.adminCrm.previewOutreachBatch({
            batch,
            reason: readReason(opts.reason, "Preview CRM outreach batch"),
          }),
      ),
    );
  addMutationOptions(
    addOutreachRecipientOptions(
      batches
        .command("add <batch>")
        .description("preview or add one recipient, or import JSON/JSONL")
        .option(
          "--file <path>",
          "JSON array, {recipients:[...]}, or one JSON object per line",
        )
        .option(
          "--max-rows <n>",
          `additional import bound (1-${OUTREACH_IMPORT_MAX_ROWS})`,
          `${OUTREACH_IMPORT_MAX_ROWS}`,
        ),
    ),
  )
    .addHelpText(
      "after",
      `
Specify either --person for one recipient or --file for a bounded import.
File preview makes no changes and returns a composite expected_version and
idempotency_key. File commit is deterministic and sequential, but not atomic;
it stops at the first failed row and may leave the preceding rows committed.
`,
    )
    .action(async (batch: string, opts: any, cmd: Command) =>
      deps.withContext(cmd, "admin crm outreach batch add", async (ctx) => {
        if (Boolean(opts.file) === Boolean(opts.person)) {
          throw Error("specify exactly one of --person or --file");
        }
        if (opts.file) {
          return await addOutreachRecipientFile(ctx, batch, opts);
        }
        return await addOneOutreachRecipient(
          ctx,
          batch,
          opts,
          await outreachRecipientFromOptions(opts),
        );
      }),
    );
  addMutationOptions(
    batches
      .command("create")
      .description("preview or create a draft outreach batch")
      .requiredOption("--name <name>", "batch name")
      .requiredOption("--purpose <purpose>", "reviewed business purpose")
      .requiredOption("--kind <kind>", CRM_OUTREACH_KINDS.join(", "))
      .requiredOption("--owner <account>", "responsible admin")
      .option(
        "--template <template>",
        "active template key, key@revision, or UUID",
      ),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(cmd, "admin crm outreach batch create", async (ctx) => {
      return await ctx.hub.adminCrm.createOutreachBatch(
        mutationRequest("outreach.batch.create", opts, {
          name: opts.name,
          purpose: opts.purpose,
          kind: enumValue(opts.kind, CRM_OUTREACH_KINDS, "--kind"),
          owner_account_id: await resolveAccount(ctx, opts.owner, deps),
          template: opts.template,
        }),
      );
    }),
  );
  addMutationOptions(
    batches
      .command("update <batch>")
      .description("preview or update draft batch fields from JSON")
      .requiredOption("--file <path>", "JSON object with reviewed changes"),
  ).action(async (batch: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach batch update",
      async (ctx) =>
        await ctx.hub.adminCrm.updateOutreachBatch(
          mutationRequest("outreach.batch.update", opts, {
            batch,
            changes: await readJson(opts.file),
          }),
        ),
    ),
  );
  addMutationOptions(
    batches
      .command("remove <batch> <delivery>")
      .description("preview or remove a draft recipient"),
  ).action(async (batch: string, delivery: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach batch remove",
      async (ctx) =>
        await ctx.hub.adminCrm.removeOutreachRecipient(
          mutationRequest("outreach.recipient.remove", opts, {
            batch,
            delivery,
          }),
        ),
    ),
  );
  addMutationOptions(
    batches
      .command("edit <batch> <delivery>")
      .description("preview or edit a draft recipient message")
      .requiredOption("--subject <subject>", "replacement exact subject")
      .requiredOption("--body-file <path>", "replacement Markdown body file")
      .option(
        "--override-reason <text>",
        "reviewed preflight warning override",
      ),
  ).action(async (batch: string, delivery: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach batch edit",
      async (ctx) =>
        await ctx.hub.adminCrm.updateOutreachRecipient(
          versionedMutationRequest("outreach.recipient.update", opts, {
            batch,
            delivery,
            subject: opts.subject,
            body_markdown: await readFile(opts.bodyFile, "utf8"),
            override_reason: opts.overrideReason,
          }),
        ),
    ),
  );
  for (const action of [
    "approve",
    "queue",
    "pause",
    "resume",
    "cancel",
  ] as const) {
    addMutationOptions(
      batches
        .command(`${action} <batch>`)
        .description(`preview or ${action} an outreach batch`),
    ).action(async (batch: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        `admin crm outreach batch ${action}`,
        async (ctx) =>
          await ctx.hub.adminCrm.transitionOutreachBatch(
            mutationRequest(`outreach.batch.${action}`, opts, {
              batch,
              action,
            }),
          ),
      ),
    );
  }

  const templates = outreach
    .command("templates")
    .description("immutable outreach template revisions");
  addPageOptions(
    templates
      .command("list")
      .option("--key <key>", "stable template key")
      .option("--kind <kind>", "outreach kind")
      .option("--status <status>", "draft, active, or retired"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach templates list",
      async (ctx) =>
        await ctx.hub.adminCrm.listOutreachTemplates({
          ...page(opts),
          template_key: opts.key,
          kind: opts.kind ? normalizeState(opts.kind) : undefined,
          status: opts.status ? normalizeState(opts.status) : undefined,
          reason: readReason(opts.reason, "Review CRM outreach templates"),
        }),
    ),
  );
  templates
    .command("show <template>")
    .description("show a template revision")
    .option("--reason <text>", "audit reason")
    .action(async (template: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach templates show",
        async (ctx) =>
          await ctx.hub.adminCrm.getOutreachTemplate({
            template,
            reason: readReason(opts.reason, "Review CRM outreach template"),
          }),
      ),
    );
  addMutationOptions(
    templates
      .command("create")
      .alias("revise")
      .description("preview or create an immutable draft template revision")
      .requiredOption("--key <key>", "stable lower-case template key")
      .requiredOption("--name <name>", "human template name")
      .requiredOption("--kind <kind>", CRM_OUTREACH_KINDS.join(", "))
      .requiredOption("--subject <template>", "allowlisted merge-field subject")
      .requiredOption("--body-file <path>", "Markdown body template")
      .option("--required-fields <fields>", "comma-separated merge fields")
      .option(
        "--follow-up-policy <policy>",
        CRM_OUTREACH_FOLLOW_UP_POLICIES.join(", "),
        "no_response",
      )
      .option("--follow-up-after-days <n>", "override follow-up interval")
      .option("--max-followups <n>", "override reviewed follow-up maximum")
      .option(
        "--final-review-after-days <n>",
        "override final review interval",
      ),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach templates create",
      async (ctx) =>
        await ctx.hub.adminCrm.createOutreachTemplate(
          mutationRequest("outreach.template.create", opts, {
            template_key: opts.key,
            name: opts.name,
            kind: enumValue(opts.kind, CRM_OUTREACH_KINDS, "--kind"),
            subject_template: opts.subject,
            body_markdown_template: await readFile(opts.bodyFile, "utf8"),
            required_fields: `${opts.requiredFields ?? ""}`
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            follow_up_policy: enumValue(
              opts.followUpPolicy,
              CRM_OUTREACH_FOLLOW_UP_POLICIES,
              "--follow-up-policy",
            ),
            follow_up_after_days: positiveInteger(
              opts.followUpAfterDays,
              "--follow-up-after-days",
              90,
            ),
            max_followups: positiveInteger(
              opts.maxFollowups,
              "--max-followups",
              5,
            ),
            final_review_after_days: positiveInteger(
              opts.finalReviewAfterDays,
              "--final-review-after-days",
              90,
            ),
          }),
        ),
    ),
  );
  for (const action of ["activate", "retire"] as const) {
    addMutationOptions(
      templates
        .command(`${action} <template>`)
        .description(`preview or ${action} a template revision`),
    ).action(async (template: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        `admin crm outreach templates ${action}`,
        async (ctx) =>
          await ctx.hub.adminCrm.transitionOutreachTemplate(
            mutationRequest(`outreach.template.${action}`, opts, {
              template,
              action,
            }),
          ),
      ),
    );
  }

  const suppressions = outreach
    .command("suppressions")
    .description("shared opt-out, bounce, complaint, and manual suppressions");
  addPageOptions(
    suppressions
      .command("list")
      .option("--organization <customer>", "CRM customer")
      .option("--person <person>", "CRM person")
      .option("--scope <scope>", CRM_OUTREACH_SUPPRESSION_SCOPES.join(", "))
      .option("--search <text>", "scope value or note")
      .option("--inactive", "show revoked suppressions"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach suppressions list",
      async (ctx) =>
        await ctx.hub.adminCrm.listContactSuppressions({
          ...page(opts),
          organization: opts.organization,
          person: opts.person,
          scope: opts.scope ? normalizeState(opts.scope) : undefined,
          search: opts.search,
          active: opts.inactive ? false : true,
          reason: readReason(opts.reason, "Review CRM outreach suppressions"),
        }),
    ),
  );
  addMutationOptions(
    suppressions
      .command("add")
      .requiredOption(
        "--scope <scope>",
        CRM_OUTREACH_SUPPRESSION_SCOPES.join(", "),
      )
      .option("--value <value>", "normalized email/domain or CRM ID")
      .option("--organization <customer>", "CRM organization")
      .option("--person <person>", "CRM person")
      .option("--email <email>", "reviewed email")
      .option(
        "--suppression-reason <reason>",
        CRM_OUTREACH_SUPPRESSION_REASONS.join(", "),
        "manual",
      )
      .option("--note <text>", "bounded internal note"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach suppressions add",
      async (ctx) =>
        await ctx.hub.adminCrm.mutateContactSuppression(
          mutationRequest("outreach.suppression.add", opts, {
            action: "add",
            scope: enumValue(
              opts.scope,
              CRM_OUTREACH_SUPPRESSION_SCOPES,
              "--scope",
            ),
            value: opts.value,
            organization: opts.organization,
            person: opts.person,
            email: opts.email,
            suppression_reason: enumValue(
              opts.suppressionReason,
              CRM_OUTREACH_SUPPRESSION_REASONS,
              "--suppression-reason",
            ),
            note: opts.note,
          }),
        ),
    ),
  );
  addMutationOptions(
    suppressions
      .command("revoke <suppression>")
      .description("preview or revoke an active suppression"),
  ).action(async (suppression: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach suppressions revoke",
      async (ctx) =>
        await ctx.hub.adminCrm.mutateContactSuppression(
          mutationRequest("outreach.suppression.revoke", opts, {
            action: "revoke",
            suppression,
          }),
        ),
    ),
  );

  const followups = outreach
    .command("followups")
    .description("shared no-response follow-up work");
  addPageOptions(
    followups
      .command("list")
      .option("--organization <customer>", "CRM customer")
      .option("--opportunity <opportunity>", "CRM opportunity")
      .option("--assignee <account>", "task assignee")
      .option("--due-before <iso>", "task deadline")
      .option("--overdue", "only overdue tasks")
      .option("--viewed", "view observed")
      .option("--unviewed", "no view observed")
      .option("--replied", "requester replied")
      .option("--unreplied", "no requester reply"),
  ).action(async (opts: any, cmd: Command) =>
    deps.withContext(cmd, "admin crm outreach followups list", async (ctx) => {
      if (opts.viewed && opts.unviewed)
        throw Error("choose --viewed or --unviewed");
      if (opts.replied && opts.unreplied)
        throw Error("choose --replied or --unreplied");
      return await ctx.hub.adminCrm.listOutreachFollowups({
        ...page(opts),
        organization: opts.organization,
        opportunity: opts.opportunity,
        assignee_account_id: opts.assignee
          ? await resolveAccount(ctx, opts.assignee, deps)
          : undefined,
        due_before: opts.dueBefore,
        overdue: opts.overdue || undefined,
        viewed: opts.viewed ? true : opts.unviewed ? false : undefined,
        replied: opts.replied ? true : opts.unreplied ? false : undefined,
        reason: readReason(opts.reason, "Review CRM outreach follow-ups"),
      });
    }),
  );
  followups
    .command("show <delivery>")
    .description("show the linked delivery and follow-up task")
    .option("--reason <text>", "audit reason")
    .action(async (delivery: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach followups show",
        async (ctx) => {
          const record = await ctx.hub.adminCrm.getOutreachDelivery({
            delivery,
            reason: readReason(opts.reason, "Review CRM outreach follow-up"),
          });
          const task = record.task_id
            ? await ctx.hub.adminCrm.getTask({
                task: record.task_id,
                reason: readReason(
                  opts.reason,
                  "Review CRM outreach follow-up task",
                ),
              })
            : undefined;
          return { delivery: record, task };
        },
      ),
    );
  followups
    .command("preview <delivery>")
    .alias("draft")
    .option("--body-file <path>", "reviewed follow-up body")
    .option("--reason <text>", "audit reason")
    .action(async (delivery: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach followups preview",
        async (ctx) =>
          await ctx.hub.adminCrm.previewOutreachFollowup({
            delivery,
            body: opts.bodyFile
              ? await readFile(opts.bodyFile, "utf8")
              : undefined,
            reason: readReason(opts.reason, "Preview CRM outreach follow-up"),
          }),
      ),
    );
  addMutationOptions(
    followups
      .command("send <delivery>")
      .description("preview or queue a reviewed same-thread Zendesk comment")
      .requiredOption("--body-file <path>", "reviewed public follow-up body"),
  ).action(async (delivery: string, opts: any, cmd: Command) =>
    deps.withContext(
      cmd,
      "admin crm outreach followups send",
      async (ctx) =>
        await ctx.hub.adminCrm.sendOutreachFollowup(
          mutationRequest("outreach.followup.queue", opts, {
            delivery,
            body: await readFile(opts.bodyFile, "utf8"),
          }),
        ),
    ),
  );

  for (const action of ["reschedule", "complete", "cancel"] as const) {
    addMutationOptions(
      followups
        .command(`${action} <delivery>`)
        .description(`preview or ${action} the shared follow-up task`)
        .option("--due <iso>", "new due timestamp (required for reschedule)"),
    ).action(async (delivery: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        `admin crm outreach followups ${action}`,
        async (ctx) => {
          if (action === "reschedule" && !opts.due)
            throw Error("--due is required");
          const record = await ctx.hub.adminCrm.getOutreachDelivery({
            delivery,
            reason: readReason(opts.reason, "Resolve outreach follow-up task"),
          });
          if (!record.task_id)
            throw Error("outreach delivery has no linked follow-up task");
          return await ctx.hub.adminCrm.transitionTask(
            mutationRequest(`task.${action}`, opts, {
              task: record.task_id,
              action,
              due_at: opts.due,
            }),
          );
        },
      ),
    );
  }

  const engagement = outreach
    .command("engagement <delivery>")
    .description("list immutable view observations for one opening message");
  addPageOptions(engagement).action(
    async (delivery: string, opts: any, cmd: Command) =>
      deps.withContext(
        cmd,
        "admin crm outreach engagement",
        async (ctx) =>
          await ctx.hub.adminCrm.listOutreachEngagementEvents({
            ...page(opts),
            delivery,
            reason: readReason(opts.reason, "Review CRM outreach engagement"),
          }),
      ),
  );
}

export function registerCrmCommand(
  admin: Command,
  deps: CrmCommandDeps,
): Command {
  const cliDeps: CrmCommandDeps = {
    ...deps,
    withContext: (
      command: unknown,
      label: string,
      fn: (ctx: unknown) => Promise<unknown>,
    ) =>
      deps.withContext(command, label, async (ctx: unknown) =>
        crmCliEnvelope(await fn(ctx)),
      ),
  };
  const crm = admin
    .command("crm")
    .description("seed-global customer relationship management")
    .addHelpText(
      "after",
      `\nAdmin runbooks:\n  cocalc docs show admin/crm --include-admin\n  cocalc docs show admin/crm-outreach --include-admin\n  cocalc docs search "customer relationship CRM" --include-admin\n  cocalc docs skill-context --query "institutional customer CRM" --include-admin\n\nMutations preview by default. Review the returned expected_version and idempotency_key, then re-run with --expected-version, --idempotency-key, and --commit. Committed writes and exports require browser-approved fresh authentication.\n`,
    );
  registerOrganizations(crm, cliDeps);
  registerDomains(crm, cliDeps);
  registerPeople(crm, cliDeps);
  registerOpportunities(crm, cliDeps);
  registerTasks(crm, cliDeps);
  registerActivities(crm, cliDeps);
  registerLinks(crm, cliDeps);
  registerOrder(crm, cliDeps);
  registerOutreach(crm, cliDeps);
  registerTopLevel(crm, cliDeps);
  return crm;
}
