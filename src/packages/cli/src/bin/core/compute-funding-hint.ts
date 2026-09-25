// Recovery advice only: preserve server denial codes and never retry spending here.
export function computeFundingHint(
  command: string,
  code: string,
  message: string,
): string | undefined {
  if (
    !/^(vm(?: |$)|computeFunding(?: |$)|compute-funding(?: |$))/.test(command)
  )
    return;
  if (code === "funding_home_bay_required")
    return "Use the account's authoritative home-bay CLI profile. Project access does not confer payer authority; do not retry against an arbitrary bay.";
  if (command.startsWith("vm personal-funding")) {
    if (
      /home[- ]volume.*(?:not yet available|not supported|unavailable)/i.test(
        message,
      )
    )
      return "Personal home-volume handoff is not supported yet. Do not omit attached volume scope or use a legacy funding-lane change to bypass this restriction.";
    if (code === "account_auth_required")
      return "Use your own account-authenticated CLI session and the returned isolated browser approval page. An agent cannot approve personal funding; never share passwords, tokens or approval codes.";
    if (
      code.startsWith("funding_") ||
      code === "insufficient_funding" ||
      code === "invalid_funding_request" ||
      /personal.*(?:not.*available|approval|approved|consent)/i.test(message)
    )
      return "Read `cocalc vm funding VM_UUID --json` and `cocalc vm personal-funding status VM_UUID --json`. Review exact consent/funding versions; changed terms need a new proposal and isolated browser approval. Never automatically increase the cap, extend the deadline, replace versions, or fall back to personal/legacy funding.";
  }
  if (
    code.startsWith("funding_") ||
    code === "insufficient_funding" ||
    code === "invalid_funding_request"
  )
    return "Account holders can inspect `cocalc compute-funding sources --include-inactive --json`; authorized VM readers can inspect `cocalc vm funding VM_UUID --json`. Check source availability, reservations, timestamps and deadlines. Keep --funding-payer, --funding-pool and --funding-grant together; removing them selects personal funding, not the course allowance. Stale or missing funding is unknown, not zero. Do not retry with another payer without approval.";
}
