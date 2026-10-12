import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockCopy = jest.fn(async (_: { text: string }) => true);
jest.mock("./copy-to-clipboard-util", () => ({
  copyTextToClipboard: (opts: { text: string }) => mockCopy(opts),
}));

import { cliSetupLine, CommandLine } from "./command-line";

const LINE = "curl -fsSL 'https://example.com/api/v2/cli/setup?a=b' | sh";

beforeEach(() => mockCopy.mockClear());

test("the big button copies the command and says so", async () => {
  render(<CommandLine command={LINE} copiedHint="Copied: paste it." />);
  expect(screen.getByText("Click to copy.")).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Copy the command" }),
  );
  expect(mockCopy).toHaveBeenCalledWith({ text: LINE });
  await waitFor(() =>
    expect(screen.getByText("Copied: paste it.")).toBeTruthy(),
  );
});

test("clicking the command itself copies it, and selects it", async () => {
  render(<CommandLine command={LINE} />);
  await userEvent.click(screen.getByText(LINE));
  expect(mockCopy).toHaveBeenCalledWith({ text: LINE });
  expect(window.getSelection()?.toString()).toBe(LINE);
});

test("the setup line is this site's script, quoted for any shell", () => {
  const line = cliSetupLine({ action: "ssh", project: "p'1" });
  expect(line).toBe(
    `curl -fsSL '${window.location.origin}/api/v2/cli/setup?action=ssh&project=p%271' | sh`,
  );
});
