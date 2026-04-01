/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ExecOutput } from "@cocalc/conat/files/fs";
import type { ProjectStorageBreakdown } from "@cocalc/conat/hub/api/projects";

export function parseDustOutput(
  output: ExecOutput,
  path: string,
): ProjectStorageBreakdown {
  const { stdout, stderr, code, truncated } = output;
  const errText = Buffer.from(stderr).toString().trim();
  if (truncated) {
    throw new Error(
      `Disk usage scan for '${path}' took too long on this large folder. Browse into a smaller folder and try again.`,
    );
  }
  if (code) {
    throw new Error(errText || `dust failed for ${path}`);
  }
  const text = Buffer.from(stdout).toString();
  if (!text.trim()) {
    throw new Error(
      errText ||
        `Disk usage scan for '${path}' returned incomplete data. Try again or browse into a smaller folder.`,
    );
  }
  let parsed: {
    size: string;
    name: string;
    children?: { size: string; name: string }[];
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Disk usage scan for '${path}' returned invalid data. Try again or browse into a smaller folder.`,
    );
  }
  const absolutePath = parsed.name;
  const prefixLength = absolutePath.length + 1;
  return {
    path: absolutePath,
    bytes: parseInt(parsed.size.slice(0, -1)),
    children: (parsed.children ?? []).map(({ size, name }) => ({
      bytes: parseInt(size.slice(0, -1)),
      path: name.slice(prefixLength),
    })),
    collected_at: new Date().toISOString(),
  };
}
