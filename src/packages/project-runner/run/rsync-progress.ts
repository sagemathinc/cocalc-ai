import { spawn } from "node:child_process";
import { split, trunc_middle } from "@cocalc/util/misc";
import { once } from "events";
import getLogger from "@cocalc/backend/logger";
import { buildPodmanCommand } from "@cocalc/backend/podman";

const logger = getLogger("project-runner:run:rsync-progress");

const MAX_UPDATES_PER_SECOND = 3;

export const PROGRESS_ARGS = [
  "--outbuf=L",
  "--no-inc-recursive",
  "--info=progress2",
  "--no-human-readable",
];

export default async function rsyncProgress({
  name,
  args,
  progress,
}: {
  // if name is given, run in the podman container with given
  // name; otherwise runs rsync directly.
  name?: string;
  args: string[];
  progress: (event) => void;
}) {
  progress({ progress: 0 });
  const args1: string[] = [];
  let command;
  let env: NodeJS.ProcessEnv | undefined;
  let cwd: string | undefined;
  if (name) {
    const containerArgs = ["exec", name, "rsync", ...PROGRESS_ARGS, ...args];
    const spec = buildPodmanCommand(containerArgs);
    command = spec.command;
    env = spec.env;
    cwd = spec.cwd;
    args1.push(...spec.args);
  } else {
    command = "rsync";
    args1.push(...PROGRESS_ARGS, ...args);
  }
  logger.debug(
    "rsyncProgress:",
    `"${command} ${args1.join(" ")}"`,
  );
  await rsyncProgressRunner({ command, args: args1, progress, env, cwd });
}

// we also use this for other commands that have the exact rsync output when they run...
export async function rsyncProgressRunner({
  command,
  args,
  progress,
  env,
  cwd,
}: {
  command: string;
  args: string[];
  progress: (event) => void;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}) {
  logger.debug(`${command} ${args.join(" ")}`);
  const child = spawn(command, args, { env, cwd });
  await rsyncProgressReporter({ child, progress });
}

export async function rsyncProgressReporter({ child, progress }) {
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  let last = 0;
  let lastTime = Date.now();
  child.stdout.on("data", (data) => {
    let time = Date.now();
    if (time - lastTime <= 1000 / MAX_UPDATES_PER_SECOND) {
      return;
    }
    const v = split(data.toString());
    if (v[1]?.endsWith("%")) {
      const p = parseInt(v[1].slice(0, -1));
      if (isFinite(p) && p > last) {
        progress({ progress: p, speed: v[2], eta: parseEta(v[3]) });
        last = p;
        lastTime = time;
      }
    }
  });
  await once(child, "close");
  if (child.exitCode) {
    logger.debug("rsyncProgress errors", trunc_middle(stderr));
    progress({ error: `there were errors -- ${trunc_middle(stderr)}` });
    throw Error(`error syncing files -- ${trunc_middle(stderr)}`);
  } else {
    progress({ progress: 100 });
  }
}

function parseEta(s?: string) {
  if (s == null) {
    return;
  }
  const i = s?.indexOf(":");
  if (i == -1) return;
  const j = s?.lastIndexOf(":");
  return (
    parseInt(s.slice(0, i)) * 1000 * 60 * 60 +
    parseInt(s.slice(i + 1, j)) * 1000 * 60 +
    parseInt(s.slice(j + 1)) * 1000
  );
}
