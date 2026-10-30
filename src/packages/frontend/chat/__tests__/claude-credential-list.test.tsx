/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaudeCredentialList } from "../claude-credential-list";

const setClaudeSubscriptionInPool = jest.fn(async () => ({ updated: true }));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {
          setClaudeSubscriptionInPool: (...args: any[]) =>
            (setClaudeSubscriptionInPool as any)(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/components/time-ago", () => ({
  TimeAgo: ({ date }: { date: string }) => <span>at {date}</span>,
}));

const hour = 3600;
const now = Math.floor(Date.now() / 1000);
const office = "00000000-0000-4000-8000-000000000001";
const claude1 = "00000000-0000-4000-8000-000000000002";
const key = "00000000-0000-4000-8000-000000000003";
const credentials = [
  {
    id: office,
    kind: "claude-subscription-home-v1",
    revoked: null,
    last_used: new Date().toISOString(),
    metadata: {
      label: "office",
      claude_usage: {
        observed_at: new Date(now * 1000).toISOString(),
        windows: {
          five_hour: { utilization: 0.13, resets_at: now + 5 * hour },
          seven_day: { utilization: 0.6, resets_at: now + 72 * hour },
        },
      },
    },
  },
  {
    id: claude1,
    kind: "claude-subscription-home-v1",
    revoked: null,
    last_used: new Date(Date.now() - 3600_000).toISOString(),
    metadata: { label: "claude1@sagemath" },
  },
  {
    id: key,
    kind: "anthropic-api-key",
    revoked: null,
    metadata: { label: "Team key" },
  },
] as any;

test("one row per payment method, with every subscription's usage and the selection clear", async () => {
  const onChange = jest.fn();
  render(
    <ClaudeCredentialList
      credentials={credentials}
      value={`account-subscription:${claude1}`}
      loaded
      onChange={onChange}
    />,
  );
  const radios = screen.getAllByRole("radio");
  // Auto, two subscriptions, the API key and the project secret.
  expect(radios).toHaveLength(5);
  expect(
    (
      screen.getByRole("radio", {
        name: /claude1@sagemath/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(screen.getByText("(used by this agent)")).toBeTruthy();
  // Usage of the subscription that is not selected is visible too.
  expect(screen.getByText("13%")).toBeTruthy();
  expect(screen.getByText("60%")).toBeTruthy();
  expect(screen.getByText("No usage reported yet")).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: /This week: on pace to reach the limit/,
    }),
  ).toBeTruthy();
  expect(screen.getByText(/It may be out of date/)).toBeTruthy();
  expect(
    screen.getByText("Anthropic bills API usage to the key owner"),
  ).toBeTruthy();
  const user = userEvent.setup();
  // Review on #1114: inspecting the warning of another subscription must not
  // switch the agent's payment method.
  const warning = screen.getByRole("button", {
    name: /This week: on pace to reach the limit/,
  });
  await user.click(warning);
  expect(onChange).not.toHaveBeenCalled();
  expect(await screen.findByRole("tooltip")).toBeTruthy();
  // Keyboard: Escape closes it, focus opens it again.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  await user.click(screen.getByRole("radio", { name: /office/ }));
  expect(onChange).toHaveBeenCalledWith(`account-subscription:${office}`);
});

test("an unknown selection stays visible", () => {
  render(
    <ClaudeCredentialList
      credentials={[]}
      value="account-subscription:gone"
      loaded
      onChange={jest.fn()}
    />,
  );
  expect(screen.getByText("Selected connection unavailable")).toBeTruthy();
});

test("offers included Claude when the membership includes it", async () => {
  const onChange = jest.fn();
  const { rerender } = render(
    <ClaudeCredentialList
      credentials={[]}
      value="project-secret"
      loaded
      onChange={onChange}
    />,
  );
  expect(screen.queryByText("CoCalc Membership (Claude Haiku 5.5)")).toBeNull();
  rerender(
    <ClaudeCredentialList
      credentials={[]}
      value="project-secret"
      loaded
      membership
      onChange={onChange}
    />,
  );
  expect(
    screen.getByText("Included in your CoCalc membership's AI allowance"),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByText("CoCalc Membership (Claude Haiku 5.5)"),
  );
  expect(onChange).toHaveBeenCalledWith("site-funded");
});

test("Auto is offered once there is a subscription", async () => {
  const onChange = jest.fn();
  const { rerender } = render(
    <ClaudeCredentialList
      credentials={[credentials[2]]}
      value="project-secret"
      loaded
      onChange={onChange}
    />,
  );
  expect(screen.queryByRole("radio", { name: /Auto/ })).toBeNull();
  rerender(
    <ClaudeCredentialList
      credentials={credentials}
      value="project-secret"
      loaded
      onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("radio", { name: /Auto/ }));
  expect(onChange).toHaveBeenCalledWith("subscription-pool");
});

test("with Auto: which subscriptions it uses, and how long they last", async () => {
  setClaudeSubscriptionInPool.mockClear();
  const onCredentials = jest.fn();
  render(
    <ClaudeCredentialList
      credentials={credentials}
      value="subscription-pool"
      loaded
      onChange={jest.fn()}
      onCredentials={onCredentials}
    />,
  );
  expect(
    (screen.getByRole("radio", { name: /Auto/ }) as HTMLInputElement).checked,
  ).toBe(true);
  // Both subscriptions have room; office has used 60% of its week.
  expect(screen.getByRole("status").textContent).toMatch(
    /2 of 2 subscriptions with room now\. About 1\.4 of 2 weekly limits left/,
  );
  const office = screen.getByRole("checkbox", { name: "office" });
  expect((office as HTMLInputElement).checked).toBe(true);
  // API keys are never in Auto.
  expect(screen.queryByRole("checkbox", { name: "Team key" })).toBeNull();
  await userEvent.click(office);
  expect(setClaudeSubscriptionInPool).toHaveBeenCalledWith({
    id: "00000000-0000-4000-8000-000000000001",
    in_pool: false,
  });
  await waitFor(() => expect(onCredentials).toHaveBeenCalled());
  const rows = (onCredentials.mock.calls[0] as any[])[0];
  expect(rows[0].metadata.claude_pool_excluded).toBe(true);
});

test("an Auto with nothing left to use says so", () => {
  render(
    <ClaudeCredentialList
      credentials={credentials.map((row: any) => ({
        ...row,
        metadata: { ...row.metadata, claude_pool_excluded: true },
      }))}
      value="subscription-pool"
      loaded
      onChange={jest.fn()}
    />,
  );
  expect(screen.getByText(/Auto has no subscription to use/)).toBeTruthy();
});
