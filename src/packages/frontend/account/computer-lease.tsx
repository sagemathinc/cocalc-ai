/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A computer's hard lease, said the same way everywhere: if the computer
// can't connect to CoCalc for N hours, all its jobs stop (William, Oct 15
// 2026). The "?" states the exact rule.

import { InputNumber, Space } from "antd";
import { HelpIcon } from "@cocalc/frontend/components/help-icon";
import {
  DEFAULT_LEASE_HOURS,
  leaseHoursText,
  leaseRule,
  MAX_LEASE_HOURS,
  MIN_LEASE_HOURS,
  validLeaseHours,
} from "@cocalc/util/computers/policy";

function LeaseHelp({ hours }: { hours: number }) {
  return (
    <HelpIcon title="Hard lease" maxWidth="360px">
      <p>{leaseRule(hours)}</p>
      <p>
        While it is connected, the lease renews by itself. It is a safety limit:
        a computer that was disconnected from your account, or deleted, while it
        was offline can't keep running work forever.
      </p>
    </HelpIcon>
  );
}

/** "Stops all work after 24 hours without CoCalc (?)" */
export function LeaseSummary({
  policy,
}: {
  policy?: { lease_hours?: number } | null;
}) {
  if (policy != null && !validLeaseHours(policy.lease_hours)) {
    return (
      <span>Connected before hard leases: runs nothing; connect it again</span>
    );
  }
  const hours = policy?.lease_hours ?? DEFAULT_LEASE_HOURS;
  return (
    <span>
      Stops all work after {leaseHoursText(hours)} without CoCalc{" "}
      <LeaseHelp hours={hours} />
    </span>
  );
}

/** The lease as a form item (whole hours, 1 to 8760). */
export function LeaseInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (hours: number) => void;
}) {
  return (
    <Space wrap>
      <span>Stop all work after</span>
      <InputNumber
        aria-label="Hard lease in hours"
        min={MIN_LEASE_HOURS}
        max={MAX_LEASE_HOURS}
        precision={0}
        value={value}
        onChange={(v) =>
          onChange(
            typeof v === "number" && Number.isInteger(v)
              ? v
              : DEFAULT_LEASE_HOURS,
          )
        }
      />
      <span>hours without CoCalc</span>
      <LeaseHelp hours={value} />
    </Space>
  );
}
