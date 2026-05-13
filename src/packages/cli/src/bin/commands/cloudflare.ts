import { Command } from "commander";

export type CloudflareCommandDeps = {
  withContext: any;
};

function summarizePlan(plan: any) {
  const summary = plan.summary ?? {};
  return {
    plan_id: plan.id ?? summary.plan_id,
    status: plan.status ?? summary.status,
    include_r2: plan.include_r2 ?? summary.include_r2,
    expires_at: plan.expires_at ?? summary.expires_at,
    cloudflare_account_id: plan.cloudflare_account_id,
    zone: plan.zone_name
      ? `${plan.zone_name}${plan.zone_id ? ` (${plan.zone_id})` : ""}`
      : (plan.zone_id ?? ""),
    selected_tunnels: summary.selected?.tunnels ?? 0,
    selected_dns_records: summary.selected?.dns_records ?? 0,
    selected_r2_buckets: summary.selected?.r2_buckets ?? 0,
    active_projects: summary.counts?.active_projects ?? 0,
    archived_project_candidates:
      summary.counts?.archived_project_candidates ?? 0,
    projects_with_backups: summary.counts?.projects_with_backups ?? 0,
    r2_bucket_records: summary.counts?.r2_bucket_records ?? 0,
    cloudflare_r2_buckets: summary.counts?.cloudflare_r2_buckets ?? 0,
    confirmation_text: plan.confirmation_text ?? summary.confirmation_text,
    warnings: (summary.warnings ?? []).join(" "),
    notes: (summary.notes ?? []).join(" "),
  };
}

function summarizeResources(plan: any) {
  const resources = plan.plan_json?.resources ?? [];
  return resources.map((resource: any) => ({
    kind: resource.kind,
    classification: resource.classification,
    id: resource.id ?? "",
    name: resource.name ?? "",
    reason: resource.reason ?? "",
  }));
}

export function registerCloudflareCommand(
  program: Command,
  deps: CloudflareCommandDeps,
) {
  const cloudflare = program
    .command("cloudflare")
    .description("Cloudflare setup, audit, and teardown helpers");

  const teardown = cloudflare
    .command("teardown")
    .description("Plan Cloudflare resource teardown");

  teardown
    .command("plan")
    .description("Create a read-only Cloudflare teardown plan")
    .option(
      "--include-r2",
      "Include R2 bucket discovery in the read-only plan; no deletion is performed",
    )
    .action(async (options, command) => {
      await deps.withContext(
        command,
        "cloudflare teardown plan",
        async (ctx) => {
          const plan = await ctx.hub.system.createCloudflareTeardownPlan({
            include_r2: !!options.includeR2,
          });
          return summarizePlan(plan);
        },
      );
    });

  teardown
    .command("review <plan-id>")
    .description("Review a saved Cloudflare teardown plan")
    .option(
      "--resources",
      "Show resource classification rows instead of summary",
    )
    .action(async (planId, options, command) => {
      await deps.withContext(
        command,
        "cloudflare teardown review",
        async (ctx) => {
          const plan = await ctx.hub.system.getCloudflareTeardownPlan({
            plan_id: planId,
          });
          return options.resources
            ? summarizeResources(plan)
            : summarizePlan(plan);
        },
      );
    });
}
