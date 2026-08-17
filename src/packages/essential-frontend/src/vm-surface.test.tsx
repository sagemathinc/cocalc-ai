/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import VmSurface from "./vm-surface";
import type { UltraliteSession } from "./session";

const project = {
  project_id: "11111111-1111-4111-8111-111111111111",
  title: "Test project",
} as AccountProjectListWindowRow;

function makeSession(vms: unknown[] = []) {
  const listVms = jest.fn(async () => vms);
  const startVm = jest.fn(async () => undefined);
  const stopVm = jest.fn(async () => undefined);
  const session = {
    browserId: "browser-test",
    hubApi: { compute: { listVms, startVm, stopVm } },
  } as unknown as UltraliteSession;
  return { listVms, session, startVm, stopVm };
}

test("opening and refreshing VMs never starts or stops compute", async () => {
  const { listVms, session, startVm, stopVm } = makeSession();

  render(<VmSurface project={project} session={session} />);
  await screen.findByText("This project has no dedicated virtual machines.");

  expect(listVms).toHaveBeenCalledTimes(1);
  expect(startVm).not.toHaveBeenCalled();
  expect(stopVm).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
  await waitFor(() => expect(listVms).toHaveBeenCalledTimes(2));
  expect(startVm).not.toHaveBeenCalled();
  expect(stopVm).not.toHaveBeenCalled();
});

test("starting a VM requires an explicit confirmed action", async () => {
  const vm = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "compute-vm",
    state: "stopped",
    desired_state: "stopped",
    provider: "gcp",
    machine_type: "e2-standard-4",
    cpu: 4,
    ram_gb: 16,
    operating_system: "linux",
    boot_disk_gb: 50,
    effective_pricing_model: "spot",
    spot_hourly_price: 0.04,
  };
  const { session, startVm } = makeSession([vm]);
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);

  render(<VmSurface project={project} session={session} />);
  const start = await screen.findByRole("button", { name: "Start" });
  fireEvent.click(start);
  expect(startVm).not.toHaveBeenCalled();

  confirm.mockReturnValue(true);
  fireEvent.click(start);
  await waitFor(() => expect(startVm).toHaveBeenCalledTimes(1));
  expect(startVm).toHaveBeenCalledWith(
    expect.objectContaining({
      browser_id: "browser-test",
      id_or_name: vm.id,
    }),
  );
  confirm.mockRestore();
});
