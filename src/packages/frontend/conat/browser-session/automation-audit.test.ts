import {
  classifyCentralBrowserAutomationAuditEvent,
  createBrowserAutomationAuditBuffer,
} from "./automation-audit";

describe("browser automation audit buffer", () => {
  it("lists filtered automation decisions and tracks dropped rows", () => {
    const audit = createBrowserAutomationAuditBuffer(2);
    audit.append({
      kind: "exec",
      decision: "allow",
      project_id: "project-1",
      posture: "prod",
      mode: "quickjs_wasm",
    });
    audit.append({
      kind: "action",
      decision: "deny",
      project_id: "project-1",
      posture: "prod",
      action_name: "click",
      reason: "blocked",
    });
    audit.append({
      kind: "sandbox_action",
      decision: "allow",
      project_id: "project-1",
      posture: "prod",
      action_name: "type",
    });

    expect(audit.list()).toMatchObject({
      dropped: 1,
      total_buffered: 2,
      next_seq: 3,
    });
    expect(audit.list().events.map((event) => event.kind)).toEqual([
      "action",
      "sandbox_action",
    ]);
    expect(
      audit.list({ decisions: ["deny"] }).events.map((event) => event.reason),
    ).toEqual(["blocked"]);
    expect(
      audit.list({ after_seq: 2 }).events.map((event) => event.seq),
    ).toEqual([3]);
  });

  it("clears buffered events without resetting sequence numbers", () => {
    const audit = createBrowserAutomationAuditBuffer();
    audit.append({ kind: "exec", decision: "allow" });

    expect(audit.clear()).toEqual({ ok: true, cleared: 1, next_seq: 1 });
    expect(audit.list()).toMatchObject({
      events: [],
      next_seq: 1,
      total_buffered: 0,
    });
  });

  it("classifies only high-risk central audit events", () => {
    expect(
      classifyCentralBrowserAutomationAuditEvent({
        kind: "exec",
        decision: "allow",
        mode: "raw_js",
      }),
    ).toBe("browser_raw_exec_allowed");
    expect(
      classifyCentralBrowserAutomationAuditEvent({
        kind: "exec",
        decision: "deny",
        requested_raw_exec: true,
      }),
    ).toBe("browser_raw_exec_denied");
    expect(
      classifyCentralBrowserAutomationAuditEvent({
        kind: "start_exec",
        decision: "deny",
      }),
    ).toBe("browser_async_exec_denied");
    expect(
      classifyCentralBrowserAutomationAuditEvent({
        kind: "sandbox_action",
        decision: "deny",
        action_name: "click",
      }),
    ).toBe("browser_quickjs_host_action_denied");
    expect(
      classifyCentralBrowserAutomationAuditEvent({
        kind: "action",
        decision: "deny",
        action_name: "click",
      }),
    ).toBeUndefined();
    expect(
      classifyCentralBrowserAutomationAuditEvent({
        kind: "exec",
        decision: "allow",
        mode: "quickjs_wasm",
      }),
    ).toBeUndefined();
  });
});
