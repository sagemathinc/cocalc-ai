import {
  jupyterLiveRunKey,
  jupyterLiveRunStoreName,
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
    expect(jupyterLiveRunStoreName(metaPath)).toStrictEqual(
      jupyterLiveRunStoreName(ipynbPath),
    );
  });

  it("scopes replay stores by notebook path", async () => {
    expect(jupyterLiveRunStoreName("a.ipynb")).not.toStrictEqual(
      jupyterLiveRunStoreName("b.ipynb"),
    );
  });

  it("delegates each open to dkv so its refcount cache owns lifetime", async () => {
    const calls: any[] = [];
    const project_id = `project-${Date.now()}`;
    const client = {
      dkv: async (opts: any) => {
        calls.push(opts);
        const store = {
          closed: false,
          isClosed() {
            return this.closed;
          },
          close() {
            this.closed = true;
          },
        };
        return store;
      },
    };

    const first = await openJupyterLiveRunStore({
      client: client as any,
      project_id,
      path: "a.ipynb",
    });
    const second = await openJupyterLiveRunStore({
      client: client as any,
      project_id,
      path: "a.ipynb",
    });
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      project_id,
      name: jupyterLiveRunStoreName("a.ipynb"),
      ephemeral: true,
    });
    expect(calls[1]).toMatchObject({
      project_id,
      name: jupyterLiveRunStoreName("a.ipynb"),
      ephemeral: true,
    });
  });
});
