import { projectSubject } from "@cocalc/conat/names";

export const JUPYTER_LIVE_RUN_SERVICE = "jupyter-live-run";

export type JupyterLiveRunMessage = {
  id?: string;
  run_id?: string;
  lifecycle?: string;
  msg_type?: string;
  metadata?: unknown;
  content?: any;
  buffers?: unknown;
  done?: boolean;
  more_output?: boolean;
};

export type JupyterLiveRunBatch = {
  path: string;
  run_id: string;
  mesgs: JupyterLiveRunMessage[];
  sent_at_ms: number;
};

export function jupyterLiveRunSubject(opts: {
  project_id: string;
  path: string;
}): string {
  return projectSubject({
    project_id: opts.project_id,
    service: JUPYTER_LIVE_RUN_SERVICE,
    path: opts.path,
  });
}
