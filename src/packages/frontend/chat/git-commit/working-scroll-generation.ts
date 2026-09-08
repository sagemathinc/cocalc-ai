import { useEffect, useState } from "react";
import type { GitShowFile } from "./types";

// A view-state identity for the loaded patch, not a filesystem mutation token.
export async function workingScrollGeneration(
  files: readonly GitShowFile[],
  truncated: boolean,
): Promise<string | undefined> {
  if (truncated || !globalThis.crypto?.subtle) return;
  let lines = 0;
  let characters = 0;
  for (const file of files) {
    lines += file.lines.length;
    characters += file.path.length;
    for (const line of file.lines) characters += line.length;
    if (lines > 20_000 || characters > 4 * 1024 * 1024) return;
  }
  const input = new TextEncoder().encode(
    JSON.stringify(files.map(({ path, lines }) => [path, lines])),
  );
  if (input.byteLength > 4 * 1024 * 1024) return;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function useWorkingScrollGeneration(
  files: GitShowFile[],
  truncated: boolean,
  enabled: boolean,
): string | undefined {
  const [result, setResult] = useState<{
    files: GitShowFile[];
    generation?: string;
  }>();
  useEffect(() => {
    if (!enabled || truncated) return;
    let cancelled = false;
    void workingScrollGeneration(files, truncated)
      .then((generation) => {
        if (!cancelled) setResult({ files, generation });
      })
      .catch(() => {
        // Optional scroll persistence must not prevent reading the diff.
        if (!cancelled) setResult({ files });
      });
    return () => {
      cancelled = true;
    };
  }, [files, truncated, enabled]);
  return enabled && !truncated && result?.files === files
    ? result.generation
    : undefined;
}
