import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackToProjects } from "./back-to-projects";

beforeEach(() => localStorage.clear());

test("Projects navigation is labeled and keyboard accessible", async () => {
  const user = userEvent.setup();
  const onBack = jest.fn();
  render(<BackToProjects onBack={onBack} />);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Back to Projects" }),
  );
  await user.keyboard("{Enter}");
  expect(onBack).toHaveBeenCalledTimes(1);
});

test("dismissing the tip restores focus and persists without hiding navigation", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<BackToProjects onBack={() => {}} />);
  await user.tab();
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Dismiss Projects navigation tip" }),
  );
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Back to Projects" }),
  );
  unmount();
  render(<BackToProjects onBack={() => {}} />);
  expect(screen.queryByText(/Your projects and courses/)).toBeNull();
  expect(screen.getByRole("button", { name: "Back to Projects" })).toBeTruthy();
});

test("unavailable storage does not prevent navigation or dismissal", async () => {
  const read = jest
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw new Error("Storage blocked");
    });
  const write = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage blocked");
    });
  try {
    const user = userEvent.setup();
    const onBack = jest.fn();
    render(<BackToProjects onBack={onBack} />);
    await user.click(
      screen.getByRole("button", { name: "Dismiss Projects navigation tip" }),
    );
    await user.click(screen.getByRole("button", { name: "Back to Projects" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});
