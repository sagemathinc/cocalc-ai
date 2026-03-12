/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpAutomationRecord } from "@cocalc/conat/ai/acp/types";
import type { DKV } from "@cocalc/conat/sync/dkv";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const AUTOMATION_STORE = "cocalc-thread-automations-v1";

type AutomationListListener = (records: AcpAutomationRecord[]) => void;

let kv: DKV<AcpAutomationRecord> | null = null;
let kvProjectId: string | null = null;
let kvInFlight: Promise<DKV<AcpAutomationRecord>> | null = null;

async function getStore(project_id: string): Promise<DKV<AcpAutomationRecord>> {
  if (kv && kvProjectId === project_id) {
    return kv;
  }
  if (kvInFlight && kvProjectId === project_id) {
    return await kvInFlight;
  }
  kvProjectId = project_id;
  kvInFlight = webapp_client.conat_client
    .dkv<AcpAutomationRecord>({
      project_id,
      name: AUTOMATION_STORE,
    })
    .then((store) => {
      kv = store;
      kvInFlight = null;
      return store;
    })
    .catch((err) => {
      kvInFlight = null;
      throw err;
    });
  return await kvInFlight;
}

function dateMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).valueOf();
  return Number.isFinite(ms) ? ms : 0;
}

function getProjectAutomations(
  entries: Record<string, AcpAutomationRecord>,
): AcpAutomationRecord[] {
  return Object.values(entries)
    .filter(Boolean)
    .sort((a, b) => dateMs(b.updated_at) - dateMs(a.updated_at));
}

export async function listAutomationsForProject(opts: {
  project_id: string;
}): Promise<AcpAutomationRecord[]> {
  const store = await getStore(opts.project_id);
  return getProjectAutomations(store.getAll());
}

export async function watchAutomationsForProject(
  opts: { project_id: string },
  listener: AutomationListListener,
): Promise<() => void> {
  const store = await getStore(opts.project_id);
  const emit = () => listener(getProjectAutomations(store.getAll()));
  const onChange = () => {
    emit();
  };
  store.on("change", onChange);
  emit();
  return () => store.removeListener("change", onChange);
}
