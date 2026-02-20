/** @jest-environment jsdom */

import { processAcpLLM } from "../acp-api";

const mockStreamAcp = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      streamAcp: (...args: any[]) => mockStreamAcp(...args),
    },
  },
}));

function emptyStream() {
  return (async function* () {})();
}

class FakeAcpState {
  private readonly map = new Map<string, string>();

  set(key: string, value: string) {
    this.map.set(key, value);
    return this;
  }

  delete(key: string) {
    this.map.delete(key);
    return this;
  }
}

describe("processAcpLLM", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("chooses a unique assistant message timestamp", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    jest
      .spyOn(global, "setTimeout")
      .mockImplementation(((fn: any) => {
        fn();
        return 0 as any;
      }) as any);
    mockStreamAcp.mockResolvedValue(emptyStream());

    const acpState = new FakeAcpState();
    const store: any = {
      get: (key: string) => {
        if (key === "project_id") return "proj";
        if (key === "path") return "x.chat";
        if (key === "acpState") return acpState;
        return undefined;
      },
      setState: jest.fn(),
    };

    const actions: any = {
      syncdb: {},
      store,
      chatStreams: new Set<string>(),
      computeThreadKey: jest.fn(() => "1000"),
      getAllMessages: () =>
        new Map<string, any>([
          ["1000", { date: new Date(1000) }],
          ["1001", { date: new Date(1001) }],
          ["1002", { date: new Date(1002) }],
        ]),
      getCodexConfig: jest.fn(),
      sendReply: jest.fn(),
    };

    const message: any = {
      event: "chat",
      sender_id: "user-1",
      date: new Date(1000),
      history: [
        {
          author_id: "user-1",
          content: "run codex",
          date: new Date(1000).toISOString(),
        },
      ],
    };

    await processAcpLLM({
      message,
      model: "codex-agent",
      input: "run codex",
      actions,
    });

    expect(mockStreamAcp).toHaveBeenCalledTimes(1);
    const arg = mockStreamAcp.mock.calls[0][0];
    expect(arg.chat.message_date).toBe(new Date(1003).toISOString());
    expect(arg.chat.reply_to).toBe(new Date(1000).toISOString());
  });
});
