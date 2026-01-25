import { useState } from "@cocalc/frontend/app-framework";
import {
  buildCreateHostPayload,
  type FieldOptionsMap,
} from "../providers/registry";
import type { Host, HostCatalog, HostLroResponse } from "@cocalc/conat/hub/api/hosts";

type HubClient = {
  hosts: {
    createHost: (opts: any) => Promise<Host>;
    startHost?: (opts: { id: string }) => Promise<HostLroResponse>;
  };
};

type UseHostCreateOptions = {
  hub: HubClient;
  refresh: () => Promise<unknown>;
  fieldOptions: FieldOptionsMap;
  catalog?: HostCatalog;
  onHostOp?: (host_id: string, op: HostLroResponse) => void;
};

export const useHostCreate = ({
  hub,
  refresh,
  fieldOptions,
  catalog,
  onHostOp,
}: UseHostCreateOptions) => {
  const [creating, setCreating] = useState(false);

  const onCreate = async (vals: any) => {
    if (creating) return;
    setCreating(true);
    try {
      const payload = buildCreateHostPayload(vals, { fieldOptions, catalog });
      const created = await hub.hosts.createHost(payload);
      const selfHostKind = payload?.machine?.metadata?.self_host_kind;
      const shouldAutoStart =
        payload?.machine?.cloud === "self-host" &&
        (selfHostKind === "direct" || selfHostKind == null);
      if (shouldAutoStart && created?.id && hub.hosts.startHost) {
        const op = await hub.hosts.startHost({ id: created.id });
        onHostOp?.(created.id, op);
      }
      await refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  return { creating, onCreate };
};
