import { markdownToSpeechText } from "./speech-text";

it("keeps outer numbering across nested bullet lists", () => {
  expect(markdownToSpeechText("3. Outer\n   - Inner\n4. Next")).toBe(
    "Item 3.\nOuter\nItem.\nInner\nItem 4.\nNext",
  );
});

it("reads table values with their column names", () => {
  expect(
    markdownToSpeechText(
      "| Task | Status |\n|---|---|\n| Build | Ready |\n| Test | Passed |",
    ),
  ).toBe("Task: Build. Status: Ready.\nTask: Test. Status: Passed.");
});

it("uses CoCalc math, mentions, tasks, and metadata parsing", () => {
  const result = markdownToSpeechText(
    '---\ntitle: Hidden metadata\n---\n\n- [x] Done\n- [ ] Pending\n\nHello <span class="user-mention" account-id=47d0393e-4814-4452-bb6c-35bac4cbd314>@William</span>.\n\n\\(x_1 + x_2\\)\n\n$$y^2$$',
  );
  expect(result).toContain("Completed: Done");
  expect(result).toContain("Not completed: Pending");
  expect(result).toContain("Hello William.");
  expect(result).toContain("$x_1 + x_2$");
  expect(result).toContain("y^2");
  expect(result).not.toContain("Hidden metadata");
  expect(result).not.toContain("span");
});

it("does not turn source line wrapping into spoken sentence breaks", () => {
  expect(markdownToSpeechText("This sentence\ncontinues here.")).toBe(
    "This sentence continues here.",
  );
});

it("does not silently drop answers inside HTML blocks", () => {
  expect(markdownToSpeechText("<div>Important result</div>")).toContain(
    "Important result",
  );
});
