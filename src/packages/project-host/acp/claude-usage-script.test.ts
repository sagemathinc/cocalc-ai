import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeUsageScript } from "./claude-usage-script";

test("usage probe initializes the SDK without submitting a prompt or enabling tools", async () => {
  const sdk = `export function query({ prompt, options }) {
    if (options.tools.length || options.settingSources.length || options.plugins.length || Object.keys(options.mcpServers).length || options.persistSession !== false) throw Error('unsafe probe');
    let initialized = false;
    let submitted = false;
    (async () => { for await (const message of prompt) submitted = true; })();
    return {
      async initializationResult() { initialized = true; },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors }) {
        if (!initialized || !skipBehaviors || submitted) throw Error('not usage-only');
        return { rate_limits_available: true, rate_limits: { five_hour: { utilization: 8, resets_at: null } } };
      },
      close() { if (submitted) throw Error('prompt submitted'); }
    };
  }`;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      claudeUsageScript(
        `data:text/javascript;base64,${Buffer.from(sdk).toString("base64")}`,
      ),
    ],
    { timeout: 5000 },
  );
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).rate_limits.five_hour.utilization).toBe(8);
});
