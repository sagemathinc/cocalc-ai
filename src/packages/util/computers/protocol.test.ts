import {
  mergeFloors,
  leaseNotAfter,
  LOCAL_START_MAX_MS,
  parseComputerCertificate,
  parseComputerTicket,
  parsePairingTranscript,
  parseProjectAttestation,
  ProtocolError,
  site,
  ticketRefusals,
  type ComputerTicket,
  type DaemonState,
} from "./protocol";

const T = Date.UTC(2026, 9, 11, 12, 0, 0);
const FP = (c: string) => `sha256:${c.repeat(43)}`;
const SIG = "s".repeat(86);
const ACCOUNT = "0b8f1c9e-1f7c-4c55-9a3e-2f0c4e5d6a7b";
const PROJECT = "9447b19f-aabe-49d8-8aea-f870de179eb0";
const COMPUTER = "c0ffee00-1234-4abc-8def-0123456789ab";
const NETWORK = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const CLUSTER = "standalone";

function attestation(overrides: Record<string, unknown> = {}) {
  return {
    type: "cocalc-project-attestation",
    version: 1,
    site: "https://cocalc.ai",
    cluster_id: CLUSTER,
    project_id: PROJECT,
    project_bay_id: "bay-2",
    eligible: true,
    privacy_epoch: 7,
    account_id: ACCOUNT,
    home_bay_id: "bay-0",
    issued_at: T,
    not_after: T + 30_000,
    ...overrides,
  };
}

function ticketInput(overrides: Record<string, unknown> = {}) {
  return {
    type: "cocalc-computer-ticket",
    version: 1,
    ticket_id: "aaaaaaaa-1111-4222-8333-444444444444",
    operation_id: "bbbbbbbb-1111-4222-8333-444444444444",
    operation: "exec",
    request_hash: FP("r"),
    site: "https://cocalc.ai",
    cluster_id: CLUSTER,
    issuer_bay_id: "bay-0",
    home_epoch: 3,
    computer_id: COMPUTER,
    computer_key: FP("k"),
    account_id: ACCOUNT,
    agent_id: "dddddddd-1111-4222-8333-444444444444",
    agent_network_id: NETWORK,
    source_project_id: PROJECT,
    attestation: { kid: FP("p"), payload: attestation(), sig: SIG },
    computer_epoch: 5,
    policy_epoch: 2,
    ceiling_hash: FP("c"),
    run_id: "eeeeeeee-1111-4222-8333-444444444444",
    run_expires_at: T + 3_600_000,
    pop_key: "MCowBQYDK2VwAyEA" + "x".repeat(43),
    issued_at: T + 1_000,
    start_by: T + 20_000,
    max_runtime_ms: 600_000,
    limits: { max_bytes: null, concurrency: 1 },
    ...overrides,
  };
}

function state(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    site: "https://cocalc.ai",
    cluster_id: CLUSTER,
    computer_id: COMPUTER,
    computer_key: FP("k"),
    account_id: ACCOUNT,
    home_bay_id: "bay-0",
    agent_network_id: NETWORK,
    ceiling_hash: FP("c"),
    policy_epoch: 2,
    floors: {
      home_epoch: 3,
      computer_epoch: 5,
      projects: { [PROJECT]: 7 },
    },
    ...overrides,
  };
}

const now = { hub_now: T + 2_000, since_receipt_ms: 100 };

describe("parseComputerTicket", () => {
  it("parses a valid ticket", () => {
    const ticket = parseComputerTicket(ticketInput());
    expect(ticket.operation).toBe("exec");
    expect(ticket.attestation.payload.privacy_epoch).toBe(7);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown version", { version: 2 }],
    ["an unknown operation", { operation: "shell" }],
    ["an unknown field", { sudo: true }],
    ["a long start window", { start_by: T + 1_000 + 3 * 60_000 }],
    ["start before issue", { start_by: T }],
    ["zero runtime", { max_runtime_ms: 0 }],
    ["zero concurrency", { limits: { max_bytes: null, concurrency: 0 } }],
    ["a bad fingerprint", { computer_key: "sha1:abc" }],
    ["a non-UUID", { account_id: "root" }],
    [
      "an attestation living too long",
      {
        attestation: {
          kid: FP("p"),
          payload: attestation({ not_after: T + 31_000 }),
          sig: SIG,
        },
      },
    ],
    ["an implausible time", { issued_at: 5 }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => parseComputerTicket(ticketInput(overrides))).toThrow(
      ProtocolError,
    );
  });

  it("refuses a missing field", () => {
    const { pop_key: _pop, ...missing } = ticketInput();
    expect(() => parseComputerTicket(missing)).toThrow(/missing 'pop_key'/);
  });
});

