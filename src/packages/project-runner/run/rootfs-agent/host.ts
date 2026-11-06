/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The rootfs agent's real dependencies on this host (see client.ts):

- the generation: the project container's full id and init pid
  (`podman inspect`), project-runner's start counter, and the separate
  runtime uid, only while the project's rootfs is mounted for it;
- the spawn: `podman exec` through the project-pool launcher, so the agent
  lands in the project's cgroup (Podman's own cgroups are disabled);
- the facts: read by this daemon from /proc, for the agent's host process
  (found by its in-container pid inside the container's pid namespace) and
  for the container's init. Never the agent's word.
- the in-container kill: `pkill` as the project user, by the spawn's token.
*/

import { execFile, spawn } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { PROJECT_RUNTIME_SEPARATE_UID } from "@cocalc/util/project-runtime";
import { nodePath } from "../mounts";
import { projectPoolPodmanLauncher, projectStartCounter } from "../podman";
import { rootfsIdmapUid } from "../rootfs";
import { ROOTFS_AGENT_CODE } from "./agent-code";
import type {
  AgentDeps,
  AgentGeneration,
  AgentHostFacts,
  ChildLike,
  ContainerFacts,
} from "./client";
import { AGENT_USER, agentExecArgs } from "./spawn";

const CONTAINER_TOOLS = "/opt/cocalc/bin2";
const CONTAINER_NODE = "/opt/cocalc/bin/node";

export interface ProcStatus {
  uid: number[];
  gid: number[];
  capEff: bigint;
  capAmb: bigint;
  noNewPrivs: number;
  seccomp: number;
  nspid: number[];
}

/** The fields of /proc/<pid>/status the authority check needs. */
export function parseProcStatus(text: string): ProcStatus {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const ints = (key: string) => {
    const v = fields.get(key);
    if (v == null) throw new Error(`status lacks ${key}`);
    const out = v.split(/\s+/).map((x) => Number(x));
    if (out.some((n) => !Number.isSafeInteger(n))) {
      throw new Error(`status ${key} is malformed`);
    }
    return out;
  };
  const hex = (key: string) => {
    const v = fields.get(key);
    if (v == null || !/^[0-9a-f]{1,16}$/.test(v)) {
      throw new Error(`status ${key} is malformed`);
    }
    return BigInt(`0x${v}`);
  };
  const one = (key: string) => {
    const [n] = ints(key);
    return n;
  };
  return {
    uid: ints("Uid"),
    gid: ints("Gid"),
    capEff: hex("CapEff"),
    capAmb: hex("CapAmb"),
    noNewPrivs: one("NoNewPrivs"),
    seccomp: one("Seccomp"),
    nspid: ints("NSpid"),
  };
}

/** The cgroup v2 path in /proc/<pid>/cgroup. */
export function parseCgroup(text: string): string {
  for (const line of text.split("\n")) {
    if (line.startsWith("0::")) return line.slice(3);
  }
  throw new Error("no cgroup v2 entry");
}

async function inspect(
  project_id: string,
): Promise<{ id: string; pid: number } | undefined> {
  return await new Promise((resolve) =>
    execFile(
      "podman",
      [
        "inspect",
        "--format",
        "{{.Id}}|{{.State.Running}}|{{.State.Pid}}",
        `project-${project_id}`,
      ],
      { cwd: "/", timeout: 30_000, env: podmanEnv() },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const [id, running, pid] = `${stdout}`.trim().split("|");
        if (running !== "true" || !/^[0-9a-f]{64}$/.test(id)) {
          return resolve(undefined);
        }
        const n = Number(pid);
        resolve(Number.isSafeInteger(n) && n > 1 ? { id, pid: n } : undefined);
      },
    ),
  );
}

export interface HostGeneration extends AgentGeneration {
  initPid: number;
}

export function hostAgentDeps(project_id: string): AgentDeps {
  return {
    generation: async () => {
      // only while the rootfs is mounted for the separate uid
      if (rootfsIdmapUid(project_id) == null) return undefined;
      const container = await inspect(project_id);
      if (container == null) return undefined;
      const gen: HostGeneration = {
        containerId: container.id,
        startCounter: projectStartCounter(project_id),
        uid: PROJECT_RUNTIME_SEPARATE_UID,
        gid: PROJECT_RUNTIME_SEPARATE_UID,
        initPid: container.pid,
      };
      return gen;
    },

    spawn: (gen, token) => {
      const launcher = projectPoolPodmanLauncher(project_id);
      const args = agentExecArgs({
        containerId: gen.containerId,
        nodePath: nodePath.startsWith("/opt/cocalc/")
          ? nodePath
          : CONTAINER_NODE,
        agentCode: ROOTFS_AGENT_CODE,
        token,
        toolsPath: CONTAINER_TOOLS,
      });
      return spawn(launcher.command, [...launcher.argsPrefix, ...args], {
        cwd: "/",
        env: podmanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      }) as unknown as ChildLike;
    },

    containerFacts: async (gen): Promise<ContainerFacts> => {
      const pid = (gen as HostGeneration).initPid;
      return {
        userns: await readlink(`/proc/${pid}/ns/user`),
        mntns: await readlink(`/proc/${pid}/ns/mnt`),
        cgroupPrefix: parseCgroup(
          await readFile(`/proc/${pid}/cgroup`, "utf8"),
        ),
      };
    },

    hostFacts: async (gen, agentPid): Promise<AgentHostFacts> => {
      const initPid = (gen as HostGeneration).initPid;
      const pidns = await readlink(`/proc/${initPid}/ns/pid`);
      const matches: number[] = [];
      for (const name of await readdir("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const status = parseProcStatus(
            await readFile(`/proc/${name}/status`, "utf8"),
          );
          if (status.nspid[status.nspid.length - 1] !== agentPid) continue;
          if ((await readlink(`/proc/${name}/ns/pid`)) !== pidns) continue;
          matches.push(Number(name));
        } catch {
          // gone, or not ours to read
        }
      }
      if (matches.length !== 1) {
        throw new Error(`found ${matches.length} host processes for the agent`);
      }
      const pid = matches[0];
      const status = parseProcStatus(
        await readFile(`/proc/${pid}/status`, "utf8"),
      );
      return {
        uid: status.uid,
        gid: status.gid,
        capEff: status.capEff,
        capAmb: status.capAmb,
        noNewPrivs: status.noNewPrivs,
        seccomp: status.seccomp,
        userns: await readlink(`/proc/${pid}/ns/user`),
        mntns: await readlink(`/proc/${pid}/ns/mnt`),
        cgroup: parseCgroup(await readFile(`/proc/${pid}/cgroup`, "utf8")),
      };
    },

    killInContainer: async (gen, token) =>
      await new Promise<void>((resolve) =>
        execFile(
          "podman",
          [
            "exec",
            "--user",
            AGENT_USER,
            gen.containerId,
            "pkill",
            "-KILL",
            "-f",
            `-- ${token}`,
          ],
          { cwd: "/", timeout: 5_000, killSignal: "SIGKILL", env: podmanEnv() },
          () => resolve(),
        ),
      ),

    now: () => Date.now(),
  };
}
