import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodexModelRecovery } from "../codex-model-recovery";
import { discoverAccountCodexModels } from "../codex-model-discovery";

jest.mock("../codex-model-discovery", () => ({
  discoverAccountCodexModels: jest.fn(),
  preferredAvailableCodexModel: (models, _preferred, rejected) =>
    models?.find((m) => m.default && m.model !== rejected) ??
    models?.find((m) => m.model !== rejected),
}));
const discover = discoverAccountCodexModels as jest.Mock;
const models = [
  { model: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", default: true },
  { model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
];
const props = {
  projectId: "project",
  failedModel: "gpt-5.6-sol",
  details: "Original HTTP 400",
};

beforeEach(() => {
  jest.clearAllMocks();
});

it("announces discovery, then supports choosing and retrying by keyboard", async () => {
  let resolve;
  discover.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const retry = jest.fn().mockResolvedValue(undefined);
  render(<CodexModelRecovery {...props} onRetry={retry} />);
  expect(screen.getByRole("status").textContent).toContain(
    "Finding an available model",
  );
  expect(screen.queryByRole("button", { name: /and retry/ })).toBeNull();
  resolve(models);
  const button = await screen.findByRole("button", {
    name: "Use GPT-5.6 Terra and retry",
  });
  const user = userEvent.setup();
  await user.tab();
  expect(
    screen.getByRole("combobox", { name: "Available model" }),
  ).toHaveFocus();
  await user.tab();
  expect(button).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(retry).toHaveBeenCalledWith("gpt-5.6-terra"));
  expect(retry).toHaveBeenCalledTimes(1);
});

it("allows a different discovered model and prevents duplicate pending retries", async () => {
  discover.mockResolvedValue(models);
  const retry = jest.fn(() => new Promise<void>(() => {}));
  render(<CodexModelRecovery {...props} onRetry={retry} />);
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByRole("combobox"), "gpt-5.6-luna");
  await user.dblClick(
    screen.getByRole("button", { name: "Use GPT-5.6 Luna and retry" }),
  );
  expect(retry).toHaveBeenCalledTimes(1);
  expect(retry).toHaveBeenCalledWith("gpt-5.6-luna");
});

it("does not guess a model on discovery failure and offers another check", async () => {
  discover
    .mockRejectedValueOnce(Error("timeout"))
    .mockResolvedValueOnce(models);
  render(<CodexModelRecovery {...props} onRetry={jest.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("couldn't check"),
  );
  expect(screen.queryByRole("button", { name: /and retry/ })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "Check available models again" }),
  );
  await screen.findByRole("button", { name: "Use GPT-5.6 Terra and retry" });
});

it("does not offer the rejected model when it is the only result", async () => {
  discover.mockResolvedValue([{ model: "gpt-5.6-sol", default: true }]);
  render(<CodexModelRecovery {...props} onRetry={jest.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("No alternative"),
  );
  expect(screen.queryByRole("button", { name: /and retry/ })).toBeNull();
});

it("keeps a failed retry actionable without auto-retrying", async () => {
  discover.mockResolvedValue(models);
  const retry = jest.fn().mockRejectedValue(Error("old host"));
  render(<CodexModelRecovery {...props} onRetry={retry} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Use GPT-5.6 Terra and retry" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("couldn't retry"),
  );
  expect(retry).toHaveBeenCalledTimes(1);
});
