// Fake Claude CLI `setup-token` that never returns a token, but turns
// terminal echo on and redraws what it reads: what the user pastes must never
// be taken for a token. No network or credentials.
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.join(" ") !== "setup-token") process.exit(2);

spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
process.stdout.write(
  "https://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&state=fixture\r\n",
);
process.stdout.write("Paste code here if prompted > ");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  process.stdout.write(`\r\n${chunk.trim()}\r\n`);
});
