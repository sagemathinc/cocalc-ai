import { count_words } from "./count_words";
import { exec } from "@cocalc/frontend/frame-editors/generic/client";

jest.mock("@cocalc/frontend/frame-editors/generic/client", () => ({
  exec: jest.fn(),
}));

describe("count_words", () => {
  beforeEach(() => {
    jest.mocked(exec).mockReset();
  });

  it("returns stderr instead of throwing when texcount cannot start", async () => {
    jest.mocked(exec).mockRejectedValue(new Error("spawn texcount ENOENT"));

    const output = await count_words("project-1", "/home/user/paper.tex", 123);

    expect(output).toMatchObject({
      type: "blocking",
      stdout: "",
      stderr: expect.stringContaining("Unable to run texcount for paper.tex."),
      exit_code: 1,
    });
    expect(output.stderr).toContain(
      "The word count tool may not be installed in this project environment.",
    );
    expect(output.stderr).toContain("spawn texcount ENOENT");
  });
});
