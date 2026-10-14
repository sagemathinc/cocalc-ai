/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { validateAgentComputerRequest } from "./computers";

const ok = (r: any) => () => validateAgentComputerRequest(r);

describe("validateAgentComputerRequest", () => {
  it("accepts each supported operation", () => {
    expect(ok({ action: "computer", op: "list" })).not.toThrow();
    expect(
      ok({ action: "computer", op: "show", computer: "lab" }),
    ).not.toThrow();
    expect(
      ok({ action: "computer", op: "request", name: "lab", policy: {} }),
    ).not.toThrow();
    expect(
      ok({
        action: "computer",
        op: "notes",
        computer: "lab",
        notes: "gpu box",
        expected_revision: 0,
      }),
    ).not.toThrow();
    expect(
      ok({
        action: "computer",
        op: "ticket",
        computer: "lab",
        operation: "exec",
        request: { argv: ["true"] },
        operation_id: "op-1",
        pop_key: "key",
      }),
    ).not.toThrow();
  });

  it("refuses unknown operations, including prototype keys", () => {
    for (const op of [
      "delete",
      "toString",
      "__proto__",
      "constructor",
      undefined,
    ]) {
      expect(ok({ action: "computer", op })).toThrow("unsupported");
    }
    expect(ok({ action: "whoami", op: "list" })).toThrow("not a computer");
    expect(ok(null)).toThrow("not a computer");
  });

  it("refuses fields the operation does not take, such as an account or project", () => {
    expect(ok({ action: "computer", op: "list", account_id: "x" })).toThrow(
      "unknown computer request field 'account_id'",
    );
    expect(
      ok({ action: "computer", op: "show", computer: "lab", project_id: "x" }),
    ).toThrow("project_id");
  });

  it("refuses missing or malformed fields", () => {
    expect(ok({ action: "computer", op: "show" })).toThrow("needs 'computer'");
    expect(ok({ action: "computer", op: "show", computer: "" })).toThrow(
      "invalid",
    );
    expect(
      ok({ action: "computer", op: "show", computer: "x".repeat(65) }),
    ).toThrow("invalid");
    expect(ok({ action: "computer", op: "request", name: "lab" })).toThrow(
      "needs 'policy'",
    );
    expect(
      ok({
        action: "computer",
        op: "notes",
        computer: "lab",
        notes: "x",
        expected_revision: -1,
      }),
    ).toThrow("expected_revision");
    expect(
      ok({
        action: "computer",
        op: "notes",
        computer: "lab",
        notes: "x".repeat(4097),
        expected_revision: 1,
      }),
    ).toThrow("notes");
    expect(
      ok({
        action: "computer",
        op: "ticket",
        computer: "lab",
        operation: "shell",
        request: {},
        operation_id: "op-1",
        pop_key: "key",
      }),
    ).toThrow("operation");
  });
});
