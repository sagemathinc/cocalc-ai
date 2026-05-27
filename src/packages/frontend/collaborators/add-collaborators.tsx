/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Add collaborators to a project
*/

import { Alert, Button, Input, Select } from "antd";
import { useIntl } from "react-intl";
import type { ProjectCollaboratorInviteUsage } from "@cocalc/conat/hub/api/projects";
import { labels } from "@cocalc/frontend/i18n";
import {
  React,
  redux,
  useActions,
  useEffect,
  useIsMountedRef,
  useMemo,
  useRef,
  useTypedRedux,
  useState,
} from "../app-framework";
import { Well } from "../antd-bootstrap";
import { Icon, Loading, ErrorDisplay, Gap } from "../components";
import { webapp_client } from "../webapp-client";
import { COLORS, SITE_NAME } from "@cocalc/util/theme";
import {
  contains_url,
  plural,
  cmp,
  trunc_middle,
  is_valid_email_address,
  is_valid_uuid_string,
  search_match,
  search_split,
} from "@cocalc/util/misc";
import { Project } from "../projects/store";
import { Avatar } from "../account/avatar/avatar";
import { alert_message } from "../alerts";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { useProjectRunQuota } from "@cocalc/frontend/project/use-project-run-quota";
import { ShowSupportLink } from "@cocalc/frontend/support/link";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import { onCollabInvitesChanged } from "./invite-events";
import {
  ViewerReadPolicyEditor,
  viewerPolicyHasReadablePath,
} from "./viewer-read-policy";
import {
  DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
  type ProjectViewerReadPolicy,
} from "@cocalc/util/project-access";

const INVITE_MESSAGE_MAX_LENGTH = 1000;
type InviteRole = "collaborator" | "viewer";

interface RegisteredUser {
  sort?: string;
  account_id: string;
  first_name?: string;
  last_name?: string;
  last_active?: number;
  created?: number;
  email_address?: string;
  email_address_verified?: boolean;
  label?: string;
  tag?: string;
  name?: string;
  extra?: string[];
}

interface NonregisteredUser {
  sort?: string;
  email_address: string;
  account_id?: undefined;
  first_name?: undefined;
  last_name?: undefined;
  last_active?: undefined;
  created?: undefined;
  email_address_verified?: undefined;
  label?: string;
  tag?: string;
  name?: string;
  extra?: string[];
}

type User = RegisteredUser | NonregisteredUser;

interface Props {
  project_id: string;
  autoFocus?: boolean;
  where: string;
  mode?: "project" | "flyout";
}

type State =
  | "input"
  | "searching"
  | "searched"
  | "invited"
  | "invited_manual"
  | "invited_errors";

interface ManualInviteLink {
  email_address: string;
  reason?: string;
  invite_urls: string[];
}

