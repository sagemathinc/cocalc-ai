/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { open_new_tab } from "@cocalc/frontend/misc/open-browser-tab";
import { CodexAttentionCard, codexFreshAuthUrl } from "../codex-attention-card";

const mockMarkdownInput = jest.fn();
jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: (props: any) => {
    mockMarkdownInput(props);
    return (
      <textarea
        aria-label={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    );
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { attentionAcp: jest.fn() },
  },
}));
jest.mock("@cocalc/frontend/misc/open-browser-tab", () => ({
  open_new_tab: jest.fn(),
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
    sessionStorage.clear();
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
    sessionStorage.clear();
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        ...(request.action === "list"
          ? { records: [questionRecord] }
          : { state: "pending", record: questionRecord }),
      }));
  });

  it("keeps the submitted answer beside its question with keyboard focus and no false receipt", async () => {
    const user = userEvent.setup();
    const question = {
      ...questionRecord,
      source_kind: "codex_async_question" as const,
      is_blocking: false,
    };
    let saved = question;
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => {
        if (request.action === "respond") {
          saved = {
            ...question,
            response_submitted_at: Date.now(),
            updated_at: question.updated_at + 1,
          };
          return { ok: true, record: saved };
        }
        return { ok: true, records: [saved] };
      });
    const view = render(<CodexAttentionCard initialRecord={question} />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("radio", { name: "EU" })).toHaveFocus();
    await user.keyboard(" ");
    await user.tab();
    expect(screen.getByRole("button", { name: "Send response" })).toHaveFocus();
    await user.keyboard("{Enter}");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(
      "Your response is saved. Receipt by the agent is not confirmed.",
    );
    expect(status).toHaveFocus();
    const response = screen.getByRole("region", {
      name: "Response for Region",
    });
    expect(within(response).getByText("Which region?")).toBeInTheDocument();
    expect(within(response).getByText("EU")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send response" }),
    ).not.toBeInTheDocument();

    view.rerender(
      <CodexAttentionCard
        initialRecord={{
          ...saved,
          state: "answered",
          updated_at: saved.updated_at + 1,
          resolution_reason: "Answer queued as a new Codex message",
        }}
      />,
    );
    expect(status).toHaveTextContent("Receipt by the agent is not confirmed");
    expect(response).toHaveTextContent("EU");
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("button", { name: "Show question" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your response is saved",
    );
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("region", { name: "Response for Region" }),
    ).toHaveTextContent("EU");
  });

  it.each(["Codex", "ACP"])(
    "requires explicit %s synchronous acceptance before claiming receipt",
    (runtime) => {
      const submitted = {
        ...questionRecord,
        state: "answered" as const,
        response_submitted_at: 10,
      };
      const view = render(<CodexAttentionCard initialRecord={submitted} />);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Receipt by the agent is not confirmed",
      );
      view.rerender(
        <CodexAttentionCard
          initialRecord={{
            ...submitted,
            updated_at: submitted.updated_at + 1,
            resolution_reason: `${runtime} accepted the response`,
          }}
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        `${runtime === "ACP" ? "The agent" : "Codex"} accepted your response.`,
      );
      expect(
        screen.getByText(
          `Received by ${runtime === "ACP" ? "agent" : "Codex"}`,
        ),
      ).toBeInTheDocument();
    },
  );

  it("restores a locally submitted answer after remount and exposes long text by keyboard", async () => {
    const user = userEvent.setup();
    const text = "Detailed answer. ".repeat(100);
    render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          state: "answered",
          response_submitted_at: 10,
        }}
        draft={{
          selected: {},
          other: {},
          submitted: { answers: { region: [text] }, declined: false },
        }}
      />,
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "Show question" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Show full response" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("region", { name: "Response for Region" }),
    ).toHaveTextContent(text.trim());
    expect(
      screen.getByRole("button", { name: "Hide full response" }),
    ).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("region", { name: "Response for Region" }),
    ).not.toHaveTextContent(text.trim());
  });

  it("keeps a saved answer visible when delivery fails and permits retry", async () => {
    const user = userEvent.setup();
    const stale = {
      ...questionRecord,
      state: "stale" as const,
      response_submitted_at: 10,
      updated_at: questionRecord.updated_at + 1,
    };
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) =>
        request.action === "respond"
          ? { ok: false, record: stale, error: "delivery failed" }
          : { ok: true, records: [] },
      );
    render(<CodexAttentionCard initialRecord={questionRecord} />);
    await user.click(screen.getByRole("radio", { name: "US" }));
    await user.click(screen.getByRole("button", { name: "Send response" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "delivery failed",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "saved, but could not be delivered",
    );
    expect(
      screen.getByRole("region", { name: "Response for Region" }),
    ).toHaveTextContent("US");
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Continue with this answer" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
      expect.objectContaining({ action: "continue" }),
    );
  });

  it("does not replace a submitted receipt with an older in-flight poll", async () => {
    let finishPoll!: (value: any) => void;
    const oldPoll = new Promise<any>((resolve) => {
      finishPoll = resolve;
    });
    const saved = {
      ...questionRecord,
      state: "answered" as const,
      response_submitted_at: 10,
      updated_at: questionRecord.updated_at + 1,
    };
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) =>
        request.action === "list"
          ? oldPoll
          : request.action === "respond"
            ? { ok: true, record: saved }
            : { ok: true },
      );
    const user = userEvent.setup();
    render(<CodexAttentionCard initialRecord={questionRecord} />);
    await user.click(screen.getByRole("radio", { name: "EU" }));
    await user.click(screen.getByRole("button", { name: "Send response" }));
    await act(async () => {
      finishPoll({ ok: true, records: [questionRecord] });
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your response is saved",
    );
    expect(
      screen.queryByRole("button", { name: "Send response" }),
    ).not.toBeInTheDocument();
  });

  it("does not present a failed submission as saved or discard its draft", async () => {
    const user = userEvent.setup();
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) =>
        request.action === "respond"
          ? { ok: false, error: "not accepted" }
          : { ok: true },
      );
    render(<CodexAttentionCard initialRecord={questionRecord} />);
    await user.click(screen.getByRole("radio", { name: "EU" }));
    await user.click(screen.getByRole("button", { name: "Send response" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not accepted");
    expect(screen.getByRole("radio", { name: "EU" })).toBeChecked();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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

  it("uses the runtime summary and does not describe a closed question as paused", () => {
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockResolvedValue({ ok: true });
    const view = render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          summary: "The current ACP turn is paused.",
        }}
      />,
    );
    expect(
      screen.getByText("The current ACP turn is paused."),
    ).toBeInTheDocument();
    view.unmount();
    render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          state: "stale",
          summary: "The current ACP turn is paused.",
          resolution_reason: "The request was interrupted.",
        }}
      />,
    );
    expect(screen.getByText("Turn ended")).toBeInTheDocument();
    expect(
      screen.getByText(
        "That turn has ended. Send your answer as a new message to continue.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("The current ACP turn is paused."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send response" }),
    ).not.toBeInTheDocument();
  });

  it("allows exactly one suggested answer", async () => {
    const user = userEvent.setup();
    const view = render(<CodexAttentionCard initialRecord={questionRecord} />);
    const eu = screen.getByRole("radio", { name: "EU" });
    const us = screen.getByRole("radio", { name: "US" });
    expect(eu).toHaveAttribute(
      "name",
      `codex-attention-${questionRecord.attention_id}-region`,
    );
    expect(us).toHaveAttribute("name", eu.getAttribute("name"));

    await user.click(eu);
    expect(eu).toBeChecked();
    expect(us).not.toBeChecked();

    await user.keyboard("{ArrowRight}");
    expect(eu).not.toBeChecked();
    expect(us).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "respond",
          answers: { region: ["US"] },
        }),
      ),
    );
    view.unmount();
  });

  it("collapses without answering and offers late answers as a new message", async () => {
    const user = userEvent.setup();
    const stale = { ...questionRecord, state: "stale" as const };
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        ...(request.action === "list"
          ? { records: [stale] }
          : { record: stale }),
      }));
    const view = render(<CodexAttentionCard initialRecord={stale} />);
    expect(
      screen.getByRole("button", { name: "Send as new message" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("radio", { name: "EU" })).not.toBeInTheDocument();
    expect(webapp_client.conat_client.attentionAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "respond" }),
    );
    await user.click(screen.getByRole("button", { name: "Show question" }));
    await user.click(screen.getByRole("radio", { name: "EU" }));
    await user.click(
      screen.getByRole("button", { name: "Send as new message" }),
    );
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "respond",
          answers: { region: ["EU"] },
        }),
      ),
    );
    view.unmount();
  });

  it("keeps keyboard recovery without duplicating an answer already in activity", async () => {
    const user = userEvent.setup();
    const record = {
      ...questionRecord,
      source_kind: "codex_sync_question" as const,
      state: "stale" as const,
      response_submitted_at: Date.now(),
    };
    jest.mocked(webapp_client.conat_client.attentionAcp).mockResolvedValue({
      ok: true,
      record: { ...record, state: "answered" },
    });
    const view = render(
      <CodexAttentionCard initialRecord={record} responseInActivity />,
    );
    expect(
      screen.queryByRole("region", { name: "Response for Region" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "could not be delivered",
    );
    const retry = screen.getByRole("button", {
      name: "Continue with this answer",
    });
    retry.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "continue",
          attention_id: record.attention_id,
        }),
      ),
    );
    expect(screen.queryByText("Received by Codex")).toBeNull();
    view.unmount();
  });

  it("keeps oversized drafts visible and enables submission after shortening", async () => {
    const user = userEvent.setup();
    const record = {
      ...questionRecord,
      questions: [{ ...questionRecord.questions[0], isOther: true }],
    };
    jest.mocked(webapp_client.conat_client.attentionAcp).mockResolvedValue({
      ok: true,
      records: [record],
    });
    const view = render(<CodexAttentionCard initialRecord={record} />);
    const input = screen.getByRole("textbox", {
      name: "Custom answer for Region",
    });
    await user.click(input);
    fireEvent.change(input, { target: { value: "a".repeat(32_001) } });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("a".repeat(32_001));
    expect(screen.getByRole("status")).toHaveTextContent("1 over the limit");
    expect(
      screen.getByRole("button", { name: "Send response" }),
    ).toBeDisabled();
    fireEvent.change(input, { target: { value: "a".repeat(32_000) } });
    expect(screen.getByRole("button", { name: "Send response" })).toBeEnabled();
    view.unmount();
  });

  it("submits Markdown and image links through the shared upload-enabled editor", async () => {
    const user = userEvent.setup();
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        ...(request.action === "respond"
          ? { record: { ...questionRecord, state: "answered" as const } }
          : { records: [] }),
      }));
    const view = render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          questions: [{ ...questionRecord.questions[0], isOther: true }],
        }}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Custom answer for Region",
    });
    await user.click(input);
    expect(input).toHaveFocus();
    fireEvent.change(input, {
      target: { value: "**EU**\n![map](.chat-images/map.png)" },
    });
    expect(mockMarkdownInput).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project_id: questionRecord.project_id,
        path: questionRecord.path,
        enableUpload: true,
        saveDebounceMs: 0,
      }),
    );
    await user.tab();
    const send = screen.getByRole("button", { name: "Send response" });
    expect(send).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "respond",
          answers: { region: ["**EU**\n![map](.chat-images/map.png)"] },
        }),
      ),
    );
    view.unmount();
  });
});
