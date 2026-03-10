import { render, screen } from "@testing-library/react";
import Leaf from "../leaf";

describe("Slate Leaf", () => {
  it("does not reserve trailing padding after inline code", () => {
    render(
      <Leaf
        attributes={{ "data-testid": "leaf" } as any}
        leaf={{ text: "Files", code: true } as any}
        text={{ text: "Files" } as any}
      >
        Files
      </Leaf>,
    );

    const code = screen.getByText("Files");
    expect(code.tagName).toBe("CODE");
    const style = code.getAttribute("style") ?? "";
    expect(style).toContain("padding: 0.2em 0px 0.2em 0.4em");
  });
});
