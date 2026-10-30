/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc gpu ...`: GPUs on your own provider account (RunPod), with the key
// connected in Settings → Connectors. Tables show a summary; --json gives
// the full provider detail.

import { createHash } from "node:crypto";
import { Command } from "commander";
import type {
  GpuAgentRequestView,
  GpuApi,
  GpuAvailabilityFilter,
  GpuCatalogResult,
  GpuPodsResult,
} from "@cocalc/conat/hub/api/gpu";
import type {
  GpuAlert,
  GpuBudgetChange,
  GpuLaunchSpec,
  GpuPodSummary,
} from "@cocalc/util/gpu/types";
import { GPU_LAUNCH_IMAGES } from "@cocalc/util/gpu/launch-spec";
import {
  adoptLaunchedKey,
  connectGpuPod,
  DEFAULT_POD_PYTHON,
  disconnectGpuPod,
  discardLaunchKey,
  newLaunchKey,
  settleLaunchKey,
  type GpuConnectDeps,
} from "../core/gpu-connect";
import {
  pinnedLaunchCommand,
  planGpuLaunch,
  templateRows,
} from "../core/gpu-template";
import { GPU_TEMPLATES, maxLaunchCostUsd } from "@cocalc/util/gpu/templates";
import {
  GPU_POD_WRITE_RPC_TIMEOUT_MS,
  GPU_READ_TIMEOUT_MS,
} from "@cocalc/util/gpu/runpod";

// A GPU read may take GPU_READ_TIMEOUT_MS on the key owner's home bay; wait a
// little longer, so the server's own deadline (and its clear error) comes
// first rather than the CLI abandoning a read that is still running.
export const GPU_CLI_RPC_TIMEOUT_MS = GPU_READ_TIMEOUT_MS + 15_000;

// Raise the context's timeouts for one GPU call, then restore them.
export async function withGpuReadTimeout<T>(
  ctx: any,
  fn: () => Promise<T>,
  timeoutMs = GPU_CLI_RPC_TIMEOUT_MS,
): Promise<T> {
  const prevTimeoutMs = ctx.timeoutMs;
  const prevRpcTimeoutMs = ctx.rpcTimeoutMs;
  ctx.timeoutMs = Math.max(prevTimeoutMs ?? 0, timeoutMs);
  ctx.rpcTimeoutMs = Math.max(prevRpcTimeoutMs ?? 0, timeoutMs);
  try {
    return await fn();
  } finally {
    ctx.timeoutMs = prevTimeoutMs;
    ctx.rpcTimeoutMs = prevRpcTimeoutMs;
  }
}

export interface GpuCommandDeps {
  withContext: any;
  // for tests: where pod keys live, and how reflect runs
  connect?: GpuConnectDeps;
}

function collect(value: string, values: string[] = []): string[] {
  for (const v of value.split(",")) {
    if (v.trim()) values.push(v.trim());
  }
  return values;
}

function positiveNumber(flag: string, integer = false) {
  return (raw: string) => {
    const n = Number(raw);
    if (!(Number.isFinite(n) && n > 0 && (!integer || Number.isInteger(n)))) {
      throw new Error(
        `${flag} must be a positive ${integer ? "integer" : "number"}`,
      );
    }
    return n;
  };
}

function isJson(ctx: any): boolean {
  return !!(ctx.globals?.json || ctx.globals?.output === "json");
}

export function catalogRows(result: GpuCatalogResult) {
  return result.catalog.gpuTypes.map((t) => ({
    id: t.id,
    name: t.name,
    memory_gb: t.memoryGb ?? null,
    secure_price: t.secure?.price ?? null,
    secure_stock: t.secure ? (t.secure.availability ?? null) : "not offered",
    community_price: t.community?.price ?? null,
    community_stock: t.community
      ? (t.community.availability ?? null)
      : "not offered",
  }));
}

export function dataCenterRows(result: GpuCatalogResult) {
  return result.catalog.dataCenters.map((dc) => ({
    id: dc.id,
    name: dc.name ?? null,
    region: dc.region ?? null,
    compliance: dc.compliance.join(","),
  }));
}

// The pods CoCalc started, with RunPod's live status where it has one.
export function managedPodRows(result: GpuPodsResult) {
  const live = new Map(result.pods.map((p) => [p.id, p]));
  return (result.records ?? []).map((r) => podRecordRow(r, live));
}

export function podRecordRow(
  r: GpuPodSummary,
  live = new Map<string, { status?: string }>(),
) {
  return {
    handle: r.handle,
    // a forced key removal left it unmanaged: it may still bill at RunPod
    state: r.unmanaged_at
      ? `${r.state} (unmanaged: may still bill at RunPod)`
      : r.state,
    status: (r.provider_pod_id && live.get(r.provider_pod_id)?.status) || null,
    gpu: r.gpu_type_id,
    count: r.gpu_count,
    cost_per_hr: r.cost_per_hr ?? null,
    cloud: r.cloud,
    deadline: r.deadline,
    pod_id: r.provider_pod_id ?? null,
    // whose money: a project's funding approval, or the key owner's own key
    paid_by: r.approval_id
      ? `the project's GPU funding (approval ${r.approval_id})`
      : `the RunPod key of account ${r.key_owner_account_id}`,
    reason: r.reason ?? null,
  };
}

