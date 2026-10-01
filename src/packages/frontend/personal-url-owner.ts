import { useEffect, useState } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { onPersonalUrlOwnerChange } from "./personal-url-state";
export { refreshPersonalUrlOwner } from "./personal-url-state";

/** A UUID remains a qualified address while optional username metadata loads. */
export function usePersonalUrlOwner(accountId?: string): string | undefined {
  const [revision, setRevision] = useState(0);
  const [owner, setOwner] = useState<{
    accountId: string;
    name: string;
  }>();
  useEffect(
    () =>
      onPersonalUrlOwnerChange((changed) => {
        if (changed === accountId) setRevision((value) => value + 1);
      }),
    [accountId],
  );
  useEffect(() => {
    if (!accountId) return;
    let disposed = false;
    const client = webapp_client.conat_client;
    void (async () =>
      client.hub.personalUrls.getUsername({ owner_account_id: accountId }))()
      .then((value) => {
        if (
          disposed ||
          client !== webapp_client.conat_client ||
          value.account_id !== accountId
        )
          return;
        setOwner({ accountId, name: value.username ?? accountId });
      })
      .catch(() => {
        // Optional display metadata must not break an owner-qualified UUID URL.
      });
    return () => {
      disposed = true;
    };
  }, [accountId, revision]);
  return owner?.accountId === accountId ? owner?.name : accountId;
}
