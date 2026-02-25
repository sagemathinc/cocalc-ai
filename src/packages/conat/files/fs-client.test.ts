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
});
