/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import {
  Button,
  Card,
  Col,
  Input,
  message as antdMessage,
  Modal,
  Popconfirm,
  Row,
  Space,
  Tag,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { Icon, Text, TimeAgo, Tip, Tooltip } from "@cocalc/frontend/components";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import {
  assignMembershipPackageSeat,
  revokeMembershipPackageSeat,
} from "@cocalc/frontend/purchases/api";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { labels } from "@cocalc/frontend/i18n";
import { ProjectMap, UserMap } from "@cocalc/frontend/todo-types";
import { User } from "@cocalc/frontend/users";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { MembershipPackageDetails } from "@cocalc/conat/hub/api/purchases";
import type { ProjectCollabInviteRow } from "@cocalc/conat/hub/api/projects";
import { search_match, search_split, trunc_middle } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { CourseActions } from "../actions";
import { StudentAssignmentInfo, StudentAssignmentInfoHeader } from "../common";
import { getActiveMembershipPackageAssignmentForAccount } from "../membership-packages";
import {
  AssignmentsMap,
  IsGradingMap,
  NBgraderRunInfo,
  StudentRecord,
} from "../store";
import { RESEND_INVITE_BEFORE } from "../student-projects/actions";
import * as styles from "../styles";
import * as util from "../util";
import { useButtonSize } from "../util";
import DeletedAccount from "./deleted-account";

export interface StudentNameDescription {
  full: string;
  display: string;
}

/*
 Updates based on:
  - Expanded/Collapsed
  - If collapsed: First name, last name, email, last active, hosting type
  - If expanded: Above +, Student's status on all assignments,
*/

interface StudentProps {
  redux: any;
  name: string;
  student: StudentRecord;
  student_id: string;
  user_map: UserMap;
  project_map: ProjectMap; // here entirely to cause an update when project activity happens
  assignments: AssignmentsMap; // here entirely to cause an update when project activity happens
  background?: string;
  is_expanded?: boolean;
  student_name: StudentNameDescription;
  display_account_name?: boolean;
  active_feedback_edits: IsGradingMap;
  nbgrader_run_info?: NBgraderRunInfo;
  assignmentFilter?;
  coursePackage?: MembershipPackageDetails;
  refreshCoursePackage?: () => Promise<void>;
}

export function Student({
  redux,
  name,
  student,
  student_id,
  user_map,
  project_map,
  //assignments,
  background,
  is_expanded,
  student_name,
  display_account_name,
  active_feedback_edits,
  nbgrader_run_info,
  assignmentFilter,
  coursePackage,
  refreshCoursePackage,
}: StudentProps) {
  const intl = useIntl();
  const actions: CourseActions = redux.getActions(name);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const store = actions.get_store();
  if (store == null) throw Error("store must be defined");

  const deletedAccount = !!student.get("deleted_account");
  const hasAccount = student.get("account_id") != null;
  const institutePayEnabled = !!store.getIn(["settings", "institute_pay"]);
  const studentAccountId = student.get("account_id");
  const studentProjectId = student.get("project_id");
  const activeSeatAssignment = useMemo(
    () =>
      getActiveMembershipPackageAssignmentForAccount(
        coursePackage,
        studentAccountId,
      ),
    [coursePackage, studentAccountId],
  );
  const [seatLoading, setSeatLoading] = useState<boolean>(false);
  const [seatError, setSeatError] = useState<string>("");
  const [sendInviteLoading, setSendInviteLoading] = useState<boolean>(false);
  const [copyInviteLoading, setCopyInviteLoading] = useState<boolean>(false);
  const [revokeInviteLoading, setRevokeInviteLoading] =
    useState<boolean>(false);
  const [inviteStatusLoading, setInviteStatusLoading] =
    useState<boolean>(false);
  const [noteDraft, setNoteDraft] = useState<string>(student.get("note") ?? "");
  const [notesOpen, setNotesOpen] = useState<boolean>(false);
  const noteValueRef = useRef<() => string>(() => noteDraft);
  const [courseInvite, setCourseInvite] = useState<
    ProjectCollabInviteRow | undefined
  >();
  const [inviteDetailsOpen, setInviteDetailsOpen] = useState<boolean>(false);
  const acceptedInviteAccountId =
    courseInvite?.status === "accepted"
      ? courseInvite.accepted_account_id
      : undefined;
  const effectiveStudentAccountId =
    studentAccountId ?? acceptedInviteAccountId ?? undefined;
  const hasLinkedAccount = effectiveStudentAccountId != null;

  const size = useButtonSize();

  const [editing_student, set_editing_student] = useState<boolean>(false);
  const [edited_display_name, set_edited_display_name] = useState<string>(
    student_name.display || "",
  );
  const [edited_email_address, set_edited_email_address] = useState<string>(
    student.get("email_address") || "",
  );
  const [more, set_more] = useState<boolean>(false);
  function reset_initial_state() {
    set_editing_student(false);
    set_edited_display_name(student_name.display || "");
    set_edited_email_address(student.get("email_address") || "");
    set_more(false);
    setInviteDetailsOpen(false);
    setNotesOpen(false);
    actions.students.setAssignmentFilter(student_id, "");
  }

  useEffect(() => {
    set_edited_display_name(student_name.display);
  }, [student_name.display]);
  useEffect(() => {
    set_edited_email_address(student.get("email_address") ?? "");
  }, [student.get("email_address")]);
  useEffect(() => {
    setNoteDraft(student.get("note") ?? "");
  }, [student.get("note")]);

  async function refreshCourseInviteStatus(): Promise<void> {
    if (hasAccount || !studentProjectId || !student.get("email_address")) {
      setCourseInvite(undefined);
      return;
    }
    setInviteStatusLoading(true);
    try {
      const invite = await actions.student_projects.get_student_course_invite({
        student_id,
      });
      setCourseInvite(invite);
      if (invite?.status === "accepted" && invite.accepted_account_id != null) {
        actions.set({
          account_id: invite.accepted_account_id,
          deleted_account: false,
          student_id,
          table: "students",
        });
      }
    } catch (_err) {
      // Invite status is helpful, but failure should not break the student row.
      setCourseInvite(undefined);
    } finally {
      setInviteStatusLoading(false);
    }
  }

  useEffect(() => {
    if (!is_expanded) return;
    void refreshCourseInviteStatus();
  }, [
    hasAccount,
    is_expanded,
    student.get("email_address"),
    student.get("last_email_invite"),
    student_id,
    studentProjectId,
  ]);

  function on_key_down(e) {
    switch (e.keyCode) {
      case 13:
        return save_student_changes();
      case 27:
        return cancel_student_edit();
    }
  }

  function toggle_show_more(e) {
    e.preventDefault();
    if (editing_student) {
      cancel_student_edit();
    }
    const item_id = student.get("student_id");
    actions.toggle_item_expansion("student", item_id);
  }

  function render_student() {
    return (
      <a href="" onClick={toggle_show_more}>
        <div style={{ width: "20px", display: "inline-block" }}>
          <Icon
            style={{ marginRight: "10px" }}
            name={is_expanded ? "caret-down" : "caret-right"}
          />
        </div>
        {render_student_name()}
      </a>
    );
  }

  function render_student_name() {
    const account_id = effectiveStudentAccountId;
    if (account_id != null) {
      return (
        <User
          account_id={account_id}
          user_map={user_map}
          name={student_name.full}
          show_original={display_account_name}
        />
      );
    }
    const name = store.get_student_name(student.get("student_id"));
    return (
      <span>
        {name} ({intl.formatMessage(labels.invited)})
      </span>
    );
  }

  function render_student_email() {
    const email = student.get("email_address");
    return (
      <a target={"_blank"} href={`mailto:${email}`} rel={"noopener"}>
        {email}
      </a>
    );
  }

  function open_project() {
    redux.getActions("projects").open_project({
      project_id: student.get("project_id"),
    });
  }

  function create_project() {
    actions.student_projects.create_student_project(student_id);
  }

  function render_last_active() {
    if (deletedAccount) {
      return (
        <DeletedAccount
          actions={actions}
          student_id={student_id}
          name={render_student_name()}
          email_address={student.get("email_address")}
        />
      );
    }
    if (!hasLinkedAccount) {
      return (
        <span style={{ color: COLORS.GRAY_M }}>
          <FormattedMessage
            id="course.students-panel-student.last_active.no_account"
            defaultMessage="(has not created account yet)"
            description="The student in the online course has no account yet"
          />
        </span>
      );
    }
    const student_project_id = student.get("project_id");
    if (student_project_id == null) {
      return;
    }
    const p = project_map.get(student_project_id);
    if (p == null) {
      return;
    }
    const u = p.get("last_active");
    const last_active = u != null ? u.get(effectiveStudentAccountId) : null;
    if (last_active) {
      // student has definitely been active (and we know about this project).
      return (
        <Text type="secondary">
          <FormattedMessage
            id="course.students-panel-student.last_active.time_ago"
            defaultMessage={"(last used project {timeago})"}
            values={{ timeago: <TimeAgo date={last_active} /> }}
          />
        </Text>
      );
    } else {
      return (
        <Text type="secondary">
          <FormattedMessage
            id="course.students-panel-student.last_active.never_used_project"
            defaultMessage={"(has never used project)"}
          />
        </Text>
      );
    }
  }

  function render_hosting() {
    const { description, tip, state, icon } = util.projectStatus(
      student.get("project_id"),
      redux,
      intl,
    );
    return (
      <Tip
        placement="left"
        title={
          <span>
            <Icon name={icon} /> {description}
          </span>
        }
        tip={tip}
      >
        <span style={{ color: COLORS.GRAY_M, cursor: "pointer" }}>
          <Icon name={icon} /> {description}
          {state}
        </span>
      </Tip>
    );
  }

  function render_project_access(): React.JSX.Element {
    // first check if the project is currently being created
    const create = student.get("create_project");
    if (create != null) {
      // if so, how long ago did it start
      const how_long = (webapp_client.server_time() - create) / 1000;
      if (how_long < 120) {
        // less than 2 minutes -- still hope, so render that creating
        return (
          <div>
            <Icon name="cocalc-ring" spin /> Creating project... (started{" "}
            <TimeAgo date={create} />)
          </div>
        );
      }
    }
    // otherwise, maybe user killed file before finished or something and
    // it is lost; give them the chance
    // to attempt creation again by clicking the create button.
    const student_project_id = student.get("project_id");
    if (student_project_id != null) {
      const accessMsg = intl.formatMessage({
        id: "course.student-panel.project_access.access_button",
        defaultMessage: "Open student project",
      });
      return (
        <Button onClick={open_project} size={size}>
          <Tip
            placement="right"
            title={accessMsg}
            tip={intl.formatMessage({
              id: "course.student-panel.project_access.access_button.tooltip",
              defaultMessage: "Open the course project for this student.",
            })}
          >
            <Icon name="edit" /> {accessMsg}
          </Tip>
        </Button>
      );
    } else {
      const createMsg = intl.formatMessage({
        id: "course.student-panel.project_access.create_button",
        defaultMessage: "Create student project",
      });
      return (
        <Tip
          placement="right"
          title={createMsg}
          tip={intl.formatMessage({
            id: "course.student-panel.project_access.create_button.tooltip",
            defaultMessage:
              "Create a new project for this student, then add the student as a collaborator, and also add any collaborators on the project containing this course.",
          })}
        >
          <Button onClick={create_project} size={size}>
            <Icon name="plus-circle" /> {createMsg}
          </Button>
        </Tip>
      );
    }
  }

  function student_changed() {
    return (
      student_name.display !== edited_display_name ||
      student.get("email_address") !== edited_email_address
    );
  }

  function render_edit_student() {
    if (editing_student) {
      const disable_save = !student_changed();
      return (
        <Space>
          <Button onClick={cancel_student_edit} size={size}>
            {intl.formatMessage(labels.cancel)}
          </Button>
          <Button
            onClick={save_student_changes}
            type="primary"
            disabled={disable_save}
            size={size}
          >
            <Icon name="save" /> {intl.formatMessage(labels.save)}
          </Button>
        </Space>
      );
    } else {
      return (
        <Button onClick={show_edit_name_dialogue} size={size}>
          <Icon name="address-card" />{" "}
          <FormattedMessage
            id="course.students-panel-student.edit_student.button"
            defaultMessage="Edit student..."
            description="Button label to open a dialog to modify data about a student in an online course"
          />
        </Button>
      );
    }
  }

  function render_search_assignment() {
    return (
      <Input.Search
        allowClear
        style={{ width: "100%" }}
        placeholder={"Filter assignments..."}
        value={assignmentFilter ?? ""}
        onChange={(e) =>
          actions.students.setAssignmentFilter(student_id, e.target.value)
        }
      />
    );
  }

  function cancel_student_edit() {
    reset_initial_state();
  }

  function save_student_changes() {
    actions.students.set_internal_student_info(student.get("student_id"), {
      display_name: edited_display_name,
      email_address: edited_email_address,
    });

    set_editing_student(false);
  }

  function show_edit_name_dialogue() {
    set_editing_student(true);
  }

  function delete_student(noTrash: boolean) {
    actions.students.delete_student(student.get("student_id"), noTrash);
  }

  function undelete_student() {
    actions.students.undelete_student(student.get("student_id"));
  }

  function render_delete_button() {
    if (!is_expanded) {
      return;
    }
    if (student.get("deleted")) {
      return (
        <Button onClick={undelete_student} size={size}>
          <Icon name="trash" /> {intl.formatMessage(labels.undelete)}
        </Button>
      );
    } else {
      return (
        <Popconfirm
          title={
            <div style={{ maxWidth: "400px" }}>
              <FormattedMessage
                id="course.student-panel.delete-student.confirm"
                defaultMessage={`Are you sure you want to delete "{name}"?
                All grades and other data about them will be removed,
                but you can still undelete them.`}
                values={{ name: render_student_name() }}
              />
            </div>
          }
          onConfirm={() => delete_student(false)}
        >
          <Button size={size}>
            <Icon name="trash" /> {intl.formatMessage(labels.delete)}...
          </Button>
        </Popconfirm>
      );
    }
  }

  function valid_date(value: unknown): Date | undefined {
    if (value == null) return;
    const date = new Date(value as any);
    return Number.isFinite(date.valueOf()) ? date : undefined;
  }

  function render_timeago(value: unknown): React.JSX.Element | undefined {
    const date = valid_date(value);
    return date == null ? undefined : <TimeAgo date={date} />;
  }

  async function copyInviteLink() {
    setCopyInviteLoading(true);
    try {
      const inviteUrl =
        await actions.student_projects.copy_pending_student_invite_link({
          student_id,
        });
      await navigator.clipboard.writeText(inviteUrl);
      void antdMessage.success("Invite link copied.");
    } catch (err) {
      void antdMessage.error(`${err}`);
    } finally {
      setCopyInviteLoading(false);
    }
  }

  async function revokeInviteLink() {
    setRevokeInviteLoading(true);
    try {
      await actions.student_projects.revoke_pending_student_invite_link({
        student_id,
      });
      await refreshCourseInviteStatus();
      void antdMessage.success("Invite link revoked.");
    } catch (err) {
      void antdMessage.error(`${err}`);
    } finally {
      setRevokeInviteLoading(false);
    }
  }

  function getInviteButtonState():
    | {
        disabled: boolean;
        msg: string | React.JSX.Element;
        when: string;
      }
    | undefined {
    if (hasLinkedAccount) return;
    const lastEmailInviteDate = valid_date(student.get("last_email_invite"));
    const hasInvite =
      courseInvite != null || student.get("last_email_invite") != null;
    const canCreateInvite =
      courseInvite?.status !== "accepted" && courseInvite?.status !== "blocked";
    const allowResending =
      lastEmailInviteDate == null || lastEmailInviteDate < RESEND_INVITE_BEFORE;
    const msg = hasInvite
      ? intl.formatMessage(
          {
            id: "course.student-panel.resend_invitation.button",
            defaultMessage: `{allowResending, select, true {Resend invitation} other {Recently invited}}`,
          },
          { allowResending },
        )
      : "Send invitation";
    const when =
      lastEmailInviteDate != null
        ? `Last invite attempt on ${lastEmailInviteDate.toLocaleString()}`
        : "never";
    return {
      disabled:
        !student.get("email_address") || !allowResending || !canCreateInvite,
      msg,
      when,
    };
  }

  async function sendInvite() {
    const email = student.get("email_address");
    if (!email) return;
    setSendInviteLoading(true);
    try {
      const result = await actions.student_projects.invite_student_to_project({
        student: email, // we use email address to trigger sending an actual email!
        student_project_id: student.get("project_id"),
        student_id: student.get("student_id"),
      });
      await refreshCourseInviteStatus();
      if (result?.email_sent) {
        void antdMessage.success("Invitation created and emailed.");
      } else if (result?.manual_delivery_required) {
        void antdMessage.warning(
          "Invitation link created, but email was not sent. Copy the invite link and send it manually.",
          8,
        );
      } else {
        void antdMessage.info(
          "Invitation created. Email delivery was not confirmed; copy the invite link if needed.",
          8,
        );
      }
    } catch (err) {
      void antdMessage.error(`${err}`);
    } finally {
      setSendInviteLoading(false);
    }
  }

  function render_course_invite_status() {
    if (hasAccount) return;
    if (inviteStatusLoading) {
      return (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Checking invite status...
        </Text>
      );
    }
    if (courseInvite == null) {
      const last_email_invite = student.get("last_email_invite");
      if (last_email_invite == null) return;
      const lastEmailInvite = render_timeago(last_email_invite);
      return (
        <Space size={6} wrap>
          <Tag>Invite attempted</Tag>
          {lastEmailInvite && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {lastEmailInvite}
            </Text>
          )}
        </Space>
      );
    }
    const expiresDate = valid_date(courseInvite.expires);
    const isExpiredPendingInvite =
      courseInvite.status === "pending" &&
      expiresDate != null &&
      expiresDate.valueOf() <= Date.now();
    const status = isExpiredPendingInvite ? "expired" : courseInvite.status;
    const color =
      status === "pending"
        ? "processing"
        : status === "accepted"
          ? "success"
          : status === "canceled" || status === "expired"
            ? "default"
            : "warning";
    const label = status === "canceled" ? "revoked" : status;
    const lastSent = render_timeago(courseInvite.last_sent);
    return (
      <Space size={6} wrap>
        <Tag color={color}>Invite {label}</Tag>
        {lastSent ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            emailed {lastSent}
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            email not sent
          </Text>
        )}
        <Button
          size="small"
          type="link"
          style={{ padding: 0, height: "auto" }}
          onClick={() => setInviteDetailsOpen(true)}
        >
          Details
        </Button>
      </Space>
    );
  }

  function render_course_invite_details_modal() {
    if (!courseInvite) return;
    const expiresDate = valid_date(courseInvite.expires);
    const isExpiredPendingInvite =
      courseInvite.status === "pending" &&
      expiresDate != null &&
      expiresDate.valueOf() <= Date.now();
    const status = isExpiredPendingInvite ? "expired" : courseInvite.status;
    const created = render_timeago(courseInvite.created);
    const lastSent = render_timeago(courseInvite.last_sent);
    const expires = render_timeago(courseInvite.expires);
    const canCopyInvite =
      courseInvite.status === "pending" && !isExpiredPendingInvite;
    const canRevokeInvite = courseInvite.status === "pending";
    const inviteButton = getInviteButtonState();
    return (
      <Modal
        open={inviteDetailsOpen}
        title="Course invite details"
        footer={null}
        onCancel={() => setInviteDetailsOpen(false)}
      >
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <div>
            <b>Status:</b> {status === "canceled" ? "revoked" : status}
          </div>
          {courseInvite.target_email && (
            <div>
              <b>Email:</b> {courseInvite.target_email}
            </div>
          )}
          {courseInvite.accepted_account_id && (
            <div>
              <b>Accepted by:</b>{" "}
              <User
                account_id={courseInvite.accepted_account_id}
                user_map={user_map}
              />
            </div>
          )}
          {created && (
            <div>
              <b>Created:</b> {created}
            </div>
          )}
          <div>
            <b>Email:</b> {lastSent ? <>sent {lastSent}</> : "not sent"}
          </div>
          {courseInvite.status === "pending" && expires ? (
            <div>
              <b>Expires:</b> {expires}
            </div>
          ) : undefined}
          {courseInvite.status === "pending" && !courseInvite.last_sent ? (
            <Text type="warning">
              Copy the invite link and send it to the student manually.
            </Text>
          ) : undefined}
          {(inviteButton || canCopyInvite || canRevokeInvite) && (
            <Space size={8} wrap>
              {inviteButton && (
                <Tooltip placement="bottom" title={inviteButton.when}>
                  <Button
                    size={size}
                    loading={sendInviteLoading}
                    disabled={inviteButton.disabled}
                    onClick={() => void sendInvite()}
                  >
                    <Icon name="mail" /> {inviteButton.msg}
                  </Button>
                </Tooltip>
              )}
              {canCopyInvite && (
                <Button
                  size={size}
                  loading={copyInviteLoading}
                  onClick={() => void copyInviteLink()}
                >
                  <Icon name="copy" /> Copy invite link
                </Button>
              )}
              {canRevokeInvite && (
                <Popconfirm
                  title="Revoke this pending course invite link?"
                  description="Anyone with the old link will no longer be able to use it."
                  onConfirm={() => void revokeInviteLink()}
                >
                  <Button size={size} loading={revokeInviteLoading}>
                    Revoke link
                  </Button>
                </Popconfirm>
              )}
            </Space>
          )}
        </Space>
      </Modal>
    );
  }

  function render_resend_invitation() {
    // don't invite student if there is already an account
    if (hasAccount) return;
    if (courseInvite?.status === "accepted") {
      return (
        <div style={{ marginTop: "10px" }}>{render_course_invite_status()}</div>
      );
    }
    const inviteButton = getInviteButtonState();
    if (!inviteButton) return;
    if (courseInvite != null) {
      return (
        <div style={{ marginTop: "10px" }}>{render_course_invite_status()}</div>
      );
    }

    return (
      <Space direction="vertical" size={4}>
        {render_course_invite_status()}
        <Tooltip placement="bottom" title={inviteButton.when}>
          <Button
            size={size}
            onClick={() => void sendInvite()}
            loading={sendInviteLoading}
            disabled={inviteButton.disabled}
          >
            <Icon name="mail" /> {inviteButton.msg}
          </Button>
        </Tooltip>
      </Space>
    );
  }

  function render_title_due(assignment) {
    const date = assignment.get("due_date");
    if (date) {
      return (
        <span>
          (Due <TimeAgo date={date} />)
        </span>
      );
    }
  }

  function render_title(assignment) {
    return (
      <span>
        <em>{trunc_middle(assignment.get("path"), 50)}</em>{" "}
        {render_title_due(assignment)}
      </span>
    );
  }

  function render_assignments_info_rows() {
    const result: any[] = [];
    const terms = search_split(assignmentFilter ?? "");
    // TODO instead of accessing the store, use the state to react to data changes -- that's why we chech in "isSame" above.
    for (const assignment of store.get_sorted_assignments()) {
      if (terms.length > 0) {
        const aPath = assignment.get("path")?.toLowerCase() ?? "";
        if (!search_match(aPath, terms)) continue;
      }
      const grade = store.get_grade(
        assignment.get("assignment_id"),
        student.get("student_id"),
      );
      const comments = store.get_comments(
        assignment.get("assignment_id"),
        student.get("student_id"),
      );
      const info = store.student_assignment_info(
        student.get("student_id"),
        assignment.get("assignment_id"),
      );
      const key = util.assignment_identifier(
        assignment.get("assignment_id"),
        student.get("student_id"),
      );
      const edited_feedback = active_feedback_edits.get(key);
      result.push(
        <StudentAssignmentInfo
          key={assignment.get("assignment_id")}
          title={render_title(assignment)}
          name={name}
          course_project_id={store.get("course_project_id")}
          student={student}
          assignment={assignment}
          grade={grade}
          comments={comments}
          nbgrader_scores={store.get_nbgrader_scores(
            assignment.get("assignment_id"),
            student.get("student_id"),
          )}
          info={info}
          is_editing={!!edited_feedback}
          nbgrader_run_info={nbgrader_run_info}
        />,
      );
    }
    return result;
  }

  function render_assignments_info() {
    const peer_grade = store.any_assignment_uses_peer_grading();
    const header = (
      <StudentAssignmentInfoHeader
        key="header"
        title="Assignment"
        peer_grade={peer_grade}
      />
    );
    return [header, render_assignments_info_rows()];
  }

  function render_note() {
    const title = intl.formatMessage({
      id: "course.students-panel-student.note.title",
      defaultMessage: "Private Student Notes",
      description: "About a student in an online course",
    });
    const tooltipTitle = intl.formatMessage({
      id: "course.students-panel-student.note.tooltip.title",
      defaultMessage: "Notes about this student",
      description: "About a student in an online course",
    });
    const tooltip = intl.formatMessage({
      id: "course.students-panel-student.note.tooltip",
      defaultMessage:
        "Record notes about this student here. These notes are only visible to you, not to the student.  In particular, you might want to include an email address or other identifying information here, and notes about late assignments, excuses, etc.",
      description: "About a student in an online course",
    });
    const placeholder = intl.formatMessage({
      id: "course.students-panel-student.note.placeholder",
      defaultMessage: "Notes about student (not visible to student)",
      description: "About a student in an online course",
    });
    const courseProjectId = store.get("course_project_id");
    const coursePath = store.get("course_filename");
    const noteEditorPath =
      coursePath != null
        ? `${coursePath}.student-notes/${student.get("student_id")}.md`
        : undefined;
    const saveNote = (value = noteValueRef.current?.() ?? noteDraft): void => {
      actions.students.set_student_note(student.get("student_id"), value);
    };
    const noteSummary = noteDraft.trim()
      ? trunc_middle(noteDraft.replace(/\s+/g, " "), 120)
      : "No private notes";
    return (
      <Row key="note" style={{ ...styles.note, marginTop: "14px" }}>
        <Col xs={24}>
          <div
            style={{
              background: COLORS.GRAY_LLL,
              border: `1px solid ${COLORS.GRAY_DDD}`,
              borderRadius: "6px",
              padding: "12px",
            }}
          >
            <div
              style={{
                alignItems: "center",
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "space-between",
                gap: "12px",
              }}
            >
              <Space size={8} wrap>
                <Tip title={tooltipTitle} tip={tooltip}>
                  <b>{title}</b>
                </Tip>
                {!notesOpen && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {noteSummary}
                  </Text>
                )}
              </Space>
              <Space size={8} wrap>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Only visible to instructors
                </Text>
                <Button size="small" onClick={() => setNotesOpen(!notesOpen)}>
                  <Icon name={notesOpen ? "caret-up" : "caret-down"} />{" "}
                  {notesOpen
                    ? "Hide notes"
                    : noteDraft.trim()
                      ? "Show notes"
                      : "Add notes"}
                </Button>
              </Space>
            </div>
            {notesOpen && (
              <div style={{ marginTop: "8px" }}>
                <MarkdownInput
                  autoGrow
                  autoGrowMaxHeight={420}
                  autoGrowMinHeight={140}
                  cacheId={`course-student-note-${name}-${student.get("student_id")}`}
                  defaultMode="markdown"
                  enableUpload={courseProjectId != null}
                  getValueRef={noteValueRef}
                  height="auto"
                  modeSwitchPlacement="toolbar"
                  onBlur={() => saveNote()}
                  onChange={setNoteDraft}
                  onSave={() => saveNote()}
                  onShiftEnter={(value) => saveNote(value)}
                  path={noteEditorPath}
                  placeholder={placeholder}
                  project_id={courseProjectId}
                  value={noteDraft}
                />
              </div>
            )}
          </div>
        </Col>
      </Row>
    );
  }

  function render_more_info() {
    // Info for each assignment about the student.
    return (
      <>
        {render_institute_paid_seat()}
        <Row key="more">
          <Col md={24}>{render_assignments_info()}</Col>
        </Row>
        {render_note()}
        {render_push_missing_handouts_and_assignments()}
      </>
    );
  }

  function render_basic_info() {
    const cellStyle = {
      alignItems: "center",
      display: "flex",
      minHeight: "34px",
    };
    return (
      <Row
        key="basic"
        style={{ alignItems: "center", backgroundColor: background }}
      >
        <Col md={6} style={cellStyle}>
          <h6 style={{ margin: 0 }}>
            {render_student()}
            {render_deleted()}
          </h6>
        </Col>
        <Col md={4} style={cellStyle}>
          <h6 style={{ color: COLORS.GRAY_D, margin: 0, overflow: "hidden" }}>
            {render_student_email()}
          </h6>
        </Col>
        <Col md={8} style={cellStyle}>
          {render_last_active()}
        </Col>
        <Col md={6} style={cellStyle}>
          {render_hosting()}
        </Col>
      </Row>
    );
  }

  function render_push_missing_handouts_and_assignments() {
    const title = intl.formatMessage({
      id: "course.students-panel-student.catch-up.title",
      defaultMessage: "Catch up this student",
      description:
        "Copy all not yet sent files to this student in an online course",
    });
    const tooltip = intl.formatMessage({
      id: "course.students-panel-student.catch-up.tooltip",
      defaultMessage:
        "Copy any assignments and handouts to this student that have been copied to at least one other student",
      description: "Files for a student in an online course",
    });

    return (
      <Row key="catchup" style={{ marginTop: "15px" }}>
        <Col xs={4}>
          <Tip title={title} tip={tooltip}>
            <FormattedMessage
              id="course.students-panel-student.catch-up.info"
              defaultMessage={"Copy missing assignments and handouts"}
            />
          </Tip>
        </Col>
        <Col xs={8}>
          <Button
            onClick={() =>
              actions.students.push_missing_handouts_and_assignments(
                student.get("student_id"),
              )
            }
          >
            <Icon name="share-square" /> {title}
          </Button>
        </Col>
      </Row>
    );
  }

  function render_deleted() {
    if (student.get("deleted")) {
      return <b> (deleted)</b>;
    }
  }

  function render_expanded_student_summary() {
    return (
      <Space size={[8, 6]} wrap>
        <Tag color={hasAccount ? "success" : "processing"}>
          {hasAccount
            ? "Account linked"
            : acceptedInviteAccountId
              ? "Invite accepted"
              : "Invite pending"}
        </Tag>
        <Tag color={studentProjectId ? "blue" : "default"}>
          {studentProjectId ? "Project created" : "No project"}
        </Tag>
        {activeSeatAssignment && <Tag color="green">Paid seat assigned</Tag>}
        {student.get("deleted") && <Tag color="red">Deleted</Tag>}
        <Text type="secondary">{render_student_email()}</Text>
        {!deletedAccount && (
          <Text type="secondary">{render_last_active()}</Text>
        )}
        <Text type="secondary">{render_hosting()}</Text>
      </Space>
    );
  }

  function render_panel_header() {
    // The whiteSpace normal is because the title of an
    // antd Card doesn't wrap, and I don't want to restructure
    // this whole student delete code right now to not put
    // confirmation in the title.  When it is restructured
    // it'll be the antd modal popup anyways...
    // See https://github.com/sagemathinc/cocalc/issues/4286
    return (
      <div style={{ whiteSpace: "normal" }}>
        <div
          style={{
            background: COLORS.GRAY_LLL,
            border: `1px solid ${COLORS.GRAY_L}`,
            borderRadius: 6,
            marginBottom: 10,
            marginTop: 10,
            padding: "8px 10px",
          }}
        >
          {render_expanded_student_summary()}
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 10,
            marginTop: 4,
          }}
        >
          {render_project_access()}
          {render_edit_student()}
          <div style={{ minWidth: 220, width: 280 }}>
            {render_search_assignment()}
          </div>
          {render_resend_invitation()}
          <div style={{ marginLeft: "auto" }}>{render_delete_button()}</div>
        </div>
        {editing_student ? (
          <Row>
            <Col md={8}>{render_edit_student_interface()}</Col>
          </Row>
        ) : undefined}
      </div>
    );
  }

  async function assign_institute_paid_seat() {
    if (!coursePackage || !studentAccountId || !studentProjectId) {
      return;
    }
    setSeatLoading(true);
    setSeatError("");
    try {
      await runFreshAuthAction(async () => {
        await assignMembershipPackageSeat({
          package_id: coursePackage.id,
          target_account_id: studentAccountId,
          metadata: {
            course_project_id: store.get("course_project_id"),
            project_id: studentProjectId,
            student_id,
          },
        });
        await refreshCoursePackage?.();
      });
    } catch (err) {
      setSeatError(`${err}`);
    } finally {
      setSeatLoading(false);
    }
  }

  async function revoke_institute_paid_seat() {
    if (!coursePackage || !studentAccountId) {
      return;
    }
    setSeatLoading(true);
    setSeatError("");
    try {
      await runFreshAuthAction(async () => {
        await revokeMembershipPackageSeat({
          package_id: coursePackage.id,
          target_account_id: studentAccountId,
        });
        await refreshCoursePackage?.();
      });
    } catch (err) {
      setSeatError(`${err}`);
    } finally {
      setSeatLoading(false);
    }
  }

  function render_institute_paid_seat() {
    if (!institutePayEnabled || student.get("deleted")) {
      return;
    }
    let content: React.JSX.Element;
    if (!coursePackage) {
      content = (
        <span style={{ color: COLORS.GRAY_M }}>
          No institute-paid course seats have been purchased yet.
        </span>
      );
    } else if (!hasAccount) {
      content = (
        <span style={{ color: COLORS.GRAY_M }}>
          The student must create a CoCalc account before you can assign a paid
          seat.
        </span>
      );
    } else if (!studentProjectId) {
      content = (
        <span style={{ color: COLORS.GRAY_M }}>
          Create the student project before assigning a paid seat so usage is
          attributed correctly.
        </span>
      );
    } else if (activeSeatAssignment) {
      content = (
        <Space wrap>
          <Tag color="green">Assigned</Tag>
          <Button
            size={size}
            loading={seatLoading}
            onClick={revoke_institute_paid_seat}
          >
            <Icon name="times" /> Revoke paid seat
          </Button>
        </Space>
      );
    } else {
      content = (
        <Space wrap>
          <Tag color="default">Not assigned</Tag>
          <Button
            size={size}
            type="primary"
            loading={seatLoading}
            disabled={coursePackage.available_seat_count <= 0}
            onClick={assign_institute_paid_seat}
          >
            <Icon name="check" /> Assign paid seat
          </Button>
          {coursePackage.available_seat_count <= 0 && (
            <span style={{ color: COLORS.GRAY_M }}>No seats available.</span>
          )}
        </Space>
      );
    }
    return (
      <Row key="membership-seat" style={{ marginBottom: "15px" }}>
        <Col xs={4}>
          <Tip
            title="Institute-paid seat"
            tip="Assign one purchased course seat to this student account."
          >
            Institute-paid seat
          </Tip>
        </Col>
        <Col xs={20}>
          {content}
          {seatError && (
            <div style={{ color: COLORS.FG_RED, marginTop: "8px" }}>
              {seatError}
            </div>
          )}
        </Col>
      </Row>
    );
  }

  function render_edit_student_interface() {
    return (
      <Card style={{ marginTop: "10px" }}>
        <Row>
          <Col md={24}>
            Name
            <Input
              autoFocus
              value={edited_display_name}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              onChange={(e) => set_edited_display_name(e.target.value)}
              onKeyDown={on_key_down}
            />
          </Col>
        </Row>
        <Row>
          <Col md={24}>
            Email Address
            <Input
              type="text"
              value={edited_email_address}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              onChange={(e) =>
                set_edited_email_address((e.target as any).value)
              }
              onKeyDown={on_key_down}
            />
          </Col>
        </Row>
      </Card>
    );
  }

  function render_more_panel() {
    return (
      <Row>
        <Col xs={24}>
          <Card title={render_panel_header()}>{render_more_info()}</Card>
        </Col>
      </Row>
    );
  }

  return (
    <div>
      <Row style={more ? styles.selected_entry : undefined}>
        <Col xs={24}>
          {render_basic_info()}
          {is_expanded ? render_more_panel() : undefined}
        </Col>
      </Row>
      {render_course_invite_details_modal()}
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
