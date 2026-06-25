import { Card, Space, Tag } from "antd";

import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { TimeAgo } from "@cocalc/frontend/components";
import { PurchasesButton } from "@cocalc/frontend/purchases/purchases";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import Impersonate from "./impersonate";
import Projects from "./projects";

export default function User({
  account_id,
  display_name,
  first_name,
  last_name,
  name,
  email_address,
  last_active,
  created,
  banned,
}) {
  const displayName =
    displayNameFromAccount({ display_name, first_name, last_name }) ||
    email_address ||
    account_id;

  return (
    <Card
      style={{ margin: "5px" }}
      styles={{ header: { backgroundColor: "#eee" } }}
      title={
        <>
          {banned && (
            <Tag
              style={{ float: "right", margin: "5px 0 5px 15px" }}
              color="error"
            >
              banned
            </Tag>
          )}
          <div
            style={{
              marginTop: "5px",
              float: "right",
              fontSize: "11pt",
              fontWeight: 250,
            }}
          >
            {email_address}, {account_id}
          </div>
          <Avatar
            account_id={account_id}
            display_name={displayName}
            style={{ marginRight: "15px" }}
          />
          {displayName} {name ? `(name: ${name})` : ""}
        </>
      }
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <div>
          Last Active: {last_active ? <TimeAgo date={last_active} /> : "never"}
          {created && (
            <span>
              {" "}
              (Created: <TimeAgo date={created} />)
            </span>
          )}
        </div>
        <Projects account_id={account_id} />
        <Impersonate account_id={account_id} display_name={displayName} />
        <PurchasesButton account_id={account_id} />
      </Space>
    </Card>
  );
}