export function podRows(result: GpuPodsResult) {
  return result.pods.map((p) => ({
    id: p.id,
    name: p.name ?? null,
    status: p.status ?? null,
    gpu: p.gpuTypeId ?? p.cpuFlavorId ?? null,
    count: p.gpuCount ?? null,
    cost_per_hr: p.cost ?? null,
    cloud: p.cloud ?? null,
    data_center: p.dataCenterId ?? null,
    created: p.createdAt ?? null,
  }));
}

// The project has no GPU funding approval and the caller no key of their
// own (PROJECT_FUNDING.md §5): the request is recorded and shown to the
// project's collaborators. Exit code 3, so scripts can tell it apart.
export const APPROVAL_REQUIRED_EXIT_CODE = 3;

export function approvalRequired(err: unknown): Error | undefined {
  const message = `${(err as any)?.message ?? err}`;
  if (
    (err as any)?.code !== "gpu_project_approval_required" &&
    !/approve GPU use in this project/.test(message)
  ) {
    return undefined;
  }
  return Object.assign(
    new Error(
      `${message}\nCheck with: cocalc gpu funding   (then run the same launch again)`,
    ),
    { cli_exit_code: APPROVAL_REQUIRED_EXIT_CODE },
  );
}

function isPrincipalRefusal(err: unknown): boolean {
  return /principal 'project' is not permitted|not permitted for 'gpu\./.test(
    `${(err as any)?.message ?? err}`,
  );
}

function fundingRows(state: any) {
  if (state?.approval) {
    const a = state.approval;
    const d = a.display ?? {};
    return {
      project_id: state.project_id,
      funded_by: d.funder_name ?? a.funder_account_id,
      state: a.state,
      amount_usd: d.authorized_usd ?? null,
      spent_usd: a.spend?.spent_usd ?? null,
      available_usd: a.spend?.available_usd ?? null,
      until: d.ends_at ?? null,
      agents_allowed: d.agents_allowed ?? null,
      live_pods: a.live_pods,
      approval_id: a.approval_id,
    };
  }
  if (state?.request) {
    return {
      project_id: state.project_id,
      funded_by: null,
      requested: state.request.summary,
      requested_by: state.request.actor_kind,
      requested_at: state.request.created,
      next: "A collaborator with their own RunPod key can approve GPU use at the top of the project in the browser.",
    };
  }
  return {
    project_id: state?.project_id,
    funded_by: null,
    next: "Nobody pays for GPUs in this project. A collaborator with their own RunPod key can approve GPU use in the project's settings (GPUs) in the browser.",
  };
}

