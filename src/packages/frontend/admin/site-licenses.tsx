/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Space, Typography } from "antd";
import { lazy, Suspense } from "react";

import { useMembershipTiers } from "@cocalc/frontend/account/membership-tiers";
import { Loading } from "@cocalc/frontend/components";

const { Paragraph, Title } = Typography;

const SiteLicenseAdminPanel = lazy(async () => ({
  default: (await import("@cocalc/frontend/account/membership-package-manager"))
    .SiteLicenseAdminPanel,
}));

export function SiteLicensesAdmin() {
  const { error, loading, tiers } = useMembershipTiers();

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
      {loading ? (
        <Loading />
      ) : (
        <Suspense fallback={<Loading />}>
          <SiteLicenseAdminPanel tiers={tiers} />
        </Suspense>
      )}
    </Space>
  );
}
