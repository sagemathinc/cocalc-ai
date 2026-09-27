import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectPinControl } from "./project-pins";
import type { DirectoryApi } from "./workspace-api";

test("keyboard pin waits for durable success, blocks duplicate actions and announces errors without stealing focus", async () => {
  const user = userEvent.setup();
  let reject!: (reason: Error) => void;
  const setProjectPinned = jest.fn(
    () =>
      new Promise<never>((_, fail) => {
        reject = fail;
      }),
  );
  const onChange = jest.fn();
  render(
    <ProjectPinControl
      api={{ setProjectPinned } as unknown as DirectoryApi}
      project={{
        project_id: "p",
        title: "Geometry",
        description: "",
        role: "owner",
      }}
      onChange={onChange}
    />,
  );
  const pin = screen.getByRole("button", { name: "Pin project Geometry" });
  pin.focus();
  await user.keyboard("{Enter}{Enter}");
  expect(pin).toHaveFocus();
  expect(pin).toHaveAttribute("aria-disabled", "true");
  expect(pin).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("status")).toHaveTextContent("Saving project pin");
  expect(setProjectPinned).toHaveBeenCalledTimes(1);
  await act(async () => reject(Error("Favorites unavailable")));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Favorites unavailable",
  );
  expect(onChange).not.toHaveBeenCalled();
  expect(pin).toHaveFocus();
  expect(pin).toHaveAttribute("aria-disabled", "false");
  await user.keyboard(" ");
  await waitFor(() => expect(setProjectPinned).toHaveBeenCalledTimes(2));
});
