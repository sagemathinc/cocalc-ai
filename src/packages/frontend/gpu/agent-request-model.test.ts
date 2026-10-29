import type { GpuAgentRequestView } from "@cocalc/conat/hub/api/gpu";
import {
  activeApprovals,
  agentLabel,
  exactRequest,
  pendingRequests,
  requestLines,
  usd,
} from "./agent-request-model";

const VIEW: GpuAgentRequestView = {
  request_id: "11111111-1000-4000-8000-000000000001",
  project_id: "00000000-1000-4000-8000-0000000000aa",
  principal_kind: "chat_session",
  operation_id: "cli-abc",
  payload: {
    spec: {
      gpu_type_id: "NVIDIA GeForce RTX 4090",
      gpu_count: 2,
      image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
      max_runtime_minutes: 60,
      container_disk_gb: 20,
      ports: ["8888/http"],
      env: { MODE: "train" },
    },
    hourly_usd: "1.3800000000",
    max_cost_usd: "1.42",
    max_pods: 1,
  },
  payload_hash: "a".repeat(64),
  state: "pending",
  created: "2026-10-28T12:00:00.000Z",
  expires_at: "2026-10-28T12:30:00.000Z",
};

describe("agent request model", () => {
  it("formats money for people", () => {
    expect(usd("1.3800000000", true)).toBe("$1.38/hour");
    expect(usd("0.004")).toBe("$0.0040");
    expect(usd("12")).toBe("$12.00");
  });

  it("names a chat session plainly and a registered agent only when resolved", () => {
    expect(agentLabel(VIEW)).toBe("This chat session");
    expect(
      agentLabel({
        ...VIEW,
        principal_kind: "registered_agent",
        agent_id: "22222222-1000-4000-8000-000000000002",
        run_id: "33333333-1000-4000-8000-000000000003",
      }),
    ).toBe("Agent 22222222 (run 33333333)");
    // no id: never invent one
    expect(agentLabel({ ...VIEW, principal_kind: "registered_agent" })).toBe(
      "This chat session",
    );
  });

  it("says every part of the stored launch, and the bound", () => {
    const lines = Object.fromEntries(
      requestLines(VIEW).map(({ label, value }) => [label, value]),
    );
    expect(lines).toMatchObject({
      "Asked by": "This chat session",
      GPU: "2 x NVIDIA GeForce RTX 4090",
      Cloud: "Secure Cloud",
      Image: VIEW.payload.spec.image,
      "Runs at most": "60 minutes, then CoCalc terminates it",
      Storage: "20 GB disk",
      Ports: "8888/http",
      Environment: "MODE=train",
      Price: "$1.38/hour at RunPod's list price",
      "Most it can cost": "$1.42 (GPUs and disk for the whole runtime)",
    });
  });

  it("shows the exact payload and hash that approval names", () => {
    expect(JSON.parse(exactRequest(VIEW))).toEqual({
      payload: VIEW.payload,
      payload_hash: VIEW.payload_hash,
    });
  });

  it("separates pending requests from active approvals", () => {
    const approved = {
      ...VIEW,
      request_id: "r2",
      state: "approved" as const,
      grant: {
        grant_id: "g2",
        state: "active" as const,
        expires_at: VIEW.expires_at,
        launches_used: 0,
      },
    };
    const ended = {
      ...approved,
      request_id: "r3",
      grant: { ...approved.grant, grant_id: "g3", state: "revoked" as const },
    };
    expect(pendingRequests([VIEW, approved, ended])).toEqual([VIEW]);
    expect(activeApprovals([VIEW, approved, ended])).toEqual([approved]);
  });
});
