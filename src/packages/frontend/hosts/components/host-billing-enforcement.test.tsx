import { renderToStaticMarkup } from "react-dom/server";
import type { Host } from "@cocalc/conat/hub/api/hosts";
import {
  HostBillingEnforcementStatus,
  hostBillingEnforcementBlocksStart,
  hostBillingEnforcementSearchText,
} from "./host-billing-enforcement";

function hostWithBilling(
  billing_enforcement: Host["billing_enforcement"],
): Host {
  return {
    id: "host-1",
    name: "Host",
    owner: "account-1",
    region: "us-central1",
    size: "small",
    gpu: false,
    status: "off",
    billing_enforcement,
  };
}

describe("host billing enforcement ui", () => {
  it("renders actionable billing state details", () => {
    const host = hostWithBilling({
      state: "stopped_billing_blocked",
      reason: "prepaid balance is exhausted",
      recovery_actions: ["add_funds", "support_limit_increase"],
    });

    const html = renderToStaticMarkup(
      <HostBillingEnforcementStatus host={host} />,
    );

    expect(html).toContain("Stopped: billing required");
    expect(html).toContain("prepaid balance is exhausted");
    expect(html).toContain("Add funds");
    expect(hostBillingEnforcementBlocksStart(host)).toBe(true);
  });

  it("does not block start for warning-only state", () => {
    const host = hostWithBilling({
      state: "at_risk",
      reason_code: "prepaid_runway_low",
      reason: "prepaid dedicated-host runway is too low",
      recovery_actions: ["add_funds"],
    });

    expect(hostBillingEnforcementBlocksStart(host)).toBe(false);
    expect(hostBillingEnforcementSearchText(host)).toContain(
      "prepaid_runway_low",
    );
  });

  it("ignores ok enforcement metadata", () => {
    const host = hostWithBilling({ state: "ok" });

    expect(hostBillingEnforcementBlocksStart(host)).toBe(false);
    expect(hostBillingEnforcementSearchText(host)).toBe("");
    expect(
      renderToStaticMarkup(<HostBillingEnforcementStatus host={host} />),
    ).toBe("");
  });
});
