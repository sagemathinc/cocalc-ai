/** @jest-environment jsdom */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Impersonate } from "./impersonate";

const mockCreate = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useState: require("react").useState,
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Loading: () => <div role="status">Loading</div>,
  CopyToClipBoard: () => null,
}));
jest.mock("@cocalc/frontend/app/localize", () => ({
  useLocalizationCtx: () => ({ locale: "en" }),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    admin_client: {
      create_impersonation_grant: (...args: any[]) => mockCreate(...args),
    },
  },
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (fn: any) => fn(),
    freshAuthModalProps: {},
  }),
}));

beforeEach(() => {
  mockCreate.mockReset();
});

it("requires an explicit reason, accepts keyboard submission, and forwards the trimmed explanation", async () => {
  const user = userEvent.setup();
  mockCreate.mockResolvedValue({
    url: "https://example.test/auth/impersonate?grant_id=test",
  });
  render(
    <Impersonate embedded account_id="subject" display_name="Test User" />,
  );
  const button = screen.getByRole("button", {
    name: "Generate impersonation link",
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  const input = screen.getByRole("textbox", {
    name: /Reason and authorization/,
  });
  fireEvent.change(input, { target: { value: "   " } });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  input.focus();
  await user.type(
    input,
    "Ticket 123: customer authorized notebook investigation",
  );
  await user.tab();
  expect(document.activeElement).toBe(button);
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(mockCreate).toHaveBeenCalledWith({
      subject_account_id: "subject",
      reason: "Ticket 123: customer authorized notebook investigation",
      lang_temp: "en",
    }),
  );
  const link = await screen.findByRole("link", { name: /Right click/ });
  await waitFor(() => expect(document.activeElement).toBe(link));
});

it("keeps the explanation available after a failed request", async () => {
  mockCreate.mockRejectedValue(new Error("fresh auth needed"));
  render(
    <Impersonate embedded account_id="subject" display_name="Test User" />,
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Ticket 123, explicit permission" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Generate impersonation link" }),
  );
  expect(await screen.findByRole("alert")).not.toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Ticket 123, explicit permission",
  );
});
