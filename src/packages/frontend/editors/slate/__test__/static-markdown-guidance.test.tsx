/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import StaticMarkdown from "../static-markdown";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

describe("static guidance rendering", () => {
  it.each([
    ["sent", "Guidance sent", UI_COLORS.infoBg],
    ["sending", "Sending guidance", UI_COLORS.infoBg],
    ["queued", "Guidance queued", UI_COLORS.warningBg],
    ["not-sent", "Guidance not sent", UI_COLORS.dangerBg],
  ])(
    "uses semantic foreground and background for %s guidance",
    (state, label, background) => {
      render(
        <StaticMarkdown
          value={`\`\`\`guidance ${state}\nReadable guidance\n\`\`\``}
        />,
      );
      const region = screen.getByRole("region", { name: label });
      expect(region.style.background).toBe(background);
      expect(region.style.color).toBe(UI_COLORS.text);
    },
  );
  it("marks rich guidance content as a constrained layout boundary", () => {
    render(
      <StaticMarkdown
        value={
          '```guidance\n<img src="/blobs/test.png" width="1200px" height="700px" />\n```'
        }
      />,
    );

    const guidance = screen.getByRole("region", { name: "Guidance sent" });
    expect(guidance).toHaveClass("cocalc-slate-guidance");
    expect(
      guidance.querySelector(".cocalc-slate-guidance-content img"),
    ).not.toBeNull();
  });
});
