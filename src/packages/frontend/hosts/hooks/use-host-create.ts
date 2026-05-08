import { useState } from "@cocalc/frontend/app-framework";
import { alert_message } from "@cocalc/frontend/alerts";
import { isFreshAuthRequiredError } from "@cocalc/frontend/auth/fresh-auth";
import {
  buildCreateHostPayload,
  type FieldOptionsMap,
} from "../providers/registry";
import type {
  Host,
  HostCatalog,
  HostLroResponse,
} from "@cocalc/conat/hub/api/hosts";

type HubClient = {
  hosts: {
    createHost: (opts: any) => Promise<Host>;
    startHost?: (opts: {
      id: string;
      browser_id?: string;
    }) => Promise<HostLroResponse>;
  };
};

type UseHostCreateOptions = {
  hub: HubClient;
  refresh: () => Promise<unknown>;
  fieldOptions: FieldOptionsMap;
  catalog?: HostCatalog;
  onHostOp?: (host_id: string, op: HostLroResponse) => void;
  browser_id?: string;
};

export const useHostCreate = ({
  hub,
  refresh,
  fieldOptions,
  catalog,
  onHostOp,
  browser_id,
}: UseHostCreateOptions) => {
  const [creating, setCreating] = useState(false);

  const onCreate = async (vals: any) => {
    if (creating) return false;
    setCreating(true);
    try {
      const payload = buildCreateHostPayload(vals, { fieldOptions, catalog });
      const created = await hub.hosts.createHost({ ...payload, browser_id });
      const selfHostKind = payload?.machine?.metadata?.self_host_kind;
      const shouldAutoStart =
        payload?.machine?.cloud === "self-host" &&
        (selfHostKind === "direct" || selfHostKind == null);
      if (shouldAutoStart && created?.id && hub.hosts.startHost) {
        const op = await hub.hosts.startHost({ id: created.id, browser_id });
        onHostOp?.(created.id, op);
      }
      await refresh();
      return true;
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
      return false;
    } finally {
      setCreating(false);
    }
  };

  return { creating, onCreate };
};
