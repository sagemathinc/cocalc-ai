/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Component, Rendered } from "@cocalc/frontend/app-framework";
import {
  Alert,
  Button,
  Input,
  Modal,
  Popconfirm,
  Space,
  Typography,
} from "antd";
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
  freshAuthAction?: "ban" | "quarantine";
  banModalOpen: boolean;
  banReason: string;
  quarantineModalOpen: boolean;
  quarantineReason: string;
  quarantineRunning: boolean;
  quarantineResult?: {
    local_subscriptions_canceled: number;
    payment_intents_canceled: number;
    payment_methods_detached: number;
    hosts_stop_requested: number;
    host_ids: string[];
    projects_stop_requested: number;
    project_ids: string[];
    errors: string[];
  };
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
      quarantineModalOpen: false,
      quarantineReason: "",
      quarantineRunning: false,
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
        freshAuthAction: undefined,
        banModalOpen: false,
        banReason: "",
      });
    } catch (err) {
      if (!this.mounted) return;
      if (isFreshAuthRequiredError(err)) {
        this.setState({
          freshAuthOpen: true,
          freshAuthAction: "ban",
          running: false,
        });
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

  async quarantine({ fromFreshAuth = false } = {}): Promise<void> {
    const reason = this.state.quarantineReason.trim();
    if (!reason) {
      this.setState({ error: "Enter a reason for the quarantine." });
      return;
    }
    this.setState({ quarantineRunning: true });
    try {
      const result =
        await webapp_client.admin_client.admin_quarantine_billing_resources(
          this.props.account_id,
          reason,
        );
      this.setState({
        quarantineRunning: false,
        freshAuthOpen: false,
        freshAuthAction: undefined,
        quarantineModalOpen: false,
        quarantineReason: "",
        quarantineResult: result,
      });
    } catch (err) {
      if (!this.mounted) return;
      if (isFreshAuthRequiredError(err)) {
        this.setState({
          freshAuthOpen: true,
          freshAuthAction: "quarantine",
          quarantineRunning: false,
        });
        if (fromFreshAuth) {
          throw err;
        }
        return;
      }
      this.setState({ error: `${err}`, quarantineRunning: false });
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
                persistent access are revoked. Billing/resource quarantine is
                also applied: automatic billing is disabled, payment methods are
                detached, subscriptions and open payment intents are canceled,
                owned dedicated hosts are stopped, and projects using this
                account's runtime slot are stopped.
              </>
            }
          />
          <Typography.Paragraph>
            This also bans supported equivalent email accounts. Matching is
            case-insensitive and currently covers Gmail/Googlemail dot and{" "}
            <Typography.Text code>+tag</Typography.Text> aliases,
            Microsoft/Proton <Typography.Text code>+tag</Typography.Text>{" "}
            aliases, and Yahoo disposable{" "}
            <Typography.Text code>nickname-keyword@yahoo.com</Typography.Text>{" "}
            aliases. Future account creation or email changes using a supported
            equivalent address will be blocked while any equivalent account
            remains banned.
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            Unbanning is intentionally per account. If this ban expands to
            equivalent email accounts, each account must be reviewed and
            unbanned separately.
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            This action does not delete projects or account data, and it does
            not send email to the user. If this was a misunderstanding, billing,
            host, and project runtime state must be reviewed and restored
            deliberately after unbanning.
          </Typography.Paragraph>
          <div style={{ marginBottom: "18px" }}>
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
          </div>
        </Space>
      </Modal>
    );
  }

  render_quarantine_modal(): Rendered {
    return (
      <Modal
        open={this.state.quarantineModalOpen}
        title={
          <>
            Quarantine billing/resources for {this.props.name ?? "this user"}?
          </>
        }
        okText="Quarantine billing/resources"
        okButtonProps={{
          danger: true,
          disabled:
            this.state.quarantineRunning || !this.state.quarantineReason.trim(),
        }}
        cancelText="Cancel"
        confirmLoading={this.state.quarantineRunning}
        onCancel={() => this.setState({ quarantineModalOpen: false })}
        onOk={() => this.quarantine()}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Alert
            type="error"
            showIcon
            message="This contains billing and paid resources without deleting account data."
            description={
              <>
                Use this when abuse, fraud, or a suspect payment instrument
                makes continuing paid resources risky. This is not a substitute
                for account deletion, and it is not a one-click reversible
                action.
              </>
            }
          />
          <Typography.Paragraph>
            The backend will disable automatic balance top-ups, clear open
            checkout state, cancel local active subscriptions, cancel open
            Stripe payment intents, detach Stripe payment methods, cancel the
            Stripe usage subscription if present, and request stop for owned
            dedicated hosts and projects using this account's runtime slot.
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            If this was a misunderstanding, the account can remain banned or be
            unbanned independently, but billing and host state must be reviewed
            and restored deliberately. This action does not send email to the
            user.
          </Typography.Paragraph>
          <div style={{ marginBottom: "18px" }}>
            <Input.TextArea
              value={this.state.quarantineReason}
              onChange={(e) =>
                this.setState({
                  quarantineReason: e.target.value,
                  error: undefined,
                })
              }
              rows={4}
              maxLength={4000}
              showCount
              placeholder="Reason for the audit log, e.g. suspected stolen card, active crypto mining, payment dispute, or support ticket link"
            />
          </div>
        </Space>
      </Modal>
    );
  }

  render_quarantine_result(): Rendered {
    const result = this.state.quarantineResult;
    if (!result) {
      return;
    }
    return (
      <Alert
        type={result.errors.length ? "warning" : "success"}
        showIcon
        style={{ marginBottom: "12px" }}
        message="Billing/resource quarantine completed"
        description={
          <>
            Canceled {result.local_subscriptions_canceled} local subscriptions,
            canceled {result.payment_intents_canceled} open payment intents,
            detached {result.payment_methods_detached} payment methods, and
            requested stop for {result.hosts_stop_requested} hosts and{" "}
            {result.projects_stop_requested} projects.
            {result.errors.length ? (
              <Typography.Paragraph style={{ marginTop: "8px" }}>
                Errors: {result.errors.join("; ")}
              </Typography.Paragraph>
            ) : undefined}
          </>
        }
      />
    );
  }

  render_quarantine_button(): Rendered {
    return (
      <Button
        danger
        disabled={this.state.quarantineRunning}
        onClick={() =>
          this.setState({
            quarantineModalOpen: true,
            quarantineResult: undefined,
          })
        }
      >
        <Icon
          name={this.state.quarantineRunning ? "sync" : "stop"}
          spin={this.state.quarantineRunning}
        />{" "}
        Quarantine Billing/Resources...
      </Button>
    );
  }

  render_ban_button(): Rendered {
    if (this.state.banned) {
      return (
        <Popconfirm
          title="Remove ban on this account?"
          description={
            <div style={{ maxWidth: "420px" }}>
              Unbanning is intentionally per account. If this ban expanded to
              equivalent email accounts, each account must be reviewed and
              unbanned separately.
            </div>
          }
          okText="Remove ban"
          cancelText="Cancel"
          onConfirm={() => this.do_request()}
        >
          <Button disabled={this.state.running}>
            <Icon
              name={this.state.running ? "sync" : "lock-open"}
              spin={this.state.running}
            />{" "}
            Remove Ban on User
          </Button>
        </Popconfirm>
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
          onCancel={() =>
            this.setState({ freshAuthOpen: false, freshAuthAction: undefined })
          }
          onSuccess={async () => {
            if (this.state.freshAuthAction === "quarantine") {
              await this.quarantine({ fromFreshAuth: true });
            } else {
              await this.do_request({ fromFreshAuth: true });
            }
          }}
        />
        <b>
          User is currently{" "}
          {this.state.banned
            ? "banned!"
            : "NOT banned: banning revokes active account, API, and project-host access, stops billing/resources and projects using this account's runtime slot, bans existing supported equivalent email accounts, and blocks future equivalent signups."}
        </b>
        <br />
        <br />
        {this.render_error()}
        {this.render_ban_modal()}
        {this.render_quarantine_modal()}
        {this.render_quarantine_result()}
        {this.render_ban_button()}
        <br />
        <br />
        {this.render_quarantine_button()}
        <br />
        <br />
      </div>
    );
  }
}
