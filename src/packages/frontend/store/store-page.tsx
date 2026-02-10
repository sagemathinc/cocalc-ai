import { Card, Space, Tag, Typography } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { MembershipStatusPanel } from "@cocalc/frontend/account/membership-status";
import VoucherPurchasePanel from "./voucher-purchase";
import AdminPurchasePanel from "./admin-purchase";
import { A } from "@cocalc/frontend/components/A";

const { Title, Paragraph, Text } = Typography;

export function StorePage() {
  const isAdmin = useTypedRedux("account", "is_admin");

  return (
    <div style={{ padding: "20px", overflowY: "auto" }}>
      <Title level={3} style={{ marginBottom: "4px" }}>
        Store
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: "20px" }}>
        Purchase memberships and vouchers. Course packages and organization
        licenses are coming soon.
      </Paragraph>

      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <div>
          <Text strong style={{ fontSize: "16px" }}>
            Membership
          </Text>
          <MembershipStatusPanel showHeader={false} />
        </div>

        <Card
          title="Credit vouchers"
          extra={
            <A href="/vouchers" title="Open the voucher center">
              Voucher Center
            </A>
          }
        >
          <VoucherPurchasePanel />
        </Card>

        <Card
          title={
            <Space>
              Course packages
              <Tag>Coming soon</Tag>
            </Space>
          }
        >
          <Paragraph type="secondary">
            Planned: bundles of memberships for teachers and students.
          </Paragraph>
        </Card>

        <Card
          title={
            <Space>
              Organization site license
              <Tag>Coming soon</Tag>
            </Space>
          }
        >
          <Paragraph type="secondary">
            Planned: org-wide memberships with a seat limit.
          </Paragraph>
        </Card>

        {isAdmin && <AdminPurchasePanel />}
      </Space>
    </div>
  );
}
