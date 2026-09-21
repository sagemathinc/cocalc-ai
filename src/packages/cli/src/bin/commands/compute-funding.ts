import { readFileSync } from "node:fs";
import { Command } from "commander";
import type {
  ComputeFundingApi,
  CourseFundingDraft,
  CourseFundingPoolChangeDraft,
} from "@cocalc/conat/hub/api/compute-funding";
import { fundingId } from "@cocalc/util/compute-funding";

export interface ComputeFundingCommandDeps {
  withContext: any;
  readTerms?: (path: string) => string;
}

export function registerComputeFundingCommand(
  program: Command,
  deps: ComputeFundingCommandDeps,
) {
  const root = program
    .command("computeFunding")
    .alias("compute-funding")
    .description(
      "course compute funding summaries, previews, and browser-approved proposals",
    );
  const run = (
    command: Command,
    label: string,
    fn: (api: ComputeFundingApi) => Promise<unknown>,
  ) =>
    deps.withContext(command, `computeFunding ${label}`, async (ctx) => {
      const user = ctx.remote?.user;
      if (
        user?.project_id ||
        user?.auth_project_id ||
        user?.host_id ||
        user?.auth_host_id ||
        user?.auth_actor === "agent"
      )
        throw Object.assign(
          Error("Course funding requires account authentication."),
          { code: "account_auth_required" },
        );
      return await fn(ctx.hub.computeFunding);
    });
  const readTerms = (path: string) => {
    const text = (
      deps.readTerms ??
      ((name) => readFileSync(name === "-" ? 0 : name, "utf8"))
    )(path);
    if (Buffer.byteLength(text) > 1_000_000)
      throw Error("Funding terms exceed 1 MB.");
    const terms = JSON.parse(text);
    if (!terms || typeof terms !== "object" || Array.isArray(terms))
      throw Error("Funding terms must be a JSON object.");
    return terms;
  };
  root
    .command("audit")
    .description(
      "administrator read-only reconciliation report on the payer's authoritative bay",
    )
    .requiredOption("--payer <uuid>")
    .requiredOption(
      "--bay <id>",
      "explicit authoritative bay; connect the CLI to that bay",
    )
    .action(async (opts, command: Command) =>
      run(command, "audit", (api) =>
        api.audit({
          payer_account_id: fundingId(opts.payer, "Payer"),
          bay_id: opts.bay,
        }),
      ),
    );
  root
    .command("summary")
    .requiredOption("--course-project <uuid>")
    .requiredOption("--course-instance <uuid>")
    .action(async (opts, command: Command) =>
      run(command, "summary", (api) =>
        api.getCourseSummary({
          course_project_id: fundingId(opts.courseProject, "Course project"),
          course_instance_id: fundingId(opts.courseInstance, "Course instance"),
        }),
      ),
    );
  root
    .command("sources")
    .description(
      "list all authoritative funding sources for the authenticated beneficiary",
    )
    .option(
      "--include-inactive",
      "include exhausted, expired, revoked and closed funding history",
    )
    .action(async (opts, command: Command) =>
      run(command, "sources", (api) =>
        opts.includeInactive
          ? api.listSources({ include_inactive: true })
          : api.listSources(),
      ),
    );
  root
    .command("status <intent_id>")
    .description("read allocation or pool-change approval status")
    .action(async (id: string, _opts, command: Command) =>
      run(command, "status", (api) =>
        api.getAllocationStatus({ intent_id: fundingId(id, "Intent") }),
      ),
    );
  for (const kind of ["allocation", "change"] as const) {
    root
      .command(`preview-${kind}`)
      .requiredOption("--terms <file>", "JSON terms file, or - for stdin")
      .action(async (opts, command: Command) => {
        const terms = readTerms(opts.terms);
        return run(command, `preview-${kind}`, (api) =>
          kind === "allocation"
            ? api.previewAllocation({ terms: terms as CourseFundingDraft })
            : api.previewPoolChange({
                terms: terms as CourseFundingPoolChangeDraft,
              }),
        );
      });
    root
      .command(`propose-${kind}`)
      .description(
        "create an intent; financial authorization happens only at the returned approval URL",
      )
      .requiredOption("--terms <file>", "JSON terms file, or - for stdin")
      .requiredOption(
        "--operation <uuid>",
        "stable operation UUID; reuse only for retries of identical terms",
      )
      .action(async (opts, command: Command) => {
        const terms = readTerms(opts.terms),
          operation_id = fundingId(opts.operation, "Operation");
        return run(command, `propose-${kind}`, (api) =>
          kind === "allocation"
            ? api.proposeAllocation({
                operation_id,
                terms: terms as CourseFundingDraft,
              })
            : api.proposePoolChange({
                operation_id,
                terms: terms as CourseFundingPoolChangeDraft,
              }),
        );
      });
  }
}
