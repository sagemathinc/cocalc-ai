import {
  isRetryableListingError,
  isStaleFilesystemClientError,
} from "./use-files";

describe("isRetryableListingError", () => {
  it("treats closed and disconnected listing failures as retryable", () => {
    expect(isRetryableListingError(new Error("closed"))).toBe(true);
    expect(isRetryableListingError("Error: closed")).toBe(true);
    expect(
      isRetryableListingError(new Error("socket has been disconnected")),
    ).toBe(true);
  });

  it("treats project-host bootstrap failures as retryable", () => {
    expect(
      isRetryableListingError(
        new Error('once: "ready" not emitted before "closed"'),
      ),
    ).toBe(true);
    expect(
      isRetryableListingError(
        new Error("failed to sign in - missing project-host bearer token"),
      ),
    ).toBe(true);
  });

  it("does not retry ordinary listing failures", () => {
    expect(isRetryableListingError(new Error("permission denied"))).toBe(false);
  });
});

describe("isStaleFilesystemClientError", () => {
  it("recognizes errors that mean the filesystem client should be replaced", () => {
    expect(isStaleFilesystemClientError(new Error("closed"))).toBe(true);
    expect(
      isStaleFilesystemClientError(new Error("socket has been disconnected")),
    ).toBe(true);
  });

  it("does not replace the filesystem client for generic retryable errors", () => {
    expect(isStaleFilesystemClientError(new Error("timeout"))).toBe(false);
    expect(isStaleFilesystemClientError(new Error("failed to sign in"))).toBe(
      false,
    );
  });
});
