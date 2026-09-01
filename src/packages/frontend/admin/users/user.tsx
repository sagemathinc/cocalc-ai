/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Display of basic information about a user, with link to get more information about that user.
*/

import { useState } from "react";
import { Icon, TimeAgo } from "@cocalc/frontend/components";
import { capitalize } from "@cocalc/util/misc";
import { Card, Space, Tag } from "antd";
import type { User } from "@cocalc/frontend/frame-editors/generic/client";
import { Projects } from "./projects";
import { Impersonate } from "./impersonate";
import { PasswordReset } from "./password-reset";
import { AdminRole } from "./admin-role";
import { Ban } from "./ban";
import { CopyToClipBoard } from "@cocalc/frontend/components";
import { displayNameFromAccount } from "@cocalc/util/accounts/display-name";
import { COLORS } from "@cocalc/util/theme";
import { AdminMembership } from "./admin-membership";
import { AdminBilling } from "./billing";
import { ManagedEgressHistoryPanel } from "@cocalc/frontend/purchases/managed-egress-history";
import { AccountStatusTags } from "../account-status-tags";
import { LegacyMigrationAdmin } from "./legacy-migration";

export type AdminUserSection =
  | "projects"
  | "billing"
  | "egress"
  | "activity"
  | "impersonate"
  | "password"
  | "ban"
  | "membership"
  | "migration";

type UserResultProps = User & {
  defaultExpanded?: boolean;
  defaultSection?: AdminUserSection;
};

export function UserResult({
  display_name,
  first_name,
  last_name,
  email_address,
  email_address_verified,
  created,
  last_active,
  account_id,
  home_bay_id,
  banned,
  is_admin,
  membership_class,
  membership_label,
  membership_source,
  defaultExpanded = false,
  defaultSection,
}: UserResultProps) {
  const userName =
    displayNameFromAccount({ display_name, first_name, last_name }) ||
    email_address ||
    account_id;
  const [details, setDetails] = useState<boolean>(
    defaultExpanded || defaultSection != null,
  );
  const [activeMore, setActiveMore] = useState<AdminUserSection | undefined>(
    defaultSection,
  );

  const renderCreated = () => {
    if (!created) {
      return <span>ancient times</span>;
    }
    return <TimeAgo date={created} />;
  };

  const renderLastActive = () => {
    if (!last_active) {
      return <span>never</span>;
    }
    return <TimeAgo date={last_active} />;
  };

  const renderMoreLink = (name: AdminUserSection) => {
    const label = name === "password" ? "profile" : name;
    return (
      <Tag.CheckableTag
        style={{ fontSize: "11pt" }}
        checked={activeMore === name}
        onChange={() => setActiveMore(activeMore === name ? undefined : name)}
      >
        {capitalize(label)}
      </Tag.CheckableTag>
    );
  };

  const showActiveContent = details && activeMore != null;

  return (
    <Card
      style={{ margin: "15px 0" }}
      styles={{
        body: { padding: showActiveContent ? undefined : 0 },
        header: { background: COLORS.GRAY_LLL },
        title: {
          overflow: "visible",
          padding: "0",
          textOverflow: "clip",
          whiteSpace: "normal",
        },
      }}
      title={
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          <div
            style={{
              alignItems: "center",
              cursor: "pointer",
              display: "flex",
              flexWrap: "wrap",
              gap: "8px 16px",
              minWidth: 0,
            }}
            onClick={() => setDetails((value) => !value)}
          >
            <Icon
              name={details ? "minus-square" : "plus-square"}
              style={{ flex: "0 0 auto" }}
            />
            <Space
              wrap
              style={{ color: COLORS.GRAY_M, flex: "1 1 360px", minWidth: 0 }}
            >
              {userName}{" "}
              {email_address ? (
                <div onClick={(e) => e.stopPropagation()}>
                  <CopyToClipBoard
                    style={{ color: COLORS.GRAY_M }}
                    value={email_address}
                  />
                </div>
              ) : (
                "NO Email"
              )}
              {home_bay_id && <Tag>Home bay: {home_bay_id}</Tag>}
              <AccountStatusTags
                account={{
                  banned,
                  membership_class,
                  membership_label,
                  membership_source,
                }}
              />
              {is_admin && <Tag color="gold">ADMIN</Tag>}
            </Space>
            <div
              style={{
                alignItems: "center",
                color: COLORS.GRAY_M,
                display: "flex",
                flex: "0 1 auto",
                flexWrap: "wrap",
                gap: "8px",
                justifyContent: "flex-end",
                marginLeft: "auto",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <span>
                Active {renderLastActive()} (Created {renderCreated()})
              </span>
            </div>
          </div>
          {details && (
            <div
              style={{
                alignItems: "center",
                display: "flex",
                flexWrap: "wrap-reverse",
                gap: "8px 16px",
                justifyContent: "space-between",
              }}
            >
              <Space wrap>
                {renderMoreLink("impersonate")}
                {renderMoreLink("password")}
                {renderMoreLink("ban")}
                {renderMoreLink("projects")}
                {renderMoreLink("billing")}
                {renderMoreLink("egress")}
                {renderMoreLink("membership")}
                {renderMoreLink("migration")}
              </Space>
              <CopyToClipBoard
                copyTip={"Copied account_id!"}
                style={{ color: COLORS.GRAY_M }}
                value={account_id}
              />
            </div>
          )}
        </Space>
      }
    >
      {showActiveContent && (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {activeMore === "impersonate" && (
            <Impersonate
              account_id={account_id}
              display_name={userName}
              embedded
            />
          )}
          {activeMore === "password" && (
            <>
              <PasswordReset
                account_id={account_id}
                email_address={email_address ?? ""}
                email_address_verified={email_address_verified}
              />
              <div style={{ marginTop: "20px" }}>
                <AdminRole
                  account_id={account_id}
                  name={userName || account_id}
                  is_admin={is_admin}
                />
              </div>
            </>
          )}
          {activeMore === "ban" && (
            <Ban
              account_id={account_id}
              banned={banned}
              name={`${userName} ${email_address ?? ""}`}
            />
          )}
          {activeMore === "projects" && (
            <Projects
              account_id={account_id}
              embedded
              title={`Recently active projects that ${userName} collaborates on`}
            />
          )}
          {activeMore === "billing" && <AdminBilling account_id={account_id} />}
          {activeMore === "egress" && (
            <ManagedEgressHistoryPanel user_account_id={account_id} />
          )}
          {activeMore === "membership" && (
            <AdminMembership account_id={account_id} />
          )}
          {activeMore === "migration" && (
            <LegacyMigrationAdmin account_id={account_id} />
          )}
        </Space>
      )}
    </Card>
  );
}

export default UserResult;
