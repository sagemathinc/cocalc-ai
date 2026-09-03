/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { open_new_tab } from "@cocalc/frontend/misc/open-browser-tab";
import { showCodexNotificationBestEffort } from "@cocalc/frontend/notifications/codex-turn-toast";
import { CodexAttentionCard, codexFreshAuthUrl } from "../codex-attention-card";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { attentionAcp: jest.fn() },
  },
}));
jest.mock("@cocalc/frontend/misc/open-browser-tab", () => ({
  open_new_tab: jest.fn(),
}));
jest.mock("@cocalc/frontend/notifications/codex-turn-toast", () => ({
  showCodexNotificationBestEffort: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/base",
}));
jest.mock("@cocalc/frontend/control-plane-origin", () => ({
  getControlPlaneAppUrl: () => "https://cocalc.test/base",
}));

const reference = "00000000-3000-4000-8000-000000000003";
const record: AcpAttentionRecord = {
  attention_id: "00000000-4000-4000-8000-000000000004",
  project_id: "00000000-2000-4000-8000-000000000002",
  account_id: "00000000-1000-4000-8000-000000000001",
  path: "agent.chat",
  thread_id: "thread-1",
  message_date: "2026-09-03T21:09:14.619Z",
  source_kind: "cocalc_action",
  source_id: `fresh_auth:${reference}`,
  attention_kind: "fresh_auth",
  is_blocking: true,
  title: "Codex needs fresh account authorization",
  questions: [],
  action: {
    kind: "fresh_auth",
    reference,
    expires_at: Date.now() + 60_000,
  },
  state: "pending",
  created_at: Date.now(),
  updated_at: Date.now(),
};

describe("Codex fresh-auth attention", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        ...(request.action === "list"
          ? { records: [record] }
          : { state: "pending", record }),
      }));
  });

  it("constructs only a first-party URL from a UUID reference", () => {
    expect(codexFreshAuthUrl(reference, "https://cocalc.test/base")).toBe(
      `https://cocalc.test/base/auth/cli-elevate/${reference}`,
    );
    expect(
      codexFreshAuthUrl(
        "https://attacker.invalid/steal",
        "https://cocalc.test",
      ),
    ).toBeUndefined();
  });

  it("renders an accessible action instead of question controls", async () => {
    const view = render(<CodexAttentionCard initialRecord={record} />);
    expect(
      screen.getByRole("region", { name: "Codex needs attention" }),
    ).toBeInTheDocument();
    const approve = screen.getByRole("button", {
      name: "Approve in CoCalc",
    });
    expect(
      screen.queryByRole("button", { name: "Send response" }),
    ).not.toBeInTheDocument();

    fireEvent.click(approve);
    expect(open_new_tab).toHaveBeenCalledWith(
      `https://cocalc.test/base/auth/cli-elevate/${reference}`,
    );
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "execute_action",
          attention_id: record.attention_id,
        }),
      ),
    );
    expect(showCodexNotificationBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({
          summary: expect.objectContaining({
            message_date: record.message_date,
          }),
        }),
      }),
    );
    view.unmount();
  });
});

describe("Codex question attention", () => {
  const questionRecord: AcpAttentionRecord = {
    ...record,
    source_kind: "codex_sync_question",
    source_id: "question-1",
    attention_kind: "question",
    action: undefined,
    questions: [
      {
        id: "region",
        header: "Region",
        question: "Which region?",
        options: [{ label: "EU" }, { label: "US" }],
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        ...(request.action === "list"
          ? { records: [questionRecord] }
          : { state: "pending", record: questionRecord }),
      }));
  });

  it("only offers custom input when the question permits it", async () => {
    const view = render(<CodexAttentionCard initialRecord={questionRecord} />);
    expect(
      screen.queryByRole("textbox", { name: "Custom answer for Region" }),
    ).not.toBeInTheDocument();
    view.unmount();
    const otherView = render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          questions: [{ ...questionRecord.questions[0], isOther: true }],
        }}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Custom answer for Region" }),
      ).toBeInTheDocument(),
    );
    otherView.unmount();
  });
});
