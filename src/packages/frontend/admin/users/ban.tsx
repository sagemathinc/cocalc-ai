/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Component, Rendered } from "@cocalc/frontend/app-framework";
import { Alert, Button, Input, Modal, Space, Typography } from "antd";
import { Icon, ErrorDisplay } from "@cocalc/frontend/components";
import { webapp_client } from "../../webapp-client";
import {
  FreshAuthModal,
  isFreshAuthRequiredError,
} from "@cocalc/frontend/auth/fresh-auth";

interface Props {
  account_id: string;
  banned?: boolean;
  name?: string;
}

interface State {
  error?: string;
  running: boolean;
  link?: string;
  banned: boolean;
  freshAuthOpen: boolean;
  banModalOpen: boolean;
  banReason: string;
}

export class Ban extends Component<Props, State> {
  mounted: boolean = true;

  constructor(props: any) {
    super(props);
    this.state = {
      running: false,
      banned: !!props.banned,
      freshAuthOpen: false,
      banModalOpen: false,
      banReason: "",
    };
  }

  componentWillUnmount(): void {
    this.mounted = false;
  }

  async do_request({ fromFreshAuth = false } = {}): Promise<void> {
    const ban = !this.state.banned;
    const reason = this.state.banReason.trim();
    if (ban && !reason) {
      this.setState({ error: "Enter a reason for the ban." });
      return;
    }
    this.setState({ running: true });
    try {
      await webapp_client.admin_client.admin_ban_user(
        this.props.account_id,
        ban,
        reason || undefined,
      );
      this.setState({
        running: false,
        banned: !this.state.banned,
        freshAuthOpen: false,
        banModalOpen: false,
        banReason: "",
      });
    } catch (err) {
      if (!this.mounted) return;
      if (isFreshAuthRequiredError(err)) {
        this.setState({ freshAuthOpen: true, running: false });
        if (fromFreshAuth) {
          throw err;
        }
        return;
      }
      this.setState({ error: `${err}`, running: false });
      if (fromFreshAuth) {
        throw err;
      }
    }
  }

  render_ban_modal(): Rendered {
    return (
      <Modal
        open={this.state.banModalOpen}
        title={<>Ban {this.props.name ?? "this user"}?</>}
        okText="Ban user and equivalent emails"
        okButtonProps={{
          danger: true,
          disabled: this.state.running || !this.state.banReason.trim(),
        }}
        cancelText="Cancel"
        confirmLoading={this.state.running}
        onCancel={() => this.setState({ banModalOpen: false })}
        onOk={() => this.do_request()}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="warning"
            showIcon
            message="This is an immediate abuse-control action."
            description={
              <>
                The user will no longer be able to sign in. Existing remember-me
                cookies, browser auth sessions, API access, and project-host
                persistent access are revoked.
              </>
            }
          />
          <Typography.Paragraph>
            This also bans Gmail/Googlemail-equivalent email accounts: matching
            is case-insensitive, ignores dots in the local part, ignores
            <Typography.Text code>+tag</Typography.Text> suffixes, and treats{" "}
            <Typography.Text code>googlemail.com</Typography.Text> as{" "}
            <Typography.Text code>gmail.com</Typography.Text>.
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            Unbanning is intentionally per account. If this ban expands to
            equivalent email accounts, each account must be reviewed and
            unbanned separately.
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            This action does not delete projects or account data, and it does
            not send email to the user.
          </Typography.Paragraph>
          <Input.TextArea
            value={this.state.banReason}
            onChange={(e) =>
              this.setState({ banReason: e.target.value, error: undefined })
            }
            rows={4}
            maxLength={4000}
            showCount
            placeholder="Reason for the audit log, e.g. spam campaign, card fraud, crypto mining, abusive traffic, or support ticket link"
          />
        </Space>
      </Modal>
    );
  }

  render_ban_button(): Rendered {
    if (this.state.banned) {
      return (
        <Button
          onClick={() => {
            this.do_request();
          }}
          disabled={this.state.running}
        >
          <Icon
            name={this.state.running ? "sync" : "lock-open"}
            spin={this.state.running}
          />{" "}
          Remove Ban on User
        </Button>
      );
    }
    return (
      <Button
        danger
        disabled={this.state.running}
        onClick={() => this.setState({ banModalOpen: true })}
      >
        <Icon
          name={this.state.running ? "sync" : "lock-open"}
          spin={this.state.running}
        />{" "}
        Ban User...
      </Button>
    );
  }

  render_error(): Rendered {
    if (!this.state.error) {
      return;
    }
    return (
      <ErrorDisplay
        error={this.state.error}
        onClose={() => {
          this.setState({ error: undefined });
        }}
      />
    );
  }

  render(): Rendered {
    return (
      <div>
        <FreshAuthModal
          open={this.state.freshAuthOpen}
          onCancel={() => this.setState({ freshAuthOpen: false })}
          onSuccess={async () => {
            await this.do_request({ fromFreshAuth: true });
          }}
        />
        <b>
          User is currently{" "}
          {this.state.banned
            ? "banned!"
            : "NOT banned: banning revokes active account, API, and project-host access, and also bans Gmail/Googlemail-equivalent accounts."}
        </b>
        <br />
        <br />
        {this.render_error()}
        {this.render_ban_modal()}
        {this.render_ban_button()}
        <br />
        <br />
      </div>
    );
  }
}
