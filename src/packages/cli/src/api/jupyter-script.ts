import type { BoundJupyterDocument } from "./jupyter";

type ProjectIdentity = {
  project_id: string;
  title: string;
  host_id: string | null;
};

export interface ProjectJupyterExecContext<
  Project extends ProjectIdentity = ProjectIdentity,
> {
  notebook: BoundJupyterDocument<Project>;
  project: Project;
  path: string;
  cwd?: string;
}

export type ProjectJupyterExecHandler<
  Project extends ProjectIdentity = ProjectIdentity,
  Result = unknown,
> = (ctx: ProjectJupyterExecContext<Project>) => Result | Promise<Result>;
