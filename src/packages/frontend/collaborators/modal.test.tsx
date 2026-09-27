import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import { CollaboratorsModal } from "./modal";

test("scopes the real modal portal while preserving caller classes and content", async () => {
  const getComputedStyle = window.getComputedStyle;
  const spy = jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
  try {
    render(
      <CollaboratorsModal open title="Scoped dialog" rootClassName="caller">
        <input aria-label="Dialog input" />
      </CollaboratorsModal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Scoped dialog" });
    expect(dialog.closest(".collaborators-modal.caller")).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Dialog input" }),
      ).toBeVisible(),
    );
  } finally {
    spy.mockRestore();
  }
});

test("only overrides motion inside Collaborators portals under reduced motion", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync(join(__dirname, "modal.css"), "utf8");
  document.head.appendChild(style);
  try {
    const rules = style.sheet!.cssRules;
    expect(rules).toHaveLength(1);
    const media = rules[0] as CSSMediaRule;
    expect(media.conditionText).toBe("(prefers-reduced-motion: reduce)");
    expect(media.cssRules).toHaveLength(1);
    const rule = media.cssRules[0] as CSSStyleRule;
    expect(rule.selectorText).toBe(".collaborators-modal .ant-modal");
    for (const property of ["animation-duration", "transition-duration"]) {
      expect(rule.style.getPropertyValue(property)).toBe("0s");
      expect(rule.style.getPropertyPriority(property)).toBe("important");
    }
  } finally {
    style.remove();
  }
});
