/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import StaticMarkdown from "../static-markdown";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

jest.mock("@cocalc/frontend/agents/api", () => ({
  useNamedAgents: () => ({ directory: undefined }),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
}));
jest.mock("@cocalc/frontend/projects/project-title", () => ({
  ProjectTitle: ({ project_id }) => <span>{project_id}</span>,
}));

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

  it("renders agent-delivered guidance as a compact nested message card", () => {
    const session = "11111111-1111-4111-8111-111111111111";
    const attempt = "22222222-2222-4222-8222-222222222222";
    const agent = "33333333-3333-4333-8333-333333333333";
    const project = "44444444-4444-4444-8444-444444444444";
    render(
      <StaticMarkdown
        value={`\`\`\`\`guidance\n\`\`\`agent-message ${session} ${attempt} from=%40illustrator source=${agent} project=${project}\nUse the revised diagram.\n\`\`\`\n\`\`\`\``}
      />,
    );

    const guidance = screen.getByRole("region", { name: "Guidance sent" });
    const message = screen.getByRole("region", {
      name: "Agent-message quote",
    });
    expect(guidance).toContainElement(message);
    expect(screen.getByText("@illustrator")).toBeVisible();
    expect(screen.getByText("Use the revised diagram.")).toBeVisible();
  });
});
