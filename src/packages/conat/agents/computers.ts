/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// What an agent can ask about computers with its runtime identity
// (`cocalc computer ...`). Account, project and run always come from the
// authenticated run, never from the request.
// Plan: src/.agents/computers-plan-2026-10-11.md.

import { OPERATION_KINDS } from "@cocalc/util/computers/protocol";

export type AgentComputerRequest =
  | { action: "computer"; op: "list" }
  | { action: "computer"; op: "show"; computer: string }
  | {
      action: "computer";
      op: "request";
      name: string;
      policy: unknown;
      why?: string;
    }
  | {
      action: "computer";
      op: "notes";
      computer: string;
      notes: string;
      expected_revision: number;
    }
  | {
      action: "computer";
      op: "ticket";
      computer: string;
      operation: string;
      request: unknown;
      operation_id: string;
      pop_key: string;
    };

type FieldCheck = (value: unknown) => boolean;

const isRef: FieldCheck = (v) =>
  typeof v === "string" && v.length > 0 && v.length <= 64;
const isText =
  (max: number): FieldCheck =>
  (v) =>
    typeof v === "string" && v.length <= max;
const isPresent: FieldCheck = (v) => v !== undefined;

// [check, required] for every field each op accepts; anything else is refused.
const FIELDS: Record<string, Record<string, [FieldCheck, boolean]>> = {
  list: {},
  show: { computer: [isRef, true] },
  request: {
    name: [isRef, true],
    policy: [isPresent, true],
    why: [isText(2000), false],
  },
  notes: {
    computer: [isRef, true],
    notes: [isText(4096), true],
    expected_revision: [
      (v) => Number.isSafeInteger(v) && (v as number) >= 0,
      true,
    ],
  },
  ticket: {
    computer: [isRef, true],
    operation: [
      (v) => (OPERATION_KINDS as readonly unknown[]).includes(v),
      true,
    ],
    request: [isPresent, true],
    operation_id: [isRef, true],
    pop_key: [isText(256), true],
  },
};

export function validateAgentComputerRequest(
  request: AgentComputerRequest,
): void {
  const r = request as any;
  if (r == null || typeof r !== "object" || r.action !== "computer") {
    throw new Error("not a computer request");
  }
  const fields = Object.prototype.hasOwnProperty.call(FIELDS, r.op)
    ? FIELDS[r.op]
    : undefined;
  if (fields == null) throw new Error("unsupported computer operation");
  for (const key of Object.keys(r)) {
    if (
      key !== "action" &&
      key !== "op" &&
      !Object.prototype.hasOwnProperty.call(fields, key)
    ) {
      throw new Error(`unknown computer request field '${key}'`);
    }
  }
  for (const [key, [check, required]] of Object.entries(fields)) {
    if (r[key] === undefined) {
      if (required) throw new Error(`computer request needs '${key}'`);
    } else if (!check(r[key])) {
      throw new Error(`invalid computer request field '${key}'`);
    }
  }
}
