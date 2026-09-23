/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HostProjectMaintenanceSchedule } from "@cocalc/conat/project-host/api";

function timestamp(value: string | null | undefined): number {
  const parsed = value == null ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function accountFairOrder(
  rows: HostProjectMaintenanceSchedule[],
  due: (row: HostProjectMaintenanceSchedule) => string | null | undefined,
): HostProjectMaintenanceSchedule[] {
  const groups = new Map<string, HostProjectMaintenanceSchedule[]>();
  for (const row of rows) {
    const account = row.storage_account_id || row.project_id;
    const group = groups.get(account) ?? [];
    group.push(row);
    groups.set(account, group);
  }
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        timestamp(due(a)) - timestamp(due(b)) ||
        (b.storage_priority ?? 0) - (a.storage_priority ?? 0) ||
        a.project_id.localeCompare(b.project_id),
    );
  }
  const result: HostProjectMaintenanceSchedule[] = [];
  const queue = [...groups.keys()].sort((aId, bId) => {
    const a = groups.get(aId)![0];
    const b = groups.get(bId)![0];
    return (
      timestamp(due(a)) - timestamp(due(b)) ||
      (b.storage_priority ?? 0) - (a.storage_priority ?? 0) ||
      aId.localeCompare(bId)
    );
  });
  const indices = new Map<string, number>();
  for (let offset = 0; offset < queue.length; offset++) {
    const account = queue[offset];
    const group = groups.get(account)!;
    const index = indices.get(account) ?? 0;
    result.push(group[index]);
    indices.set(account, index + 1);
    if (index + 1 < group.length) queue.push(account);
  }
  return result;
}

export function orderProjectMaintenance(
  rows: HostProjectMaintenanceSchedule[],
  due: (row: HostProjectMaintenanceSchedule) => string | null | undefined,
): HostProjectMaintenanceSchedule[] {
  const paying = accountFairOrder(
    rows.filter((row) => row.storage_service_class === "paying"),
    due,
  );
  const free = accountFairOrder(
    rows.filter((row) => row.storage_service_class !== "paying"),
    due,
  );
  const result: HostProjectMaintenanceSchedule[] = [];
  let paidIndex = 0;
  let freeIndex = 0;
  while (paidIndex < paying.length || freeIndex < free.length) {
    for (let i = 0; i < 9 && paidIndex < paying.length; i++) {
      result.push(paying[paidIndex++]);
    }
    if (freeIndex < free.length) result.push(free[freeIndex++]);
  }
  return result;
}
