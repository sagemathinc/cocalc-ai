import { webapp_client } from "@cocalc/frontend/webapp-client";

export interface RemoteKernelSetup {
  name: string;
  host: string;
  environment: string;
  python?: string;
  kernel?: string;
  recipe?: "python" | "pytorch-cu128";
}

export function remoteKernelSetupArgs(config: RemoteKernelSetup): string[] {
  for (const name of [config.name, config.environment]) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name)) {
      throw Error(
        "Names may contain letters, numbers, hyphens and underscores.",
      );
    }
  }
  if (
    !config.host ||
    config.host.startsWith("-") ||
    /[\s\x00-\x1f]/.test(config.host)
  ) {
    throw Error("Enter an SSH destination or alias.");
  }
  const args = [
    "jupyter",
    "setup",
    "--target",
    config.name,
    "--host",
    config.host,
    "--environment",
    config.environment,
  ];
  if (config.kernel) {
    if (config.python || !config.kernel.startsWith("/"))
      throw Error("Choose an absolute remote kernelspec path");
    args.push("--kernel", config.kernel);
  } else if (config.python) {
    if (!config.python.startsWith("/"))
      throw Error("Use an absolute remote Python path.");
    args.push("--python", config.python);
  } else if (config.recipe) {
    if (!["python", "pytorch-cu128"].includes(config.recipe))
      throw Error("Unknown kernel recipe");
    args.push("--recipe", config.recipe);
  }
  return args;
}

export async function setupRemoteKernel(
  project_id: string,
  config: RemoteKernelSetup,
): Promise<string> {
  const result = await webapp_client.project_client.exec({
    project_id,
    command: "reflect",
    args: remoteKernelSetupArgs(config),
    bash: false,
    timeout: 600,
    err_on_exit: false,
  });
  checkRemoteKernelResult(result, config.host);
  const data = JSON.parse(result.stdout);
  if (data.kernel !== `reflect-${config.name}`)
    throw Error("Unexpected remote kernel setup response");
  return data.kernel;
}

export interface RemoteKernelTarget {
  name: string;
  host: string;
  environment: string;
  disabled?: boolean;
}

export interface RemoteKernelProbe {
  platform: string;
  suggested_name: string;
  gpu: {
    status: "available" | "absent" | "unknown" | "unavailable" | "unsupported";
    reason?: string;
    description?: string;
  };
  kernels: {
    id: string;
    name: string;
    display_name: string;
    language: string;
  }[];
  environments: { name: string; recipe: string | null }[];
  warnings: string[];
  search_paths: string[];
}

export async function remoteSshTargets(
  project_id: string,
): Promise<{ aliases: string[]; warnings: string[] }> {
  return await manage(project_id, ["ssh-targets"]);
}

export async function probeRemoteKernel(
  project_id: string,
  host: string,
  searchPath?: string,
): Promise<RemoteKernelProbe> {
  if (!host || host.startsWith("-") || /[\s\x00-\x1f]/.test(host))
    throw Error("Enter an SSH destination or alias");
  return await manage(project_id, [
    "probe",
    "--host",
    host,
    ...(searchPath ? ["--search-path", searchPath] : []),
  ]);
}

export function suggestedEnvironment(
  host: string,
  recipe: string,
  environments: RemoteKernelProbe["environments"],
): string {
  const normalized = host.replace(/[^a-zA-Z0-9_-]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "-") start++;
  while (end > start && normalized[end - 1] === "-") end--;
  const base =
    (normalized.slice(start, Math.min(end, start + 70)).toLowerCase() ||
      "remote") + (recipe === "pytorch-cu128" ? "-gpu" : "-python");
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const existing = environments.find((x) => x.name === name);
    if (!existing || existing.recipe === recipe) return name;
  }
}

async function manage(project_id: string, args: string[]): Promise<any> {
  const result = await webapp_client.project_client.exec({
    project_id,
    command: "reflect",
    args: ["jupyter", ...args],
    bash: false,
    timeout: 120,
    err_on_exit: false,
  });
  const hostIndex = args.indexOf("--host");
  checkRemoteKernelResult(
    result,
    hostIndex < 0 ? undefined : args[hostIndex + 1],
  );
  return JSON.parse(result.stdout);
}

function checkRemoteKernelResult(
  result: { exit_code?: number; stderr?: string; stdout?: string },
  host?: string,
): void {
  if (result.exit_code == null || result.exit_code === 0) return;
  // Keep the actual diagnostic, not project-exec's wrapper or Node stack frames.
  const output = (result.stderr?.trim() || result.stdout?.trim() || "").split(
    /\r?\n/,
  );
  const stackStart = output.findIndex((line) => /^\s+at\s/.test(line));
  const message = (stackStart < 0 ? output : output.slice(0, stackStart))
    .join("\n")
    .replace(/^Error: /, "")
    .trim();
  const sshFailure = /^SSH operation failed \(255\):\s*/;
  if (host && sshFailure.test(message)) {
    const target = /^[a-zA-Z0-9_@.:/-]+$/.test(host)
      ? host
      : `'${host.replace(/'/g, "'\\''")}'`;
    throw Error(`~$ ssh ${target}\n${message.replace(sshFailure, "")}`);
  }
  throw Error(
    message || `Remote kernel command failed (exit ${result.exit_code}).`,
  );
}

export async function listRemoteKernelTargets(
  project_id: string,
): Promise<RemoteKernelTarget[]> {
  return await manage(project_id, ["targets"]);
}

export async function removeRemoteKernelTarget(
  project_id: string,
  name: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name)) throw Error("Invalid target name");
  await manage(project_id, ["remove", "--target", name]);
}
