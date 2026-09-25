import type { HostProjectMaintenanceSchedule } from "@cocalc/conat/project-host/api";
import { orderProjectMaintenance } from "./maintenance-priority";

const due = (row: HostProjectMaintenanceSchedule) => row.backup_due_since;

function row(
  project_id: string,
  service: "paying" | "free",
  account: string,
  day: number,
): HostProjectMaintenanceSchedule {
  return {
    project_id,
    storage_service_class: service,
    storage_account_id: account,
    backup_due_since: new Date(Date.UTC(2026, 8, day)).toISOString(),
    last_edited: null,
    snapshots: null,
    backups: null,
  };
}

it("admits paying work first while guaranteeing free progress", () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) =>
      row(`paid-${i}`, "paying", `paid-account-${i}`, 1),
    ),
    row("free-1", "free", "free-account", 1),
    row("free-2", "free", "free-account", 2),
  ];
  const order = orderProjectMaintenance(rows, due).map(
    (item) => item.project_id,
  );
  expect(order[0]).toMatch(/^paid-/);
  expect(order[9]).toBe("free-1");
  expect(order[19]).toBe("free-2");
});

it("rotates between paying accounts even when one has many old projects", () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) =>
      row(`account-a-${i}`, "paying", "account-a", 1),
    ),
    row("account-b", "paying", "account-b", 2),
  ];
  const order = orderProjectMaintenance(rows, due).map(
    (item) => item.project_id,
  );
  expect(order.indexOf("account-b")).toBe(1);
});

it("does not truncate a fleet larger than one host query page", () => {
  const rows = Array.from({ length: 1_003 }, (_, i) =>
    row(`project-${i}`, "free", `account-${i}`, 1),
  );
  expect(orderProjectMaintenance(rows, due)).toHaveLength(1_003);
});
