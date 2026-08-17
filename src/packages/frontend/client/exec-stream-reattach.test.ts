/** @jest-environment jsdom */

import { isJobGoneError, shouldReattach } from "./exec-stream-reattach";

const BASE = {
  jobId: "job-1",
  canAttach: true,
  jobIsGone: false,
  now: 1000,
  deadline: 2000,
};

describe("shouldReattach", () => {
  it("re-attaches to a known job before the deadline", () => {
    expect(shouldReattach(BASE)).toBe(true);
  });

  it("never re-attaches to a runtime that did not advertise attach support", () => {
    // An older project treats attach_job_id as an ordinary execution option
    // and would run the build a second time.
    expect(shouldReattach({ ...BASE, canAttach: false })).toBe(false);
  });

  it("stops immediately once the service says the job is gone", () => {
    // Retrying to the deadline would delay the failure by many minutes.
    expect(shouldReattach({ ...BASE, jobIsGone: true })).toBe(false);
  });

  it("stops once the job can no longer be running", () => {
    expect(shouldReattach({ ...BASE, now: 2000 })).toBe(false);
    expect(shouldReattach({ ...BASE, now: 2001 })).toBe(false);
  });

  it("has nothing to attach to without a job id", () => {
    expect(shouldReattach({ ...BASE, jobId: undefined })).toBe(false);
  });
});

describe("isJobGoneError", () => {
  it("recognizes the service's terminal response", () => {
    expect(isJobGoneError("no such job abc-123")).toBe(true);
    expect(isJobGoneError(new Error("no such job abc-123"))).toBe(true);
  });

  it("treats other failures as transient", () => {
    expect(isJobGoneError("timeout")).toBe(false);
    expect(isJobGoneError("exec stream ended before done")).toBe(false);
  });
});
