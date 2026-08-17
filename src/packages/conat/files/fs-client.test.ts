import { fsClient } from "./fs";

function makeCallStub() {
  return {
    readdir: jest.fn(async () => []),
    stat: jest.fn(async () => ({})),
    lstat: jest.fn(async () => ({})),
    watch: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
    constants: jest.fn(async () => ({})),
    writeFile: jest.fn(async () => undefined),
  } as any;
}

describe("fsClient waitForInterest defaults", () => {
  it("uses waitForInterest by default to avoid startup races", () => {
    const callStub = makeCallStub();
    const client = {
      call: jest.fn(() => callStub),
    } as any;

    fsClient({
      client,
      subject: "fs.project-11111111-1111-1111-1111-111111111111",
    });

    expect(client.call).toHaveBeenCalledWith(
      "fs.project-11111111-1111-1111-1111-111111111111",
      expect.objectContaining({ waitForInterest: true }),
    );
  });

  it("allows disabling waitForInterest explicitly", () => {
    const callStub = makeCallStub();
    const client = {
      call: jest.fn(() => callStub),
    } as any;

    fsClient({
      client,
      subject: "fs.project-22222222-2222-2222-2222-222222222222",
      waitForInterest: false,
    });

    expect(client.call).toHaveBeenCalledWith(
      "fs.project-22222222-2222-2222-2222-222222222222",
      expect.objectContaining({ waitForInterest: false }),
    );
  });

  it("writes against the exact contents read without an overwrite fallback", async () => {
    const conflict = Object.assign(new Error("changed"), {
      code: "ETAG_MISMATCH",
    });
    const callStub = makeCallStub();
    callStub.writeFile.mockRejectedValue(conflict);
    const client = {
      call: jest.fn(() => callStub),
    } as any;
    const fs = fsClient({
      client,
      subject: "fs.project-33333333-3333-4333-8333-333333333333",
    });

    await expect(
      fs.writeFileIfUnchanged("/home/user/a.py", "new\n", "old\n"),
    ).rejects.toBe(conflict);

    expect(callStub.writeFile).toHaveBeenCalledTimes(1);
    expect(callStub.writeFile).toHaveBeenCalledWith(
      "/home/user/a.py",
      expect.objectContaining({
        patch: expect.anything(),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      undefined,
    );
  });

  it("does not write unchanged contents", async () => {
    const callStub = makeCallStub();
    const client = {
      call: jest.fn(() => callStub),
    } as any;
    const fs = fsClient({
      client,
      subject: "fs.project-44444444-4444-4444-8444-444444444444",
    });

    await fs.writeFileIfUnchanged("/home/user/a.py", "same", "same");

    expect(callStub.writeFile).not.toHaveBeenCalled();
  });
});
