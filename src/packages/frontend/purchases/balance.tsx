import type { CSSProperties } from "react";
import { useState } from "react";
import { Button, Card, Space, Spin } from "antd";
import { Tooltip } from "@cocalc/frontend/components";
import { zIndexTip } from "./zindex";
import MoneyStatistic from "./money-statistic";
import Payment from "./payment";
import { Icon } from "@cocalc/frontend/components/icon";
import AutoBalance from "./auto-balance";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { MoneyValue } from "@cocalc/util/money";

interface Props {
  style?: CSSProperties;
  refresh?: Function;
  cost?: MoneyValue; // optional amount of money we want right now
  defaultAdd?: boolean;
}

export default function Balance({ style, refresh, cost, defaultAdd }: Props) {
  const balance = useTypedRedux("account", "balance");
  const [add, setAdd] = useState<boolean>(!!defaultAdd);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  const handleRefresh = async () => {
    try {
      setRefreshing(true);
      await refresh?.();
    } finally {
      setRefreshing(false);
    }
  };

  let body;
  if (balance == null) {
    body = (
      <div
        style={{
          height: "125px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Spin delay={1000} size="large" />
      </div>
    );
  } else {
    let stat = (
      <MoneyStatistic title={"Current Balance"} value={balance} roundDown />
    );
    if (balance < 0) {
      stat = (
        <Tooltip
          zIndex={zIndexTip}
          title="You have a negative balance (an account credit).  This is money that you can spend anywhere in CoCalc."
        >
          {stat}
        </Tooltip>
      );
    }

    if (!add) {
      body = (
        <div>
          {stat}
          <Space style={{ marginTop: "5px" }} wrap>
            <Button type="primary" size="large" onClick={() => setAdd(true)}>
              <Icon name="credit-card" style={{ marginRight: "5px" }} />
              Deposit Money
            </Button>
            {refresh != null && (
              <Button size="large" loading={refreshing} onClick={handleRefresh}>
                <Icon name="refresh" style={{ marginRight: "5px" }} />
                Refresh
              </Button>
            )}
          </Space>
          <div style={{ marginTop: "20px" }}>
            <AutoBalance />
          </div>
        </div>
      );
    } else {
      body = (
        <>
          <Button
            onClick={() => setAdd(false)}
            style={{ position: "absolute", right: "15px" }}
          >
            Cancel
          </Button>
          <Payment
            balance={balance}
            update={() => {
              refresh?.();
              setAdd(false);
            }}
            cost={cost}
          />
        </>
      );
    }
  }
  return <Card style={style}>{body}</Card>;
}
