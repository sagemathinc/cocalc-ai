import { projectHostBootstrapDirCandidates } from "./bootstrap-paths";

describe("projectHostBootstrapDirCandidates", () => {
  const previousHome = process.env.HOME;
  const previousBootstrapDir = process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR;

  afterEach(() => {
    if (previousHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousBootstrapDir == null) {
      delete process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR;
    } else {
      process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR = previousBootstrapDir;
    }
  });

  it("prefers explicit and canonical home-based bootstrap directories without a hardcoded root fallback", () => {
    process.env.COCALC_PROJECT_HOST_BOOTSTRAP_DIR = "/explicit/bootstrap";
    process.env.HOME = "/home/cocalc-host";

    const candidates = projectHostBootstrapDirCandidates();

    expect(candidates[0]).toBe("/explicit/bootstrap");
    expect(candidates).toContain("/home/cocalc-host/cocalc-host/bootstrap");
    expect(candidates).toContain("/mnt/cocalc/data/.host-bootstrap/bootstrap");
    expect(candidates).not.toContain("/root/cocalc-host/bootstrap");
  });
});
