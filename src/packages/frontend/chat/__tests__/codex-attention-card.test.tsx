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

import { writeCodexSubscriptionSelection } from "../codex-subscription-selection";

const mockMarkdownInput = jest.fn();
jest.mock("@cocalc/frontend/editors/markdown-input/multimode", () => ({
  __esModule: true,
  default: (props: any) => {
    mockMarkdownInput(props);
    if (props.controlRef) props.controlRef.current = { focus: mockFocus };
    return (
      <textarea
        aria-label={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.shiftKey) {
            event.preventDefault();
            props.onShiftEnter?.(props.value);
          }
        }}
      />
    );
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: { attentionAcp: jest.fn() },
  },
}));
const mockNamedAgents = jest.fn(() => ({ directory: { agents: [] as any[] } }));
beforeEach(() => {
  mockNamedAgents.mockReturnValue({ directory: { agents: [] } });
});
jest.mock("@cocalc/frontend/agents/api", () => ({
  useNamedAgents: () => mockNamedAgents(),
  namedAgentReference: (agent: any) => ({
    version: 1,
    naming_account_id: agent.account_id,
    target: agent.endpoint,
    name: agent.name,
  }),
}));
const mockPreflight = jest.fn(
  async (_value: string, send: () => void | Promise<void>) => {
    await send();
  },
);
let mockRestoreFocus: (() => void) | undefined;
const mockFocus = jest.fn();
let mockMentionAgents: any[] = [];
const mockOnSelect = jest.fn();
jest.mock("@cocalc/frontend/agents/use-agent-mentions", () => ({
  useAgentMentions: (opts: any) => (
    (mockRestoreFocus = opts.restoreFocus),
    {
      agents: mockMentionAgents,
      context: { allowAgentMentions: true, onSelect: mockOnSelect, states: {} },
      preflight: (value: string, send: () => void | Promise<void>) =>
        mockPreflight(value, send),
      ui: null,
    }
  ),
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
    localStorage.clear();
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
      screen.getByRole("region", { name: "The agent needs attention" }),
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
    localStorage.clear();
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        ...(request.action === "list"
          ? { records: [questionRecord] }
          : { state: "pending", record: questionRecord }),
      }));
  });

  it("submits the same private subscription selection as the composer", async () => {
    const credentialId = "77777777-7777-4777-8777-777777777777";
    writeCodexSubscriptionSelection({
      accountId: record.account_id,
      projectId: record.project_id,
      threadKey: record.thread_id,
      credentialId,
    });
    const view = render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          source_kind: "codex_async_question",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "respond",
          codex_credential_id: credentialId,
        }),
      ),
    );
    view.unmount();
  });

  it("says a lone question once, and nothing about the agent going on", () => {
    render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          source_kind: "codex_async_question",
          is_blocking: false,
          title: "Question 1",
          summary: "Claude may continue while it waits for your reply.",
          questions: [{ ...questionRecord.questions[0], header: "Question 1" }],
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Question" }),
    ).toBeInTheDocument();
    // Shown nowhere: only the fieldset's legend (for screen readers) says it.
    expect(
      screen
        .queryAllByText("Question 1")
        .every(
          (element) =>
            element.tagName === "LEGEND" &&
            element.style.position === "absolute",
        ),
    ).toBe(true);
    expect(screen.queryByText(/may continue while it waits/)).toBeNull();
    // Still named for screen readers.
    expect(
      screen.getByRole("group", { name: "Question 1" }),
    ).toBeInTheDocument();
  });

  it("names the agent, not Codex, while an async question waits", () => {
    const question = {
      ...questionRecord,
      source_kind: "codex_async_question" as const,
      is_blocking: false,
    };
    const unnamed = render(<CodexAttentionCard initialRecord={question} />);
    expect(
      screen.getByRole("region", { name: "The agent needs attention" }),
    ).toBeInTheDocument();
    // No line about the agent working on: the running turn shows that.
    expect(screen.queryByText(/can keep working while you answer/)).toBeNull();
    unnamed.unmount();

    mockNamedAgents.mockReturnValue({
      directory: {
        agents: [
          {
            name: "cocalc-acp",
            path: question.path,
            thread_id: question.thread_id,
            endpoint: { project_id: question.project_id },
          },
          {
            name: "other-thread",
            path: question.path,
            thread_id: "thread-2",
            endpoint: { project_id: question.project_id },
          },
        ],
      },
    });
    render(<CodexAttentionCard initialRecord={question} />);
    expect(
      screen.getByRole("region", { name: "@cocalc-acp needs attention" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/can keep working while you answer/)).toBeNull();
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

  it.each(["Codex", "ACP", "Claude", "Agent"])(
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
      const name =
        runtime === "Codex" || runtime === "Claude" ? runtime : undefined;
      expect(screen.getByRole("status")).toHaveTextContent(
        `${name ?? "The agent"} accepted your response.`,
      );
      expect(
        screen.getByText(`Received by ${name ?? "agent"}`),
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

  it("keeps the saved answer on screen after a successful retry", async () => {
    const user = userEvent.setup();
    const questionId = questionRecord.questions[0].id;
    const stale = {
      ...questionRecord,
      state: "stale" as const,
      response_submitted_at: 10,
      own_response: { answers: { [questionId]: ["US"] } },
    };
    // The continue reply is the public record, without own_response.
    const { own_response: _omit, ...publicAnswered } = {
      ...stale,
      state: "answered" as const,
      updated_at: stale.updated_at + 5,
    };
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) =>
        request.action === "continue"
          ? { ok: true, record: publicAnswered }
          : { ok: true, records: [] },
      );
    render(<CodexAttentionCard initialRecord={stale} />);
    await user.click(
      screen.getByRole("button", { name: "Continue with this answer" }),
    );
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({ action: "continue" }),
      ),
    );
    const region = screen.getByRole("region", { name: "Response for Region" });
    expect(region).toHaveTextContent("US");
    expect(region).not.toHaveTextContent("not available");
  });

  it("shows the person's own saved answer after a reload", () => {
    const stale = {
      ...questionRecord,
      state: "stale" as const,
      response_submitted_at: 10,
      own_response: { answers: { [questionRecord.questions[0].id]: ["US"] } },
    };
    render(<CodexAttentionCard initialRecord={stale} />);
    const region = screen.getByRole("region", { name: "Response for Region" });
    expect(region).toHaveTextContent("US");
    expect(region).not.toHaveTextContent("not available");

    const declined = {
      ...stale,
      own_response: { answers: {}, declined: true },
    };
    render(<CodexAttentionCard initialRecord={declined} />);
    expect(
      screen.getAllByRole("region", { name: "Response for Region" })[1],
    ).toHaveTextContent("Declined to answer");
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

  it("dismisses an open async question on the server, for every device", async () => {
    const user = userEvent.setup();
    const open = {
      ...questionRecord,
      source_kind: "codex_async_question" as const,
      is_blocking: false,
    };
    const dismissed = {
      ...open,
      state: "canceled" as const,
      resolution_reason: "Dismissed without an answer.",
      updated_at: open.updated_at + 1,
    };
    jest
      .mocked(webapp_client.conat_client.attentionAcp)
      .mockImplementation(async (request: any) => ({
        ok: true,
        ...(request.action === "list"
          ? { records: [open] }
          : request.action === "dismiss"
            ? { state: "canceled", record: dismissed }
            : { record: open }),
      }));
    const view = render(<CodexAttentionCard initialRecord={open} />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "dismiss",
          attention_id: open.attention_id,
        }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Show question" }),
    ).toBeTruthy();
    expect(webapp_client.conat_client.attentionAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "respond" }),
    );
    view.unmount();
  });

  it.each(["codex_sync_question", "codex_async_question"] as const)(
    "keeps keyboard recovery and selected subscription for a saved %s",
    async (source_kind) => {
      const user = userEvent.setup();
      const record = {
        ...questionRecord,
        source_kind,
        state: "stale" as const,
        resolution_reason:
          "The selected Codex payment source (subscription) is not configured.",
        response_submitted_at: Date.now(),
      };
      jest.mocked(webapp_client.conat_client.attentionAcp).mockResolvedValue({
        ok: true,
        record: { ...record, state: "answered" },
      });
      const credentialId = "77777777-7777-4777-8777-777777777777";
      writeCodexSubscriptionSelection({
        accountId: record.account_id,
        projectId: record.project_id,
        threadKey: record.thread_id,
        credentialId,
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
      expect(screen.getByRole("status")).toHaveTextContent(
        record.resolution_reason,
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
            codex_credential_id: credentialId,
            attention_id: record.attention_id,
          }),
        ),
      );
      expect(screen.queryByText("Received by Codex")).toBeNull();
      view.unmount();
    },
  );

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

  it("offers @agents in a custom answer and checks them like the composer before sending", async () => {
    const view = render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          questions: [{ ...questionRecord.questions[0], isOther: true }],
        }}
      />,
    );
    expect(mockMarkdownInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ enableMentions: true }),
    );
    const answer =
      'Ask <span class="agent-mention" data-agent-reference="x">@reviewer</span> first';
    fireEvent.change(
      screen.getByRole("textbox", { name: "Custom answer for Region" }),
      { target: { value: answer } },
    );
    // The check holds the answer back (an Agent Network still needs approval).
    mockPreflight.mockImplementationOnce(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    await waitFor(() =>
      expect(mockPreflight).toHaveBeenCalledWith(answer, expect.any(Function)),
    );
    expect(webapp_client.conat_client.attentionAcp).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "respond" }),
    );
    // Once it passes, the answer goes out with its reference as written.
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "respond",
          answers: { region: [answer] },
        }),
      ),
    );
    view.unmount();
  });

  it("offers to resolve a typed @name, as the composer does, so the answer can be sent", async () => {
    const sagebrush = {
      account_id: "00000000-1000-4000-8000-000000000001",
      name: "sagebrush",
      endpoint: {
        project_id: "00000000-5000-4000-8000-000000000005",
        agent_id: "00000000-6000-4000-8000-000000000006",
      },
      thread_title: "Coordinator",
      project_title: "Sagebrush",
    };
    mockMentionAgents = [sagebrush];
    try {
      const view = render(
        <CodexAttentionCard
          initialRecord={{
            ...questionRecord,
            questions: [{ ...questionRecord.questions[0], isOther: true }],
          }}
        />,
      );
      const box = screen.getByRole("textbox", {
        name: "Custom answer for Region",
      });
      expect(screen.queryByRole("button", { name: /Resolve @sagebrush/ })).toBe(
        null,
      );
      fireEvent.change(box, {
        target: { value: "Yes, send it to @sagebrush." },
      });
      mockFocus.mockClear();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Resolve @sagebrush to named agent (Coordinator / Sagebrush)",
        }),
      );
      const value = (box as HTMLTextAreaElement).value;
      expect(value).toMatch(
        /^Yes, send it to <span class="agent-mention" data-agent-reference="[^"]+">@sagebrush<\/span>\.$/,
      );
      expect(mockOnSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "sagebrush",
          target: sagebrush.endpoint,
        }),
      );
      // Resolved, it is no longer offered.
      expect(screen.queryByRole("button", { name: /Resolve @sagebrush/ })).toBe(
        null,
      );
      // The button went: the focus is back in the answer, not lost.
      await waitFor(() => expect(mockFocus).toHaveBeenCalled());
      view.unmount();
    } finally {
      mockMentionAgents = [];
    }
  });

  it("checks only what the person wrote, never an agent's own choices", async () => {
    const view = render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          questions: [
            {
              ...questionRecord.questions[0],
              options: [{ label: "Ask @reviewer" }, { label: "US" }],
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Ask @reviewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "respond",
          answers: { region: ["Ask @reviewer"] },
        }),
      ),
    );
    expect(mockPreflight).toHaveBeenCalledWith("", expect.any(Function));
    view.unmount();
  });

  it("puts focus back in the custom answer after the approval dialog", () => {
    const view = render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          questions: [{ ...questionRecord.questions[0], isOther: true }],
        }}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Custom answer for Region" }),
      { target: { value: "Ask @" } },
    );
    mockFocus.mockClear();
    mockRestoreFocus?.();
    expect(mockFocus).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("after approval that Send asked for, focus returns to Send, not the last answer", async () => {
    const view = render(
      <CodexAttentionCard
        initialRecord={{
          ...questionRecord,
          questions: [
            { ...questionRecord.questions[0], isOther: true },
            {
              ...questionRecord.questions[0],
              id: "size",
              header: "Size",
              isOther: true,
            },
          ],
        }}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Custom answer for Size" }),
      { target: { value: "Ask @reviewer" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Custom answer for Region" }),
      { target: { value: "EU" } },
    );
    // Send opens the approval dialog (and waits there).
    mockPreflight.mockImplementationOnce(async () => {});
    const send = screen.getByRole("button", { name: "Send response" });
    fireEvent.click(send);
    await waitFor(() => expect(mockPreflight).toHaveBeenCalled());
    mockFocus.mockClear();
    mockRestoreFocus?.();
    expect(send).toHaveFocus();
    expect(mockFocus).not.toHaveBeenCalled();
    view.unmount();
  });

  it("Shift+Enter in a custom answer sends once the response can be sent", async () => {
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
    const responded = () =>
      jest
        .mocked(webapp_client.conat_client.attentionAcp)
        .mock.calls.filter(([request]: any) => request.action === "respond");
    // Nothing to send yet: Shift+Enter does nothing.
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mockPreflight).not.toHaveBeenCalled();
    // Over the limit: still nothing.
    fireEvent.change(input, { target: { value: "a".repeat(32_001) } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mockPreflight).not.toHaveBeenCalled();
    // A valid answer: sent, as Send would.
    fireEvent.change(input, { target: { value: "EU" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(responded()).toHaveLength(1));
    expect(responded()[0][0]).toMatchObject({
      action: "respond",
      answers: { region: ["EU"] },
    });
    view.unmount();
  });

  it("Shift+Enter sends the editor's live value, even before it renders", async () => {
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
    // As the rich-text editor does: the change and Shift+Enter in one go,
    // with no render between them.
    const props = mockMarkdownInput.mock.lastCall![0];
    act(() => {
      props.onChange("EU");
      props.onShiftEnter("EU");
    });
    await waitFor(() =>
      expect(webapp_client.conat_client.attentionAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "respond",
          answers: { region: ["EU"] },
        }),
      ),
    );
    // The card shows what was sent, not the draft before it rendered.
    expect(
      await screen.findByRole("region", { name: "Response for Region" }),
    ).toHaveTextContent("EU");
    view.unmount();
  });

  it("an approval that Shift+Enter asked for returns focus to that answer", async () => {
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
    fireEvent.change(input, { target: { value: "Ask @reviewer" } });
    mockPreflight.mockImplementationOnce(async () => {});
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(mockPreflight).toHaveBeenCalled());
    mockFocus.mockClear();
    mockRestoreFocus?.();
    expect(mockFocus).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
