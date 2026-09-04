/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  start_project,
  exec,
} from "@cocalc/frontend/frame-editors/generic/client";
import { map as awaitMap } from "awaiting";
import { MAX_PARALLEL_TASKS } from "./actions";

export type ResultStatus = "succeeded" | "failed" | "timed_out";
export type ResultPhase = "starting" | "running";

export type Result = {
  project_id: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  timeout?: number;
  total_time: number;
  status: ResultStatus;
  phase: ResultPhase;
};

export function isTimeoutError(err: unknown): boolean {
  const message = `${err}`.toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("killed command")
  );
}

export async function run_in_all_projects(
  project_ids: string[],
  command: string,
  args?: string[],
  timeout?: number,
  log?: (result: Result) => void,
): Promise<Result[]> {
  const task = async (project_id: string): Promise<Result> => {
    const start = Date.now();
    let phase: ResultPhase = "starting";
    let result: Result;
    try {
      await start_project(project_id, 60);
      phase = "running";
      const output = await exec({
        project_id,
        command,
        args,
        timeout,
        err_on_exit: false,
      });
      result = {
        ...output,
        project_id,
        timeout,
        total_time: (Date.now() - start) / 1000,
        status: output.exit_code === 0 ? "succeeded" : "failed",
        phase,
      };
    } catch (err) {
      result = {
        project_id,
        stdout: "",
        stderr: `${err}`,
        exit_code: -1,
        total_time: (Date.now() - start) / 1000,
        timeout,
        status: isTimeoutError(err) ? "timed_out" : "failed",
        phase,
      };
    }
    try {
      log?.(result);
    } catch {
      // Live progress is best effort; the final result list is authoritative.
    }
    return result;
  };

  return await awaitMap(project_ids, MAX_PARALLEL_TASKS, task);
}
