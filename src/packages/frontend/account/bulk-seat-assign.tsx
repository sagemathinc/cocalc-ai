/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Button, Input, Space, Typography } from "antd";
import { useId, useMemo, useState } from "react";

import { MAX_SEAT_EMAIL_BATCH, planSeatEmailList } from "./seat-email-list";

const { Paragraph, Text } = Typography;

export interface BulkSeatAssignResult {
  assigned: string[];
  failed: { email: string; error: string }[];
}

// Paste many email addresses and reserve one seat per address. Each address
// still goes through the normal per-seat assignment (and its server-side
// checks); this only removes the one-at-a-time searching.
export function BulkSeatEmailAssign({
  seatName,
  availableSeats,
  alreadyAssigned,
  assignEmails,
}: {
  seatName: string;
  availableSeats: number;
  alreadyAssigned: ReadonlySet<string>;
  /** Assign each address in order; resolves with per-address outcomes. */
  assignEmails: (emails: string[]) => Promise<BulkSeatAssignResult>;
}) {
  const textId = useId();
  const helpId = useId();
  const [text, setText] = useState<string>("");
  const [running, setRunning] = useState<boolean>(false);
  const [result, setResult] = useState<BulkSeatAssignResult | null>(null);
  const [error, setError] = useState<string>("");
  const plan = useMemo(
    () => planSeatEmailList({ text, alreadyAssigned, availableSeats }),
    [text, alreadyAssigned, availableSeats],
  );
  const count = plan.toAssign.length;

  async function run() {
    if (count === 0) return;
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const outcome = await assignEmails(plan.toAssign);
      setResult(outcome);
      // Keep only the addresses that still need attention.
      setText(outcome.failed.map(({ email }) => email).join("\n"));
    } catch (err) {
      setError(`${err}`);
    } finally {
      setRunning(false);
    }
  }

  const notes: string[] = [];
  if (plan.alreadyAssigned.length > 0) {
    notes.push(`${plan.alreadyAssigned.length} already have a seat`);
  }
  if (plan.duplicates.length > 0) {
    notes.push(`${plan.duplicates.length} listed more than once`);
  }
  if (plan.overCapacity.length > 0) {
    notes.push(
      `${plan.overCapacity.length} do not fit (${availableSeats} free seats; at most ${MAX_SEAT_EMAIL_BATCH} per batch)`,
    );
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <label htmlFor={textId}>
        <Text strong>Email addresses</Text>
      </label>
      <Paragraph id={helpId} type="secondary" style={{ marginBottom: 0 }}>
        Paste addresses separated by new lines, commas or semicolons, for
        example a column copied from a spreadsheet. Each address reserves one{" "}
        {seatName} seat, which becomes claimable once that person verifies the
        address on their CoCalc account. Use the address each person actually
        signs in with.
      </Paragraph>
      <Input.TextArea
        id={textId}
        aria-describedby={helpId}
        value={text}
        rows={6}
        disabled={running}
        onChange={(e) => {
          setText(e.target.value);
          setResult(null);
        }}
        placeholder={"ta1@example.edu\nta2@example.edu"}
      />
      <div role="status" aria-live="polite">
        {text.trim() ? (
          <Text>
            {count} {count === 1 ? "seat" : "seats"} will be assigned
            {notes.length > 0 ? `; ${notes.join("; ")}` : ""}.
          </Text>
        ) : null}
      </div>
      {plan.invalid.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={`Not valid email addresses: ${plan.invalid.slice(0, 10).join(", ")}${plan.invalid.length > 10 ? ", …" : ""}`}
        />
      ) : null}
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {result ? (
        <Alert
          type={result.failed.length > 0 ? "warning" : "success"}
          showIcon
          title={`Assigned ${result.assigned.length} ${result.assigned.length === 1 ? "seat" : "seats"}${result.failed.length > 0 ? `; ${result.failed.length} failed and remain in the list` : ""}.`}
          description={
            result.failed.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {result.failed.slice(0, 20).map(({ email, error }) => (
                  <li key={email}>
                    {email}: {error}
                  </li>
                ))}
              </ul>
            ) : undefined
          }
        />
      ) : null}
      <Button
        type="primary"
        disabled={count === 0}
        loading={running}
        onClick={() => void run()}
      >
        {count > 0
          ? `Assign ${count} ${count === 1 ? "seat" : "seats"}`
          : "Assign seats"}
      </Button>
    </Space>
  );
}
