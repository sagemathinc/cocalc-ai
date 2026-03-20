import type {
  ProjectInfo,
  ProjectInfoHistory,
  Process,
} from "@cocalc/util/types/project-info/types";
import {
  summarizeWorkspaceLiveProcesses,
  summarizeWorkspaceProcessHistory,
} from "./process-summary";
import type { WorkspaceRecord } from "./types";

function workspace(root_path: string): WorkspaceRecord {
  return {
    workspace_id: "w1",
    project_id: "p1",
    root_path,
    theme: {
      title: "Workspace",
      description: "",
      color: null,
      accent_color: null,
      icon: null,
      image_blob: null,
    },
    pinned: false,
    last_used_at: null,
    last_active_path: null,
    chat_path: null,
    notice_thread_id: null,
    notice: null,
    activity_viewed_at: null,
    activity_running_at: null,
    created_at: 1,
    updated_at: 1,
    source: "manual",
  };
}

function process(
  path: string,
  opts?: Partial<Process> & { kind?: "terminal" | "jupyter" | "x11" },
): Process {
  const kind = opts?.kind ?? "terminal";
  return {
    pid: opts?.pid ?? 1,
    ppid: opts?.ppid ?? 0,
    exe: "/usr/bin/node",
    cmdline: ["node"],
    stat: {
      ppid: opts?.ppid ?? 0,
      state: "R",
      utime: 0,
      stime: 0,
      cutime: 0,
      cstime: 0,
      starttime: 1,
      nice: 0,
      num_threads: 1,
      mem: { rss: opts?.stat?.mem.rss ?? 0 },
    },
    cpu: {
      pct: opts?.cpu?.pct ?? 0,
      secs: opts?.cpu?.secs ?? 0,
    },
    uptime: 1,
    origin: opts?.origin,
    cocalc:
      kind === "terminal"
        ? { type: "terminal", path }
        : kind === "jupyter"
          ? { type: "jupyter", path }
          : { type: "x11", path },
  };
}

describe("workspace process summary", () => {
  it("aggregates live terminal and notebook usage for a workspace", () => {
    const info: ProjectInfo = {
      timestamp: 1,
      disk_usage: {
        tmp: { available: 1, free: 1, total: 2, usage: 1 },
        project: { available: 1, free: 1, total: 2, usage: 1 },
      },
      uptime: 1,
      boottime: new Date(),
      processes: {
        "1": process("/repo/a/session.term", {
          pid: 1,
          cpu: { pct: 25, secs: 5 },
          stat: {
            ppid: 0,
            state: "R",
            utime: 0,
            stime: 0,
            cutime: 0,
            cstime: 0,
            starttime: 1,
            nice: 0,
            num_threads: 1,
            mem: { rss: 200 },
          },
          kind: "terminal",
        }),
        "2": process("/repo/a/notebook.ipynb", {
          pid: 2,
          cpu: { pct: 50, secs: 10 },
          stat: {
            ppid: 0,
            state: "R",
            utime: 0,
            stime: 0,
            cutime: 0,
            cstime: 0,
            starttime: 1,
            nice: 0,
            num_threads: 1,
            mem: { rss: 300 },
          },
          kind: "jupyter",
        }),
        "3": process("/repo/b/other.term", {
          pid: 3,
          cpu: { pct: 99, secs: 10 },
          stat: {
            ppid: 0,
            state: "R",
            utime: 0,
            stime: 0,
            cutime: 0,
            cstime: 0,
            starttime: 1,
            nice: 0,
            num_threads: 1,
            mem: { rss: 999 },
          },
          kind: "terminal",
        }),
      },
    };
    expect(
      summarizeWorkspaceLiveProcesses(workspace("/repo/a"), info, "/repo"),
    ).toEqual({
      processCount: 2,
      terminals: 1,
      notebooks: 1,
      other: 0,
      cpuPct: 75,
      memRss: 500,
    });
  });

  it("aggregates historical cpu and memory trends per workspace", () => {
    const history: ProjectInfoHistory = {
      generated_at: 1,
      minutes: 60,
      samples: [
        {
          timestamp: 10,
          project: { cpu_pct: 0, mem_rss: 0, nprocs: 0 },
          processes: {
            p1: {
              id: "1",
              pid: 1,
              cpu_pct: 20,
              mem_rss: 100,
              kind: "terminal",
              path: "/repo/a/session.term",
            },
            p2: {
              id: "2",
              pid: 2,
              cpu_pct: 40,
              mem_rss: 500,
              kind: "terminal",
              path: "/repo/b/session.term",
            },
          },
        },
        {
          timestamp: 20,
          project: { cpu_pct: 0, mem_rss: 0, nprocs: 0 },
          processes: {
            p3: {
              id: "3",
              pid: 3,
              cpu_pct: 35,
              mem_rss: 120,
              kind: "jupyter",
              path: "/repo/a/notebook.ipynb",
            },
          },
        },
      ],
    };
    expect(
      summarizeWorkspaceProcessHistory(workspace("/repo/a"), history, "/repo"),
    ).toEqual({
      cpuTrend: [20, 35],
      memTrend: [100, 120],
      timestamps: [10, 20],
    });
  });
});