export function registerGpuCommand(
  program: Command,
  deps: GpuCommandDeps,
): Command {
  const gpu = program
    .command("gpu")
    .description(
      "GPUs on your own RunPod account (connect a key in Settings → Connectors)",
    );
  const run = (
    command: Command,
    label: string,
    fn: (api: GpuApi, ctx: any) => Promise<unknown>,
    timeoutMs = GPU_CLI_RPC_TIMEOUT_MS,
  ) =>
    deps.withContext(command, `gpu ${label}`, async (ctx) =>
      withGpuReadTimeout(ctx, () => fn(ctx.hub.gpu, ctx), timeoutMs),
    );

  gpu
    .command("catalog")
    .description(
      "GPU types with list prices and stock per cloud tier (--json: full detail, including stock per data center)",
    )
    .option("--data-centers", "list data centers instead of GPU types")
    .action(async (opts, command: Command) =>
      run(command, "catalog", async (api, ctx) => {
        const result = await api.catalog({});
        if (isJson(ctx)) return result;
        return opts.dataCenters ? dataCenterRows(result) : catalogRows(result);
      }),
    );

  gpu
    .command("availability")
    .description(
      "where each GPU type is in stock now: one row per GPU type, cloud and data center, cheapest first",
    )
    .option(
      "--gpu <id-or-name>",
      "GPU type id or name (repeatable or comma-separated)",
      collect,
    )
    .option("--cloud <cloud>", "SECURE or COMMUNITY")
    .option(
      "--data-center <id>",
      "data center id, e.g. US-TX-3 (repeatable)",
      collect,
    )
    .option(
      "--region <region>",
      "e.g. NORTH_AMERICA, EUROPE (repeatable)",
      collect,
    )
    .option("--min-stock <level>", "LOW, MEDIUM or HIGH")
    .option(
      "--max-price <usd>",
      "maximum list price per GPU-hour",
      positiveNumber("--max-price"),
    )
    .option(
      "--min-count <n>",
      "GPU types allowing at least this many GPUs on one pod",
      positiveNumber("--min-count", true),
    )
    .action(async (opts, command: Command) =>
      run(command, "availability", async (api, ctx) => {
        const filter: GpuAvailabilityFilter = {};
        if (opts.gpu) filter.gpu = opts.gpu;
        if (opts.cloud) filter.cloud = `${opts.cloud}`.toUpperCase() as any;
        if (opts.dataCenter) filter.data_center = opts.dataCenter;
        if (opts.region) filter.region = opts.region;
        if (opts.minStock) {
          filter.min_stock = `${opts.minStock}`.toUpperCase() as any;
        }
        if (opts.maxPrice != null)
          filter.max_price_per_gpu_hour = opts.maxPrice;
        if (opts.minCount != null) filter.min_count = opts.minCount;
        const result = await api.availability(filter);
        return isJson(ctx) ? result : result.offers;
      }),
    );

  gpu
    .command("pods")
    .description(
      "the pods CoCalc started for you (--id: one pod read live, with SSH endpoints and utilization; --all: every pod in your RunPod account)",
    )
    .option("--id <pod>", "one pod: its handle or RunPod pod id")
    .option("--ended", "also pods that ended in the last 30 days")
    .option(
      "--all",
      "every pod in your RunPod account, including ones CoCalc didn't start",
    )
    .action(async (opts, command: Command) =>
      run(command, "pods", async (api, ctx) => {
        const result = await api.pods({
          ...(opts.id ? { pod_id: opts.id } : {}),
          ...(opts.all ? { scope: "account" as const } : {}),
          ...(opts.ended ? { include_ended: true } : {}),
        });
        if (isJson(ctx)) return result;
        if (opts.all) {
          if (opts.id) {
            if (result.pods.length === 0) throw new Error("no such pod");
            return result.pods[0];
          }
          return podRows(result);
        }
        if (opts.id) {
          const record = result.records?.[0];
          if (!record) throw new Error("no such pod");
          return { ...record, live: result.pods[0] ?? null };
        }
        return managedPodRows(result);
      }),
    );

  gpu
    .command("templates")
    .description(
      "built-in launch templates (cocalc gpu launch --template <id>): image, runtime, GPU memory, and whether they set up SSH and a Jupyter kernel",
    )
    .action(async (_opts, command: Command) =>
      run(command, "templates", async (_api, ctx) =>
        isJson(ctx) ? GPU_TEMPLATES : templateRows(),
      ),
    );

  gpu
    .command("launch")
    .description(
      "start a pod on your RunPod key; it is terminated after --max-runtime minutes at the latest (once budgets land; until then, terminate it yourself)",
    )
    .option(
      "--template <id>",
      "start from a built-in template (cocalc gpu templates); other options override it",
    )
    .option(
      "--gpu <id>",
      'GPU type id, e.g. "NVIDIA GeForce RTX 4090" (with --template: default the cheapest in stock with enough memory)',
    )
    .option(
      "--max-runtime <minutes>",
      "maximum runtime in minutes (5 to 1440; with --template: the template's)",
      positiveNumber("--max-runtime", true),
    )
    .option(
      "--dry-run",
      "show the spec, the GPU offer and the most it can cost (GPUs and disk at list price for the whole max runtime), without launching",
    )
    .option(
      "--max-cost <usd>",
      "refuse the launch if it could cost more than this (GPUs and disk at list price for the whole max runtime), e.g. the amount a dry run showed",
      positiveNumber("--max-cost"),
    )
    .option(
      "--no-connect",
      "with a kernel template: don't wait for the pod and set up its kernel (run cocalc gpu connect later)",
    )
    .option(
      "--wait <seconds>",
      "with a kernel template: how long to wait for the pod to register (default 300)",
      positiveNumber("--wait", true),
    )
    .option(
      "--project <project-id>",
      "the project it is for (default: this project)",
    )
    .option(
      "--count <n>",
      "GPUs on the pod (default 1)",
      positiveNumber("--count", true),
    )
    .option("--cloud <cloud>", "SECURE (default) or COMMUNITY")
    .option("--data-center <id>", "data center id, e.g. US-TX-3")
    .option("--image <image>", "container image (one of the allowed images)")
    .option(
      "--disk <gb>",
      "container disk in GB (default 20)",
      positiveNumber("--disk", true),
    )
    .option(
      "--volume <gb>",
      "persistent volume at /workspace, in GB",
      positiveNumber("--volume", true),
    )
    .option(
      "--port <port>",
      'exposed port, e.g. "8888/http" (repeatable)',
      collect,
    )
    .option(
      "--env <NAME=value>",
      "non-secret environment variable (repeatable)",
      (v: string, a: string[] = []) => [...a, v],
    )
    .option(
      "--ssh",
      "make the pod's SSH key here, so `cocalc gpu connect` can reach it from this project",
    )
    .option("--ssh-public-key <key>", "the pod's own ssh-ed25519 public key")
    .option(
      "--operation <id>",
      "for agents: this launch's id, the same when it is run again after your human approved it (default: derived from the launch)",
    )
    .option(
      "--own-key",
      "pay with your own RunPod key even when the project has a GPU funding approval",
    )
    .action(async (opts, command: Command) =>
      run(
        command,
        "launch",
        async (api, ctx) => {
          const project_id = opts.project ?? process.env.COCALC_PROJECT_ID;
          if (!project_id) {
            throw new Error("--project is required outside a project");
          }
          if (opts.sshPublicKey && (opts.ssh || opts.template)) {
            throw new Error(
              "--ssh-public-key can't be combined with --ssh or --template, which make the pod's key here",
            );
          }
          let plan: Awaited<ReturnType<typeof planGpuLaunch>>;
          try {
            plan = await planGpuLaunch(api, {
              template: opts.template,
              spec: explicitSpecFromOptions(opts),
              price: !!opts.dryRun,
              max_cost_usd: opts.maxCost,
            });
          } catch (err) {
            // the project's own credential can launch, not browse prices
            if (isPrincipalRefusal(err)) {
              throw new Error(
                "From a project terminal, give the GPU with --gpu (see the project's GPU funding with `cocalc gpu funding`); --dry-run and --max-cost need a signed-in account.",
              );
            }
            throw err;
          }
          const spec = plan.spec;
          const ssh = !!opts.ssh || !!plan.template?.ssh;
          const kernel = !!plan.template?.kernel && opts.connect !== false;
          if (opts.dryRun) {
            return {
              dry_run: true,
              template: plan.template?.id ?? null,
              spec,
              ssh,
              kernel,
              offer: plan.offer ?? null,
              max_cost_usd: plan.max_cost_usd ?? null,
              // the same GPU, held to this bound
              next:
                pinnedLaunchCommand(plan, {
                  project_id,
                  template: opts.template,
                  ssh: !!opts.ssh,
                  connect: opts.connect,
                  wait: opts.wait,
                }) ?? null,
            };
          }
          // The private key stays here; the launch gets only the public key.
          const key = ssh ? await newLaunchKey(deps.connect) : undefined;
          if (key) spec.ssh_public_key = key.publicKey;
          let pod: Awaited<ReturnType<typeof api.launch>>;
          try {
            pod = await api.launch({
              project_id,
              spec,
              operation_id: opts.operation ?? launchOperationId(spec),
              ...(opts.ownKey ? { own_key: true } : {}),
            });
          } catch (err) {
            // Kept without an answer (`connect` adopts it by fingerprint if
            // the pod was made after all); otherwise adopted or removed.
            if (key) await settleLaunchKey(api, key, err, deps.connect);
            throw approvalRequired(err) ?? err;
          }
          if (key) {
            if (pod.state === "failed") {
              await discardLaunchKey(key, deps.connect);
            } else {
              await adoptLaunchedKey(key, pod.handle, deps.connect);
            }
          }
          // The price was checked before the launch; RunPod's actual rate is
          // known only now. Above --max-cost, or if it can't be verified, the
          // pod goes at once.
          if (opts.maxCost != null && pod.state !== "failed") {
            const raw = `${pod.cost_per_hr ?? ""}`.trim();
            const hourly = raw === "" ? NaN : Number(raw);
            const verified = Number.isFinite(hourly) && hourly >= 0;
            const bound = verified
              ? maxLaunchCostUsd({
                  price_per_gpu_hour: hourly / spec.gpu_count,
                  gpu_count: spec.gpu_count,
                  max_runtime_minutes: spec.max_runtime_minutes,
                  container_disk_gb: spec.container_disk_gb ?? 0,
                  volume_gb: spec.volume_gb ?? 0,
                })
              : undefined;
            if (bound == null || bound > opts.maxCost) {
              const cap = `--max-cost $${opts.maxCost.toFixed(2)}`;
              const why = verified
                ? `RunPod billed ${pod.handle} at $${hourly}/h, so it could cost up to $${bound!.toFixed(2)}, more than ${cap}`
                : `RunPod didn't report a billed rate for ${pod.handle}, so it can't be held to ${cap}`;
              let ended: string;
              try {
                await api.terminate({ pod_id: pod.handle });
                ended = "it was terminated";
              } catch {
                ended = `terminating it failed: run cocalc gpu terminate ${pod.handle}`;
              }
              // Only after RunPod was asked: forgetting it here is best effort.
              if (key && ended === "it was terminated") {
                try {
                  await disconnectGpuPod(pod.handle, deps.connect);
                } catch {}
              }
              throw new Error(`${why}; ${ended}.`);
            }
          }
          const shown: Record<string, unknown> = isJson(ctx)
            ? { ...pod }
            : podRecordRow(pod);
          if (plan.max_cost_usd != null) shown.max_cost_usd = plan.max_cost_usd;
          if (!kernel || !key || pod.state === "failed") return shown;
          // The pod bills from now on: a connect failure is reported, not
          // thrown, so the pod's handle is never lost.
          try {
            shown.connect = await connectGpuPod(
              api,
              pod.handle,
              { waitSeconds: opts.wait },
              deps.connect,
            );
          } catch (err) {
            shown.connect_error = `${(err as Error)?.message ?? err}`;
            shown.next = `cocalc gpu connect ${pod.handle}   (or cocalc gpu terminate ${pod.handle})`;
          }
          return shown;
        },
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  gpu
    .command("terminate <pod>")
    .description(
      "terminate a pod CoCalc started (its handle or RunPod pod id); this ends its billing, including storage",
    )
    .action(async (pod: string, _opts, command: Command) =>
      run(
        command,
        "terminate",
        async (api) => {
          const result = await api.terminate({ pod_id: pod });
          // Forget its kernel and SSH alias here too, if this project had
          // them. The pod is gone either way, so this never fails the command.
          try {
            const { handle, ssh_key_fingerprint } = await api.sshInfo({
              pod_id: pod,
            });
            await disconnectGpuPod(handle, deps.connect, ssh_key_fingerprint);
          } catch {}
          return result;
        },
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  gpu
    .command("connect <pod>")
    .description(
      "reach a pod launched from this project with --ssh: once it has registered its SSH host key, write the ssh alias (the pod's handle) with that key pinned, and register a remote Jupyter kernel on it",
    )
    .option(
      "--wait <seconds>",
      "how long to wait for the pod to register its host key (default 300)",
      positiveNumber("--wait", true),
    )
    .option("--no-kernel", "only write the ssh alias")
    .option(
      "--python <path>",
      `the pod's Python for the kernel (default ${DEFAULT_POD_PYTHON})`,
    )
    .action(async (pod: string, opts, command: Command) =>
      run(
        command,
        "connect",
        async (api) =>
          await connectGpuPod(
            api,
            pod,
            {
              waitSeconds: opts.wait,
              kernel: opts.kernel,
              python: opts.python,
            },
            deps.connect,
          ),
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  const budget = gpu
    .command("budget")
    .description(
      "your RunPod key's GPU budget: money and limits CoCalc enforces before every launch",
    )
    .action(async (_opts, command: Command) =>
      run(command, "budget", async (api) => await api.budget({})),
    );

  budget
    .command("set")
    .description(
      'change the budget; "none" removes a limit. Lowering works here; raising needs you to sign in again, from Settings in the browser',
    )
    .option("--authorized <usd>", "the total CoCalc may let the key spend")
    .option("--max-hourly <usd|none>", "all pods together, per hour")
    .option("--max-pods <n|none>", "pods at once")
    .option("--max-gpus <n|none>", "GPUs at once")
    .option("--max-runtime <minutes|none>", "per pod")
    .option("--ends <iso-time>", "when the budget stops admitting launches")
    .option("--expected-version <n>", "fail if the budget changed meanwhile")
    .action(async (opts, command: Command) =>
      run(command, "budget set", async (api) => {
        const change = budgetChangeFromOptions(opts);
        return await api.setBudget({
          change,
          ...(opts.expectedVersion != null
            ? { expected_version: Number(opts.expectedVersion) }
            : {}),
        });
      }),
    );

  gpu
    .command("kill")
    .description(
      "the kill switch: terminate every pod CoCalc started with your RunPod key and pause new launches until gpu resume (--no-pause to not); with --project, only that project's pods, without pausing",
    )
    .option("--project <project-id>", "only this project's pods")
    .option(
      "--no-pause",
      "don't pause new launches (the account kill switch pauses by default)",
    )
    .action(async (opts, command: Command) =>
      run(
        command,
        "kill",
        async (api) =>
          await api.killSwitch({
            ...(opts.project ? { project_id: opts.project } : {}),
            ...(opts.project ? {} : { pause: opts.pause !== false }),
          }),
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  gpu
    .command("report-compromised")
    .description(
      "report your RunPod key stolen: CoCalc stops using it and terminates EVERY pod in that RunPod account (including ones it didn't start), and keeps doing so every minute until you delete the key on RunPod's Credentials page; then it removes its copy and asks you to check RunPod's Pods page once, for pods started after its last look (if pods it launched are still left once RunPod rejects the key, follow the returned warning: terminate them at RunPod, then remove the key with \"Remove anyway\"). Needs --confirm-cocalc-only, and you to sign in again (from Settings in the browser)",
    )
    .option(
      "--confirm-cocalc-only",
      "confirm the RunPod account is used only for CoCalc",
    )
    .action(async (opts, command: Command) =>
      run(
        command,
        "report-compromised",
        async (api) =>
          await api.reportCompromised({
            confirm_cocalc_only: opts.confirmCocalcOnly === true,
          }),
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  gpu
    .command("resume")
    .description(
      "lift the pause on new launches (the kill switch's, or the one an alert raised: see gpu alerts first); needs you to sign in again, from Settings in the browser",
    )
    .action(async (_opts, command: Command) =>
      run(command, "resume", async (api) => await api.resume({})),
    );

  gpu
    .command("account-checks")
    .description(
      "compare your RunPod account's own spend rate and balance with the pods CoCalc runs, and alert (and pause new launches, for a large difference) when RunPod spends much more. Only for a RunPod account used only by you, only for CoCalc: --confirm says so for the connected key, --withdraw turns the checks off (both need you to sign in again, from Settings in the browser). Without either, shows whether the checks are on",
    )
    .option(
      "--confirm",
      "confirm the connected key's RunPod account is used only by you, only for CoCalc",
    )
    .option("--withdraw", "withdraw that confirmation (the checks stop)")
    .action(async (opts, command: Command) =>
      run(command, "account-checks", async (api) => {
        if (opts.confirm && opts.withdraw) {
          throw Error("Give --confirm or --withdraw, not both.");
        }
        if (opts.confirm || opts.withdraw) {
          return await api.confirmAccountChecks({
            confirm: opts.confirm === true,
          });
        }
        return await api.accountChecks({});
      }),
    );

  const alerts = gpu
    .command("alerts")
    .description(
      "what CoCalc found on your RunPod account that needs you (a pod it didn't start, a key RunPod rejects, a held budget, ...); each says what to do",
    )
    .option("--all", "also recently resolved alerts")
    .action(async (opts, command: Command) =>
      run(command, "alerts", async (api, ctx) => {
        const result = await api.alerts({
          ...(opts.all ? { include_resolved: true } : {}),
        });
        if (isJson(ctx)) return result;
        return result.map(alertRow);
      }),
    );
  alerts
    .command("ack <id>")
    .description(
      "acknowledge an alert only you can end (acknowledgeable: yes), once you've done what it says",
    )
    .action(async (id: string, _opts, command: Command) =>
      run(command, "alerts ack", async (api, ctx) => {
        const result = await api.acknowledgeAlert({ id });
        return isJson(ctx) ? result : alertRow(result);
      }),
    );

  gpu
    .command("release-quarantined <pod>")
    .description(
      "release the budget held for a pod CoCalc couldn't confirm RunPod created (or that a forced key removal left unmanaged), once you've checked at RunPod that it doesn't exist or terminated it; needs you to sign in again, from Settings in the browser",
    )
    .action(async (pod: string, _opts, command: Command) =>
      run(
        command,
        "release-quarantined",
        async (api) => await api.releaseQuarantined({ pod_id: pod }),
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  gpu
    .command("who <query>")
    .description(
      "who is responsible for a pod, and what was done to it: a handle, RunPod pod id or IP address",
    )
    .action(async (query: string, _opts, command: Command) =>
      run(command, "who", async (api, ctx) => {
        const result = await api.who({ query });
        if (isJson(ctx)) return result;
        return result.map(({ pod, events }) => ({
          ...podRecordRow(pod),
          beneficiary: pod.beneficiary_account_id,
          key_owner: pod.key_owner_account_id,
          project: pod.project_id ?? null,
          events: events
            .map((e) => `${e.at} ${e.actor_kind} ${e.action}`)
            .join("; "),
        }));
      }),
    );

  const funding = gpu
    .command("funding")
    .description(
      "who pays for GPUs in a project: a collaborator's approval, paid by their own RunPod account (with no subcommand: this project's)",
    )
    .option("--project <project-id>", "the project (default: this project)")
    .action(async (opts, command: Command) =>
      run(command, "funding", async (api, ctx) => {
        const project_id = opts.project ?? process.env.COCALC_PROJECT_ID;
        if (!project_id)
          throw new Error("--project is required outside a project");
        const state = await api.projectFunding({ project_id });
        return isJson(ctx) ? state : fundingRows(state);
      }),
    );

  funding
    .command("pods")
    .description(
      "the GPUs a project's funding approvals pay for (live, and ended within a day)",
    )
    .option("--project <project-id>", "the project (default: this project)")
    .option("--cursor <cursor>", "the next page, from a previous answer")
    .action(async (opts, command: Command) =>
      run(command, "funding pods", async (api, ctx) => {
        const project_id = opts.project ?? process.env.COCALC_PROJECT_ID;
        if (!project_id)
          throw new Error("--project is required outside a project");
        const page = await api.projectPods({
          project_id,
          ...(opts.cursor ? { cursor: opts.cursor } : {}),
        });
        if (isJson(ctx)) return page;
        if (page.incomplete.length > 0 || page.next_cursor) {
          return {
            pods: page.pods.map((p) => podRecordRow(p)),
            incomplete: page.incomplete,
            next_cursor: page.next_cursor ?? null,
          };
        }
        return page.pods.map((p) => podRecordRow(p));
      }),
    );

  funding
    .command("terminate <pod>")
    .description(
      "terminate one of the GPUs the project's funding pays for (CoCalc ends it within a minute or two)",
    )
    .option("--project <project-id>", "the project (default: this project)")
    .action(async (pod: string, opts, command: Command) =>
      run(command, "funding terminate", async (api) => {
        const project_id = opts.project ?? process.env.COCALC_PROJECT_ID;
        if (!project_id)
          throw new Error("--project is required outside a project");
        const r = await api.projectTerminate({ project_id, pod_id: pod });
        if (!r.found)
          throw new Error(`no GPU ${pod} is paid for in this project`);
        return r;
      }),
    );

  funding
    .command("list")
    .description(
      "the projects whose GPU use you approved (your RunPod key pays)",
    )
    .action(async (_opts, command: Command) =>
      run(command, "funding list", async (api, ctx) => {
        const result = await api.fundedProjects({});
        if (isJson(ctx) || !result.history_truncated) {
          return isJson(ctx) ? result : result.approvals;
        }
        return {
          approvals: result.approvals,
          note: "Every active approval is listed; older ended ones are not.",
        };
      }),
    );

  funding
    .command("lower <approval-id>")
    .description(
      "lower an approval you gave (raising it needs you to sign in again, in the browser)",
    )
    .option("--amount <usd>", "the new amount", positiveNumber("--amount"))
    .option("--no-agents", "agents in the project may no longer use it")
    .action(async (approvalId: string, opts, command: Command) =>
      run(command, "funding lower", async (api) => {
        const change: Record<string, unknown> = {};
        if (opts.amount != null) change.authorized_usd = opts.amount.toFixed(2);
        if (opts.agents === false) change.agents_allowed = false;
        if (Object.keys(change).length === 0) {
          throw new Error("give --amount and/or --no-agents");
        }
        // the server refuses any raise in this mode, fresh sign-in or not
        return await api.changeProjectFunding({
          approval_id: approvalId,
          change,
          narrow_only: true,
        });
      }),
    );

  funding
    .command("end <approval-id>")
    .description(
      "end an approval you gave: no new GPU in that project on your account, and CoCalc terminates the GPUs it paid for",
    )
    .action(async (approvalId: string, _opts, command: Command) =>
      run(command, "funding end", async (api) =>
        api.revokeProjectFunding({ approval_id: approvalId }),
      ),
    );

  const agent = gpu
    .command("agent")
    .description(
      "agents' GPU launches: an agent may launch only what you approved, once; review its requests here",
    );

  agent
    .command("requests")
    .description(
      "what agents asked to launch on your key (pending, unless --all), with the exact launch and its hash",
    )
    .option("--all", "also approved, superseded and expired requests")
    .option("--project <project-id>", "only this project's")
    .action(async (opts, command: Command) =>
      run(command, "agent requests", async (api, ctx) => {
        const views = await api.agentRequests({
          ...(opts.project ? { project_id: opts.project } : {}),
          include_decided: !!opts.all,
        });
        if (isJson(ctx)) return views;
        return views.map(agentRequestRow);
      }),
    );

  agent
    .command("approve <request-id>")
    .description(
      "approve exactly one reviewed request: one launch, by that agent run, until its run ends. Needs a fresh sign-in, so it works only where CoCalc can verify one",
    )
    .requiredOption(
      "--hash <payload-hash>",
      "the request's payload hash, as `cocalc gpu agent requests` showed it: the approval fails if the request isn't exactly that",
    )
    .action(async (request_id: string, opts, command: Command) =>
      run(
        command,
        "agent approve",
        async (api) =>
          await api.approveAgentRequest({
            request_id,
            expected_hash: opts.hash,
          }),
      ),
    );

  agent
    .command("deny <request-id>")
    .description(
      "decline a pending request: nothing is approved, and the agent has to ask again",
    )
    .action(async (request_id: string, _opts, command: Command) =>
      run(
        command,
        "agent deny",
        async (api) => await api.denyAgentRequest({ request_id }),
      ),
    );

  agent
    .command("revoke <grant-id>")
    .description(
      "revoke an approval: no new launch, and the pods it launched are terminated",
    )
    .action(async (grant_id: string, _opts, command: Command) =>
      run(
        command,
        "agent revoke",
        async (api) => await api.revokeAgentGrant({ grant_id }),
        GPU_POD_WRITE_RPC_TIMEOUT_MS,
      ),
    );

  return gpu;
}

export function alertRow(a: GpuAlert) {
  return {
    id: a.id,
    severity: a.severity,
    kind: a.kind,
    opened: a.opened,
    last_seen: a.last_seen,
    resolved: a.resolved_at ?? null,
    acknowledgeable: a.acknowledgeable ? "yes" : "no",
    pod:
      (a.details?.provider_pod_id as string | undefined) ??
      (a.details?.handle as string | undefined) ??
      null,
    message: a.message,
  };
}

// The same launch gets the same id, so an agent that asked for approval and
// runs the identical command again uses the grant. The pod's SSH key, new
// on every run, isn't part of it.
export function launchOperationId(spec: GpuLaunchSpec): string {
  const { ssh_public_key: _, ...rest } = spec;
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v != null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sorted((v as any)[k])]),
          )
        : v;
  return `cli-${createHash("sha256")
    .update(JSON.stringify(sorted(rest)))
    .digest("hex")
    .slice(0, 32)}`;
}

export function agentRequestRow(v: GpuAgentRequestView) {
  const { spec } = v.payload;
  return {
    request: v.request_id,
    state: v.grant ? `${v.state} (grant ${v.grant.state})` : v.state,
    // a project agent token is one chat session, not a named agent
    agent:
      v.principal_kind === "chat_session"
        ? "this chat session"
        : `agent ${v.agent_id ?? "?"}`,
    project: v.project_id,
    gpu: `${spec.gpu_count ?? 1} x ${spec.gpu_type_id}`,
    cloud: spec.cloud ?? "SECURE",
    max_runtime: spec.max_runtime_minutes,
    hourly_usd: v.payload.hourly_usd,
    max_cost_usd: v.payload.max_cost_usd,
    hash: v.payload_hash,
    grant: v.grant?.grant_id ?? null,
    expires: v.grant?.expires_at ?? v.expires_at,
  };
}

// The CLI's options as a launch spec; the server checks it against the
// allowlist.
export function launchSpecFromOptions(opts: any): GpuLaunchSpec {
  return {
    gpu_count: 1,
    image: GPU_LAUNCH_IMAGES[0],
    ...explicitSpecFromOptions(opts),
  } as GpuLaunchSpec;
}

// Only the options given, so a template's values stay where none was.
export function explicitSpecFromOptions(opts: any): Partial<GpuLaunchSpec> {
  const spec: Partial<GpuLaunchSpec> = {};
  if (opts.gpu) spec.gpu_type_id = opts.gpu;
  if (opts.count != null) spec.gpu_count = opts.count;
  if (opts.image) spec.image = opts.image;
  if (opts.maxRuntime != null) spec.max_runtime_minutes = opts.maxRuntime;
  if (opts.cloud) spec.cloud = `${opts.cloud}`.toUpperCase() as any;
  if (opts.dataCenter) spec.data_center_id = opts.dataCenter;
  if (opts.disk != null) spec.container_disk_gb = opts.disk;
  if (opts.volume != null) spec.volume_gb = opts.volume;
  if (opts.port) spec.ports = opts.port;
  if (opts.env) {
    spec.env = {};
    for (const kv of opts.env as string[]) {
      const i = kv.indexOf("=");
      if (i <= 0) throw new Error(`--env must be NAME=value, not ${kv}`);
      spec.env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  if (opts.sshPublicKey) spec.ssh_public_key = opts.sshPublicKey;
  return spec;
}

// "none" removes a limit; numbers are checked again by the server.
export function budgetChangeFromOptions(opts: any): GpuBudgetChange {
  const change: GpuBudgetChange = {};
  const count = (flag: string, v: string): number | null => {
    if (`${v}`.toLowerCase() === "none") return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`${flag} must be a whole number or none`);
    }
    return n;
  };
  if (opts.authorized != null) change.authorized_usd = `${opts.authorized}`;
  if (opts.maxHourly != null) {
    change.max_hourly_usd =
      `${opts.maxHourly}`.toLowerCase() === "none" ? null : `${opts.maxHourly}`;
  }
  if (opts.maxPods != null)
    change.max_concurrent_pods = count("--max-pods", opts.maxPods);
  if (opts.maxGpus != null)
    change.max_gpu_count = count("--max-gpus", opts.maxGpus);
  if (opts.maxRuntime != null)
    change.max_runtime_minutes = count("--max-runtime", opts.maxRuntime);
  if (opts.ends != null) change.ends_at = `${opts.ends}`;
  if (Object.keys(change).length === 0) {
    throw new Error("give at least one limit to change");
  }
  return change;
}