export const AddCollaborators: React.FC<Props> = ({
  autoFocus,
  project_id,
  mode = "project",
}) => {
  const intl = useIntl();
  const isFlyout = mode === "flyout";
  const student = useStudentProjectFunctionality(project_id);
  const accountCustomize = useTypedRedux("account", "customize")?.toJS() as
    | { disableCollaborators?: boolean }
    | undefined;
  const user_map = useTypedRedux("users", "user_map");
  const project_map = useTypedRedux("projects", "project_map");
  const project: Project | undefined = useMemo(
    () => project_map?.get(project_id),
    [project_id, project_map],
  );
  const project_users = project?.get("users");

  // search that user has typed in so far
  const [search, set_search] = useState<string>("");
  const search_ref = useRef<string>("");

  // list of results for doing the search -- turned into a selector
  const [results, set_results] = useState<User[]>([]);
  const [num_matching_already, set_num_matching_already] = useState<number>(0);

  // list of actually selected entries in the selector list
  const [selected_entries, set_selected_entries] = useState<string[]>([]);
  const select_ref = useRef<any>(null);

  // currently carrying out a search
  const [state, set_state] = useState<State>("input");
  const [select_open, set_select_open] = useState<boolean>(false);
  // display an error in case something went wrong doing a search
  const [err, set_err] = useState<string>("");
  // if set, adding user via email to this address
  const [email_to, set_email_to] = useState<string>("");
  // with this body.
  const [email_body, set_email_body] = useState<string>("");
  const [email_body_error, set_email_body_error] = useState<string>("");
  const [email_body_editing, set_email_body_editing] = useState<boolean>(false);
  const [customize_email, set_customize_email] = useState<boolean>(false);
  const [invite_result, set_invite_result] = useState<string>("");
  const [manual_invite_links, set_manual_invite_links] = useState<
    ManualInviteLink[]
  >([]);
  const [invite_role, set_invite_role] = useState<InviteRole>("collaborator");
  const [invite_read_policy, set_invite_read_policy] =
    useState<ProjectViewerReadPolicy>(DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY);
  const [invite_usage, set_invite_usage] =
    useState<ProjectCollaboratorInviteUsage | null>(null);
  const [invite_usage_error, set_invite_usage_error] = useState<string>("");

  const isMountedRef = useIsMountedRef();

  const project_actions = useActions("projects");
  const { runQuota } = useProjectRunQuota(project_id);

  const allow_urls = useMemo(
    () => !!(runQuota?.network || runQuota?.member_host),
    [runQuota],
  );

  async function load_invite_usage(): Promise<void> {
    try {
      const usage = await webapp_client.project_collaborators.get_invite_usage({
        project_id,
      });
      if (!isMountedRef.current) return;
      set_invite_usage(usage);
      set_invite_usage_error("");
    } catch (err) {
      if (!isMountedRef.current) return;
      set_invite_usage_error(`${err}`);
    }
  }

  useEffect(() => {
    void load_invite_usage();
  }, [project_id, project_users]);

  useEffect(() => {
    return onCollabInvitesChanged(({ project_id: changedProjectId }) => {
      if (changedProjectId == null || changedProjectId === project_id) {
        void load_invite_usage();
      }
    });
  }, [project_id]);

  const invite_slots_remaining = invite_usage?.remaining ?? null;
  const invite_slot_limited =
    invite_usage?.limit != null && invite_slots_remaining != null;
  const invite_slots_exhausted =
    invite_role === "collaborator" &&
    invite_slot_limited &&
    invite_slots_remaining <= 0;
  const viewer_policy_empty =
    invite_role === "viewer" &&
    !viewerPolicyHasReadablePath(invite_read_policy);

  function reset(): void {
    set_search("");
    set_results([]);
    set_num_matching_already(0);
    set_selected_entries([]);
    set_state("input");
    set_err("");
    set_email_to("");
    set_email_body("");
    set_email_body_error("");
    set_email_body_editing(false);
    set_customize_email(false);
    set_invite_result("");
    set_manual_invite_links([]);
    set_select_open(false);
  }

  async function do_search(search: string): Promise<void> {
    if (state == "searching" || project == null) {
      // already searching
      return;
    }
    set_search(search);
    if (search.length === 0) {
      set_err("");
      set_results([]);
      return;
    }
    set_state("searching");
    let err = "";
    let search_results: User[] = [];
    let num_already_matching = 0;
    const already = new Set<string>([]);
    try {
      for (let query of search.split(",")) {
        query = query.trim().toLowerCase();
        const query_results = await webapp_client.users_client.user_search({
          query,
          limit: 30,
        });
        if (!isMountedRef.current) return; // no longer mounted
        if (query_results.length == 0 && is_valid_email_address(query)) {
          const email_address = query;
          if (!already.has(email_address)) {
            search_results.push({ email_address, sort: "0" + email_address });
            already.add(email_address);
          }
        } else {
          // There are some results, so not adding non-cloud user via email.
          // Filter out any users that already a collab on this project.
          for (const r of query_results) {
            if (r.account_id == null) continue; // won't happen
            if (project.getIn(["users", r.account_id]) == null) {
              if (!already.has(r.account_id)) {
                search_results.push(r);
                already.add(r.account_id);
              } else {
                // if we got additional information about email
                // address and already have this user, remember that
                // extra info.
                if (r.email_address != null) {
                  for (const x of search_results) {
                    if (x.account_id == r.account_id) {
                      x.email_address = r.email_address;
                    }
                  }
                }
              }
            } else {
              num_already_matching += 1;
            }
          }
        }
      }
    } catch (e) {
      err = e.toString();
    }
    set_num_matching_already(num_already_matching);
    write_email_invite();
    set_selected_entries([]);
    // sort search_results with collaborators first by last_active,
    // then non-collabs by last_active.
    search_results.sort((x, y) => {
      let c = cmp(
        x.account_id && user_map.has(x.account_id) ? 0 : 1,
        y.account_id && user_map.has(y.account_id) ? 0 : 1,
      );
      if (c) return c;
      c = -cmp(x.last_active?.valueOf() ?? 0, y.last_active?.valueOf() ?? 0);
      if (c) return c;
      return cmp(x.last_name?.toLowerCase(), y.last_name?.toLowerCase());
    });

    set_state("searched");
    set_err(err);
    set_results(search_results);
    set_email_to("");
    set_customize_email(false);
    set_select_open(true);
    select_ref.current?.focus();
  }

  function render_options(users: User[]): React.JSX.Element[] {
    const options: React.JSX.Element[] = [];
    for (const r of users) {
      if (r.label == null || r.tag == null || r.name == null) {
        let name = r.account_id
          ? (r.first_name ?? "") + " " + (r.last_name ?? "")
          : r.email_address;
        if (!name?.trim()) {
          name = "Anonymous User";
        }
        const tag = trunc_middle(name, 20);

        const extra: string[] = [];
        if (r.account_id != null && user_map.get(r.account_id)) {
          extra.push("Collaborator");
        }
        if (r.last_active) {
          extra.push(`Active ${new Date(r.last_active).toLocaleDateString()}`);
        }
        if (r.created) {
          extra.push(`Created ${new Date(r.created).toLocaleDateString()}`);
        }
        if (r.account_id == null) {
          extra.push("Invite by email");
        } else {
          if (r.email_address) {
            if (r.email_address_verified?.[r.email_address]) {
              extra.push(`${r.email_address} -- verified`);
            } else {
              extra.push(`${r.email_address} -- not verified`);
            }
          }
        }
        r.label = `${name} ${extra.join(" ")}`.toLowerCase();
        r.tag = tag;
        r.name = name;
        r.extra = extra;
      }
      const x = r.account_id ?? r.email_address;
      options.push(
        <Select.Option key={x} value={x} label={r.label} tag={r.tag}>
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <Avatar
              size={36}
              no_tooltip={true}
              account_id={r.account_id}
              first_name={r.account_id ? r.first_name : "@"}
              last_name={r.last_name}
            />
            <div style={{ lineHeight: 1.25, minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 500,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={r.name}
              >
                {r.name}
              </div>
              {r.extra != null && r.extra.length > 0 && (
                <div
                  style={{
                    color: COLORS.GRAY_M,
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.extra.join(" · ")}
                </div>
              )}
            </div>
          </div>
        </Select.Option>,
      );
    }
    return options;
  }

  async function invite_collaborator(account_id: string): Promise<void> {
    if (project == null) return;
    const { subject, replyto, replyto_name } = sender_info();

    await project_actions.invite_collaborator(
      project_id,
      account_id,
      email_body,
      subject,
      false,
      replyto,
      replyto_name,
      invite_role,
      invite_role === "viewer" ? invite_read_policy : undefined,
    );
  }

  async function add_selected(): Promise<void> {
    const errors: string[] = [];
    const manualDeliveryLinks: ManualInviteLink[] = [];
    const number_selected = selected_entries.length;
    for (const x of selected_entries) {
      try {
        if (is_valid_email_address(x)) {
          const result = await invite_noncloud_collaborator(x, true);
          const inviteLinks = (result?.invites ?? [])
            .map((invite) => invite.invite_url)
            .filter((url) => !!url);
          if (result?.manual_delivery_required && inviteLinks.length > 0) {
            manualDeliveryLinks.push({
              email_address: x,
              invite_urls: inviteLinks,
              reason: result.email_blocked_reason,
            });
          }
        } else if (is_valid_uuid_string(x)) {
          await invite_collaborator(x);
        } else {
          // skip
          throw Error(
            `BUG - invalid selection ${x} must be an email address or account_id.`,
          );
        }
      } catch (err) {
        errors.push(`Error - ${err}`);
      }
    }
    reset();
    void load_invite_usage();
    if (errors.length > 0) {
      set_invite_result(errors.join("\n"));
      set_state("invited_errors");
    } else if (manualDeliveryLinks.length > 0) {
      set_manual_invite_links(manualDeliveryLinks);
      set_invite_result("");
      set_state("invited_manual");
    } else {
      set_invite_result(
        `${number_selected} ${plural(number_selected, "invitation")} created.`,
      );
      set_state("invited");
    }
  }

  function write_email_invite(): void {
    if (project == null) return;

    const name = redux.getStore("account").get_fullname();
    const title = project.get("title");
    const target = `'${title}'`;
    const SiteName = redux.getStore("customize").get("site_name") ?? SITE_NAME;
    const action =
      invite_role === "viewer"
        ? "view this project read-only"
        : "collaborate with me";
    const body = `Hello!\n\nPlease ${action} using ${SiteName} on ${target}.\n\nBest wishes,\n\n${name}`;
    set_email_to(search);
    set_email_body(body);
  }

  function sender_info(): {
    subject: string;
    replyto?: string;
    replyto_name: string;
  } {
    const replyto = redux.getStore("account").get_email_address();
    const replyto_name = redux.getStore("account").get_fullname();
    const SiteName = redux.getStore("customize").get("site_name") ?? SITE_NAME;
    let subject;
    const access = invite_role === "viewer" ? "view" : "collaborate on";
    if (replyto_name != null) {
      subject = `${replyto_name} invited you to ${access} '${project?.get("title")}'`;
    } else {
      subject = `${SiteName} Invitation to '${project?.get("title")}'`;
    }
    return { subject, replyto, replyto_name };
  }

  async function invite_noncloud_collaborator(
    email_address,
    silent = false,
  ): Promise<any> {
    if (project == null) return;
    const { subject, replyto, replyto_name } = sender_info();
    const result = await project_actions.invite_collaborators_by_email(
      project_id,
      email_address,
      email_body,
      subject,
      silent,
      replyto,
      replyto_name,
      undefined,
      undefined,
      invite_role,
      invite_role === "viewer" ? invite_read_policy : undefined,
    );
    if (!silent && !allow_urls) {
      // Show a message that they might have to email that person
      // and tell them to make a cocalc account, and when they do
      // then they will get added as collaborator to this project....
      alert_message({
        type: "warning",
        message: `If email delivery is unreliable, copy the pending invite link and send it to ${email_address} through a trusted channel.`,
      });
    }
    return result;
  }

  async function send_email_invite(): Promise<void> {
    if (project == null) return;
    const emails = email_to
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    const errors: string[] = [];
    const manualDeliveryLinks: ManualInviteLink[] = [];
    for (const email of emails) {
      try {
        const result = await invite_noncloud_collaborator(email, true);
        const inviteLinks = (result?.invites ?? [])
          .map((invite) => invite.invite_url)
          .filter((url) => !!url);
        if (result?.manual_delivery_required && inviteLinks.length > 0) {
          manualDeliveryLinks.push({
            email_address: email,
            invite_urls: inviteLinks,
            reason: result.email_blocked_reason,
          });
        }
      } catch (err) {
        errors.push(`Error inviting ${email} - ${err}`);
      }
    }
    reset();
    void load_invite_usage();
    if (errors.length > 0) {
      set_invite_result(errors.join("\n"));
      set_state("invited_errors");
    } else if (manualDeliveryLinks.length > 0) {
      set_manual_invite_links(manualDeliveryLinks);
      set_state("invited_manual");
    } else {
      set_invite_result(
        `${emails.length} ${plural(emails.length, "invitation")} created.`,
      );
      set_state("invited");
    }
  }

  function check_email_body(value: string): void {
    if (!allow_urls && contains_url(value)) {
      set_email_body_error("Sending URLs is not allowed. (anti-spam measure)");
    } else {
      set_email_body_error("");
    }
  }

  function render_email_body_error(): React.JSX.Element | undefined {
    if (!email_body_error) {
      return;
    }
    return <ErrorDisplay error={email_body_error} />;
  }

  function render_email_textarea(): React.JSX.Element {
    return (
      <>
        <Input.TextArea
          value={email_body}
          autoSize={true}
          maxLength={INVITE_MESSAGE_MAX_LENGTH}
          onBlur={() => {
            set_email_body_editing(false);
          }}
          onFocus={() => set_email_body_editing(true)}
          onChange={(e) => {
            const value: string = (e.target as any).value;
            set_email_body(value);
            check_email_body(value);
          }}
        />
        <div
          style={{
            color: COLORS.GRAY,
            fontSize: "12px",
            lineHeight: "18px",
            marginTop: "4px",
            textAlign: "right",
          }}
        >
          {email_body.length} / {INVITE_MESSAGE_MAX_LENGTH}
        </div>
      </>
    );
  }

  function render_customize_message(): React.JSX.Element {
    return (
      <div style={{ marginTop: "8px" }}>
        <Button
          type="link"
          style={{ padding: 0 }}
          onClick={() => set_customize_email(!customize_email)}
        >
          <Icon name={customize_email ? "caret-down" : "caret-right"} />{" "}
          Customize invite message
        </Button>
        {customize_email && (
          <div
            style={{
              border: "1px solid lightgrey",
              padding: "10px",
              borderRadius: "5px",
              backgroundColor: "white",
              marginTop: "8px",
            }}
          >
            {render_email_body_error()}
            {render_email_textarea()}
          </div>
        )}
      </div>
    );
  }

  function render_send_email(): React.JSX.Element | undefined {
    if (!email_to) {
      return;
    }
    const recipientCount = email_to
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0).length;
    const exceedsSlots =
      invite_role === "collaborator" &&
      invite_slots_remaining != null &&
      recipientCount > invite_slots_remaining;

    return (
      <div>
        <hr />
        <Well>
          Enter one or more email addresses separated by commas:
          <Input
            placeholder="Email addresses separated by commas..."
            value={email_to}
            onChange={(e) => set_email_to((e.target as any).value)}
            autoFocus
          />
          {render_access_role()}
          {render_invite_slots()}
          {render_customize_message()}
          <div style={{ display: "flex", marginTop: "10px" }}>
            <Button
              onClick={() => {
                set_email_to("");
                set_email_body("");
                set_email_body_editing(false);
                set_customize_email(false);
              }}
            >
              {intl.formatMessage(labels.cancel)}
            </Button>
            <Gap />
            <Button
              type="primary"
              onClick={() => void send_email_invite()}
              disabled={
                !!email_body_editing ||
                invite_slots_exhausted ||
                exceedsSlots ||
                viewer_policy_empty
              }
            >
              {exceedsSlots
                ? `Only ${invite_slots_remaining} invite ${plural(
                    invite_slots_remaining,
                    "slot",
                  )} left`
                : "Send Invitation"}
            </Button>
          </div>
        </Well>
      </div>
    );
  }

  function render_access_role(): React.JSX.Element {
    return (
      <div
        style={{
          background: COLORS.GRAY_LLL,
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: 10,
          marginBottom: 10,
          padding: 12,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Access level</div>
        <Select
          style={{ width: "100%" }}
          value={invite_role}
          onChange={(value) => set_invite_role(value as InviteRole)}
          options={[
            {
              value: "collaborator",
              label: "Collaborator: can edit files and use project runtimes",
            },
            {
              value: "viewer",
              label: "Viewer: read-only files, no runtimes or write access",
            },
          ]}
        />
        {invite_role === "viewer" ? (
          <ViewerReadPolicyEditor
            value={invite_read_policy}
            onChange={set_invite_read_policy}
          />
        ) : (
          <div style={{ color: COLORS.GRAY_M, fontSize: 12, marginTop: 6 }}>
            Collaborators get normal read/write access, project runtimes,
            terminals, SSH, and project tools.
          </div>
        )}
      </div>
    );
  }

  function render_invite_slots(): React.JSX.Element | undefined {
    if (invite_usage_error) {
      return (
        <Alert
          showIcon
          type="warning"
          style={{ marginBottom: 10 }}
          message="Unable to load collaborator slot usage"
          description={invite_usage_error}
        />
      );
    }
    if (invite_usage == null || invite_usage.limit == null) {
      return;
    }
    if (invite_role === "viewer") {
      return (
        <Alert
          showIcon
          type="info"
          style={{ marginBottom: 10 }}
          message="Viewer invites do not use collaborator slots"
          description="Viewers have read-only file access and cannot edit files or use project runtimes."
        />
      );
    }
    const { current, limit, remaining } = invite_usage;
    const remainingCount = remaining ?? 0;
    const exhausted = remainingCount <= 0;
    return (
      <Alert
        showIcon
        type={exhausted ? "warning" : "info"}
        style={{ marginBottom: 10 }}
        message={`${remainingCount} invite ${plural(remainingCount, "slot")} left`}
        description={
          <span>
            This project is using {current} of {limit} member and pending invite
            slots. To add more people, revoke a pending invite, remove a
            collaborator or owner,{" "}
            <a href={joinUrlPath(appBasePath, "store")}>upgrade membership</a>,
            or <ShowSupportLink text="contact support" />.
          </span>
        }
      />
    );
  }

  function render_select_list(): React.JSX.Element | undefined {
    if (project == null) return;

    const users: User[] = [];
    const existing: User[] = [];
    for (const r of results) {
      if (project.getIn(["users", r.account_id]) != null) {
        existing.push(r);
      } else {
        users.push(r);
      }
    }
    const showSelector = state === ("searched" as State) && users.length > 0;

    const hasSearchContentBelow =
      showSelector || selected_entries.length > 0 || state == "searched";

    return (
      <div
        style={{
          background: COLORS.GRAY_LLL,
          border: `1px solid ${COLORS.GRAY_LL}`,
          borderRadius: 10,
          marginBottom: 10,
          padding: 12,
        }}
      >
        <Input.Search
          autoFocus={autoFocus}
          placeholder="Search by name or email address..."
          value={search}
          enterButton="Search"
          loading={state === ("searching" as State)}
          style={{ marginBottom: hasSearchContentBelow ? 10 : 0 }}
          onChange={(e) => {
            const value = (e.target as any).value ?? "";
            search_ref.current = value;
            set_search(value);
          }}
          onSearch={(value) => {
            const next = value.trim();
            if (next && state !== ("searching" as State)) {
              void do_search(next);
            }
          }}
        />
        {showSelector && (
          <Select
            ref={select_ref}
            mode="multiple"
            allowClear
            open={select_open}
            showSearch={false}
            filterOption={(s, opt) => {
              if (s.indexOf(",") != -1) return true;
              return search_match(
                (opt as any).label,
                search_split(s.toLowerCase()),
              );
            }}
            style={{ width: "100%", marginBottom: 10 }}
            placeholder={`Select from ${users.length} ${plural(
              users.length,
              "matching user",
            )}.`}
            onChange={(value) => {
              const selected = value as string[];
              set_selected_entries(selected);
              if (selected.length > 0) {
                set_select_open(false);
              }
            }}
            value={selected_entries}
            optionLabelProp="tag"
            notFoundContent={null}
            onFocus={() => {
              set_select_open(true);
            }}
            onBlur={() => {
              set_select_open(false);
            }}
            onDropdownVisibleChange={(open) => {
              set_select_open(open);
            }}
          >
            {render_options(users)}
          </Select>
        )}
        {selected_entries.length > 0 && (
          <>
            {render_access_role()}
            {render_invite_slots()}
            {render_customize_message()}
          </>
        )}
        {state == "searched" && render_select_list_button()}
      </div>
    );
  }

  function render_select_list_button(): React.JSX.Element | undefined {
    const number_selected = selected_entries.length;
    let label: string;
    let disabled: boolean;
    if (number_selected == 0 && results.length == 0) {
      label = "No matching users";
      if (num_matching_already > 0) {
        label += ` (${num_matching_already} matching ${plural(
          num_matching_already,
          "user",
        )} already added)`;
      }
      disabled = true;
    } else {
      if (number_selected == 0) {
        label = "Invite selected user";
        disabled = true;
      } else if (number_selected == 1) {
        label = "Invite selected user";
        disabled = false;
      } else {
        label = `Invite ${number_selected} selected users`;
        disabled = false;
      }
    }
    if (email_body_error) {
      disabled = true;
    }
    if (
      invite_role === "collaborator" &&
      invite_slots_remaining != null &&
      number_selected > invite_slots_remaining
    ) {
      disabled = true;
      label = `Only ${invite_slots_remaining} invite ${plural(
        invite_slots_remaining,
        "slot",
      )} left`;
    }
    if (viewer_policy_empty) {
      disabled = true;
      label = "Viewer policy allows no files";
    }
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: customize_email && selected_entries.length > 0 ? 18 : 0,
        }}
      >
        <Button onClick={reset}>Cancel</Button>
        <Gap />
        <Button
          disabled={disabled}
          onClick={() => void add_selected()}
          type="primary"
        >
          <Icon name="user-plus" /> {label}
        </Button>
      </div>
    );
  }

  function render_invite_result(): React.JSX.Element | undefined {
    if (
      state != "invited" &&
      state != "invited_manual" &&
      state != "invited_errors"
    ) {
      return;
    }
    if (state === "invited_manual" && manual_invite_links.length > 0) {
      return render_manual_invite_result();
    }
    return (
      <Alert
        style={{ margin: "8px 0" }}
        showIcon
        closable
        onClose={reset}
        type={
          state == "invited_errors"
            ? "error"
            : state == "invited_manual"
              ? "success"
              : "success"
        }
        message={
          state == "invited_manual"
            ? "Invitation link created"
            : state == "invited_errors"
              ? "Invitation failed"
              : "Invitation created"
        }
        description={render_invite_result_description()}
      />
    );
  }

  function render_manual_invite_result(): React.JSX.Element {
    return (
      <div
        style={{
          background: COLORS.BLUE_LLLL,
          border: `1px solid ${COLORS.BLUE_LLL}`,
          borderRadius: 12,
          margin: "10px 0",
          padding: 16,
        }}
      >
        <div
          style={{
            alignItems: "flex-start",
            display: "flex",
            gap: 12,
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: COLORS.BLUE_D,
              borderRadius: "50%",
              color: COLORS.GRAY_LLL,
              display: "flex",
              flex: "0 0 34px",
              height: 34,
              justifyContent: "center",
              width: 34,
            }}
          >
            <Icon name="link" />
          </div>
          <div style={{ minWidth: 0, width: "100%" }}>
            <div
              style={{
                color: COLORS.BLUE_DDD,
                fontSize: 16,
                fontWeight: 700,
                marginBottom: 4,
              }}
            >
              Invitation link created
            </div>
            <div style={{ color: COLORS.GRAY_D, marginBottom: 14 }}>
              Send this link through email, Canvas, Slack, chat, or another
              trusted channel.
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {manual_invite_links.map((entry, index) => (
                <div key={`${entry.email_address}:${index}`}>
                  <div
                    style={{
                      color: COLORS.GRAY_DD,
                      fontWeight: 600,
                      marginBottom: 6,
                    }}
                  >
                    {entry.email_address}
                  </div>
                  {entry.invite_urls.map((url) => (
                    <div
                      key={url}
                      style={{
                        alignItems: "center",
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <Input
                        readOnly
                        style={{
                          flex: "1 1 320px",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          minWidth: 0,
                        }}
                        value={url}
                      />
                      <Button
                        onClick={() => {
                          void navigator.clipboard.writeText(url);
                          alert_message({
                            type: "success",
                            message: "Invite link copied.",
                          });
                        }}
                        type="primary"
                      >
                        <Icon name="copy" /> Copy
                      </Button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div
              style={{
                alignItems: "flex-start",
                background: COLORS.BLUE_LLLL,
                borderRadius: 8,
                color: COLORS.BLUE_DDD,
                display: "flex",
                gap: 8,
                marginTop: 14,
                padding: "10px 12px",
              }}
            >
              <Icon name="lock" style={{ marginTop: 2 }} />
              <div>
                <b>Security note:</b> anyone with this invite link can accept it
                until it expires or is revoked. You can revoke pending
                invitations below.
              </div>
            </div>
          </div>
          <Button
            onClick={reset}
            style={{ flex: "0 0 auto" }}
            title="Dismiss"
            type="text"
          >
            <Icon name="times" />
          </Button>
        </div>
      </div>
    );
  }

  function render_invite_result_description(): React.JSX.Element {
    return (
      <div style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
        {invite_result}
      </div>
    );
  }

  if (student.disableCollaborators || accountCustomize?.disableCollaborators) {
    return <div></div>;
  }

  return (
    <div
      style={isFlyout ? { paddingLeft: "5px", paddingRight: "5px" } : undefined}
    >
      {err && <ErrorDisplay error={err} onClose={() => set_err("")} />}
      {state == "searching" && <Loading />}
      {render_select_list()}
      {render_send_email()}
      {render_invite_result()}
    </div>
  );
};
