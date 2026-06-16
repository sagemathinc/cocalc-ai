/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "antd";
import { useEffect, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { TeamLicenseWarning } from "@cocalc/conat/hub/api/purchases";

const REFRESH_MS = 5 * 60 * 1000;

export function TeamLicenseWarningBanner() {
  const account_id = useTypedRedux("account", "account_id");
  const is_logged_in = useTypedRedux("account", "is_logged_in");
  const [warning, setWarning] = useState<TeamLicenseWarning | null>(null);

  useEffect(() => {
    if (!is_logged_in || !account_id) {
      setWarning(null);
      return;
    }
    let canceled = false;
    async function load() {
      try {
        const details =
          await webapp_client.conat_client.hub.purchases.getMembershipDetails(
            {},
          );
        if (!canceled) {
          setWarning(details.selected.team_license_warning ?? null);
        }
      } catch (_err) {
        if (!canceled) {
          setWarning(null);
        }
      }
    }
    void load();
    const interval = setInterval(() => void load(), REFRESH_MS);
    return () => {
      canceled = true;
      clearInterval(interval);
    };
  }, [account_id, is_logged_in]);

  if (!warning) {
    return null;
  }

  return (
    <Alert
      type="warning"
      showIcon
      banner
      style={{ marginBottom: "10px", paddingBlock: "6px" }}
      message={warning.message}
    />
  );
}
