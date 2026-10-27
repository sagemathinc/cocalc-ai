/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StaticMarkdown from "../static-markdown";
import { redux } from "@cocalc/frontend/app-framework";
import { serializeAgentMention } from "@cocalc/util/agent-mentions";

const mockGetIdentity = jest.fn();
jest.mock("@cocalc/frontend/agents/open-notification", () => ({
  openAgentNotification: async () => false,
}));
jest.mock("@cocalc/frontend/agents/api", () => ({
  personalAgentApi: () => ({ getIdentity: mockGetIdentity }),
  useNamedAgents: () => ({ directory: undefined }),
  sameEndpoint: (a, b) =>
    a.project_id === b.project_id && a.agent_id === b.agent_id,
}));

it("an agent on another site is a named, keyboard-reachable chip that opens Agents", async () => {
  const set_active_tab = jest.fn();
  const getActions = jest
    .spyOn(redux, "getActions")
    .mockReturnValue({ set_active_tab } as any);
  try {
    const user = userEvent.setup();
    render(
      <StaticMarkdown
        value={`Ask ${serializeAgentMention({
          version: 1,
          naming_account_id: "11111111-1111-4111-8111-111111111111",
          target: {
            kind: "external",
            account_id: "66666666-6666-4666-8666-666666666666",
            agent_id: "77777777-7777-4777-8777-777777777777",
            installation_id: "88888888-8888-4888-8888-888888888888",
          },
          name: "ops0",
        })} to look.`}
      />,
    );
    const chip = screen.getByRole("button", {
      name: "Agent on another site @ops0; open Agents",
    });
    expect(chip).toHaveTextContent("@ops0");
    await user.tab();
    expect(chip).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(getActions).toHaveBeenCalledWith("page");
    expect(set_active_tab).toHaveBeenCalledWith("agents");
    // It has no thread here to look up.
    expect(mockGetIdentity).not.toHaveBeenCalled();
  } finally {
    getActions.mockRestore();
  }
});
