/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Input, Row, Space, Spin, Tag } from "antd";
import { CSSProperties, ReactNode, useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { useActions } from "@cocalc/frontend/app-framework";
import { Icon, Markdown, Tip } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import { labels } from "@cocalc/frontend/i18n";
import { NotebookScores } from "@cocalc/frontend/jupyter/nbgrader/autograde";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { COLORS } from "@cocalc/util/theme";
import { BigTime } from ".";
import { CourseActions } from "../actions";
import { NbgraderScores } from "../nbgrader/scores";
import {
  AssignmentRecord,
  LastCopyInfo,
  NBgraderRunInfo,
  StudentRecord,
} from "../store";
import { AssignmentCopyType } from "../types";
import { useButtonSize } from "../util";
import { STEP_NAMES, Steps, STEPS_INTL, STEPS_INTL_ACTIVE } from "./consts";

interface StudentAssignmentInfoProps {
  name: string;
  course_project_id?: string;
  title: ReactNode;
  student: StudentRecord;
  assignment: AssignmentRecord;
  grade?: string;
  comments?: string;
  info: {
    assignment_id: string;
    student_id: string;
    peer_assignment: boolean;
    peer_collect: boolean;
    last_assignment?: LastCopyInfo;
    last_collect?: LastCopyInfo;
    last_peer_assignment?: LastCopyInfo;
    last_peer_collect?: LastCopyInfo;
    last_return_graded?: LastCopyInfo;
  };
  nbgrader_scores?: { [ipynb: string]: NotebookScores | string };
  nbgrader_score_ids?: { [ipynb: string]: string[] };
  is_editing: boolean;
  nbgrader_run_info?: NBgraderRunInfo;
}

interface RenderLastProps {
  step: Steps;
  type: AssignmentCopyType;
  data?: any;
  enable_copy?: boolean;
  copy_tip?: string;
  open_tip?: string;
  omit_errors?: boolean;
}

type StageState = "waiting" | "ready" | "running" | "done" | "error";

const RECOPY_INIT: Record<Steps, false> = {
  Assign: false,
  Collect: false,
  "Peer Assign": false,
  Return: false,
  "Peer Collect": false,
} as const;

function useRecopy(): [
  typeof RECOPY_INIT,
  (key: Steps, value: boolean) => void,
] {
  const [recopy, set_recopy] = useState<typeof RECOPY_INIT>(RECOPY_INIT);
  function set(key: Steps, value: boolean) {
    set_recopy({ ...recopy, [key]: value });
  }
  return [recopy, set];
}

export function StudentAssignmentInfo({
  name,
  course_project_id,
  title,
  student,
  assignment,
  grade = "",
  comments = "",
  info,
  nbgrader_scores,
  nbgrader_score_ids,
  is_editing,
  nbgrader_run_info,
}: StudentAssignmentInfoProps) {
  const intl = useIntl();
  const clicked_nbgrader = useRef<Date | undefined>(undefined);
  const actions = useActions<CourseActions>({ name });
  const size = useButtonSize();
  const [recopy, set_recopy] = useRecopy();
  const [commentDraft, setCommentDraft] = useState(comments || "");
  const assignment_id = assignment.get("assignment_id");
  const student_id = student.get("student_id");
  const uploadPath = `.course/feedback/${assignment_id}/${student_id}`;

  useEffect(() => {
    if (!is_editing) {
      setCommentDraft(comments || "");
    }
  }, [comments, is_editing]);

  function open(
    type: AssignmentCopyType,
    assignment_id: string,
    student_id: string,
  ) {
    return actions.assignments.open_assignment(type, assignment_id, student_id);
  }

  function copy(
    type: AssignmentCopyType,
    assignment_id: string,
    student_id: string,
  ) {
    return actions.assignments.copy_assignment(type, assignment_id, student_id);
  }

  function stop(
    type: AssignmentCopyType,
    assignment_id: string,
    student_id: string,
  ) {
    actions.assignments.stop_copying_assignment(
      assignment_id,
      student_id,
      type,
    );
  }

  function set_edited_feedback() {
    actions.assignments.update_edited_feedback(
      assignment.get("assignment_id"),
      student.get("student_id"),
    );
  }

  function stop_editing() {
    actions.assignments.clear_edited_feedback(assignment_id, student_id);
  }

  function save_grade(value: string) {
    actions.assignments.set_grade(assignment_id, student_id, value);
  }

  function save_comment(value: string) {
    actions.assignments.set_comment(assignment_id, student_id, value);
  }

  function render_grade() {
    if (is_editing) {
      return (
        <Input
          placeholder="Grade..."
          defaultValue={grade || ""}
          onBlur={(event) => save_grade(event.target.value)}
          onPressEnter={(event) => {
            save_grade(event.currentTarget.value);
            stop_editing();
          }}
          size={size}
          spellCheck={false}
          style={{
            margin: "5px 0",
            maxWidth: 240,
            minWidth: 110,
            width: "100%",
          }}
          autoFocus
        />
      );
    } else {
      const text = intl.formatMessage(
        {
          id: "course.student-assignment-info.grade.label",
          defaultMessage: `{show, select, true {Grade: {grade}} other {Enter grade...}}`,
          description: "Grade of an assignment in an online course",
        },
        { grade, show: !!((grade ?? "").trim() || (comments ?? "").trim()) },
      );

      return (
        <Button
          key="edit"
          onClick={() => set_edited_feedback()}
          disabled={is_editing}
          size={size}
          style={{
            maxWidth: "100%",
            minWidth: 110,
            overflow: "hidden",
            textAlign: "left",
            textOverflow: "ellipsis",
          }}
        >
          {text}
        </Button>
      );
    }
  }

  function render_comments() {
    if (!is_editing) {
      if (!comments?.trim()) return;
      return (
        <div style={{ width: "100%", paddingRight: "5px" }}>
          <Markdown
            value={comments}
            style={{
              width: "100%",
              maxHeight: "4em",
              overflowY: "auto",
              padding: "5px",
              border: `1px solid ${COLORS.GRAY_L}`,
              borderRadius: 4,
              cursor: "pointer",
              display: "inline-block",
            }}
            onClick={() => set_edited_feedback()}
          />
        </div>
      );
    } else {
      return (
        <MarkdownInput
          cacheId={`course-grade-comment-${assignment_id}-${student_id}`}
          project_id={course_project_id}
          path={uploadPath}
          defaultMode="markdown"
          placeholder="Optional markdown comments..."
          value={commentDraft}
          onChange={setCommentDraft}
          onBlur={() => save_comment(commentDraft)}
          onShiftEnter={(value) => {
            save_comment(value);
            stop_editing();
          }}
          height="auto"
          autoGrow
          autoGrowMinHeight={120}
          autoGrowMaxHeight={320}
          enableUpload={course_project_id != null}
          hideHelp
          modeSwitchPlacement="toolbar"
          saveDebounceMs={0}
          style={{ width: "100%" }}
        />
      );
    }
  }

  function render_nbgrader_scores() {
    if (!nbgrader_scores) return;
    return (
      <div>
        <NbgraderScores
          show_all={is_editing}
          set_show_all={() => set_edited_feedback()}
          nbgrader_scores={nbgrader_scores}
          nbgrader_score_ids={nbgrader_score_ids}
          name={name}
          student_id={student.get("student_id")}
          assignment_id={assignment.get("assignment_id")}
        />
        {render_run_nbgrader("Run nbgrader again")}
      </div>
    );
  }

  function render_run_nbgrader(label: React.JSX.Element | string) {
    let running = false;
    if (nbgrader_run_info != null) {
      const t = nbgrader_run_info.get(
        assignment.get("assignment_id") + "-" + student.get("student_id"),
      );
      if (t && webapp_client.server_time() - t <= 1000 * 60 * 10) {
        // Time starting is set and it's also within the last few minutes.
        // This "few minutes" is just in case -- we probably shouldn't need
        // that at all ever, but it could make cocalc state usable in case of
        // weird issues, I guess).  User could also just close and re-open
        // the course file, which resets this state completely.
        running = true;
      }
    }
    label = running ? (
      <span>
        {" "}
        <Spin /> Running nbgrader
      </span>
    ) : (
      <span>{label}</span>
    );

    return (
      <div style={{ marginTop: "5px" }}>
        <Button
          key="nbgrader"
          disabled={running}
          size={size}
          onClick={() => {
            if (
              clicked_nbgrader.current != null &&
              webapp_client.server_time() -
                clicked_nbgrader.current.valueOf() <=
                3000
            ) {
              // User *just* clicked, and we want to avoid double click
              // running nbgrader twice.
              return;
            }

            clicked_nbgrader.current = new Date();
            actions.assignments.run_nbgrader_for_one_student(
              assignment.get("assignment_id"),
              student.get("student_id"),
            );
          }}
        >
          <Icon name="graduation-cap" /> {label}
        </Button>
      </div>
    );
  }

  function render_nbgrader() {
    if (nbgrader_scores) {
      return render_nbgrader_scores();
    }
    if (!assignment.get("nbgrader") || assignment.get("skip_grading")) return;

    return render_run_nbgrader("Run nbgrader");
  }

  function render_save_button() {
    if (!is_editing) return;
    return (
      <Button key="save" size={size} onClick={() => stop_editing()}>
        Save
      </Button>
    );
  }

  function render_last_time(time?: string | number | Date) {
    return (
      <div
        key="time"
        style={{
          color: COLORS.GRAY_M,
          fontSize: 12,
          lineHeight: "14px",
          minHeight: 14,
        }}
      >
        {time != null ? <BigTime date={time} /> : null}
      </div>
    );
  }

  function render_open_recopy_confirm(
    step: Steps,
    copy: Function,
    copy_tip: string,
    placement,
  ) {
    if (recopy[step]) {
      const v: React.JSX.Element[] = [];
      v.push(
        <Button
          key="copy_cancel"
          size={size}
          onClick={() => set_recopy(step, false)}
        >
          {intl.formatMessage(labels.cancel)}
        </Button>,
      );
      v.push(
        <Button
          key="recopy_confirm"
          danger
          size={size}
          onClick={() => {
            set_recopy(step, false);
            copy();
          }}
        >
          <Icon
            name="share-square"
            rotate={step.indexOf("ollect") !== -1 ? "180" : undefined}
          />{" "}
          <FormattedMessage
            id="course.student-assignment-info.recopy_confirm.label"
            defaultMessage={`Yes, {activity} again`}
            description={"Confirm an activity, like 'assign', 'collect', ..."}
            values={{ activity: step_intl(step, false).toLowerCase() }}
          />
        </Button>,
      );
      if (step.toLowerCase() === "assign") {
        // inline-block because buttons above are float:left
        v.push(
          <div
            key="what-happens"
            style={{ margin: "5px", display: "inline-block" }}
          >
            <a target="_blank" href="/app-docs/teaching/create-assignment">
              {intl.formatMessage({
                id: "course.student-assignment-info.recopy.what_happens",
                defaultMessage: "What happens when I assign again?",
                description:
                  "Asking the question, what happens if all files are transferred to all students in an online course once again.",
              })}
            </a>
          </div>,
        );
      }
      return <Space wrap>{v}</Space>;
    } else {
      return (
        <Button
          key="copy"
          type="dashed"
          size={size}
          onClick={() => set_recopy(step, true)}
        >
          <Tip title={step} placement={placement} tip={<span>{copy_tip}</span>}>
            <Icon
              name="share-square"
              rotate={step.indexOf("ollect") !== -1 ? "180" : undefined}
            />{" "}
            {step_intl(step, false)}...
          </Tip>
        </Button>
      );
    }
  }

  function render_open_recopy(
    step: Steps,
    open,
    copy,
    copy_tip: string,
    open_tip: string,
  ) {
    const placement = step === "Return" ? "left" : "right";
    return (
      <Space key="open_recopy" wrap size={[6, 6]}>
        {render_open_recopy_confirm(step, copy, copy_tip, placement)}
        <Button key="open" size={size} onClick={open}>
          <Tip title="Open assignment" placement={placement} tip={open_tip}>
            <Icon name="folder-open" /> {intl.formatMessage(labels.open)}
          </Tip>
        </Button>
      </Space>
    );
  }

  function step_intl(step: Steps, active: boolean): string {
    return intl.formatMessage(active ? STEPS_INTL_ACTIVE : STEPS_INTL, {
      step: STEP_NAMES.indexOf(step),
    });
  }

  function render_open_copying(step: Steps, open, stop) {
    return (
      <Space key="open_copying" wrap>
        <Button key="copy" disabled={true} size={size}>
          <Spin /> {step_intl(step, true)}
        </Button>
        <Button key="stop" danger onClick={stop} size={size}>
          {intl.formatMessage(labels.cancel)} <Icon name="times" />
        </Button>
        <Button key="open" onClick={open} size={size}>
          <Icon name="folder-open" /> {intl.formatMessage(labels.open)}
        </Button>
      </Space>
    );
  }

  function render_copy(step: Steps, copy: () => void, copy_tip: string) {
    let placement;
    if (step === "Return") {
      placement = "left";
    }
    return (
      <Tip key="copy" title={step} tip={copy_tip} placement={placement}>
        <Button onClick={copy} size={size}>
          <Icon
            name="share-square"
            rotate={step.indexOf("ollect") !== -1 ? "180" : undefined}
          />{" "}
          {step_intl(step, false)}
        </Button>
      </Tip>
    );
  }

  function render_error(step: Steps, error) {
    if (typeof error !== "string") {
      error = `${error}`;
    }
    if (error.includes("[object Object]")) {
      // already too late to know the actual error -- it got mangled/reported incorrectly
      error = "";
    }
    // We search for two different error messages, since different errors happen in
    // Project-host versus local deployments. This depends on what is doing the copy.
    if (
      error.indexOf("No such file or directory") !== -1 ||
      error.indexOf("ENOENT") != -1
    ) {
      error = `The student might have renamed or deleted the directory that contained their assignment.  Open their project and see what happened.   If they renamed it, you could rename it back, then collect the assignment again -- \n${error}`;
    } else {
      error = `Try to ${step.toLowerCase()} again -- \n${error}`;
    }
    return (
      <ShowError
        key="error"
        error={error}
        style={{
          marginTop: "5px",
          maxHeight: "140px",
          overflow: "auto",
          display: "block",
        }}
      />
    );
  }

  function stage_state(data: LastCopyInfo, enable_copy: boolean): StageState {
    if (data.error) return "error";
    if (webapp_client.server_time() - (data.start ?? 0) < 15_000) {
      return "running";
    }
    if (data.time) return "done";
    return enable_copy ? "ready" : "waiting";
  }

  function render_stage_tag(state: StageState) {
    switch (state) {
      case "done":
        return <Tag color="success">Done</Tag>;
      case "error":
        return <Tag color="error">Error</Tag>;
      case "running":
        return <Tag color="processing">Working</Tag>;
      case "ready":
        return <Tag color="blue">Ready</Tag>;
      case "waiting":
        return <Tag>Waiting</Tag>;
    }
  }

  function stage_card_style(state: StageState): CSSProperties {
    const borderColor =
      state === "done"
        ? COLORS.BS_GREEN
        : state === "error"
          ? COLORS.BS_RED
          : state === "running" || state === "ready"
            ? COLORS.ANTD_LINK_BLUE
            : COLORS.GRAY_L;
    const background =
      state === "done"
        ? COLORS.BS_GREEN_LL
        : state === "error"
          ? COLORS.ANTD_BG_RED_L
          : state === "running"
            ? COLORS.YELL_LLL
            : state === "ready"
              ? COLORS.ANTD_BG_BLUE_L
              : COLORS.GRAY_LLL;
    return {
      background,
      border: `1px solid ${borderColor}`,
      borderRadius: 6,
      minHeight: 92,
      padding: 8,
      display: "flex",
      flexDirection: "column",
      gap: 6,
      width: "100%",
    };
  }

  const workflowColStyle: CSSProperties = {
    display: "flex",
    paddingRight: 8,
  };

  const workflowCardContentStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  };

  function Status({
    step,
    type,
    data = {},
    enable_copy = false,
    copy_tip = "",
    open_tip = "",
    omit_errors = false,
  }: RenderLastProps): React.JSX.Element {
    const do_open = () => open(type, info.assignment_id, info.student_id);
    const do_copy = () => copy(type, info.assignment_id, info.student_id);
    const do_stop = () => stop(type, info.assignment_id, info.student_id);
    const state = stage_state(data, enable_copy);
    const v: React.JSX.Element[] = [];
    if (enable_copy) {
      if (state === "running") {
        v.push(render_open_copying(step, do_open, do_stop));
      } else if (data.time) {
        v.push(
          render_open_recopy(
            step,
            do_open,
            do_copy,
            copy_tip as string,
            open_tip as string,
          ),
        );
      } else {
        v.push(render_copy(step, do_copy, copy_tip as string));
      }
    }
    return (
      <div style={stage_card_style(state)}>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 6,
            justifyContent: "space-between",
          }}
        >
          <span style={{ color: COLORS.GRAY_D, fontWeight: 600 }}>
            {step_intl(step, false)}
          </span>
          {render_stage_tag(state)}
        </div>
        {v.length > 0 ? (
          <div style={workflowCardContentStyle}>
            {v}
            {render_last_time(data.time)}
            {data.error && !omit_errors ? render_error(step, data.error) : null}
          </div>
        ) : (
          <div style={workflowCardContentStyle}>
            <span style={{ color: COLORS.GRAY_M, fontSize: 12 }}>
              Waiting for the previous stage.
            </span>
            {render_last_time(data.time)}
            {data.error && !omit_errors ? render_error(step, data.error) : null}
          </div>
        )}
      </div>
    );
  }

  let show_grade_col, show_return_graded;
  const peer_grade: boolean = !!assignment.getIn(["peer_grade", "enabled"]);
  const skip_grading: boolean = !!assignment.get("skip_grading");
  const skip_assignment: boolean = !!assignment.get("skip_assignment");
  const skip_collect: boolean = !!assignment.get("skip_collect");
  if (peer_grade) {
    show_grade_col = !skip_grading && info.last_peer_collect;
    show_return_graded = grade || (skip_grading && info.last_peer_collect);
  } else {
    show_grade_col = (!skip_grading && info.last_collect) || skip_collect;
    show_return_graded =
      grade ||
      (skip_grading && info.last_collect) ||
      (skip_grading && skip_collect);
  }

  const width = peer_grade ? 4 : 6;

  function render_assignment_col() {
    return (
      <Col md={width} key="last_assignment" style={workflowColStyle}>
        <Status
          step="Assign"
          data={info.last_assignment}
          type="assigned"
          enable_copy={true}
          copy_tip={intl.formatMessage({
            id: "course.student-assignment-info.assignment_col.copy.tooltip",
            defaultMessage: `Copy the assignment from your project to this student's project so they can do their homework.`,
            description: "files of a student in an online course",
          })}
          open_tip={intl.formatMessage({
            id: "course.student-assignment-info.assignment_col.open.tooltip",
            defaultMessage: `Open the student's copy of this assignment directly in their project.
              You will be able to see them type, chat with them, leave them hints, etc.`,
            description: "files of a student in an online course",
          })}
          omit_errors={skip_assignment}
        />
      </Col>
    );
  }

  function render_collect_col() {
    return (
      <Col md={width} key="last_collect" style={workflowColStyle}>
        {skip_assignment ||
        !(info.last_assignment != null
          ? info.last_assignment.error
          : undefined) ? (
          <Status
            step="Collect"
            data={info.last_collect}
            type="collected"
            enable_copy={info.last_assignment != null || skip_assignment}
            copy_tip={intl.formatMessage({
              id: "course.student-assignment-info.collect_col.copy.tooltip",
              defaultMessage:
                "Copy the assignment from your student's project back to your project so you can grade their work.",
              description: "files of a student in an online course",
            })}
            open_tip={intl.formatMessage({
              id: "course.student-assignment-info.collect_col.open.tooltip",
              defaultMessage:
                "Open the copy of your student's work in your own project, so that you can grade their work.",
              description: "files of a student in an online course",
            })}
            omit_errors={skip_collect}
          />
        ) : undefined}
      </Col>
    );
  }

  function render_peer_assign_col() {
    if (!peer_grade) return;
    if (!info.peer_assignment) return;
    if (info.last_collect?.error != null) return;
    return (
      <Col md={4} key="peer_assign" style={workflowColStyle}>
        <Status
          step="Peer Assign"
          data={info.last_peer_assignment}
          type={"peer-assigned"}
          enable_copy={info.last_collect != null}
          copy_tip={intl.formatMessage({
            id: "course.student-assignment-info.peer_assign_col.copy.tooltip",
            defaultMessage:
              "Copy collected assignments from your project to this student's project so they can grade them.",
            description: "files of a student in an online course",
          })}
          open_tip={intl.formatMessage({
            id: "course.student-assignment-info.peer_assign_col.open.tooltip",
            defaultMessage:
              "Open the student's copies of this assignment directly in their project, so you can see what they are peer grading.",
            description: "files of a student in an online course",
          })}
        />
      </Col>
    );
  }

  function render_peer_collect_col() {
    if (!peer_grade) return;
    if (!info.peer_collect) return;
    return (
      <Col md={4} key="peer_collect" style={workflowColStyle}>
        <Status
          step="Peer Collect"
          data={info.last_peer_collect}
          type="peer-collected"
          enable_copy={info.last_peer_assignment != null}
          copy_tip={intl.formatMessage({
            id: "course.student-assignment-info.peer_collect_col.copy.tooltip",
            defaultMessage:
              "Copy the peer-graded assignments from various student projects back to your project so you can assign their official grade.",
            description: "files of a student in an online course",
          })}
          open_tip={intl.formatMessage({
            id: "course.student-assignment-info.peer_collect_col.open.tooltip",
            defaultMessage:
              "Open your copy of your student's peer grading work in your own project, so that you can grade their work.",

            description: "files of a student in an online course",
          })}
        />
      </Col>
    );
  }

  function render_grade_col() {
    //      {render_enter_grade()}
    return (
      <Col
        md={width}
        key="grade"
        style={{ ...workflowColStyle, minWidth: 240, paddingRight: 12 }}
      >
        {show_grade_col && (
          <div
            style={{
              background: is_editing ? COLORS.ANTD_BG_BLUE_L : COLORS.GRAY_LLL,
              border: `1px solid ${
                is_editing ? COLORS.ANTD_LINK_BLUE : COLORS.GRAY_L
              }`,
              borderRadius: 6,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minHeight: 92,
              padding: 8,
              width: "100%",
            }}
          >
            <div
              style={{
                alignItems: "center",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span style={{ color: COLORS.GRAY_D, fontWeight: 600 }}>
                Grade & Feedback
              </span>
              <Tag color={grade || comments ? "success" : "blue"}>
                {grade || comments ? "Recorded" : "Ready"}
              </Tag>
            </div>
            {render_save_button()}
            {render_grade()}
            {render_comments()}
            {render_nbgrader()}
            {render_last_time()}
          </div>
        )}
      </Col>
    );
  }

  function render_return_graded_col() {
    return (
      <Col md={width} key="return_graded" style={workflowColStyle}>
        {show_return_graded ? (
          <Status
            step="Return"
            data={info.last_return_graded}
            type="graded"
            enable_copy={info.last_collect != null || skip_collect}
            copy_tip={intl.formatMessage({
              id: "course.student-assignment-info.graded_col.copy.tooltip",
              defaultMessage: `Copy the graded assignment back to your student's project.`,
              description: "files of a student in an online course",
            })}
            open_tip={intl.formatMessage({
              id: "course.student-assignment-info.graded_col.open.tooltip",
              defaultMessage: `Open the copy of your student's work that you returned to them.
                  This opens the returned assignment directly in their project.`,
              description: "the files of a student in an online course",
            })}
          />
        ) : undefined}
      </Col>
    );
  }

  return (
    <div>
      <Row
        style={{
          borderTop: `1px solid ${COLORS.GRAY_L}`,
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <Col md={4} key="title" style={{ paddingRight: 12 }}>
          <div
            style={{
              color: COLORS.GRAY_D,
              fontWeight: 600,
              overflowWrap: "anywhere",
              paddingTop: 8,
            }}
          >
            {title}
          </div>
        </Col>
        <Col md={20} key="rest">
          <Row>
            {render_assignment_col()}
            {render_collect_col()}
            {render_peer_assign_col()}
            {render_peer_collect_col()}
            {render_grade_col()}
            {render_return_graded_col()}
          </Row>
        </Col>
      </Row>
    </div>
  );
}
