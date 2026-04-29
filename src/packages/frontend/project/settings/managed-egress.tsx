/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space } from "antd";
import { Paragraph, SettingBox, Text } from "@cocalc/frontend/components";
import {
  ManagedEgressHistoryButton,
  ManagedEgressRateSummary,
} from "@cocalc/frontend/purchases/managed-egress-history";

export function ManagedEgress({ project_id }: { project_id: string }) {
  return (
    <SettingBox title="Network Egress" icon="network">
      <Paragraph style={{ marginBottom: "12px" }}>
        Review outbound network traffic attributed to this project across recent
        time windows. This includes metered downloads, proxy traffic,
        interactive sessions, SSH, and raw outbound network traffic on supported
        shared hosts.
      </Paragraph>
      <Space direction="vertical" size="small">
        <ManagedEgressRateSummary project_id={project_id} />
        <ManagedEgressHistoryButton
          project_id={project_id}
          buttonText="View egress history"
        />
        <Text type="secondary">
          Use this before assuming a quiet project has no network cost. Leaked
          daemons, tunnels, or test infrastructure can generate substantial
          outbound traffic.
        </Text>
      </Space>
    </SettingBox>
  );
}
