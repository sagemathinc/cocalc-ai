/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// cSpell:ignore texcount htmlcore

import {
  exec,
  type ExecOutput,
} from "@cocalc/frontend/frame-editors/generic/client";
import { path_split } from "@cocalc/util/misc";

// an enhancement might be to generate html via $ texcount -htmlcore
// but that doesn't format it in a substantially better way

export async function count_words(
  project_id: string,
  path: string,
  time?: number,
): Promise<ExecOutput> {
  const { head, tail } = path_split(path);
  try {
    return await exec(
      {
        command: "texcount",
        args: [tail],
        project_id: project_id,
        path: head,
        err_on_exit: false,
        aggregate: time,
      },
      path,
    );
  } catch (err) {
    const detail = stringifyExecError(err);
    return {
      type: "blocking",
      stdout: "",
      stderr: [
        `Unable to run texcount for ${tail}.`,
        "The word count tool may not be installed in this project environment.",
        detail ? `\n${detail}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      exit_code: 1,
      time: Date.now(),
    };
  }
}

function stringifyExecError(err: unknown): string {
  if (err instanceof Error) return err.message || `${err}`;
  if (typeof err === "string") return err;
  if (err == null) return "";
  if (typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
    try {
      const encoded = JSON.stringify(err);
      return encoded === "{}" ? "" : encoded;
    } catch {
      // fall through
    }
  }
  return `${err}`;
}
