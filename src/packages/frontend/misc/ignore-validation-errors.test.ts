import { ignoreValidationErrors } from "./ignore-validation-errors";

describe("ignoreValidationErrors", () => {
  it("ignores antd validation rejections", async () => {
    const invalid = Promise.reject({
      errorFields: [{ name: ["title"], errors: ["Enter a title"] }],
      values: {},
      outOfDate: false,
    });
    const onValid = jest.fn();
    await expect(
      invalid.then(onValid, ignoreValidationErrors),
    ).resolves.toBeUndefined();
    expect(onValid).not.toHaveBeenCalled();
  });

  it("rethrows other errors", async () => {
    const failed = Promise.reject(new Error("network down"));
    await expect(
      failed.then(() => undefined, ignoreValidationErrors),
    ).rejects.toThrow("network down");
  });
});
