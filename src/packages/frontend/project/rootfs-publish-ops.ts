import { Map as ImmutableMap } from "immutable";
import type { DStream } from "@cocalc/conat/sync/dstream";
import type { LroEvent, LroSummary } from "@cocalc/conat/hub/api/lro";
import { MultiLroOpsManager } from "@cocalc/frontend/lro/ops-manager";
import type { LroOpState } from "@cocalc/frontend/lro/utils";

const ROOTFS_PUBLISH_LRO_KIND = "project-rootfs-publish";

export type RootfsPublishLroState = LroOpState;

export type RootfsPublishOpsManagerOptions = {
  project_id: string;
  setState: (state: {
    rootfs_publish_ops?: ImmutableMap<string, RootfsPublishLroState>;
  }) => void;
  isClosed: () => boolean;
  listLro: (opts: {
    scope_type: "project";
    scope_id: string;
    include_completed?: boolean;
  }) => Promise<LroSummary[]>;
  getLroStream: (opts: {
    op_id: string;
    scope_type: LroSummary["scope_type"];
    scope_id: string;
  }) => Promise<DStream<LroEvent>>;
  dismissLro: (opts: { op_id: string }) => Promise<void>;
  log?: (message: string, err?: unknown) => void;
};

export class RootfsPublishOpsManager {
  private manager: MultiLroOpsManager;

  constructor(opts: RootfsPublishOpsManagerOptions) {
    this.manager = new MultiLroOpsManager({
      kind: ROOTFS_PUBLISH_LRO_KIND,
      scope_type: "project",
      scope_id: opts.project_id,
      include_completed: false,
      retainTerminal: true,
      refreshMs: 30_000,
      listLro: opts.listLro,
      getLroStream: opts.getLroStream,
      dismissLro: opts.dismissLro,
      isClosed: opts.isClosed,
      log: opts.log,
      setState: (state) =>
        opts.setState({
          rootfs_publish_ops: state ? ImmutableMap(state) : undefined,
        }),
    });
  }

  init = () => this.manager.init();
  close = () => this.manager.close();
  track = (op: {
    op_id?: string;
    scope_type?: LroSummary["scope_type"];
    scope_id?: string;
  }) => this.manager.track(op);
  dismiss = (op_id?: string) => this.manager.dismiss(op_id);
}
