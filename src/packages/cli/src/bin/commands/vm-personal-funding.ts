/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { closeSync, openSync, readSync } from "node:fs";
import { Command } from "commander";
import type {
  VmPersonalFundingApi,
  VmPersonalFundingTerms,
} from "@cocalc/util/compute-vm-funding";
import {
  fundingAmount,
  fundingDate,
  fundingId,
} from "@cocalc/util/compute-funding";

const MAX_TERMS_BYTES = 64 * 1024;
const TERM_KEYS = [
  "vm_id",
  "expected_funding_version",
  "home_volume_ids",
  "lane",
  "cap_usd",
  "ends_at",
  "activation",
  "fallback_reasons",
];

function readTermsFile(path: string): string {
  const fd = path === "-" ? 0 : openSync(path, "r");
  try {
    // Bound file and stdin reads before allocation/parsing, including piped input.
    const buffer = Buffer.alloc(MAX_TERMS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_TERMS_BYTES)
      throw Error("Personal funding terms exceed 64 KiB.");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    if (path !== "-") closeSync(fd);
  }
}

function fundingVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw Error(
      "Expected funding version must be a nonempty string of at most 512 characters.",
    );
  }
  return value;
}

export function parseVmPersonalFundingTerms(
  text: string,
): VmPersonalFundingTerms {
  if (Buffer.byteLength(text) > MAX_TERMS_BYTES)
    throw Error("Personal funding terms exceed 64 KiB.");
  const terms = JSON.parse(text);
  if (
    !terms ||
    typeof terms !== "object" ||
    Array.isArray(terms) ||
    Object.keys(terms).some((key) => !TERM_KEYS.includes(key))
  ) {
    throw Error(
      "Personal funding terms must contain only the explicit VM funding fields.",
    );
  }
  if (
    !["prepaid", "postpaid"].includes(terms.lane) ||
    !["immediate", "fallback"].includes(terms.activation)
  ) {
    throw Error(
      "Personal funding requires an explicit lane and activation mode.",
    );
  }
  if (
    !Array.isArray(terms.home_volume_ids) ||
    terms.home_volume_ids.length > 100
  ) {
    throw Error(
      "home_volume_ids must explicitly list up to 100 UUIDs; use [] for none.",
    );
  }
  if (
    !Array.isArray(terms.fallback_reasons) ||
    terms.fallback_reasons.length > 2 ||
    terms.fallback_reasons.some(
      (reason) => !["course_exhausted", "course_expired"].includes(reason),
    ) ||
    (terms.activation === "fallback"
      ? terms.fallback_reasons.length === 0
      : terms.fallback_reasons.length !== 0)
  ) {
    throw Error(
      "Fallback requires explicit course_exhausted/course_expired reasons; immediate activation requires [].",
    );
  }
  return {
    vm_id: fundingId(terms.vm_id, "VM"),
    expected_funding_version: fundingVersion(terms.expected_funding_version),
    home_volume_ids: [
      ...new Set<string>(
        terms.home_volume_ids.map((id) => fundingId(id, "Home volume")),
      ),
    ].sort(),
    lane: terms.lane,
    cap_usd: fundingAmount(terms.cap_usd, { positive: true, cents: true }),
    ends_at: fundingDate(terms.ends_at),
    activation: terms.activation,
    fallback_reasons: [
      ...new Set<VmPersonalFundingTerms["fallback_reasons"][number]>(
        terms.fallback_reasons,
      ),
    ].sort(),
  };
}

function consentVersion(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw Error("Expected consent version must be a nonnegative safe integer.");
  }
  return Number(value);
}

