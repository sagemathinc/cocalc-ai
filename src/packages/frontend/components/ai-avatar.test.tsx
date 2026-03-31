import { render } from "@testing-library/react";
import AIAvatar from "./ai-avatar";

describe("AIAvatar", () => {
  it("applies iconColor to the inner wrapper so currentColor can inherit", () => {
    const { container } = render(
      <div style={{ color: "rgb(10, 20, 30)" }}>
        <AIAvatar size={16} iconColor="currentColor" />
      </div>,
    );

    const svg = container.querySelector("svg");
    const inner = svg?.parentElement;
    expect(inner).not.toBeNull();
    expect(window.getComputedStyle(inner!).color).toBe("rgb(10, 20, 30)");
  });

  it("uses the explicit icon color when one is provided", () => {
    const { container } = render(<AIAvatar size={16} iconColor="#123456" />);

    const svg = container.querySelector("svg");
    const inner = svg?.parentElement;
    expect(inner).not.toBeNull();
    expect(window.getComputedStyle(inner!).color).toBe("rgb(18, 52, 86)");
  });
});
