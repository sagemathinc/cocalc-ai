// Fake Claude CLI for first-party login lifecycle tests. No network or credentials.
const args = process.argv.slice(2);
if (process.env.ANTHROPIC_API_KEY || process.env.COCALC_BEARER_TOKEN)
  process.exit(3);

if (args.join(" ") === "auth login --claudeai") {
  process.stdout.write(
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=fixture\nPaste code here if prompted > ",
  );
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.includes("\n"))
      process.exit(input.trim() === "fixture-code" ? 0 : 1);
  });
} else if (args.join(" ") === "auth status --json") {
  process.stdout.write(
    JSON.stringify({
      loggedIn: true,
      apiProvider: "firstParty",
      subscriptionType: "max",
      email: "subscriber@example.com",
    }),
  );
} else {
  process.exit(2);
}
