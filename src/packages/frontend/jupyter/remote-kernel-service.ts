import { webapp_client } from "@cocalc/frontend/webapp-client";

export interface RemoteKernelSetup {
  name: string;
  host: string;
  environment: string;
  python?: string;
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
  if (config.python) {
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
    err_on_exit: true,
  });
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

async function manage(project_id: string, args: string[]): Promise<any> {
  const result = await webapp_client.project_client.exec({
    project_id,
    command: "reflect",
    args: ["jupyter", ...args],
    bash: false,
    timeout: 120,
    err_on_exit: true,
  });
  return JSON.parse(result.stdout);
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
