import { conat } from "@cocalc/conat/client";
import {
  publishLroEvent as publishLroEvent0,
  publishLroSummary as publishLroSummary0,
} from "@cocalc/conat/lro/stream";
import type {
  LroEvent,
  LroScopeType,
  LroSummary,
} from "@cocalc/conat/hub/api/lro";

export async function publishLroEvent(opts: {
  scope_type: LroScopeType;
  scope_id: string;
  op_id: string;
  event: LroEvent;
  ttl?: number;
}): Promise<void> {
  await publishLroEvent0({
    ...opts,
    client: conat(),
  });
}

export async function publishLroSummary(opts: {
  scope_type: LroScopeType;
  scope_id: string;
  summary: LroSummary;
}): Promise<void> {
  await publishLroSummary0({
    ...opts,
    client: conat(),
  });
}
