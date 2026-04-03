import { resolveWorkspaceRoot } from "../workspace-root";

describe("resolveWorkspaceRoot", () => {
  const originalEnv = process.env.COCALC_ACP_EXECUTOR;

  afterEach(() => {
    process.env.COCALC_ACP_EXECUTOR = originalEnv;
  });

  describe("container executor opt-in", () => {
    beforeEach(() => {
      process.env.COCALC_ACP_EXECUTOR = "container";
    });

    it("uses the provided container working dir verbatim", () => {
      const root = resolveWorkspaceRoot({
        workingDirectory: "/home/user/custom",
      } as any);
      expect(root).toBe("/home/user/custom");
    });

    it("leaves non-runtime absolute paths alone", () => {
      const root = resolveWorkspaceRoot({
        workingDirectory: "/root/custom",
      } as any);
      expect(root).toBe("/root/custom");
    });

    it("preserves scratch roots instead of rebasing them under /root", () => {
      const root = resolveWorkspaceRoot({
        workingDirectory: "/scratch/demo",
      } as any);
      expect(root).toBe("/scratch/demo");
    });

    it("does not rewrite unexpected container paths either", () => {
      const root = resolveWorkspaceRoot({
        workingDirectory: "sub",
      } as any);
      expect(root).toBe("sub");
    });

    it("falls back to project root when unset", () => {
      const root = resolveWorkspaceRoot(undefined);
      expect(root).toBe("/home/user");
    });
  });

  describe("local/lite default", () => {
    beforeEach(() => {
      delete process.env.COCALC_ACP_EXECUTOR;
    });

    it("resolves local relative paths from cwd", () => {
      const root = resolveWorkspaceRoot({ workingDirectory: "tmp" } as any);
      expect(root.endsWith("/tmp")).toBe(true);
    });

    it("returns cwd when nothing specified", () => {
      const root = resolveWorkspaceRoot(undefined);
      expect(root).toBe(process.env.HOME ?? process.cwd());
    });
  });
});
