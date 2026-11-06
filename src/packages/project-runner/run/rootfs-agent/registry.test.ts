jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, default: factory, getLogger: factory };
});

const mockIdmapUid = jest.fn<number | undefined, [string]>();
jest.mock("../rootfs", () => ({
  getRootfsMountpoint: (id: string) => `/run/cocalc/project-rootfs/${id}/root`,
  rootfsIdmapUid: (id: string) => mockIdmapUid(id),
}));
const mockClients: string[] = [];
const mockRequest = jest.fn(async () => ({ result: null }));
jest.mock("./client", () => ({
  RootfsAgentClient: class {
    constructor(project_id: string) {
      mockClients.push(project_id);
    }
    request = mockRequest;
    close() {}
  },
}));
jest.mock("./host", () => ({ hostAgentDeps: jest.fn(() => ({})) }));

import {
  rootfsSandboxOptions,
  rootfsSandboxOptionsWithoutAgent,
} from "./registry";

const P = 1073741824;

describe("rootfs agent registry", () => {
  beforeEach(() => {
    mockClients.length = 0;
    mockIdmapUid.mockReset();
    mockRequest.mockClear();
  });

  it("gives a separate-uid project's sandboxes one agent client, asked for on every call", async () => {
    mockIdmapUid.mockReturnValue(P);
    const { rootfsAgent } = rootfsSandboxOptions("p1");
    await rootfsAgent()!.call("stat", { path: "/etc" });
    await rootfsAgent()!.call("stat", { path: "/usr" });
    expect(mockClients).toEqual(["p1"]);
    // the project went back to keep-id: no agent any more
    mockIdmapUid.mockReturnValue(undefined);
    expect(rootfsAgent()).toBeUndefined();
  });

  it("never starts an agent for the viewer, API-key and share servers (B3)", async () => {
    mockIdmapUid.mockReturnValue(P);
    const { rootfsAgent } = rootfsSandboxOptionsWithoutAgent("p2");
    const agent = rootfsAgent()!;
    await expect(agent.call("stat", { path: "/etc/passwd" })).rejects.toThrow(
      "files outside HOME (such as '/etc/passwd') are not available yet",
    );
    await expect(
      agent.call("readFile", { path: "/etc/shadow" }),
    ).rejects.toThrow("not available yet");
    expect(mockClients).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();
    // keep-id projects: unchanged
    mockIdmapUid.mockReturnValue(undefined);
    expect(rootfsAgent()).toBeUndefined();
  });
});
