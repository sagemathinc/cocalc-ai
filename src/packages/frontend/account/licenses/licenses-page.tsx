/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Space, Tabs, Typography } from "antd";
import { useEffect, useState } from "react";

import api from "@cocalc/frontend/client/api";
import { Icon, Loading } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";
import {
  ClaimableMembershipPackagesPanel,
  MembershipPackageManager,
  SiteLicenseReverificationPanel,
} from "../membership-package-manager";
import { SoftwareLicensesPage } from "./software-licenses";

const { Paragraph, Text, Title } = Typography;

interface MembershipTier {
  id: string;
  label?: string;
  store_visible?: boolean;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: Record<string, unknown>;
  disabled?: boolean;
}

interface MembershipTiersResponse {
  tiers?: MembershipTier[];
}

function SiteLicensesPage() {
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [refreshToken, setRefreshToken] = useState<number>(0);

  useEffect(() => {
    let canceled = false;
    async function loadTiers() {
      setLoading(true);
      setError("");
      try {
        const result = (await api(
          "purchases/get-membership-tiers",
        )) as MembershipTiersResponse;
        if (!canceled) {
          setTiers(result?.tiers ?? []);
        }
      } catch (err) {
        if (!canceled) {
          setError(`${err}`);
          setTiers([]);
        }
      } finally {
        if (!canceled) {
          setLoading(false);
        }
      }
    }
    void loadTiers();
    return () => {
      canceled = true;
    };
  }, [refreshToken]);

  function handleChanged() {
    setRefreshToken((value) => value + 1);
  }

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        style={{
          border: 0,
          background: `linear-gradient(135deg, ${COLORS.BLUE_LLLL}, ${COLORS.BS_GREEN_LL})`,
          boxShadow: `0 12px 28px ${COLORS.GRAY_LL}`,
        }}
      >
        <Space
          wrap
          align="start"
          style={{ justifyContent: "space-between", width: "100%" }}
        >
          <Space orientation="vertical" size={4} style={{ maxWidth: 760 }}>
            <Title level={3} style={{ margin: 0 }}>
              Campus and team licenses
            </Title>
            <Paragraph style={{ marginBottom: 0 }}>
              Manage institutional access, approval queues, team seats, and
              Launchpad software licenses from one place.
            </Paragraph>
          </Space>
          <Button onClick={handleChanged}>
            <Icon name="refresh" /> Refresh
          </Button>
        </Space>
      </Card>

      {error ? (
        <Alert
          type="error"
          showIcon
          title="Could not load membership tiers"
          description={error}
        />
      ) : null}

      {loading ? (
        <Loading />
      ) : (
        <>
          <Card>
            <Space
              orientation="vertical"
              size="middle"
              style={{ width: "100%" }}
            >
              <Space orientation="vertical" size={2}>
                <Text strong>Institutional access</Text>
                <Text type="secondary">
                  Claim an available campus seat and keep your affiliation
                  current.
                </Text>
              </Space>
              <ClaimableMembershipPackagesPanel onChanged={handleChanged} />
              <SiteLicenseReverificationPanel onChanged={handleChanged} />
            </Space>
          </Card>

          <MembershipPackageManager tiers={tiers} onChanged={handleChanged} />
        </>
      )}
    </Space>
  );
}

export function LicensesPage() {
  return (
    <div style={{ margin: "auto", maxWidth: 1200, width: "100%" }}>
      <Tabs
        defaultActiveKey="site"
        style={{ width: "100%" }}
        items={[
          {
            key: "site",
            label: (
              <span>
                <Icon name="users" /> Site licenses
              </span>
            ),
            children: <SiteLicensesPage />,
          },
          {
            key: "software",
            label: (
              <span>
                <Icon name="key" /> Launchpad licenses
              </span>
            ),
            children: <SoftwareLicensesPage />,
          },
        ]}
      />
    </div>
  );
}
