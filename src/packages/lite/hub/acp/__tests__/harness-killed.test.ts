import {
  formatMemoryLimit,
  oomKilledBetween,
  parseMemoryMax,
  parseOomKills,
} from "../project-memory";
import { acpTestInternals } from "../index";

const { harnessKilledFailure, failureRecoveryDirective } = acpTestInternals;
const projectId = "881e5f4d-fca6-4739-9848-45bfaa8d49d3";
const diagnostic = "[Diagnostic ID: be31a8d0-e44d-4839-aab1-d73e1091ac8c]";

describe("project memory events", () => {
  it("reads the OOM kill counter and limit of a project cgroup", () => {
    expect(
      parseOomKills(
        "low 0\nhigh 0\nmax 12\noom 4\noom_kill 4\noom_group_kill 0\n",
      ),
    ).toBe(4);
    expect(parseOomKills("oom 0\n")).toBeUndefined();
    expect(parseMemoryMax("16000000000\n")).toBe(16e9);
    expect(parseMemoryMax("max\n")).toBeUndefined();
    expect(formatMemoryLimit(16e9)).toBe("16 GB");
    expect(formatMemoryLimit(2.5e9)).toBe("2.5 GB");
    expect(oomKilledBetween({ oomKills: 1 }, { oomKills: 4 })).toBe(true);
    expect(oomKilledBetween({ oomKills: 4 }, { oomKills: 4 })).toBe(false);
    expect(oomKilledBetween({}, { oomKills: 4 })).toBe(false);
  });
});

describe("harness killed mid-turn", () => {
  it("says the project ran out of memory when the kernel OOM-killed it", async () => {
    const failure = await harnessKilledFailure({
      err: Object.assign(
        new Error(`Claude could not process this message. ${diagnostic}`),
        { killed: false },
      ),
      projectId,
      memoryBefore: { oomKills: 0, limitBytes: 16e9 },
      agent: "Claude",
      resumable: true,
      readMemory: async () => ({ oomKills: 4, limitBytes: 16e9 }),
    });
    expect(failure?.message).toBe(
      `Claude was stopped because this project ran out of memory (its limit is 16 GB), most likely from a memory-heavy command it was running. It is being resumed automatically. ${diagnostic}`,
    );
    const directive = failureRecoveryDirective(
      "acp_harness_killed",
      failure?.detail,
    );
    expect(directive).toMatchObject({
      interruptedNotice:
        "**Claude was stopped because this project ran out of memory.**",
      maxRetries: 1,
    });
    expect(directive?.recoveryGuidance).toMatch(/one at a time/);
  });

  it("reports an unexplained SIGKILL without blaming memory", async () => {
    const failure = await harnessKilledFailure({
      err: Object.assign(new Error(`killed ${diagnostic}`), { killed: true }),
      projectId,
      memoryBefore: {},
      agent: "Claude",
      resumable: false,
      readMemory: async () => ({}),
    });
    expect(failure?.message).toMatch(
      /^Claude's process was killed unexpectedly \(SIGKILL\)\. It was already resumed automatically once, so it was not resumed again\./,
    );
    expect(
      failureRecoveryDirective("acp_harness_killed", failure?.detail)
        ?.interruptedNotice,
    ).toBe("**Claude's process was killed unexpectedly.**");
  });

  it("leaves other failures alone", async () => {
    expect(
      await harnessKilledFailure({
        err: new Error("Claude could not process this message."),
        projectId,
        memoryBefore: { oomKills: 4 },
        agent: "Claude",
        resumable: true,
        readMemory: async () => ({ oomKills: 4 }),
      }),
    ).toBeUndefined();
  });
});
