import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

// The protocol suite uses node:test so it can supervise real stdio processes.
// Include it in the normal Jest-backed workspace/CI lane, not only manual QA.
test("ACP real-stdio protocol and lifecycle regressions", async () => {
  try {
    await promisify(execFile)(
      process.execPath,
      ["--test", join(__dirname, "__tests__/harness-client.test.cjs")],
      { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string };
    throw Error(
      `ACP subprocess tests failed: ${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}, 100_000);
