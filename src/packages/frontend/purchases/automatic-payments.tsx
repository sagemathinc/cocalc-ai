import { Space } from "antd";
import SpendRate from "./spend-rate";
import { useEffect, useState } from "react";
import { getSpendRate as getSpendRateUsingApi } from "./api";
import ShowError from "@cocalc/frontend/components/error";
import { SectionDivider } from "./util";
import Balance from "./balance";
import type { MoneyValue } from "@cocalc/util/money";

export default function AutomaticPayments({
  compact: _compact,
  style,
}: {
  compact?;
  style?;
}) {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [spendRate, setSpendRate] = useState<MoneyValue | null>(null);

  const getSpendRate = async () => {
    setSpendRate(await getSpendRateUsingApi());
  };

  const handleRefresh = async () => {
    try {
      setError("");
      setLoading(true);
      setSpendRate(null);
      await getSpendRate();
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    handleRefresh();
  }, []);

  return (
    <div style={style}>
      <SectionDivider onRefresh={handleRefresh} loading={loading}>
        Automatic Deposits and Spend Rate
      </SectionDivider>
      <ShowError
        error={error}
        setError={setError}
        style={{ marginBottom: "15px" }}
      />
      <div style={{ textAlign: "center" }}>
        <Space wrap size="large">
          <Balance />
          <SpendRate spendRate={spendRate} />
        </Space>
      </div>
    </div>
  );
}