describe("ticketRefusals", () => {
  const ticket = (overrides: Record<string, unknown> = {}): ComputerTicket =>
    parseComputerTicket(ticketInput(overrides));

  it("admits a ticket that matches everything", () => {
    expect(ticketRefusals(ticket(), state(), now)).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      "another computer",
      { computer_id: "c0ffee00-1234-4abc-8def-0123456789ac" },
      /another computer/,
    ],
    [
      "another key (re-paired computer)",
      { computer_key: FP("z") },
      /another key/,
    ],
    [
      "another account",
      { account_id: "0b8f1c9e-1f7c-4c55-9a3e-2f0c4e5d6a7c" },
      /another account/,
    ],
    [
      "another network",
      { agent_network_id: "11111111-2222-4333-8444-555555555556" },
      /agent network/,
    ],
    ["another site", { site: "https://evil.example" }, /another site/],
    ["another issuer bay", { issuer_bay_id: "bay-9" }, /home bay/],
    ["another ceiling", { ceiling_hash: FP("d") }, /ceiling/],
    ["an old effective policy", { policy_epoch: 1 }, /effective policy/],
    ["a stale home epoch (rehomed)", { home_epoch: 2 }, /home bay epoch/],
    [
      "a stale computer epoch (revoked)",
      { computer_epoch: 4 },
      /computer epoch/,
    ],
    [
      "a ticket outliving the agent run",
      { run_expires_at: T + 10_000 },
      /outlives the agent run/,
    ],
  ])("refuses %s", (_label, overrides, reason) => {
    expect(ticketRefusals(ticket(overrides), state(), now).join("; ")).toMatch(
      reason,
    );
  });

  describe("the privacy fence", () => {
    it("refuses an ineligible project", () => {
      const t = ticket({
        attestation: {
          kid: FP("p"),
          payload: attestation({ eligible: false }),
          sig: SIG,
        },
      });
      expect(ticketRefusals(t, state(), now).join()).toMatch(/not eligible/);
    });

    it("refuses an attestation for another project", () => {
      const t = ticket({
        attestation: {
          kid: FP("p"),
          payload: attestation({
            project_id: "9447b19f-aabe-49d8-8aea-f870de179eb1",
          }),
          sig: SIG,
        },
      });
      expect(ticketRefusals(t, state(), now).join()).toMatch(/another project/);
    });

    it("refuses a privacy epoch below the pushed floor (collaborator added)", () => {
      const s = state();
      s.floors.projects[PROJECT] = 8;
      expect(ticketRefusals(ticket(), s, now).join()).toMatch(
        /privacy epoch is stale/,
      );
    });

    it("refuses a ticket whose start window outlives its attestation", () => {
      // Issued one instant before the attestation expires, with the usual
      // start window: it must not be usable after the attestation ends.
      const t = ticket({ issued_at: T + 29_000, start_by: T + 60_000 });
      expect(
        ticketRefusals(t, state(), {
          hub_now: T + 29_500,
          since_receipt_ms: 10,
        }).join(),
      ).toMatch(/outlives the project attestation/);
    });

    it("refuses admission after the attestation expired, even with every push lost", () => {
      const t = ticket({ issued_at: T + 20_000, start_by: T + 30_000 });
      expect(
        ticketRefusals(t, state(), {
          hub_now: T + 30_001,
          since_receipt_ms: 10,
        }).join(),
      ).toMatch(/attestation expired|start window passed/);
    });

    it("leases never outlive the attestation", () => {
      const a = parseProjectAttestation(attestation());
      expect(leaseNotAfter(a, T + 60_000)).toBe(T + 30_000);
      expect(leaseNotAfter(a, T + 10_000)).toBe(T + 10_000);
    });
  });

  describe("time", () => {
    it("refuses a ticket dated far in the future", () => {
      const t = ticket({
        issued_at: T + 100_000,
        start_by: T + 110_000,
        attestation: {
          kid: FP("p"),
          payload: attestation({
            issued_at: T + 100_000,
            not_after: T + 120_000,
          }),
          sig: SIG,
        },
      });
      expect(ticketRefusals(t, state(), now).join()).toMatch(/future/);
    });

    it("refuses a ticket past its start window", () => {
      expect(
        ticketRefusals(ticket(), state(), {
          hub_now: T + 25_000,
          since_receipt_ms: 0,
        }).join(),
      ).toMatch(/start window passed/);
    });

    it("refuses a ticket that waited too long locally", () => {
      expect(
        ticketRefusals(ticket(), state(), {
          hub_now: T + 2_000,
          since_receipt_ms: LOCAL_START_MAX_MS + 1,
        }).join(),
      ).toMatch(/waited too long/);
    });
  });
});

