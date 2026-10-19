const rows = new Map<string, any>();

jest.mock("../../sqlite/database", () => ({
  getRow: (table: string, pk: string) => rows.get(`${table}:${pk}`),
  upsertRow: (table: string, pk: string, row: any) =>
    rows.set(`${table}:${pk}`, row),
}));

import { agentUserTimeContext, rememberAgentUserLocale } from "../user-locale";

const account = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-17T19:45:00Z");

describe("agent user locale on the host", () => {
  beforeEach(() => rows.clear());

  it("remembers a browser's locale for turns that no browser started", () => {
    const seattle = {
      time_zone: "America/Los_Angeles",
      city: "Seattle",
      region: "Washington",
      country_code: "US",
    };
    expect(rememberAgentUserLocale(account, seattle)).toEqual(seattle);
    // A sensor wake or another agent's message carries no locale.
    expect(agentUserTimeContext(account, undefined, now)).toContain(
      "12:45 PM PDT (America/Los_Angeles). The user is near Seattle, Washington, US.",
    );
    // Remembered per account.
    expect(agentUserTimeContext(other, undefined, now)).toBe(undefined);
  });

  it("replaces the remembered place, e.g. after location is turned off", () => {
    rememberAgentUserLocale(account, {
      time_zone: "America/Los_Angeles",
      city: "Seattle",
    });
    rememberAgentUserLocale(account, { time_zone: "America/Los_Angeles" });
    const line = agentUserTimeContext(account, undefined, now);
    expect(line).toContain("(America/Los_Angeles)");
    expect(line).not.toContain("Seattle");
  });

  it("ignores invalid input without forgetting a valid locale", () => {
    rememberAgentUserLocale(account, { time_zone: "Europe/Paris" });
    expect(
      rememberAgentUserLocale(account, { time_zone: "Not/AZone" }),
    ).toEqual({ time_zone: "Europe/Paris" });
    expect(rememberAgentUserLocale("not-an-account", undefined)).toBe(
      undefined,
    );
  });
});
