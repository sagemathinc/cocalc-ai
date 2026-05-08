import { Alert, Card } from "antd";
import MoneyStatistic from "./money-statistic";
import type { MoneyValue } from "@cocalc/util/money";

interface Props {
  minBalance?: MoneyValue | null;
  style?;
}

export default function MinBalance({ minBalance, style }: Props) {
  if (minBalance == null) {
    // loading...
    return null;
  }
  return (
    <Card style={style}>
      <MoneyStatistic title={"Minimum Balance"} value={minBalance} />
      <Alert
        showIcon
        type="info"
        message="Deprecated"
        description="Minimum balance is no longer used to extend negative-balance credit. Purchases now stop at zero balance."
      />
    </Card>
  );
}
