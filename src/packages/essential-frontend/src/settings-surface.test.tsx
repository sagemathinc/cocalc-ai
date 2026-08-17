/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsSurface from "./settings-surface";

test("confirms before stopping a running project", async () => {
  const stop = jest.fn(async () => undefined);
  const getProjectState = jest
    .fn()
    .mockResolvedValueOnce({ state: "running" })
    .mockResolvedValueOnce({ state: "stopped" });
  const session = {
    getProjectState,
    hubApi: { projects: { restart: jest.fn(), stop } },
  };
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  render(
    <SettingsSurface
      project={
        {
          description: "A focused test project",
          host_id: "host-1",
          project_id: "11111111-1111-4111-8111-111111111111",
          state_summary: { state: "running" },
          title: "Test",
        } as any
      }
      session={session as any}
    />,
  );

  const stopButton = await screen.findByRole("button", {
    name: "Stop project",
  });
  fireEvent.click(stopButton);
  await waitFor(() =>
    expect(stop).toHaveBeenCalledWith({
      project_id: "11111111-1111-4111-8111-111111111111",
    }),
  );
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Stop"));
  expect(await screen.findByText("stopped")).toBeVisible();
  confirm.mockRestore();
});
