// Fake Claude CLI `setup-token` for sign-in lifecycle tests, run in a
// pseudo-terminal like the real terminal UI. No network or credentials.
const args = process.argv.slice(2);
if (process.env.ANTHROPIC_API_KEY || process.env.COCALC_BEARER_TOKEN)
  process.exit(3);
if (args.join(" ") !== "setup-token") process.exit(2);

const ESC = String.fromCharCode(27);
// The real UI colors text and draws some spaces as cursor moves.
const say = (text) =>
  process.stdout.write(
    `${ESC}[2m${text.split(" ").join(`${ESC}[1C`)}${ESC}[22m\r\n`,
  );
say("Welcome to Claude Code");
say("Browser didn't open? Use the url below to sign in");
process.stdout.write(
  "https://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&state=fixture\r\n",
);
process.stdout.write("Paste code here if prompted > ");
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!/[\r\n]/.test(input)) return;
  if (input.trim() === "fixture-code") {
    say("Long-lived authentication token created successfully!");
    say("Your OAuth token (valid for 365 days):");
    process.stdout.write(
      `${ESC}[33msk-ant-oat01-${"Fixture_token-0123456789".repeat(3)}${ESC}[39m\r\n`,
    );
    setTimeout(() => process.exit(0), 50);
  } else {
    // The real UI waits for Enter to retry rather than exiting.
    say("OAuth error: Request failed with status code 400");
    say("Press Enter to retry.");
    input = "";
  }
});
