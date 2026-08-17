#!/usr/bin/env node
/*
 * Read-only abuse triage for the standard production health check.
 *
 * Control-plane rules run through audited admin SQL. Filesystem rules inspect
 * only recent top-level file metadata on site-funded hosts; they never read
 * file contents. Detection and containment are intentionally separate.
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(scriptDir, "../..");
const repoCli = resolve(srcRoot, "packages/cli/dist/bin/cocalc.js");
const execFileAsync = promisify(execFile);

const useRepoCli = existsSync(repoCli);
const DEFAULT_NODE = useRepoCli
  ? process.execPath
  : existsSync("/opt/cocalc/bin/node")
    ? "/opt/cocalc/bin/node"
    : process.execPath;
const DEFAULT_CLI = useRepoCli ? repoCli : "/opt/cocalc/bin2/cocalc-cli.js";

function positiveInteger(value, name, fallback, max) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

export function parseArgs(argv) {
  const opts = {
    api: "https://cocalc.ai",
    profile: "prod",
    node: process.env.COCALC_NODE || DEFAULT_NODE,
    cli: process.env.COCALC_CLI || DEFAULT_CLI,
    hours: 24,
    minAccounts: 3,
    minFingerprintProjects: 3,
    hostConcurrency: 4,
    skipFiles: false,
    json: false,
    bays: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value == null) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === "--api") opts.api = next();
    else if (arg === "--profile") opts.profile = next();
    else if (arg === "--node") opts.node = next();
    else if (arg === "--cli") opts.cli = next();
    else if (arg === "--bay") opts.bays.push(next());
    else if (arg === "--hours") {
      opts.hours = positiveInteger(next(), "--hours", 24, 30 * 24);
    } else if (arg === "--min-accounts") {
      opts.minAccounts = positiveInteger(next(), "--min-accounts", 3, 100);
    } else if (arg === "--min-fingerprint-projects") {
      opts.minFingerprintProjects = positiveInteger(
        next(),
        "--min-fingerprint-projects",
        3,
        100,
      );
    } else if (arg === "--host-concurrency") {
      opts.hostConcurrency = positiveInteger(
        next(),
        "--host-concurrency",
        4,
        16,
      );
    } else if (arg === "--skip-files") opts.skipFiles = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

function help() {
  return `Usage: node src/scripts/ops/abuse-health-scan.mjs [options]

Read-only abuse signals for the standard cluster health check.

Options:
  --api <url>                         site API (default: https://cocalc.ai)
  --profile <name>                    CLI auth profile (default: prod)
  --bay <id>                          scan one bay; repeatable
  --hours <n>                         lookback in hours (default: 24)
  --min-accounts <n>                  cluster threshold (default: 3)
  --min-fingerprint-projects <n>      repeated file threshold (default: 3)
  --host-concurrency <n>              concurrent host metadata scans (default: 4)
  --skip-files                        skip project-host metadata scans
  --node <path>                       Node executable for the CoCalc CLI
  --cli <path>                        CoCalc CLI script
  --json                              emit JSON

The command requires admin fresh auth. It reports candidates only and never
bans accounts, stops projects, reads file contents, or changes host services.`;
}

function parseEnvelope(output, command) {
  let envelope;
  try {
    envelope = JSON.parse(`${output}`);
  } catch (err) {
    throw new Error(`${command} returned invalid JSON: ${err}`);
  }
  if (!envelope?.ok) {
    throw new Error(
      `${command} failed: ${envelope?.error?.message ?? "unknown error"}`,
    );
  }
  return envelope.data;
}

function cliArgs(opts, args) {
  return [
    opts.cli,
    "--no-daemon",
    "--disable-env-auth-defaults",
    "--profile",
    opts.profile,
    "--api",
    opts.api,
    "--json",
    ...args,
  ];
}

function runCli(opts, args) {
  const output = execFileSync(opts.node, cliArgs(opts, args), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseEnvelope(output, args.join(" "));
}

async function runCliAsync(opts, args) {
  const { stdout } = await execFileAsync(opts.node, cliArgs(opts, args), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseEnvelope(stdout, args.join(" "));
}

function rowsFromAdminQuery(data) {
  const fields = (data?.fields ?? []).map(({ name }) => name);
  return (data?.rows ?? []).map((values) =>
    Object.fromEntries(fields.map((name, index) => [name, values[index]])),
  );
}

function queryBay(opts, bay, sql, reason) {
  return rowsFromAdminQuery(
    runCli(opts, [
      "admin",
      "db",
      "query",
      "--bay",
      bay,
      "--reason",
      reason,
      "--limit",
      "5000",
      "--timeout-ms",
      "30000",
      "--max-bytes",
      `${16 * 1024 * 1024}`,
      "--sql",
      sql,
    ]),
  );
}

async function mapLimit(values, limit, fn) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

function emailParts(email) {
  const normalized = `${email ?? ""}`.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return {};
  return { local: normalized.slice(0, at), domain: normalized.slice(at + 1) };
}

export function looksRandomLocalPart(local) {
  const value = `${local ?? ""}`.toLowerCase();
  return (
    /^[a-z0-9]{8,24}$/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value)
  );
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const id = key(value);
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(value);
    groups.set(id, group);
  }
  return groups;
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
}

export function scoreAccountCluster(accounts, projectsByAccount) {
  const count = accounts.length;
  const ips = new Set(
    accounts.map(({ created_ip }) => created_ip).filter(Boolean),
  );
  const agents = accounts.map(({ user_agent }) => user_agent).filter(Boolean);
  const [commonAgent, commonAgentCount] = mostCommon(agents);
  const headlessCount = agents.filter((value) =>
    /headless/i.test(value),
  ).length;
  const randomCount = accounts.filter(({ email_address }) =>
    looksRandomLocalPart(emailParts(email_address).local),
  ).length;
  const authMethods = accounts
    .map(({ primary_auth_method }) => primary_auth_method)
    .filter(Boolean);
  const accountProjects = accounts.flatMap(
    ({ account_id }) => projectsByAccount.get(account_id) ?? [],
  );
  const uniqueProjects = [
    ...new Map(accountProjects.map((row) => [row.project_id, row])).values(),
  ];
  const runningProjects = uniqueProjects.filter(
    ({ state }) => state === "running",
  ).length;
  const [commonTitle, commonTitleCount] = mostCommon(
    uniqueProjects.map(({ title }) => `${title ?? ""}`.trim().toLowerCase()),
  );

  let score = 0;
  const signals = [];
  if (count >= 8) {
    score += 2;
    signals.push("at least 8 accounts in the lookback window");
  } else if (count >= 4) {
    score += 1;
    signals.push("at least 4 accounts in the lookback window");
  }
  if (ips.size === 1 && count >= 3) {
    score += 3;
    signals.push("all accounts share one creation IP");
  } else if (ips.size > 0 && ips.size <= Math.max(1, Math.ceil(count / 4))) {
    score += 2;
    signals.push("creation IPs are highly concentrated");
  }
  if (headlessCount > 0) {
    score += 4;
    signals.push(`${headlessCount} account sessions report headless browsers`);
  }
  if (commonAgent && commonAgentCount / count >= 0.75) {
    score += 1;
    signals.push("at least 75% share one exact user agent");
  }
  if (randomCount / count >= 0.75) {
    score += 2;
    signals.push("at least 75% use random-looking email local parts");
  }
  if (
    authMethods.length >= Math.ceil(count * 0.75) &&
    authMethods.filter((value) => value === "email_code").length / count >= 0.75
  ) {
    score += 1;
    signals.push("at least 75% use email-code authentication");
  }
  if (uniqueProjects.length / count >= 0.75) {
    score += 1;
    signals.push("at least 75% immediately created projects");
  }
  if (
    commonTitle &&
    uniqueProjects.length >= 3 &&
    commonTitleCount / uniqueProjects.length >= 0.75
  ) {
    score += 1;
    signals.push("at least 75% of projects share one exact title");
  }
  if (
    uniqueProjects.length >= 2 &&
    runningProjects / uniqueProjects.length >= 0.5
  ) {
    score += 2;
    signals.push("at least half of the projects are running");
  }

  return {
    score,
    signals,
    account_count: count,
    unbanned_count: accounts.filter(({ banned }) => banned !== true).length,
    distinct_ips: ips.size,
    headless_sessions: headlessCount,
    random_local_parts: randomCount,
    common_user_agent_count: commonAgentCount,
    common_user_agent: commonAgent ? `${commonAgent}`.slice(0, 240) : null,
    project_count: uniqueProjects.length,
    running_project_count: runningProjects,
    common_project_title: commonTitle || null,
    common_project_title_count: commonTitleCount,
    account_ids: accounts.map(({ account_id }) => account_id),
    project_ids: uniqueProjects.map(({ project_id }) => project_id),
  };
}

export function buildAccountCandidates(accounts, projects, minAccounts = 3) {
  const projectsByAccount = groupBy(projects, ({ account_id }) => account_id);
  const candidates = [];
  const addGroups = (kind, groups) => {
    for (const [key, members] of groups) {
      if (members.length < minAccounts) continue;
      const details = scoreAccountCluster(members, projectsByAccount);
      const domainIdentitySignal =
        details.headless_sessions > 0 ||
        (details.distinct_ips > 0 &&
          details.distinct_ips <= Math.max(1, Math.ceil(members.length / 4))) ||
        details.random_local_parts / members.length >= 0.75 ||
        details.common_user_agent_count / members.length >= 0.75;
      if (kind === "email_domain" && !domainIdentitySignal) continue;
      if (details.score < 4) continue;
      const domains = [
        ...new Set(
          members.map(({ email_address }) => emailParts(email_address).domain),
        ),
      ].filter(Boolean);
      const highConfidence =
        details.headless_sessions > 0 ||
        details.running_project_count >= 2 ||
        (details.account_count >= 8 &&
          details.distinct_ips === 1 &&
          details.random_local_parts / details.account_count >= 0.75 &&
          details.common_user_agent_count / details.account_count >= 0.75);
      candidates.push({
        kind,
        key,
        domains,
        status:
          details.unbanned_count === 0
            ? "contained"
            : details.score >= 7 && highConfidence
              ? "high"
              : "watch",
        ...details,
      });
    }
  };
  addGroups(
    "email_domain",
    groupBy(accounts, ({ email_address }) => emailParts(email_address).domain),
  );
  addGroups(
    "creation_ip",
    groupBy(accounts, ({ created_ip }) => created_ip),
  );
  return candidates.sort((a, b) => {
    const active = Number(b.unbanned_count > 0) - Number(a.unbanned_count > 0);
    return active || b.score - a.score || b.account_count - a.account_count;
  });
}

function accountSql(hours) {
  return `
    SELECT a.account_id,
           a.email_address,
           a.created,
           COALESCE(a.created_by::TEXT, auth.ip_address) AS created_ip,
           COALESCE(a.banned, FALSE) AS banned,
           auth.primary_auth_method,
           auth.user_agent
      FROM accounts a
      LEFT JOIN LATERAL (
        SELECT s.primary_auth_method,
               s.user_agent,
               s.ip_address::TEXT AS ip_address
          FROM account_auth_sessions s
         WHERE s.account_id = a.account_id
         ORDER BY s.created ASC
         LIMIT 1
      ) auth ON TRUE
     WHERE a.created >= NOW() - INTERVAL '${hours} hours'
     ORDER BY a.created DESC
  `;
}

function projectSql(hours) {
  return `
    SELECT p.project_id,
           p.title,
           p.created,
           p.host_id,
           COALESCE(p.state->>'state', 'opened') AS state,
           collaborator.account_id
      FROM projects p
      CROSS JOIN LATERAL
        jsonb_object_keys(COALESCE(p.users, '{}'::JSONB))
        AS collaborator(account_id)
     WHERE p.created >= NOW() - INTERVAL '${hours} hours'
     ORDER BY p.created DESC
  `;
}

async function scanControlPlane(opts) {
  const bays = opts.bays.length
    ? opts.bays
    : runCli(opts, ["bay", "list"]).map(({ bay_id }) => bay_id);
  const accounts = [];
  const projects = [];
  const errors = [];
  for (const bay of bays) {
    try {
      accounts.push(
        ...queryBay(
          opts,
          bay,
          accountSql(opts.hours),
          "standard abuse health scan: recent account metadata",
        ).map((row) => ({ ...row, bay_id: bay })),
      );
      projects.push(
        ...queryBay(
          opts,
          bay,
          projectSql(opts.hours),
          "standard abuse health scan: recent project metadata",
        ).map((row) => ({ ...row, bay_id: bay })),
      );
    } catch (err) {
      errors.push({ bay_id: bay, error: `${err}` });
    }
  }
  return {
    bays,
    account_count: accounts.length,
    project_count: projects.length,
    candidates: buildAccountCandidates(accounts, projects, opts.minAccounts),
    errors,
  };
}

export function parseFindMetadata(buffer, host) {
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const rows = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const directory = fields[i];
    const match = /\/project-([0-9a-f-]{36})$/i.exec(directory);
    if (!match) continue;
    rows.push({
      host_id: host.host_id,
      host_name: host.name,
      project_id: match[1],
      name: fields[i + 1],
      size: Number(fields[i + 2]),
      mtime_epoch: Number(fields[i + 3]),
    });
  }
  return rows;
}

export function buildFileFingerprints(rows, minimumProjects = 3) {
  const groups = groupBy(rows, ({ name, size }) => `${name}\0${size}`);
  const fingerprints = [];
  for (const members of groups.values()) {
    const byProject = new Map(
      members.map((member) => [member.project_id, member]),
    );
    if (byProject.size < minimumProjects) continue;
    const unique = [...byProject.values()];
    fingerprints.push({
      name: unique[0].name,
      size: unique[0].size,
      project_count: unique.length,
      host_count: new Set(unique.map(({ host_id }) => host_id)).size,
      project_ids: unique.map(({ project_id }) => project_id),
      hosts: [...new Set(unique.map(({ host_name }) => host_name))],
      newest_mtime_epoch: Math.max(
        ...unique.map(({ mtime_epoch }) => mtime_epoch),
      ),
    });
  }
  return fingerprints.sort(
    (a, b) => b.project_count - a.project_count || b.size - a.size,
  );
}

async function scanHostFiles(opts, host) {
  try {
    const endpoint = await runCliAsync(opts, [
      "host",
      "ssh",
      host.host_id,
      "--print",
      "--no-connect",
    ]);
    const minutes = opts.hours * 60;
    const command =
      "sudo find /mnt/cocalc/project-* -xdev -maxdepth 1 -type f " +
      `! -name '.*' -mmin -${minutes} -size +1023c -size -10485761c ` +
      "-printf '%h\\0%f\\0%s\\0%T@\\0' 2>/dev/null";
    const { stdout } = await execFileAsync(
      "ssh",
      [
        "-n",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-p",
        `${endpoint.ssh_port}`,
        endpoint.ssh_target,
        command,
      ],
      { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
    );
    return { host, rows: parseFindMetadata(stdout, host) };
  } catch (err) {
    return { host, rows: [], error: `${err}` };
  }
}

async function scanFileMetadata(opts) {
  if (opts.skipFiles) {
    return { skipped: true, hosts: 0, files: 0, fingerprints: [], errors: [] };
  }
  const hosts = runCli(opts, ["host", "list", "--admin-view"]).filter(
    (host) =>
      host.status === "running" &&
      host.funding_mode === "site-funded" &&
      host.scope === "owned",
  );
  const scans = await mapLimit(hosts, opts.hostConcurrency, (host) =>
    scanHostFiles(opts, host),
  );
  const rows = scans.flatMap(({ rows }) => rows);
  return {
    skipped: false,
    hosts: hosts.length,
    files: rows.length,
    fingerprints: buildFileFingerprints(rows, opts.minFingerprintProjects),
    errors: scans
      .filter(({ error }) => error)
      .map(({ host, error }) => ({
        host_id: host.host_id,
        name: host.name,
        error,
      })),
  };
}

function printHuman(report) {
  console.log(`Abuse health scan: ${report.checked_at}`);
  console.log(
    `Control plane: ${report.control_plane.account_count} recent accounts, ` +
      `${report.control_plane.project_count} recent projects, ` +
      `${report.control_plane.bays.length} bay(s)`,
  );
  if (!report.control_plane.candidates.length) {
    console.log("  No scored signup clusters.");
  }
  for (const candidate of report.control_plane.candidates) {
    console.log(
      `  [${candidate.status.toUpperCase()}] ${candidate.kind}=${candidate.key} ` +
        `score=${candidate.score} accounts=${candidate.account_count} ` +
        `unbanned=${candidate.unbanned_count} projects=${candidate.project_count} ` +
        `running=${candidate.running_project_count}`,
    );
    console.log(`    ${candidate.signals.join("; ")}`);
  }
  if (report.control_plane.errors.length) {
    console.log(
      `  Incomplete bay scans: ${report.control_plane.errors.length}`,
    );
  }

  if (report.files.skipped) {
    console.log("Project files: skipped");
    return;
  }
  console.log(
    `Project files: ${report.files.files} recent top-level files across ` +
      `${report.files.hosts} site-funded host(s)`,
  );
  if (!report.files.fingerprints.length) {
    console.log("  No repeated filename/size fingerprints.");
  }
  for (const fingerprint of report.files.fingerprints) {
    const correlation = fingerprint.control_plane_candidates.length
      ? "[CORRELATED] "
      : "";
    console.log(
      `  ${correlation}${JSON.stringify(fingerprint.name)} size=${fingerprint.size} ` +
        `projects=${fingerprint.project_count} hosts=${fingerprint.host_count}`,
    );
    if (fingerprint.control_plane_candidates.length) {
      console.log(
        `    signup clusters: ${fingerprint.control_plane_candidates.join(", ")}`,
      );
    }
    console.log(`    projects: ${fingerprint.project_ids.join(", ")}`);
  }
  if (report.files.errors.length) {
    console.log(`  Incomplete host scans: ${report.files.errors.length}`);
    for (const { name, error } of report.files.errors) {
      console.log(`    ${name}: ${error.slice(0, 300)}`);
    }
  }
}

export async function run(opts) {
  const [controlPlane, files] = await Promise.all([
    scanControlPlane(opts),
    scanFileMetadata(opts),
  ]);
  const clusterByProject = new Map();
  for (const candidate of controlPlane.candidates) {
    const label = `${candidate.status}:${candidate.kind}=${candidate.key}`;
    for (const projectId of candidate.project_ids) {
      const labels = clusterByProject.get(projectId) ?? new Set();
      labels.add(label);
      clusterByProject.set(projectId, labels);
    }
  }
  files.fingerprints = files.fingerprints
    .map((fingerprint) => ({
      ...fingerprint,
      control_plane_candidates: [
        ...new Set(
          fingerprint.project_ids.flatMap((projectId) => [
            ...(clusterByProject.get(projectId) ?? []),
          ]),
        ),
      ],
    }))
    .sort(
      (a, b) =>
        Number(b.control_plane_candidates.length > 0) -
          Number(a.control_plane_candidates.length > 0) ||
        b.project_count - a.project_count,
    );
  return {
    checked_at: new Date().toISOString(),
    lookback_hours: opts.hours,
    report_only: true,
    control_plane: controlPlane,
    files,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(help());
    return;
  }
  const report = await run(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (
    report.control_plane.errors.length > 0 ||
    report.files.errors.length > 0
  ) {
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : `${err}`);
    process.exitCode = 1;
  });
}
