import maintainSubscriptions from "./maintain-subscriptions";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { before, after } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import dayjs from "dayjs";
import {
  createTestAccount,
  createTestMembershipSubscription,
} from "./test-data";
import {
  formatPaymentActionDate,
  formatRenewalDate,
} from "./subscription-renewal-notice";

const mockCreateSubscriptionPayment = jest.fn();
const mockGetBillingReadiness = jest.fn();
const mockGetServerSettings = jest.fn();
const mockGetTotalBalance = jest.fn();
const mockSend = jest.fn();
const mockUrl = jest.fn();

jest.mock("./stripe/create-subscription-payment", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCreateSubscriptionPayment(...args),
}));

jest.mock("./stripe/billing-readiness", () => ({
  getBillingReadiness: (...args: any[]) => mockGetBillingReadiness(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args: any[]) => mockGetServerSettings(...args),
}));

jest.mock("./get-balance", () => ({
  __esModule: true,
  default: jest.fn(),
  getTotalBalance: (...args: any[]) => mockGetTotalBalance(...args),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  __esModule: true,
  default: (...args: any[]) => mockSend(...args),
  url: (...args: any[]) => mockUrl(...args),
}));

beforeAll(async () => {
  await before({ noConat: true });
}, 15000);
afterAll(after);

describe("test maintainSubscriptions", () => {
  beforeEach(async () => {
    await getPool().query("DELETE FROM subscriptions");
    mockCreateSubscriptionPayment.mockReset().mockResolvedValue(undefined);
    mockGetBillingReadiness.mockReset().mockResolvedValue({
      hasBillingDetails: true,
      hasPaymentMethod: true,
    });
    mockGetServerSettings.mockReset().mockResolvedValue({
      site_name: "CoCalc",
      support_account_id: uuid(),
    });
    mockGetTotalBalance.mockReset().mockResolvedValue(0);
    mockSend.mockReset().mockResolvedValue(undefined);
    mockUrl.mockReset().mockImplementation(async (path) => path);
  });

  it("run maintainSubscriptions once and it doesn't crash", async () => {
    try {
      await maintainSubscriptions();
    } catch (_) {
      // rare case that some muck left in database due to half-failed tests, so clean up
      // once and try again.  A little iffy do to tests running in parallel, but should
      // never happen if there is a clean slate.
      await initEphemeralDatabase({ reset: true });
      await maintainSubscriptions();
    }
  });

  it("does not create renewal payments before the subscription period ends", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    await createTestMembershipSubscription(account_id, {
      end: dayjs().add(2, "days").toDate(),
    });

    const { createPayments } = await import("./maintain-subscriptions");
    await createPayments();

    expect(mockCreateSubscriptionPayment).not.toHaveBeenCalled();
  });

  it("creates renewal payments when the subscription period has ended", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const { subscription_id } = await createTestMembershipSubscription(
      account_id,
      {
        start: dayjs().subtract(1, "month").toDate(),
        end: dayjs().subtract(1, "minute").toDate(),
      },
    );

    const { createPayments } = await import("./maintain-subscriptions");
    await createPayments();

    expect(mockCreateSubscriptionPayment).toHaveBeenCalledWith({
      account_id,
      subscription_id,
    });
  });

  it("sends renewal reminders with renewal and payment action dates", async () => {
    const account_id = uuid();
    await createTestAccount(account_id);
    const current_period_end = dayjs().add(5, "days").toDate();
    await createTestMembershipSubscription(account_id, {
      cost: 72,
      end: current_period_end,
      interval: "year",
    });

    const { sendUpcomingRenewalNotifications } =
      await import("./maintain-subscriptions");
    await sendUpcomingRenewalNotifications();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const body = mockSend.mock.calls[0][0].body;
    expect(body).toContain(formatRenewalDate(current_period_end));
    expect(body).toContain(formatPaymentActionDate(current_period_end));
    expect(body).toContain("Your payment method will be charged on or after");
    expect(body).not.toContain("two days from now");
    expect(body).not.toContain("days before");
  });
});
