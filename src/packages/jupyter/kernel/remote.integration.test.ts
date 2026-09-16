import { JupyterKernel } from "./kernel";
import { jupyter_run_notebook } from "../nbgrader/jupyter-run";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { closeAllAndWait } from "./launch-kernel";

const name = process.env.COCALC_REMOTE_JUPYTER_TEST_KERNEL;
const remoteTests = name ? describe : describe.skip;

remoteTests("registered remote kernel through CoCalc", () => {
  const opened: JupyterKernel[] = [];
  const path = join(tmpdir(), `reflect-cocalc-${randomUUID()}.ipynb`);
  function create() {
    const kernel = new JupyterKernel(name!, path, undefined, undefined);
    opened.push(kernel);
    return kernel;
  }
  afterEach(async () => {
    for (const kernel of opened.splice(0)) {
      kernel.close();
      await kernel.waitUntilClosed();
    }
  });
  it("executes remotely and admits a replacement only after graceful close", async () => {
    const first = create();
    const output = await first.execute_code_now({
      code: "remote_sentinel=29\nprint('REMOTE_COCALC_OK')",
    });
    expect(JSON.stringify(output)).toContain("REMOTE_COCALC_OK");
    expect(first.isRemote()).toBe(true);
    first.close();
    const second = create();
    const result = await second.execute_code_now({
      code: "assert 'remote_sentinel' not in globals()\nprint('RESTART_OK')",
    });
    expect(JSON.stringify(result)).toContain("RESTART_OK");
    expect(first.pid()).toBeUndefined();
  }, 120000);
  it("does not finish an asynchronous launch after its instance closed", async () => {
    const kernel = create();
    const spawning = kernel.spawn();
    kernel.close();
    await spawning;
    await kernel.waitUntilClosed();
    expect(kernel.isClosed()).toBe(true);
    expect(kernel.pid()).toBeUndefined();
  }, 120000);
  it("gracefully closes remote launchers through process-wide cleanup", async () => {
    const kernel = create();
    await kernel.execute_code_now({ code: "print('CLEANUP_READY')" });
    const child = kernel.get_spawned_kernel()!.spawn;
    await closeAllAndWait();
    expect(child.exitCode).toBe(0);
  }, 120000);
  it("executes nbgrader cells through the same kernelspec", async () => {
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { name, language: "python", display_name: "Remote" },
      },
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          source: ["assert 2+3 == 5\nprint('REMOTE_GRADE_OK')"],
          outputs: [],
          metadata: {
            nbgrader: {
              grade: true,
              grade_id: "remote",
              locked: true,
              points: 1,
              schema_version: 3,
              solution: false,
              task: false,
            },
          },
        },
      ],
    };
    const result = await jupyter_run_notebook({
      path: tmpdir(),
      ipynb: JSON.stringify(notebook),
      nbgrader: true,
      limits: { max_total_time_ms: 90000, max_time_per_cell_ms: 60000 },
    });
    expect(result).toContain("REMOTE_GRADE_OK");
    expect(JSON.parse(result).cells[0].outputs[0].text).toBe(
      "REMOTE_GRADE_OK\n",
    );
  }, 120000);
});
