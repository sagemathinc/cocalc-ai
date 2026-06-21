import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import CodexSessionsPanel from "../codex-sessions-panel";

const listMock = jest.fn();
const interruptMock = jest.fn();
const interruptAllMock = jest.fn();
const messageSuccessMock = jest.fn();
const messageWarningMock = jest.fn();
const ensureProjectIsOpenMock = jest.fn();
const openFileMock = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: jest.fn(() => ({
      ensureProjectIsOpen: (...args: any[]) => ensureProjectIsOpenMock(...args),
      open_file: (...args: any[]) => openFileMock(...args),
    })),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        aiSessions: {
          list: (...args: any[]) => listMock(...args),
          interrupt: (...args: any[]) => interruptMock(...args),
          interruptAll: (...args: any[]) => interruptAllMock(...args),
        },
      },
    },
  },
}));

jest.mock("antd", () => {
  const Button = ({ children, disabled, onClick }: any) => (
    <button disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  );
  const Card = ({ children, extra, title }: any) => (
    <section>
      <h2>{title}</h2>
      {extra}
      {children}
    </section>
  );
  const Space = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Tag = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );
  const Text = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );
  const Paragraph = ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  );
  const Table = ({ columns, dataSource, rowKey }: any) => (
    <table>
      <tbody>
        {dataSource.map((row: any) => (
          <tr key={row[rowKey]}>
            {columns.map((column: any) => (
              <td key={column.key ?? column.dataIndex ?? column.title}>
                {column.render
                  ? column.render(row[column.dataIndex], row)
                  : row[column.dataIndex]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return {
    Button,
    Card,
    Space,
    Table,
    Tag,
    Typography: { Paragraph, Text },
    message: {
      success: (...args: any[]) => messageSuccessMock(...args),
      warning: (...args: any[]) => messageWarningMock(...args),
    },
  };
});

function runningSession(overrides: Record<string, unknown> = {}) {
  return {
    account_id: "11111111-1111-4111-8111-111111111111",
    model: "gpt-test",
    path: "/home/user/sage/sage.chat",
    payment_source_kind: "site_api_key",
    project_id: "22222222-2222-4222-8222-222222222222",
    session_id: "session-1",
    session_key: "op:abc",
    state: "running",
    terminal: false,
    updated_at: "2026-06-20T19:00:00.000Z",
    ...overrides,
  };
}

describe("CodexSessionsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens the chat file internally for a session", async () => {
    listMock.mockResolvedValueOnce([runningSession()]);
    ensureProjectIsOpenMock.mockResolvedValueOnce(undefined);
    openFileMock.mockResolvedValueOnce(undefined);

    render(<CodexSessionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Open chat" }));
    await waitFor(() =>
      expect(ensureProjectIsOpenMock).toHaveBeenCalledWith(true),
    );
    expect(openFileMock).toHaveBeenCalledWith({
      path: "sage/sage.chat",
      foreground: true,
    });
  });

  it("interrupts one session and confirms after refresh", async () => {
    listMock
      .mockResolvedValueOnce([runningSession()])
      .mockResolvedValueOnce([]);
    interruptMock.mockResolvedValueOnce({
      ok: true,
      state: "interrupted",
      terminal: true,
      session_key: "op:abc",
    });

    render(<CodexSessionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Interrupt" }));

    await waitFor(() =>
      expect(interruptMock).toHaveBeenCalledWith({
        note: "Requested from account AI settings",
        op_id: undefined,
        session_id: "session-1",
        session_key: "op:abc",
      }),
    );
    await waitFor(() =>
      expect(messageSuccessMock).toHaveBeenCalledWith(
        "Codex session is no longer confirmed active.",
      ),
    );
  });

  it("rechecks stop-all before warning about uncertainty", async () => {
    listMock
      .mockResolvedValueOnce([runningSession()])
      .mockResolvedValueOnce([]);
    interruptAllMock.mockResolvedValueOnce({
      results: [
        {
          ok: false,
          state: "transport_failed",
          terminal: false,
          session_key: "op:abc",
        },
      ],
      terminal: 0,
      total: 1,
      uncertain: 1,
    });

    render(<CodexSessionsPanel />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Stop all active or uncertain",
      }),
    );

    await waitFor(() =>
      expect(interruptAllMock).toHaveBeenCalledWith({
        limit: 100,
        note: "Requested from account AI settings",
      }),
    );
    await waitFor(() =>
      expect(messageSuccessMock).toHaveBeenCalledWith(
        "No active Codex session remains confirmed running.",
      ),
    );
    expect(messageWarningMock).not.toHaveBeenCalled();
  });
});
