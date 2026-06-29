import { isMissingRusticRepositoryError } from "./backup-index-errors";

describe("backup index error classification", () => {
  it("detects rustic repository-not-initialized failures", () => {
    expect(
      isMissingRusticRepositoryError(
        new Error(
          "No repository config file found for `opendal:s3:bucket`. Please check the repository.",
        ),
      ),
    ).toBe(true);
  });

  it("detects opendal missing config failures", () => {
    expect(
      isMissingRusticRepositoryError(
        new Error(
          "[WARN] service=s3 name=prod-apac path=config: stat failed NotFound (persistent) at stat\n" +
            "error: `rustic_core` experienced an error related to `the configuration`.",
        ),
      ),
    ).toBe(true);
  });

  it("ignores unrelated backup errors", () => {
    expect(
      isMissingRusticRepositoryError(new Error("bucket 'x' does not exist")),
    ).toBe(false);
  });
});
