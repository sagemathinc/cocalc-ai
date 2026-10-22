/*
The confirmed restart from the saved notebook, as the notebook tab asks for it
(bounded history plan H1b-3 r4, §3): bound to exactly the history state the
user confirmed; asked again (never retried silently) when it moved; and no
request at all when the history was already reset meanwhile.
*/

const restartHistoryFromIpynb = jest.fn();
const alerts: any[] = [];

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    project_client: {
      conatApi: () => ({ jupyter: { restartHistoryFromIpynb } }),
    },
  },
}));
jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: (x) => alerts.push(x),
}));

import { confirmRestartFromIpynb } from "./history-reset-handlers";

function tab({
  states,
  answers,
}: {
  // what historyResetState returns, call by call
  states: any[];
  // the user's answers to the confirmations, in order
  answers: boolean[];
}) {
  const closed: string[] = [];
  const asked: string[] = [];
  return {
    closed,
    asked,
    tab: {
      project_id: "p",
      path: "a.ipynb",
      isClosed: () => false,
      syncdb: {
        client: {
          historyResetState: jest.fn(async () => states.shift()),
        },
      },
      redux: {
        getActions: () => ({
          popconfirm: async ({ title }) => {
            asked.push(title);
            return answers.shift() ?? false;
          },
        }),
        getProjectActions: () => ({ close_file: (p) => closed.push(p) }),
      },
    },
  };
}

const S = (epoch: number, seq: number, count: number) => ({
  epoch,
  seq,
  count,
});

beforeEach(() => {
  restartHistoryFromIpynb.mockReset();
  alerts.length = 0;
});

describe("confirmRestartFromIpynb", () => {
  it("sends exactly the confirmed epoch and revision", async () => {
    const t = tab({
      states: [S(2, 10, 9), S(2, 10, 9)],
      answers: [true, true],
    });
    restartHistoryFromIpynb.mockResolvedValue({
      restarted: true,
      history_epoch: 3,
    });
    await confirmRestartFromIpynb(t.tab as any);
    expect(restartHistoryFromIpynb).toHaveBeenCalledTimes(1);
    expect(restartHistoryFromIpynb).toHaveBeenCalledWith({
      path: "a.ipynb",
      epoch: 2,
      revision: { seq: 10, count: 9 },
    });
    expect(t.asked).toHaveLength(2);
  });

  it("the history was already reset meanwhile: nothing is sent", async () => {
    const t = tab({ states: [S(2, 10, 9), S(3, 1, 1)], answers: [true, true] });
    await confirmRestartFromIpynb(t.tab as any);
    expect(restartHistoryFromIpynb).not.toHaveBeenCalled();
    expect(alerts[0].title).toContain("already restarted");
  });

  it("the revision moved before sending: the user is asked again, and the new state is sent", async () => {
    const t = tab({
      states: [S(2, 10, 9), S(2, 11, 10), S(2, 11, 10), S(2, 11, 10)],
      answers: [true, true, true, true],
    });
    restartHistoryFromIpynb.mockResolvedValue({
      restarted: true,
      history_epoch: 3,
    });
    await confirmRestartFromIpynb(t.tab as any);
    expect(t.asked).toHaveLength(4);
    expect(restartHistoryFromIpynb).toHaveBeenCalledTimes(1);
    expect(restartHistoryFromIpynb).toHaveBeenCalledWith(
      expect.objectContaining({ epoch: 2, revision: { seq: 11, count: 10 } }),
    );
  });

  it("the project answers moved: asked again, never retried silently", async () => {
    const t = tab({
      states: [S(2, 10, 9), S(2, 10, 9), S(2, 12, 11), S(2, 12, 11)],
      // the user declines the second time
      answers: [true, true, false],
    });
    restartHistoryFromIpynb.mockResolvedValueOnce({
      restarted: false,
      reason: "moved",
    });
    await confirmRestartFromIpynb(t.tab as any);
    expect(restartHistoryFromIpynb).toHaveBeenCalledTimes(1);
    expect(t.asked).toHaveLength(3);
    expect(t.closed).toEqual(["a.ipynb"]);
  });

  it("busy, a failed cap or a missed deadline never leads to another request", async () => {
    for (const reason of ["busy", "too-large", "deadline", "failed"]) {
      const t = tab({
        states: [S(2, 10, 9), S(2, 10, 9)],
        answers: [true, true],
      });
      restartHistoryFromIpynb.mockReset();
      restartHistoryFromIpynb.mockResolvedValueOnce({
        restarted: false,
        reason,
      });
      await confirmRestartFromIpynb(t.tab as any);
      expect(restartHistoryFromIpynb).toHaveBeenCalledTimes(1);
      expect(alerts.at(-1).type).toBe("error");
    }
  });

  it("declining closes the notebook and resets nothing", async () => {
    const t = tab({ states: [S(2, 10, 9)], answers: [false] });
    await confirmRestartFromIpynb(t.tab as any);
    expect(restartHistoryFromIpynb).not.toHaveBeenCalled();
    expect(t.closed).toEqual(["a.ipynb"]);
  });

  it("the second confirmation discloses the kernel restart and the archived edits", async () => {
    const t = tab({ states: [S(2, 10, 9)], answers: [true, false] });
    const descriptions: string[] = [];
    (t.tab.redux as any).getActions = () => ({
      popconfirm: async ({ description }) => {
        descriptions.push(description);
        return descriptions.length == 1;
      },
    });
    await confirmRestartFromIpynb(t.tab as any);
    expect(descriptions[1]).toMatch(/kernel restarts/);
    expect(descriptions[1]).toMatch(/variables/);
    expect(descriptions[1]).toMatch(/archived history/);
  });
});
