import {
  encodeRuntimeSponsorDenial,
  extractRuntimeSponsorDenial,
} from "./runtime-sponsor-denial";

describe("runtime sponsor denial", () => {
  const denial = {
    code: "runtime_sponsor_slots_exhausted" as const,
    sponsor_account_id: "6426eb12-2e1e-4dcb-b7e5-ed891a129f4b",
    limit: 1,
    current: 1,
    active_projects: [
      {
        project_id: "6132933e-3ca3-49e2-8082-832c34e40968",
        state: "running" as const,
        title: "host-0",
        visible: true,
        can_stop: true,
      },
    ],
    sponsor_display_name: "Bella Boo",
    can_upgrade: true,
    can_change_sponsor: false,
  };

  it("extracts a denial from an exact encoded error", () => {
    expect(
      extractRuntimeSponsorDenial(encodeRuntimeSponsorDenial(denial)),
    ).toEqual(denial);
  });

  it("extracts a denial from an Error with transport suffix text", () => {
    const err = new Error(
      `${encodeRuntimeSponsorDenial(denial)} - callHub: subject='hub.account.6426eb12-2e1e-4dcb-b7e5-ed891a129f4b.api', name='projects.start', code='undefined'`,
    );

    expect(extractRuntimeSponsorDenial(err)).toEqual(denial);
  });
});