describe("parsePairingTranscript", () => {
  const transcript = {
    type: "cocalc-computer-pairing",
    version: 1,
    site: "https://cocalc.ai",
    cluster_id: CLUSTER,
    request_id: "R-7Q2M9K4WXZ",
    account_id: ACCOUNT,
    policy_hash: FP("h"),
    signing_key: FP("s"),
    agreement_key: FP("a"),
    client_nonce: "n".repeat(43),
    server_nonce: "m".repeat(43),
    machine: {
      hostname: "macbook",
      os: "darwin",
      arch: "arm64",
      user: "wstein",
    },
  };

  it("parses", () => {
    expect(parsePairingTranscript(transcript).request_id).toBe("R-7Q2M9K4WXZ");
  });

  it("refuses one key used for both signing and agreement", () => {
    expect(() =>
      parsePairingTranscript({ ...transcript, agreement_key: FP("s") }),
    ).toThrow(/differ/);
  });

  it("refuses control characters in machine labels", () => {
    expect(() =>
      parsePairingTranscript({
        ...transcript,
        machine: { ...transcript.machine, user: "w\nroot" },
      }),
    ).toThrow(ProtocolError);
  });

  it("refuses a site that isn't exactly normalized", () => {
    expect(() =>
      parsePairingTranscript({ ...transcript, site: "https://CoCalc.ai/" }),
    ).toThrow(/written as/);
  });
});

describe("parseComputerCertificate", () => {
  it("binds both keys and the transcript; refuses empty validity", () => {
    const cert = {
      type: "cocalc-computer-certificate",
      version: 1,
      site: "https://cocalc.ai",
      cluster_id: CLUSTER,
      computer_id: COMPUTER,
      account_id: ACCOUNT,
      home_bay_id: "bay-0",
      home_epoch: 3,
      signing_key: FP("s"),
      signing_public_key: "MCowBQYDK2VwAyEA" + "x".repeat(43),
      agreement_key: FP("a"),
      transcript_hash: FP("t"),
      ceiling_hash: FP("c"),
      not_before: T,
      not_after: T + 86_400_000,
    };
    expect(parseComputerCertificate(cert).agreement_key).toBe(FP("a"));
    expect(() => parseComputerCertificate({ ...cert, not_after: T })).toThrow(
      /empty/,
    );
  });
});

describe("site", () => {
  it.each([
    ["https://cocalc.ai", "https://cocalc.ai"],
    ["https://cocalc.ai/", "https://cocalc.ai"],
    ["https://lite1b.cocalc.ai:8443", "https://lite1b.cocalc.ai:8443"],
    ["http://localhost:9100", "http://localhost:9100"],
  ])("accepts %s", (input, expected) => {
    expect(site(input)).toBe(expected);
  });

  it.each([
    "http://cocalc.ai",
    "https://user:pw@cocalc.ai",
    "https://cocalc.ai/projects",
    "https://cocalc.ai?x=1",
    "https://cocalc.ai:443",
    "cocalc.ai",
  ])("refuses %s", (input) => {
    expect(() => site(input)).toThrow(ProtocolError);
  });
});

describe("computer floors", () => {
  const project = "4f8d2a3e-1b6c-4c1e-9a7d-2e5f6a7b8c9d";
  const floors = {
    home_epoch: 0,
    computer_epoch: 3,
    projects: { [project]: 7 },
  };

  it("only ever raises floors, so an old state replayed changes nothing", () => {
    const current = {
      home_epoch: 1,
      computer_epoch: 5,
      projects: { [project]: 9, other: 2 },
    };
    const old = mergeFloors(current, floors);
    expect(old).toEqual({ floors: current, raised: false });
    const newer = mergeFloors(current, {
      home_epoch: 1,
      computer_epoch: 6,
      projects: { [project]: 10 },
    });
    expect(newer).toEqual({
      floors: {
        home_epoch: 1,
        computer_epoch: 6,
        projects: { [project]: 10, other: 2 },
      },
      raised: true,
    });
  });
});
