import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

// Version strings cannot distinguish a patched build from its upstream release.
// Stream large executables instead of loading them into memory at startup.
export async function matchesBinarySha256(
  path: string,
  expected: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
    return hash.digest("hex") === expected;
  } catch {
    return false;
  }
}
