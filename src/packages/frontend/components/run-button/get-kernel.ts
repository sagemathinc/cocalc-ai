/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS } from "immutable";

import infoToMode from "@cocalc/frontend/editors/slate/elements/code-block/info-to-mode";
import detectLanguage from "@cocalc/frontend/misc/detect-language";
import { closest_kernel_match, field_cmp } from "@cocalc/util/misc";
import { getKernelInfo } from "./kernel-info";

export default async function getKernel({
  input,
  history,
  info,
  project_id,
}): Promise<string> {
  return await guessKernel({
    info,
    code: (history ?? []).concat([input ?? ""]).join("\n"),
    project_id,
  });
}

async function guessKernel({ info, code, project_id }): Promise<string> {
  const kernelInfo = await getKernelInfo(project_id);
  if (kernelInfo.length == 0) {
    throw Error("there are no available kernels");
  }
  if (!info) {
    // Guess locally since nothing was given. Use Python when heuristics cannot identify the language.
    const guess = detectLanguage(code);
    // TODO: should restrict guesses to available kernels...
    info = guess == "txt" ? "py" : guess;
  }

  const mode = infoToMode(info, { preferKernel: true });
  const matches: { name: string; priority: number }[] = [];
  for (const { name, display_name, language, metadata } of kernelInfo) {
    if (name == mode) {
      // mode **exactly** matches a known kernel, so obviously use that.
      return name;
    }
    if (mode == language || mode == display_name.toLowerCase()) {
      matches.push({ name, priority: metadata?.cocalc?.priority ?? 0 });
    }
  }
  if (matches.length > 0) {
    matches.sort(field_cmp("priority"));
    return matches[matches.length - 1].name;
  }
  if (info.includes("kernel") || info.includes("engine")) {
    // No match but they are clearly attempting to use an explicit kernel, so use closest_kernel_match.
    // TODO: it's not efficient converting to immutable.js constantly...
    closest_kernel_match(mode, fromJS(kernelInfo) as any).get("name");
  }
  // Let them decide explicitly.
  return "";
}
