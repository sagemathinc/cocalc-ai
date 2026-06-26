/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountByEmail } from "@cocalc/server/inter-bay/accounts";
import { isValidUUID } from "@cocalc/util/misc";

const execFileAsync = promisify(execFile);

type Options = {
  accountId?: string;
  email?: string;
  hostId?: string;
  projectIds: string[];
  limit?: number;
  output?: string;
  sshUser: string;
  maxFileBytes: number;
};

type ProjectRow = {
  legacy_project_id: string;
  project_id: string;
  title: string | null;
  host_id: string | null;
  host_name: string | null;
  public_ip: string | null;
};

type ProjectScan = {
  legacy_project_id: string;
  project_id: string;
  title?: string | null;
  host_id?: string | null;
  host_name?: string | null;
  files_scanned?: number;
  ipynb_count?: number;
  py_count?: number;
  r_count?: number;
  python_imports?: Record<string, number>;
  r_packages?: Record<string, number>;
  pip_packages?: Record<string, number>;
  conda_packages?: Record<string, number>;
  kernels?: Record<string, number>;
  errors?: string[];
};

function usage(): never {
  console.log(`Usage:
  node packages/server/dist/legacy-migration/scan-account-environment.js [options]

Scan restored legacy projects for likely Python/R/notebook environment needs.
The script queries restored imports for one account, groups them by assigned
project host, SSHes to each host, and scans files read-only.

Options:
  --account-id <uuid>        Target cocalc.ai account id.
  --email <email>            Resolve target cocalc.ai account by email.
  --project-id <uuid>        Restrict to one restored project. Can repeat.
  --host-id <uuid>           Restrict to projects assigned to one host.
  --limit <n>                Maximum projects to scan.
  --output <path>            Write JSON report to this path.
  --ssh-user <user>          SSH user for project hosts. Default: ubuntu.
  --max-file-bytes <n>       Skip individual source files larger than n.
                             Default: 1048576.
  --help                     Show this help.

Run this on the target account's home bay.
`);
  process.exit(0);
}

function clean(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    projectIds: [],
    sshUser: "ubuntu",
    maxFileBytes: 1024 * 1024,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--account-id") {
      options.accountId = value;
    } else if (arg === "--email") {
      options.email = value;
    } else if (arg === "--project-id") {
      options.projectIds.push(value);
    } else if (arg === "--host-id") {
      options.hostId = value;
    } else if (arg === "--limit") {
      options.limit = positiveInt(value, arg);
    } else if (arg === "--output") {
      options.output = value;
    } else if (arg === "--ssh-user") {
      options.sshUser = value;
    } else if (arg === "--max-file-bytes") {
      options.maxFileBytes = positiveInt(value, arg);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (!options.accountId && !options.email) {
    throw new Error("one of --account-id or --email is required");
  }
  if (options.accountId && !isValidUUID(options.accountId)) {
    throw new Error("--account-id must be a valid uuid");
  }
  if (options.hostId && !isValidUUID(options.hostId)) {
    throw new Error("--host-id must be a valid uuid");
  }
  for (const projectId of options.projectIds) {
    if (!isValidUUID(projectId)) {
      throw new Error(`invalid --project-id ${projectId}`);
    }
  }
  return options;
}

async function resolveAccountId(options: Options): Promise<string> {
  if (options.accountId) return options.accountId;
  const email = clean(options.email);
  if (!email) throw new Error("--email must not be empty");
  const account = await getClusterAccountByEmail(email);
  if (!account?.account_id) {
    throw new Error(`account not found for email ${email}`);
  }
  const homeBayId = clean((account as any).home_bay_id);
  const currentBayId = getConfiguredBayId();
  if (homeBayId && homeBayId !== currentBayId) {
    throw new Error(
      `account ${account.account_id} is homed on ${homeBayId}; run this script on that bay, not ${currentBayId}`,
    );
  }
  return account.account_id;
}

async function listRestoredProjects({
  accountId,
  options,
}: {
  accountId: string;
  options: Options;
}): Promise<ProjectRow[]> {
  const projectIds = options.projectIds;
  const { rows } = await getPool().query<ProjectRow>(
    `
    SELECT i.legacy_project_id,
           i.project_id::TEXT AS project_id,
           legacy.title,
           projects.host_id::TEXT AS host_id,
           hosts.name AS host_name,
           hosts.metadata #>> '{runtime,public_ip}' AS public_ip
      FROM legacy_migration_project_imports i
      JOIN legacy_migration_projects legacy
        ON legacy.legacy_project_id=i.legacy_project_id
      JOIN projects
        ON projects.project_id=i.project_id
      LEFT JOIN project_hosts hosts
        ON hosts.id=projects.host_id
     WHERE i.owner_account_id=$1
       AND i.restore_status='restored'
       AND ($2::UUID IS NULL OR projects.host_id=$2::UUID)
       AND (
         COALESCE(array_length($3::UUID[], 1), 0)=0
         OR i.project_id=ANY($3::UUID[])
       )
     ORDER BY legacy.last_edited DESC NULLS LAST, i.legacy_project_id
     LIMIT $4
    `,
    [
      accountId,
      options.hostId ?? null,
      projectIds.length === 0 ? [] : projectIds,
      options.limit ?? 100000,
    ],
  );
  return rows;
}

