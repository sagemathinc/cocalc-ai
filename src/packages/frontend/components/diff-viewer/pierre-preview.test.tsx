/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PierrePreview from "./pierre-preview";

const mockScrollTo = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => undefined },
}));
jest.mock(
  "@pierre/diffs/react",
  () => {
    const React = require("react");
    return {
      CodeView: React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({ scrollTo: mockScrollTo }));
        return (
          <div
            ref={props.containerRef}
            data-testid="pierre-view"
            data-expanded={props.options.expandUnchanged}
            data-overflow={props.options.overflow}
            data-layout={props.options.diffStyle}
            style={props.style}
          >
            {props.items.flatMap((item: any) =>
              item.annotations.map((annotation: any) => (
                <div key={annotation.metadata}>
                  {props.renderAnnotation(annotation, item)}
                </div>
              )),
            )}
          </div>
        );
      }),
    };
  },
  { virtual: true },
);
jest.mock("./pierre-model", () => ({
  parsePreviewSource: () => [{ name: "example.ts" }, { name: "second.ts" }],
  containsPreviewLine: (_file: any, line: number) => line === 10,
}));
jest.mock("@cocalc/frontend/chat/git-commit/review-editors", () => ({
  MarkdownHistoryInput: (props: any) => (
    <textarea
      aria-label="Temporary comment"
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

const source = { kind: "patch" as const, patch: "", label: "Fixture" };

beforeEach(() => mockScrollTo.mockClear());

it("scrolls the focused diff without consuming spaces in controls or drafts", async () => {
  const user = userEvent.setup();
  render(<PierrePreview source={source} fontSize={14} />);
  const viewport = screen.getByRole("region", { name: "Diff preview" });
  Object.defineProperties(viewport, {
    clientHeight: { value: 500 },
    scrollHeight: { value: 3000 },
  });
  expect(document.activeElement).toBe(viewport);
  await user.keyboard(" ");
  expect(viewport.scrollTop).toBe(450);
  await user.keyboard("{Shift>} {/Shift}");
  expect(viewport.scrollTop).toBe(0);
  await user.keyboard("{PageDown}{ArrowDown}");
  expect(viewport.scrollTop).toBe(490);
  await user.keyboard("{Home}");
  expect(viewport.scrollTop).toBe(0);
  const split = screen.getByRole("checkbox", { name: "Side by side" });
  split.focus();
  await user.keyboard(" ");
  expect((split as HTMLInputElement).checked).toBe(true);
  expect(viewport.scrollTop).toBe(0);
  const input = screen.getByRole("spinbutton", { name: "Preview line" });
  fireEvent.change(input, { target: { value: "10" } });
  await user.click(screen.getByRole("button", { name: "Go to line" }));
  await user.click(
    screen.getByRole("button", { name: "Add temporary comment" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Temporary comment" }),
    "some words",
  );
  expect(viewport.scrollTop).toBe(0);
});

it("navigates immediately on keyboard file selection and updates layout options", async () => {
  const user = userEvent.setup();
  render(<PierrePreview source={source} fontSize={14} />);
  const file = screen.getByRole("combobox", { name: "Preview file" });
  file.focus();
  await user.selectOptions(file, "1");
  expect(document.activeElement).toBe(file);
  expect(mockScrollTo).toHaveBeenLastCalledWith({
    type: "item",
    id: "1",
    align: "start",
    behavior: "instant",
  });
  const view = screen.getByTestId("pierre-view");
  expect(view.style.overflow).toBe("auto");
  expect(view.getAttribute("data-overflow")).toBe("wrap");
  const split = screen.getByRole("checkbox", { name: "Side by side" });
  split.focus();
  await user.keyboard(" ");
  expect(view.getAttribute("data-layout")).toBe("split");
  await user.click(screen.getByRole("checkbox", { name: "Wrap long lines" }));
  expect(view.getAttribute("data-overflow")).toBe("scroll");
});

it("expands full-document context so line navigation can reveal unchanged lines", () => {
  render(
    <PierrePreview
      source={{
        kind: "documents",
        path: "example.ts",
        before: "old",
        after: "new",
        label: "History",
      }}
      fontSize={14}
    />,
  );
  expect(screen.getByTestId("pierre-view").getAttribute("data-expanded")).toBe(
    "true",
  );
});

it("allows keyboard navigation to an old-side line and adding a comment", async () => {
  const user = userEvent.setup();
  render(<PierrePreview source={source} fontSize={14} />);
  const input = screen.getByRole("spinbutton", { name: "Preview line" });
  fireEvent.change(input, { target: { value: "10" } });
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Preview side" }),
    "deletions",
  );
  input.focus();
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(input);
  expect(mockScrollTo).toHaveBeenCalledWith(
    expect.objectContaining({ lineNumber: 10, side: "deletions" }),
  );
  const add = screen.getByRole("button", { name: "Add temporary comment" });
  add.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByText("Temporary comment (old line 10)")).toBeTruthy();
  await user.type(
    screen.getByRole("textbox", { name: "Temporary comment" }),
    "Keep **this** draft",
  );
  await user.click(screen.getByRole("checkbox", { name: "Side by side" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Temporary comment",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Keep **this** draft");
});

it("reports missing historical context instead of scrolling somewhere else", async () => {
  render(<PierrePreview source={source} fontSize={14} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Go to line" }));
  expect(screen.getByRole("status").textContent).toContain("not present");
  expect(mockScrollTo).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("button", {
        name: "Add temporary comment",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
