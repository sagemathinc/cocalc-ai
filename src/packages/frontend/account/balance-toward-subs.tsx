// slightly weird props since this will be used in the nextjs app

import { Alert, Card, Checkbox } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { USE_BALANCE_TOWARD_SUBSCRIPTIONS_DEFAULT } from "@cocalc/util/db-schema/accounts";

export default function UseBalanceTowardSubscriptions({
  style,
  use_balance_toward_subscriptions,
  set_use_balance_toward_subscriptions,
  minimal,
}) {
  const body = (
    <Alert
      style={{ marginBottom: "15px" }}
      type="info"
      showIcon
      title={
        <div>
          <Tooltip
            title={
              <div>
                Enable this if you do not need to maintain a positive balance
                for pay as you go purchases. If you primarily put credit on your
                account to pay for membership renewals, consider enabling this.
                The entire amount for the renewal must be available.
              </div>
            }
          >
            <Checkbox
              checked={use_balance_toward_subscriptions}
              onChange={(e) => {
                set_use_balance_toward_subscriptions(e.target.checked);
              }}
            >
              <span style={{ fontSize: "13pt" }}>
                Use account balance for membership renewals when possible.{" "}
                {!use_balance_toward_subscriptions && (
                  <b>(Currently Disabled)</b>
                )}
              </span>
            </Checkbox>
          </Tooltip>
        </div>
      }
    />
  );
  if (minimal) {
    return body;
  }
  return (
    <Card
      style={style}
      title={
        <>
          <Icon name="calendar" /> Use Balance Toward Membership Renewals
        </>
      }
    >
      {body}
    </Card>
  );
}

export function UseBalance({ style, minimal }: { style?; minimal? }) {
  const use_balance_toward_subscriptions = useTypedRedux(
    "account",
    "other_settings",
  )?.get("use_balance_toward_subscriptions");

  return (
    <UseBalanceTowardSubscriptions
      minimal={minimal}
      style={style}
      use_balance_toward_subscriptions={
        use_balance_toward_subscriptions ??
        USE_BALANCE_TOWARD_SUBSCRIPTIONS_DEFAULT
      }
      set_use_balance_toward_subscriptions={(value) => {
        const actions = redux.getActions("account");
        actions.set_other_settings("use_balance_toward_subscriptions", value);
      }}
    />
  );
}