export function registerVmPersonalFundingCommand(
  vm: Command,
  deps: { withContext: any; readTerms?: (path: string) => string },
) {
  const root = vm
    .command("personal-funding")
    .description("bounded personal VM funding with isolated browser approval")
    .addHelpText(
      "after",
      `
Use account authentication. Inspect course sources with
  cocalc compute-funding sources --include-inactive --json
and the VM's current funding version/deadlines with
  cocalc vm funding VM_UUID --json

Preview exact terms, propose them, and open only the returned isolated approval
URL in your own browser. After approval, read status again: its consent version
has changed. Apply is only for approved immediate consent. It returns preparing;
the backend stops the VM, checks settlement/backing, switches funding and queues
a restart. Poll status and vm get; an accepted request is not completed cutover.
Cancel active/preparing consent can stop the VM; it does not refund prior usage.
Include an attached course-funded home volume in the review. It receives its
own reservation within the same cap and survives VM deletion under its own
retention deadline. Include an already personally funded home volume too: its
agreement stays unchanged outside the VM cap. VM approval does not extend or
cancel that disk's funding or retention.
Never remove volume scope, change versions automatically, or use vm funding --set
to bypass a rejected proposal. No command here approves consent or extends timers.
`,
    );
  const run = (
    command: Command,
    label: string,
    fn: (api: VmPersonalFundingApi) => Promise<unknown>,
  ) =>
    deps.withContext(command, `vm personal-funding ${label}`, async (ctx) => {
      const user = ctx.remote?.user;
      if (
        user?.project_id ||
        user?.auth_project_id ||
        user?.host_id ||
        user?.auth_host_id ||
        user?.auth_actor === "agent"
      ) {
        throw Object.assign(
          Error("Personal VM funding requires account authentication."),
          { code: "account_auth_required" },
        );
      }
      return await fn(ctx.hub.compute);
    });

  for (const action of ["preview", "propose"] as const) {
    const command = root
      .command(action)
      .description(
        action === "preview"
          ? "quote explicit personal funding terms without creating consent"
          : "return an isolated browser approval URL; does not approve or apply funding",
      )
      .requiredOption(
        "--terms <file>",
        "explicit JSON terms file, or - for stdin (maximum 64 KiB)",
      )
      .addHelpText(
        "after",
        `
Terms JSON (all fields required):
  vm_id                    VM UUID
  expected_funding_version Current funding_status.funding_version from vm funding
  home_volume_ids          Array of home-volume UUIDs, or [] for none
  lane                     "prepaid" or "postpaid"
  cap_usd                  Positive whole-cent decimal string, e.g. "12.34"
  ends_at                  Absolute ISO timestamp with timezone, within VM deletion deadline
  activation               "immediate" or "fallback"
  fallback_reasons         [] for immediate; otherwise course_exhausted and/or course_expired

The cap includes compute, egress and protected storage. Review the returned
terms and costs; only the isolated browser approval page can authorize them.
Include the attached course-funded home volume in home_volume_ids. Automatic
fallback requires the VM and its home disk to use the same course allowance.
Do not omit an attached volume to bypass a rejected review.
`,
      );
    if (action === "propose")
      command.requiredOption(
        "--operation <uuid>",
        "stable operation UUID; reuse only for retries of identical terms",
      );
    command.action(async (opts, command: Command) => {
      // Read once outside withContext so authentication retries keep identical
      // terms and operation identity; never infer a cap, payer, or deadline.
      const terms = parseVmPersonalFundingTerms(
        (deps.readTerms ?? readTermsFile)(opts.terms),
      );
      const operation_id =
        action === "propose"
          ? fundingId(opts.operation, "Operation")
          : undefined;
      return run(command, action, (api) =>
        action === "preview"
          ? api.previewVmPersonalFunding({ terms })
          : api.proposeVmPersonalFunding({
              terms,
              operation_id: operation_id!,
            }),
      );
    });
  }

  root
    .command("status <vm_id>")
    .description("read the latest personal funding consent and approval URL")
    .action(async (id: string, _opts, command: Command) => {
      const vm_id = fundingId(id, "VM");
      return run(command, "status", (api) =>
        api.getVmPersonalFunding({ vm_id }),
      );
    });

  for (const action of ["cancel", "apply"] as const) {
    const command = root
      .command(`${action} <vm_id>`)
      .description(
        action === "cancel"
          ? "cancel the specified consent subject to backend lifecycle checks"
          : "request the backend stop/cutover/restart for approved immediate consent; never grants approval",
      )
      .requiredOption(
        "--consent <uuid>",
        "consent UUID returned by propose/status",
      )
      .requiredOption(
        "--expected-version <version>",
        "explicit consent version from propose/status",
      )
      .requiredOption(
        "--operation <uuid>",
        "stable operation UUID for this action",
      );
    if (action === "apply")
      command.requiredOption(
        "--expected-funding-version <version>",
        "exact current VM funding version approved in the terms",
      );
    command.action(async (id: string, opts, command: Command) => {
      const request = {
        vm_id: fundingId(id, "VM"),
        consent_id: fundingId(opts.consent, "Consent"),
        expected_version: consentVersion(opts.expectedVersion),
        operation_id: fundingId(opts.operation, "Operation"),
      };
      const expected_funding_version =
        action === "apply"
          ? fundingVersion(opts.expectedFundingVersion)
          : undefined;
      return run(command, action, (api) =>
        action === "cancel"
          ? api.clearVmPersonalFunding(request)
          : api.switchVmPersonalFunding({
              ...request,
              expected_funding_version: expected_funding_version!,
            }),
      );
    });
  }
}
