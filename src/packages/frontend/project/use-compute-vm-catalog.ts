import { useCallback, useRef, useState } from "react";
import type { ComputeCatalog } from "@cocalc/conat/hub/api/compute";
import { webapp_client } from "@cocalc/frontend/webapp-client";

// Catalog availability is independent of VM/volume list requests. In
// particular, an unfinished request is not evidence of disabled compute.
export function useComputeVmCatalog() {
  const [catalog, setCatalog] = useState<ComputeCatalog>();
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const request = useRef(0);
  const loadCatalog = useCallback(async () => {
    const id = ++request.current;
    setStatus("loading");
    try {
      const next = await webapp_client.conat_client.hub.compute.getCatalog({});
      if (id !== request.current) return;
      setCatalog(next);
      setStatus("ready");
    } catch {
      if (id !== request.current) return;
      // Retain a previously fetched catalog during transient refresh failures.
      // Without one, the modal offers retry rather than inferring site setup.
      setStatus("error");
    }
  }, []);
  return { catalog, catalogLoading: status === "loading", loadCatalog };
}
