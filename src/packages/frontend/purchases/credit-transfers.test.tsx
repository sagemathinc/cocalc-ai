import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreditTransfers from "./credit-transfers";
import type { CreditTransferApi } from "@cocalc/util/credit-transfers";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));

const recipient = "11111111-1111-4111-8111-111111111111";
const preview = {
  terms: {
    currency: "USD",
    amount_usd: "10.0000000000",
    recipient: {
      account_id: recipient,
      home_bay_id: "launchpad",
      authority_epoch: "22222222-2222-4222-8222-222222222222",
      display_name: "Verified Recipient",
      email_address: "recipient@example.test",
    },
  },
  transferable_usd: "50",
  remaining_transferable_usd: "40",
};
function api(): jest.Mocked<CreditTransferApi> {
  return {
    listCreditTransfers: jest
      .fn()
      .mockResolvedValue({ enabled: true, receipts: [] }),
    previewCreditTransfer: jest.fn().mockResolvedValue(preview),
    proposeCreditTransfer: jest
      .fn()
      .mockImplementation(async ({ operation_id }) => ({
        operation_id,
        state: "approval_required",
        approval_url: "https://approve.example.test/funding/intent",
      })),
    getCreditTransferStatus: jest
      .fn()
      .mockImplementation(async ({ operation_id }) => ({
        operation_id,
        state: "received",
      })),
  };
}
it("makes the horizontally scrollable receipts keyboard accessible", async () => {
  const service = api();
  service.listCreditTransfers.mockResolvedValue({
    enabled: true,
    receipts: [
      {
        purchase_id: 1,
        direction: "sent",
        counterpart_account_id: recipient,
        created_at: "2026-09-13T17:00:00Z",
        transfer_id: "33333333-3333-4333-8333-333333333333",
        operation_id: "44444444-4444-4444-8444-444444444444",
        amount_usd: "1.00",
        state: "received",
      },
    ],
  });
  render(<CreditTransfers api={service} />);
  const receipts = await screen.findByRole("region", {
    name: "Transfer receipts",
  });
  expect(receipts).toHaveAttribute("tabindex", "0");
  expect(within(receipts).getByRole("table")).toBeVisible();
  const user = userEvent.setup();
  screen.getByRole("textbox", { name: "Amount (USD)" }).focus();
  await user.tab();
  expect(receipts).toHaveFocus();
});
async function fill() {
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", {
    name: "Recipient account ID",
  });
  await user.type(input, recipient);
  await user.type(screen.getByRole("textbox", { name: "Amount (USD)" }), "10");
  return user;
}
it("supports keyboard preview, isolated approval and focus restoration", async () => {
  const service = api();
  render(<CreditTransfers api={service} />);
  const user = await fill();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Preview transfer" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Transfer preview" }),
    ).toHaveFocus(),
  );
  expect(service.proposeCreditTransfer).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Request authorization" }),
  );
  const link = await screen.findByRole("link", {
    name: "Review transfer and authorize",
  });
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByRole("textbox", { name: "Amount (USD)" })).toBeDisabled();
  await user.click(
    screen.getByRole("button", { name: "Refresh transfer status" }),
  );
  await user.click(await screen.findByRole("button", { name: "New transfer" }));
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Recipient account ID" }),
    ).toHaveFocus(),
  );
});
it("retries an uncertain proposal with the same operation and terms", async () => {
  const service = api();
  service.proposeCreditTransfer.mockRejectedValueOnce(Error("lost reply"));
  render(<CreditTransfers api={service} />);
  const user = await fill();
  await user.click(screen.getByRole("button", { name: "Preview transfer" }));
  await user.click(
    await screen.findByRole("button", { name: "Request authorization" }),
  );
  await screen.findByRole("alert");
  await user.click(
    screen.getByRole("button", { name: "Request authorization" }),
  );
  await screen.findByRole("link", { name: "Review transfer and authorize" });
  expect(service.proposeCreditTransfer.mock.calls[0][0]).toEqual(
    service.proposeCreditTransfer.mock.calls[1][0],
  );
});
it("discards a stale preview when amount changes during the request", async () => {
  const service = api();
  let resolve!: (value: any) => void;
  service.previewCreditTransfer.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<CreditTransfers api={service} />);
  const user = await fill();
  await user.click(screen.getByRole("button", { name: "Preview transfer" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Amount (USD)" }), {
    target: { value: "20" },
  });
  resolve(preview);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Preview transfer" }),
    ).not.toBeDisabled(),
  );
  expect(
    screen.queryByRole("heading", { name: "Transfer preview" }),
  ).not.toBeInTheDocument();
});
it("does not expose transfer controls when the server gate is disabled", async () => {
  const service = api();
  service.listCreditTransfers.mockResolvedValue({
    enabled: false,
    receipts: [],
    unavailable_reason: "Transfers disabled",
  });
  render(<CreditTransfers api={service} />);
  expect(await screen.findByText("Transfers disabled")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Preview transfer" }),
  ).not.toBeInTheDocument();
});
it("resumes a durable pending approval after reopening billing without reproposing", async () => {
  const service = api();
  const operation_id = "33333333-3333-4333-8333-333333333333";
  service.listCreditTransfers.mockResolvedValue({
    enabled: true,
    receipts: [],
    pending_approvals: [
      {
        ...preview,
        operation_id,
        approval_url: "https://approve.example.test/funding/existing",
      },
    ] as any,
  });
  render(<CreditTransfers api={service} />);
  const user = userEvent.setup();
  const button = await screen.findByRole("button", {
    name: "Resume transfer to recipient@example.test",
  });
  button.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Transfer preview" }),
    ).toHaveFocus(),
  );
  expect(
    screen.getByRole("link", { name: "Review transfer and authorize" }),
  ).toHaveAttribute("href", "https://approve.example.test/funding/existing");
  expect(service.proposeCreditTransfer).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Refresh transfer status" }),
  );
  expect(service.getCreditTransferStatus).toHaveBeenCalledWith({
    operation_id,
  });
});
