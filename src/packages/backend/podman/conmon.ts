import { spawn } from "node:child_process";

export interface ConmonContainerProcess {
  name: string;
  project_id?: string;
  conmon_pid: number;
  child_pids: number[];
}

function isExecConmonArgs(args: string): boolean {
  return args.includes("--exec-attach") || args.includes("--exec-process-spec");
}

export function parseConmonContainerProcessLists(
  stdout: string,
): Map<string, ConmonContainerProcess[]> {
  const conmonByPid = new Map<number, ConmonContainerProcess>();
  const childPidsByParent = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const args = match[3];
    if (Number.isFinite(ppid) && ppid > 0) {
      const childPids = childPidsByParent.get(ppid) ?? [];
      childPids.push(pid);
      childPidsByParent.set(ppid, childPids);
    }
    const conmonMatch = args.match(
      /(?:^|\s|\/)conmon(?:\s|$).*?\s-n\s+([^\s]+)(?:\s|$)/,
    );
    if (isExecConmonArgs(args)) continue;
    if (!conmonMatch || !Number.isFinite(pid) || pid <= 0) continue;
    const name = conmonMatch[1];
    const projectMatch = name.match(/^project-([0-9a-fA-F-]{36})$/);
    conmonByPid.set(pid, {
      name,
      project_id: projectMatch?.[1],
      conmon_pid: pid,
      child_pids: [],
    });
  }

  const states = new Map<string, ConmonContainerProcess[]>();
  for (const [pid, info] of conmonByPid) {
    const child_pids = [...new Set(childPidsByParent.get(pid) ?? [])].filter(
      (childPid) => Number.isFinite(childPid) && childPid > 0,
    );
    if (!child_pids.length) continue;
    const existing = states.get(info.name) ?? [];
    existing.push({ ...info, child_pids });
    states.set(info.name, existing);
  }
  return states;
}

export function parseConmonContainerProcesses(
  stdout: string,
): Map<string, ConmonContainerProcess> {
  return new Map(
    [...parseConmonContainerProcessLists(stdout).entries()]
      .map(([name, infos]) => [
        name,
        [...infos].sort((left, right) => left.conmon_pid - right.conmon_pid)[
          infos.length - 1
        ],
      ])
      .filter((entry): entry is [string, ConmonContainerProcess] => !!entry[1]),
  );
}

async function getConmonProcessSnapshot(): Promise<string> {
  return await new Promise<string>((resolve) => {
    const child = spawn("ps", ["-eo", "pid=,ppid=,args="]);
    let stdout = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.on("error", () => resolve(""));
    child.on("exit", (code) => {
      if (code !== 0) return resolve("");
      resolve(stdout);
    });
  });
}

export async function getConmonContainerProcessLists(): Promise<
  Map<string, ConmonContainerProcess[]>
> {
  return parseConmonContainerProcessLists(await getConmonProcessSnapshot());
}

export async function getConmonContainerProcesses(): Promise<
  Map<string, ConmonContainerProcess>
> {
  return parseConmonContainerProcesses(await getConmonProcessSnapshot());
}
