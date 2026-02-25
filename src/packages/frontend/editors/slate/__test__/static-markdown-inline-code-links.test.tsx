/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import StaticMarkdown from "../static-markdown";

describe("StaticMarkdown inline code links", () => {
  it("renders verified inline code paths using the internal file-link scheme", () => {
    render(
      <StaticMarkdown
        value={"Open `src/workspaces.py:12`."}
        inlineCodeLinks={[
          {
            code: "src/workspaces.py:12",
            abs_path: "/tmp/x/src/workspaces.py",
            display_path_at_turn: "src/workspaces.py",
            workspace_root_at_turn: "/tmp/x",
            line: 12,
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", {
      name: "src/workspaces.py:12",
    });
    expect(link.getAttribute("href")).toBe(
      "cocalc-file://open?path=%2Ftmp%2Fx%2Fsrc%2Fworkspaces.py&line=12",
    );
    expect(link.getAttribute("title")).toBe("/tmp/x/src/workspaces.py:12");
  });

  it("prefers display_path_at_turn over recomputing from current workspace root", () => {
    render(
      <StaticMarkdown
        value={"Use `different/path.ts:3`."}
        inlineCodeWorkspaceRoot="/some/other/root"
        inlineCodeLinks={[
          {
            code: "different/path.ts:3",
            abs_path: "/tmp/x/src/path.ts",
            display_path_at_turn: "different/path.ts",
            workspace_root_at_turn: "/tmp/x",
            line: 3,
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", { name: "different/path.ts:3" });
    expect(link).toBeTruthy();
  });

  it("preserves absolute inline-code display text", () => {
    render(
      <StaticMarkdown
        value={"Open `/usr/bin/python3.13`."}
        inlineCodeWorkspaceRoot="/tmp/x"
        inlineCodeLinks={[
          {
            code: "/usr/bin/python3.13",
            abs_path: "/usr/bin/python3.13",
            display_path_at_turn: "../../usr/bin/python3.13",
            workspace_root_at_turn: "/tmp/x",
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", { name: "/usr/bin/python3.13" });
    expect(link.getAttribute("href")).toBe(
      "cocalc-file://open?path=%2Fusr%2Fbin%2Fpython3.13",
    );
  });
});
