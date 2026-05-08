import { Alert } from "antd";

export default function PayAsYouGoMinBalance({ account_id }) {
  return (
    <Alert
      style={{ maxWidth: "800px" }}
      type="info"
      showIcon
      message="Minimum allowed balance is deprecated"
      description={`The legacy min_balance credit model is ignored for account ${account_id}. Pay-as-you-go purchases now stop at zero balance instead of extending negative-balance credit.`}
    />
  );
}
