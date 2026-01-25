import { useState } from "@cocalc/frontend/app-framework";
import {
  buildCreateHostPayload,
  type FieldOptionsMap,
} from "../providers/registry";
import type { HostCatalog } from "@cocalc/conat/hub/api/hosts";

type HubClient = {
  hosts: {
    createHost: (opts: any) => Promise<unknown>;
  };
};

type UseHostCreateOptions = {
  hub: HubClient;
  refresh: () => Promise<unknown>;
  fieldOptions: FieldOptionsMap;
  catalog?: HostCatalog;
};

export const useHostCreate = ({
  hub,
  refresh,
  fieldOptions,
  catalog,
}: UseHostCreateOptions) => {
  const [creating, setCreating] = useState(false);

  const onCreate = async (vals: any) => {
    if (creating) return;
    setCreating(true);
    try {
      const payload = buildCreateHostPayload(vals, { fieldOptions, catalog });
      await hub.hosts.createHost(payload);
      await refresh();
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  return { creating, onCreate };
};
