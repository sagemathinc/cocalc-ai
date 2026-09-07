import { fireEvent, render, screen } from "@testing-library/react";
import type { DocsEntry } from "@cocalc/docs";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { DocsLearnedControl, DocsPrivateNotesPanel } from "./panel";

jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: ({ value, onChange }: any) => (
    <textarea
      aria-label="Private note"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }: any) => <div>{value}</div>,
}));
jest.mock("@cocalc/frontend/components", () => ({
  Tooltip: ({ children }: any) => children,
}));

const entry = {
  id: "test",
  slug: "test",
  title: "Test",
} as unknown as DocsEntry;
describe("private docs appearance", () => {
  it("pairs the notes surface and text while adding a note", () => {
    const { container } = render(
      <DocsPrivateNotesPanel
        accountId="test"
        entry={entry}
        notes={[]}
        markViewed={jest.fn()}
        onDeleteNote={jest.fn()}
        onSaveNote={jest.fn()}
        onToggleStar={jest.fn()}
      />,
    );
    const style = container.querySelector(".ant-card")!.getAttribute("style");
    expect(style).toContain(UI_COLORS.surface);
    expect(style).toContain(UI_COLORS.text);
    fireEvent.click(screen.getByRole("button", { name: "Add Note" }));
    expect(screen.getByRole("textbox", { name: "Private note" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it.each([false, true])(
    "uses semantic learned-state colors (%s)",
    (learned) => {
      const onSetLearned = jest.fn();
      const { container } = render(
        <DocsLearnedControl
          entry={entry}
          onSetLearned={onSetLearned}
          summary={{
            starred: false,
            noteCount: 0,
            noteText: "",
            learnedAt: learned ? 1 : undefined,
          }}
        />,
      );
      const style = container.querySelector(".ant-card")!.getAttribute("style");
      expect(style).toContain(
        learned ? UI_COLORS.successBg : UI_COLORS.surface,
      );
      expect(style).toContain(UI_COLORS.text);
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Done - I learned this page" }),
      );
      expect(onSetLearned).toHaveBeenCalledWith(entry, !learned);
    },
  );
});
