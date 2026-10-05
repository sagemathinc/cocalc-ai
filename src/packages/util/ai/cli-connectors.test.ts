import { cliConnectorTurnContext, cloudflareScopes } from "./cli-connectors";

test("no context without connector tokens", () => {
  expect(cliConnectorTurnContext([])).toBeUndefined();
});

test("names each connected account and asks for care", () => {
  const text = cliConnectorTurnContext([
    { connector: "cloudflare", description: "API token" },
    { connector: "github", description: "@octo" },
  ])!;
  expect(text.startsWith("[CLI connectors]")).toBe(true);
  expect(text.indexOf("GitHub (@octo)")).toBeLessThan(
    text.indexOf("Cloudflare (API token)"),
  );
  expect(text).toContain("confirm before");
  expect(text).toContain("never print");
});

test("Cloudflare scopes always include the base scopes, once", () => {
  const scopes = cloudflareScopes(["workers", "workers"]);
  expect(scopes).toContain("account:read");
  expect(new Set(scopes).size).toBe(scopes.length);
});
