/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useProjectSecrets } from "@cocalc/frontend/project/use-project-secrets";
import { ClaudeProjectSecretModal } from "../claude-project-secret-modal";

jest.mock("@cocalc/frontend/project/use-project-secrets", () => ({
  useProjectSecrets: jest.fn(),
}));
jest.mock("@cocalc/frontend/project/use-project-field", () => ({
  publishProjectDetailInvalidation: jest.fn(),
}));

test("Claude dialog saves only ANTHROPIC_API_KEY without displaying an existing value", async () => {
  const refresh = jest.fn();
  const setSecrets = jest.fn();
  jest.mocked(useProjectSecrets).mockReturnValue({
    secrets: [{ name: "ANTHROPIC_API_KEY" } as any],
    refresh,
    setSecrets,
  });
  const save = jest
    .spyOn(webapp_client.conat_client.hub.projects, "setProjectSecret")
    .mockResolvedValue({ name: "ANTHROPIC_API_KEY" } as any);
  const onClose = jest.fn();
  try {
    render(
      <ClaudeProjectSecretModal
        open
        projectId="project-a"
        onClose={onClose}
        warning="Project collaborators can read this key."
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByText("Project collaborators can read this key."),
    ).toBeTruthy();
    expect(screen.getByText(/existing value cannot be displayed/)).toBeTruthy();
    const key = screen.getByLabelText("ANTHROPIC_API_KEY") as HTMLInputElement;
    expect(key.value).toBe("");
    const user = userEvent.setup();
    await user.type(key, "test-key");
    await user.click(screen.getByRole("button", { name: "Replace key" }));
    expect(save).toHaveBeenCalledWith({
      project_id: "project-a",
      name: "ANTHROPIC_API_KEY",
      value: "test-key",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(setSecrets).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalled();
  } finally {
    save.mockRestore();
  }
});
