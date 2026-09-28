import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { pinClaudeProvider } from "./qualified-harness-entry";

const fixture = String.raw`
const lines = require("node:readline").createInterface({input: process.stdin});
let config;
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "providers/set") config = req.params;
  const result = req.method === "providers/list" ? { providers: [{
    providerId: "main", current: { apiType: "anthropic", baseUrl: process.env.WRONG_ROUTE || config.baseUrl }
  }] } : {};
  console.log(JSON.stringify({jsonrpc:"2.0", id:req.id, result}));
});
`;

test.each([false, true])(
  "provider pinning verifies the selected route, conflicting=%s",
  async (conflict) => {
    const child = spawn(process.execPath, ["-e", fixture], {
      env: { ...(conflict ? { WRONG_ROUTE: "https://wrong.invalid" } : {}) },
      stdio: "pipe",
    });
    const closed = once(child, "close");
    const output = new PassThrough();
    let forwarded = "";
    output.on("data", (chunk) => {
      forwarded += chunk;
    });
    try {
      const pinned = pinClaudeProvider(child, "http://127.0.0.1:1234", output);
      if (conflict)
        await expect(pinned).rejects.toThrow("could not be verified");
      else await pinned;
      expect(forwarded).toBe("");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  },
);
