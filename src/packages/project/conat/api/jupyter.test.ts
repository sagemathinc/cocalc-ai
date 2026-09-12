import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxedFilesystem } from "@cocalc/backend/sandbox";

jest.mock("@cocalc/jupyter/nbgrader/jupyter-parse", () => ({}));
jest.mock("@cocalc/jupyter/nbgrader/jupyter-run", () => ({}));
jest.mock("../../jupyter/convert", () => ({}));
jest.mock("../../formatters", () => ({}));
jest.mock("@cocalc/jupyter/kernel/logo", () => ({}));
jest.mock("@cocalc/jupyter/kernel/kernel-data", () => ({}));
jest.mock("@cocalc/jupyter/stateless-api/execute", () => ({}));
jest.mock("@cocalc/project/client", () => ({ getClient: () => mockClient }));
jest.mock("@cocalc/project/data", () => ({ project_id: "test-project" }));
jest.mock("@cocalc/jupyter/control", () => ({
  isRunning: jest.fn(() => false),
  start: jest.fn(),
  save: jest.fn(),
  load: jest.fn(),
}));

const mockClient = {};

describe("project Jupyter filesystem paths", () => {
  const previousHome = process.env.HOME;
  const previousRuntimeHome = process.env.COCALC_RUNTIME_HOME;
  let dir: string;
  let home: string;
  let api: typeof import("./jupyter");
  let control: jest.Mocked<typeof import("@cocalc/jupyter/control")>;

  beforeEach(async () => {
    jest.resetModules();
    dir = await mkdtemp(join(tmpdir(), "jupyter-home-alias-"));
    home = join(dir, "project");
    await mkdir(home);
    process.env.HOME = home;
    delete process.env.COCALC_RUNTIME_HOME;
    api = await import("./jupyter");
    control = jest.requireMock("@cocalc/jupyter/control");
  });

  afterEach(async () => {
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousRuntimeHome == null) delete process.env.COCALC_RUNTIME_HOME;
    else process.env.COCALC_RUNTIME_HOME = previousRuntimeHome;
    await rm(dir, { recursive: true, force: true });
  });

  function startedFilesystem(): SandboxedFilesystem {
    return control.start.mock.calls.at(-1)![0].fs!;
  }

  it("loads canonical workspace paths from the process home", async () => {
    process.env.COCALC_RUNTIME_HOME = "/home/user";
    const name = `${dir.split("/").pop()}.ipynb`;
    await writeFile(join(home, name), "owned notebook");
    await api.start(`/home/user/${name}`);
    const fs = startedFilesystem();
    expect(control.start).toHaveBeenCalledWith({
      project_id: "test-project",
      path: `/home/user/${name}`,
      client: mockClient,
      fs,
    });
    expect(await fs.readFile(`/home/user/${name}`, "utf8")).toBe(
      "owned notebook",
    );
    expect(await fs.readFile(name, "utf8")).toBe("owned notebook");
  });

  it("passes the same alias-aware filesystem to save and reload without writing host home", async () => {
    // A temporary advertised home makes a regression safe to exercise with
    // real writes; neither side of this test can touch the developer's home.
    const advertisedHome = join(dir, "advertised");
    await mkdir(advertisedHome);
    process.env.COCALC_RUNTIME_HOME = advertisedHome;
    const path = join(advertisedHome, "fixture.ipynb");
    await writeFile(path, "host sentinel");
    control.save.mockImplementation(async ({ path }) => {
      await startedFilesystem().writeFile(path, "saved notebook");
    });
    let loaded: unknown;
    control.load.mockImplementation(async ({ path }) => {
      loaded = await startedFilesystem().readFile(path, "utf8");
    });

    await api.save({ path });
    const fs = startedFilesystem();
    await api.load({ path });
    expect(startedFilesystem()).toBe(fs);
    expect(loaded).toBe("saved notebook");
    expect(await readFile(join(home, "fixture.ipynb"), "utf8")).toBe(
      "saved notebook",
    );
    expect(await readFile(path, "utf8")).toBe("host sentinel");
  });

  it("does not add aliases or change the notebook identity without an advertised home", async () => {
    const absolute = join(dir, "absolute.ipynb");
    await writeFile(join(home, "relative.ipynb"), "relative notebook");
    await api.start(absolute);
    const fs = startedFilesystem();
    expect(fs.homeAliases).toEqual([]);
    expect(control.start.mock.calls[0][0].path).toBe(absolute);
    expect(await fs.readFile("relative.ipynb", "utf8")).toBe(
      "relative notebook",
    );
  });

  it("does not remap paths differently when runtime home already equals HOME", async () => {
    process.env.COCALC_RUNTIME_HOME = home;
    const path = join(home, "fixture.ipynb");
    await writeFile(path, "native notebook");
    await api.start(path);
    expect(await startedFilesystem().readFile(path, "utf8")).toBe(
      "native notebook",
    );
  });

  it("does not replace the filesystem of an already running notebook", async () => {
    control.isRunning.mockReturnValue(true);
    await api.start("/home/user/fixture.ipynb");
    expect(control.start).not.toHaveBeenCalled();
  });
});
