/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Flex, Space, Typography } from "antd";

const { Text } = Typography;

export function ActiveUsersMapSummary({
  total,
  mapped,
  usageMetricsNotEnabled,
  unavailable,
  onShowAll,
  onShowUnavailable,
  hint,
}: {
  total: number;
  mapped: number;
  usageMetricsNotEnabled?: number;
  unavailable: number;
  onShowAll?: () => void;
  onShowUnavailable?: () => void;
  hint: string;
}) {
  return (
    <Flex justify="space-between" align="center" wrap gap="small">
      <Space wrap>
        {total > 0 && onShowAll ? (
          <Button type="link" size="small" onClick={onShowAll}>
            Active users: <strong>{total}</strong>
          </Button>
        ) : (
          <Text>
            Active users: <Text strong>{total}</Text>
          </Text>
        )}
        <Text type="secondary">·</Text>
        <Text>
          On map: <Text strong>{mapped}</Text>
        </Text>
        {usageMetricsNotEnabled != null && (
          <Space>
            <Text type="secondary">·</Text>
            <Text>
              Usage metrics not enabled:{" "}
              <Text strong>{usageMetricsNotEnabled}</Text>
            </Text>
          </Space>
        )}
        <Text type="secondary">·</Text>
        {unavailable > 0 && onShowUnavailable ? (
          <Button type="link" size="small" onClick={onShowUnavailable}>
            Location unavailable: <strong>{unavailable}</strong>
          </Button>
        ) : (
          <Text>
            Location unavailable: <Text strong>{unavailable}</Text>
          </Text>
        )}
      </Space>
      <Text type="secondary">{hint}</Text>
    </Flex>
  );
}