function groupByHost(projects: ProjectRow[]): Map<string, ProjectRow[]> {
  const grouped = new Map<string, ProjectRow[]>();
  for (const project of projects) {
    const key = project.host_id ?? "";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(project);
  }
  return grouped;
}

function remoteScanner(projects: ProjectRow[], maxFileBytes: number): string {
  const encoded = Buffer.from(JSON.stringify(projects)).toString("base64");
  return String.raw`
import ast
import base64
import json
import os
import re
import sys

PROJECTS = json.loads(base64.b64decode("${encoded}").decode("utf-8"))
MAX_FILE_BYTES = ${maxFileBytes}

SKIP_DIR_NAMES = {
    ".git", ".hg", ".svn", ".tox", ".mypy_cache", ".pytest_cache",
    "__pycache__", "node_modules", "venv", ".venv", "env", ".env",
    "site-packages", "dist", "build", ".ipynb_checkpoints",
}
SKIP_REL_PREFIXES = (
    ".local/share/cocalc/rootfs",
    ".local/share/cocalc/persist",
    ".cache/cocalc",
    ".snapshots",
    ".smc",
)

IMPORT_RE = re.compile(r"^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))", re.M)
R_PACKAGE_RE = re.compile(r"\b(?:library|require)\s*\(\s*['\"]?([A-Za-z][A-Za-z0-9_.]*)")
R_INSTALL_RE = re.compile(r"\binstall\.packages\s*\(\s*(?:c\s*\()?\s*([^)]+)")
PIP_RE = re.compile(r"^\s*(?:!|%)?\s*(?:python(?:3)?\s+-m\s+)?pip\s+install\s+(.+)$", re.M)
CONDA_RE = re.compile(r"^\s*(?:!|%)?\s*(?:conda|mamba)\s+install\s+(.+)$", re.M)

def add(counter, key):
    key = (key or "").strip()
    if not key:
        return
    counter[key] = counter.get(key, 0) + 1

def top_module(name):
    return (name or "").split(".")[0]

def add_python_imports(counter, text):
    try:
        tree = ast.parse(text)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    add(counter, top_module(alias.name))
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    add(counter, top_module(node.module))
        return
    except Exception:
        pass
    for match in IMPORT_RE.finditer(text):
        add(counter, top_module(match.group(1) or match.group(2)))

def package_tokens(text):
    for raw in re.split(r"\s+", text.strip()):
        token = raw.strip().strip("'\"")
        if not token or token.startswith("-"):
            continue
        if "://" in token or token.startswith("git+"):
            continue
        token = re.split(r"[<>=!~\[]", token, maxsplit=1)[0]
        token = token.strip(",;")
        if token:
            yield token

def add_install_hints(pip_counter, conda_counter, r_counter, text):
    for match in PIP_RE.finditer(text):
        for token in package_tokens(match.group(1)):
            add(pip_counter, token)
    for match in CONDA_RE.finditer(text):
        for token in package_tokens(match.group(1)):
            add(conda_counter, token)
    for match in R_INSTALL_RE.finditer(text):
        for token in re.findall(r"['\"]([^'\"]+)['\"]", match.group(1)):
            add(r_counter, token)

def add_r_packages(counter, text):
    for match in R_PACKAGE_RE.finditer(text):
        add(counter, match.group(1))

def should_skip_dir(project_root, root):
    rel = os.path.relpath(root, project_root)
    if rel == ".":
        return False
    normalized = rel.replace(os.sep, "/")
    return any(normalized == prefix or normalized.startswith(prefix + "/") for prefix in SKIP_REL_PREFIXES)

def sorted_counter(counter):
    return dict(sorted(counter.items(), key=lambda item: (-item[1], item[0])))

def scan_project(project):
    project_id = project["project_id"]
    root = f"/mnt/cocalc/project-{project_id}"
    result = {
        "legacy_project_id": project["legacy_project_id"],
        "project_id": project_id,
        "title": project.get("title"),
        "host_id": project.get("host_id"),
        "host_name": project.get("host_name"),
        "files_scanned": 0,
        "ipynb_count": 0,
        "py_count": 0,
        "r_count": 0,
        "python_imports": {},
        "r_packages": {},
        "pip_packages": {},
        "conda_packages": {},
        "kernels": {},
        "errors": [],
    }
    if not os.path.isdir(root):
        result["errors"].append(f"project directory not found: {root}")
        return result
    for current_root, dirs, files in os.walk(root):
        dirs[:] = [
            d for d in dirs
            if d not in SKIP_DIR_NAMES and not should_skip_dir(root, os.path.join(current_root, d))
        ]
        if should_skip_dir(root, current_root):
            dirs[:] = []
            continue
        for filename in files:
            lower = filename.lower()
            if not (lower.endswith(".py") or lower.endswith(".ipynb") or lower.endswith(".r") or lower.endswith(".rmd")):
                continue
            path = os.path.join(current_root, filename)
            try:
                if os.path.getsize(path) > MAX_FILE_BYTES:
                    continue
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()
            except Exception as err:
                result["errors"].append(f"{os.path.relpath(path, root)}: {err}")
                continue
            result["files_scanned"] += 1
            if lower.endswith(".py"):
                result["py_count"] += 1
                add_python_imports(result["python_imports"], text)
                add_install_hints(result["pip_packages"], result["conda_packages"], result["r_packages"], text)
            elif lower.endswith(".ipynb"):
                result["ipynb_count"] += 1
                try:
                    notebook = json.loads(text)
                    metadata = notebook.get("metadata") or {}
                    kernelspec = metadata.get("kernelspec") or {}
                    language_info = metadata.get("language_info") or {}
                    kernel = kernelspec.get("name") or kernelspec.get("display_name") or language_info.get("name")
                    add(result["kernels"], kernel)
                    for cell in notebook.get("cells") or []:
                        if cell.get("cell_type") != "code":
                            continue
                        source = cell.get("source") or ""
                        if isinstance(source, list):
                            source = "".join(source)
                        source = str(source)
                        add_python_imports(result["python_imports"], source)
                        add_r_packages(result["r_packages"], source)
                        add_install_hints(result["pip_packages"], result["conda_packages"], result["r_packages"], source)
                except Exception as err:
                    result["errors"].append(f"{os.path.relpath(path, root)}: notebook parse failed: {err}")
            else:
                result["r_count"] += 1
                add_r_packages(result["r_packages"], text)
                add_install_hints(result["pip_packages"], result["conda_packages"], result["r_packages"], text)
    for key in ["python_imports", "r_packages", "pip_packages", "conda_packages", "kernels"]:
        result[key] = sorted_counter(result[key])
    return result

for project in PROJECTS:
    print(json.dumps(scan_project(project), sort_keys=True), flush=True)
`;
}

