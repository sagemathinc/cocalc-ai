import type {
  ReflectForwardRow,
  ReflectSessionRow,
} from "@cocalc/conat/hub/api/reflect";
import { runReflect, runReflectJson } from "./runner";

type ListSessionsOpts = {
  selectors?: string[];
  target?: string;
};

function buildSelectorArgs(opts?: ListSessionsOpts): string[] {
  const selectors = Array.isArray(opts?.selectors) ? [...opts!.selectors] : [];
  if (opts?.target) {
    selectors.push(`cocalc-plus-target=${opts.target}`);
  }
  const args: string[] = [];
  for (const sel of selectors) {
    args.push("--selector", sel);
  }
  return args;
}

export async function listSessionsUI(
  opts?: ListSessionsOpts,
): Promise<ReflectSessionRow[]> {
  const args = ["list", "--json", ...buildSelectorArgs(opts)];
  return await runReflectJson<ReflectSessionRow[]>(args);
}

export async function listForwardsUI(): Promise<ReflectForwardRow[]> {
  const args = ["forward", "list", "--json"];
  return await runReflectJson<ReflectForwardRow[]>(args);
}

export async function createSessionUI(opts: {
  alpha: string;
  beta: string;
  name?: string;
  labels?: string[];
  target?: string;
}): Promise<void> {
  const args = ["create", opts.alpha, opts.beta];
  if (opts.name) {
    args.push("--name", opts.name);
  }
  const labels = Array.isArray(opts.labels) ? opts.labels : [];
  if (opts.target) {
    labels.push(`cocalc-plus-target=${opts.target}`);
  }
  for (const label of labels) {
    args.push("--label", label);
  }
  await runReflect(args);
}
