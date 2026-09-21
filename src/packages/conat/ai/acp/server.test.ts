import {
  ACP_CLIENT_REFRESH_REQUIRED_CODE,
  ACP_CLIENT_REFRESH_REQUIRED_MESSAGE,
  ACP_SUBJECT_ROOT,
} from "./subjects";
import { __test__ } from "./server";

describe("ACP server subject identity binding", () => {
  const project_id = "00000000-0000-4000-8000-000000000001";
  const other_project_id = "00000000-0000-4000-8000-000000000002";
  const account_id = "00000000-0000-4000-8000-000000000003";
  const other_account_id = "00000000-0000-4000-8000-000000000004";
  const subject = `${ACP_SUBJECT_ROOT}.project-${project_id}.account-${account_id}.api`;

  it("executes harness requests only on their versioned endpoint", async () => {
    const evaluate = jest.fn().mockResolvedValue(undefined);
    const respond = jest.fn().mockResolvedValue(undefined);
    const runtime = { version: 1, kind: "acp", profile: {} };
    await __test__.handleMessage(
      { subject, data: { runtime }, respond },
      evaluate,
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(respond.mock.calls[0][0].error).toContain("harness-v1");
    respond.mockClear();
    await __test__.handleMessage(
      {
        subject: subject.replace(/api$/, "harness-v1"),
        data: { runtime },
        respond,
      },
      evaluate,
      "harness-v1",
    );
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ account_id, project_id, runtime }),
    );
  });

  it("rejects missing runtime and mismatched authority on harness-v1", async () => {
    const evaluate = jest.fn();
    const respond = jest.fn().mockResolvedValue(undefined);
    for (const data of [
      {},
      { runtime: { kind: "acp", version: 2 } },
      { account_id: other_account_id, runtime: { kind: "acp", version: 1 } },
    ]) {
      await __test__.handleMessage(
        { subject: subject.replace(/api$/, "harness-v1"), data, respond },
        evaluate,
        "harness-v1",
      );
    }
    expect(evaluate).not.toHaveBeenCalled();
    expect(
      respond.mock.calls.filter(([value]) => value?.type === "error"),
    ).toHaveLength(3);
  });

  it("derives both identities from the subject", () => {
    const options: any = { prompt: "hello", chat: {} };

    __test__.bindOptionsToSubject(options, subject, "api");

    expect(options).toMatchObject({
      account_id,
      project_id,
      chat: { project_id },
    });
  });

  it("rejects payload account mismatches", () => {
    expect(() =>
      __test__.bindOptionsToSubject(
        { account_id: other_account_id, project_id },
        subject,
        "api",
      ),
    ).toThrow("account_id does not match subject");
  });

  it("rejects payload project mismatches", () => {
    expect(() =>
      __test__.bindOptionsToSubject(
        { account_id, project_id: other_project_id },
        subject,
        "api",
      ),
    ).toThrow("project_id does not match subject");
  });

  it("rejects nested chat project mismatches", () => {
    expect(() =>
      __test__.bindOptionsToSubject(
        {
          account_id,
          project_id,
          chat: { project_id: other_project_id },
        },
        subject,
        "api",
      ),
    ).toThrow("chat.project_id does not match subject");
  });

  it("rejects legacy and wrong-operation subjects for execution", () => {
    expect(() =>
      __test__.bindOptionsToSubject(
        { account_id, project_id },
        `${ACP_SUBJECT_ROOT}.project-${project_id}.api`,
        "api",
      ),
    ).toThrow("ACP subject must bind an account and project");
    expect(() =>
      __test__.bindOptionsToSubject(
        { account_id, project_id },
        `${ACP_SUBJECT_ROOT}.project-${project_id}.account-${account_id}.interrupt`,
        "api",
      ),
    ).toThrow("ACP subject must bind an account and project");
  });
});

describe("legacy ACP compatibility response", () => {
  const project_id = "00000000-0000-4000-8000-000000000001";

  it("terminates legacy streaming requests without executing work", async () => {
    const respond = jest.fn().mockResolvedValue(undefined);

    await __test__.rejectLegacyRequest(
      {
        subject: `${ACP_SUBJECT_ROOT}.project-${project_id}.api`,
        respond,
      },
      "api",
    );

    expect(respond).toHaveBeenNthCalledWith(
      1,
      {
        seq: 0,
        type: "error",
        code: ACP_CLIENT_REFRESH_REQUIRED_CODE,
        error: ACP_CLIENT_REFRESH_REQUIRED_MESSAGE,
        retryable: false,
      },
      { noThrow: true },
    );
    expect(respond).toHaveBeenNthCalledWith(2, null, { noThrow: true });
  });

  it("returns a non-retryable error for legacy control requests", async () => {
    const respond = jest.fn().mockResolvedValue(undefined);

    await __test__.rejectLegacyRequest(
      {
        subject: `${ACP_SUBJECT_ROOT}.project-${project_id}.interrupt`,
        respond,
      },
      "interrupt",
    );

    expect(respond).toHaveBeenCalledWith(
      {
        code: ACP_CLIENT_REFRESH_REQUIRED_CODE,
        error: ACP_CLIENT_REFRESH_REQUIRED_MESSAGE,
        retryable: false,
      },
      { noThrow: true },
    );
  });
});
