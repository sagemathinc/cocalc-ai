import {
  jupyterLiveRunKey,
  jupyterLiveRunSubject,
  openJupyterLiveRunStore,
} from "@cocalc/conat/project/jupyter/live-run";
import { syncdbPath } from "@cocalc/util/jupyter/names";

describe("jupyter live-run helpers", () => {
  it("canonicalizes syncdb and ipynb paths to the same subject and key", () => {
    const project_id = "00000000-1000-4000-8000-000000000000";
    const ipynbPath = "/tmp/demo.ipynb";
    const metaPath = syncdbPath(ipynbPath);
    expect(jupyterLiveRunSubject({ project_id, path: metaPath })).toStrictEqual(
      jupyterLiveRunSubject({ project_id, path: ipynbPath }),
    );
    expect(
      jupyterLiveRunKey({ path: metaPath, run_id: "run-1" }),
    ).toStrictEqual(jupyterLiveRunKey({ path: ipynbPath, run_id: "run-1" }));
  });

  it("recreates a closed cached store for the same project", async () => {
    const created: any[] = [];
    const project_id = `project-${Date.now()}`;
    const client = {
      dkv: async () => {
        const store = {
          closed: false,
          isClosed() {
            return this.closed;
          },
          close() {
            this.closed = true;
          },
        };
        created.push(store);
        return store;
      },
    };

    const first = await openJupyterLiveRunStore({
      client: client as any,
      project_id,
    });
    const second = await openJupyterLiveRunStore({
      client: client as any,
      project_id,
    });
    expect(second).toBe(first);
    expect(created).toHaveLength(1);

    first.close();

    const third = await openJupyterLiveRunStore({
      client: client as any,
      project_id,
    });
    expect(third).not.toBe(first);
    expect(created).toHaveLength(2);
  });
});