async function scanHost({
  host,
  projects,
  sshUser,
  maxFileBytes,
}: {
  host: string;
  projects: ProjectRow[];
  sshUser: string;
  maxFileBytes: number;
}): Promise<ProjectScan[]> {
  const script = remoteScanner(projects, maxFileBytes);
  const target = `${sshUser}@${host}`;
  const { stdout, stderr } = await execFileAsync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "StrictHostKeyChecking=accept-new",
      target,
      "python3",
      "-",
    ],
    {
      input: script,
      maxBuffer: 1024 * 1024 * 100,
      timeout: 30 * 60 * 1000,
    } as any,
  );
  const stdoutText = stdout.toString();
  const stderrText = stderr.toString();
  if (stderrText.trim()) {
    console.error(`ssh ${target} stderr:\n${stderrText}`);
  }
  return stdoutText
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProjectScan);
}

function addCounts(
  target: Record<string, number>,
  source: Record<string, number> | undefined,
): void {
  for (const [key, count] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + count;
  }
}

function sortCounter(counter: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counter).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    ),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const accountId = await resolveAccountId(options);
  const projects = await listRestoredProjects({ accountId, options });
  const missingHost = projects.filter((project) => !project.public_ip);
  const grouped = groupByHost(projects.filter((project) => project.public_ip));
  const scans: ProjectScan[] = [];
  for (const [hostId, hostProjects] of grouped) {
    const publicIp = hostProjects[0]?.public_ip;
    if (!publicIp) continue;
    console.error(
      `scan host=${hostId} ip=${publicIp} projects=${hostProjects.length}`,
    );
    scans.push(
      ...(await scanHost({
        host: publicIp,
        projects: hostProjects,
        sshUser: options.sshUser,
        maxFileBytes: options.maxFileBytes,
      })),
    );
  }

  const python_imports: Record<string, number> = {};
  const r_packages: Record<string, number> = {};
  const pip_packages: Record<string, number> = {};
  const conda_packages: Record<string, number> = {};
  const kernels: Record<string, number> = {};
  for (const scan of scans) {
    addCounts(python_imports, scan.python_imports);
    addCounts(r_packages, scan.r_packages);
    addCounts(pip_packages, scan.pip_packages);
    addCounts(conda_packages, scan.conda_packages);
    addCounts(kernels, scan.kernels);
  }
  const report = {
    account_id: accountId,
    generated_at: new Date().toISOString(),
    project_count: projects.length,
    scanned_project_count: scans.length,
    missing_host_project_count: missingHost.length,
    summary: {
      python_imports: sortCounter(python_imports),
      r_packages: sortCounter(r_packages),
      pip_packages: sortCounter(pip_packages),
      conda_packages: sortCounter(conda_packages),
      kernels: sortCounter(kernels),
    },
    missing_host_projects: missingHost,
    projects: scans,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await writeFile(options.output, text);
  }
  process.stdout.write(text);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end();
  });
