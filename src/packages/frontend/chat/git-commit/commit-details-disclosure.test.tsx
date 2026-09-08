import { fireEvent, render, screen } from "@testing-library/react";
import { CommitDetailsDisclosure } from "./commit-details-disclosure";

beforeEach(() => localStorage.clear());

test("remembers expanded and collapsed details across commit remounts", () => {
  let view = render(
    <CommitDetailsDisclosure>First commit</CommitDetailsDisclosure>,
  );
  let details = screen.getByText("Commit details").closest("details")!;
  expect(details.open).toBe(false);
  details.open = true;
  fireEvent(details, new Event("toggle"));
  view.unmount();
  view = render(
    <CommitDetailsDisclosure>Second commit</CommitDetailsDisclosure>,
  );
  details = screen.getByText("Commit details").closest("details")!;
  expect(details.open).toBe(true);
  details.open = false;
  fireEvent(details, new Event("toggle"));
  view.unmount();
  render(<CommitDetailsDisclosure>Third commit</CommitDetailsDisclosure>);
  expect(screen.getByText("Commit details").closest("details")!.open).toBe(
    false,
  );
});

test("still toggles when localStorage is unavailable", () => {
  const get = jest
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation(() => {
      throw Error("disabled");
    });
  const set = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("disabled");
    });
  try {
    render(<CommitDetailsDisclosure>Commit</CommitDetailsDisclosure>);
    const details = screen.getByText("Commit details").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(details.open).toBe(true);
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});
