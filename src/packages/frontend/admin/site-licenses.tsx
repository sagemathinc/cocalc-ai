/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Space, Typography } from "antd";
import { useEffect, useState } from "react";

import { SiteLicenseAdminPanel } from "@cocalc/frontend/account/membership-package-manager";
import type { MembershipTierLike } from "@cocalc/frontend/account/membership-package-manager";
import api from "@cocalc/frontend/client/api";
import { Loading } from "@cocalc/frontend/components";

const { Paragraph, Title } = Typography;

interface MembershipTiersResponse {
  error?: string;
  tiers?: MembershipTierLike[];
}

export function SiteLicensesAdmin() {
  const [tiers, setTiers] = useState<MembershipTierLike[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let canceled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const result = (await api(
          "purchases/get-membership-tiers",
        )) as MembershipTiersResponse;
        if (result?.error) {
          throw Error(result.error);
        }
        if (!canceled) {
          setTiers(result?.tiers ?? []);
        }
      } catch (err) {
        if (!canceled) {
          setTiers([]);
          setError(`${err}`);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <div>
        <Title level={4}>Site Licenses</Title>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Create deployment-level licenses, configure pools, and attach customer
          owners or managers. Customer owners and managers see their management
          controls in account settings after they are attached.
        </Paragraph>
      </div>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {loading ? <Loading /> : <SiteLicenseAdminPanel tiers={tiers} />}
    </Space>
  );
}
