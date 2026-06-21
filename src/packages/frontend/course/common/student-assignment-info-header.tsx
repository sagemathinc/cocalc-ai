/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Col, Row } from "antd";
import { useIntl } from "react-intl";

import { Tip } from "@cocalc/frontend/components";
import { capitalize, unreachable } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { AssignmentCopyStep } from "../types";
import { course } from "@cocalc/frontend/i18n";

interface StudentAssignmentInfoHeaderProps {
  title: "Assignment" | "Handout" | "Student";
  peer_grade?: boolean;
}

export function StudentAssignmentInfoHeader({
  title,
  peer_grade,
}: StudentAssignmentInfoHeaderProps) {
  const intl = useIntl();

  function tip_title(key: AssignmentCopyStep | "grade"): {
    tip: string;
    title: string;
  } {
    switch (key) {
      case "assignment":
        return {
          title: intl.formatMessage({
            id: "course.student-assignment-info-header.assign.label",
            defaultMessage: "Assign to Student",
            description: "Student in an online course",
          }),
          tip: intl.formatMessage({
            id: "course.student-assignment-info-header.assign.tooltip",
            defaultMessage:
              "This column gives the status of making homework available to students, and lets you copy homework to one student at a time.",
            description: "Student in an online course",
          }),
        };
      case "collect":
        return {
          title: intl.formatMessage({
            id: "course.student-assignment-info-header.collect.label",
            defaultMessage: "Collect from Student",
            description: "Student in an online course",
          }),
          tip: intl.formatMessage({
            id: "course.student-assignment-info-header.collect.tooltip",
            defaultMessage:
              "This column gives status information about collecting homework from students, and lets you collect from one student at a time.",
            description: "Student in an online course",
          }),
        };
      case "grade":
        return {
          title: intl.formatMessage({
            id: "course.student-assignment-info-header.grade.label",
            defaultMessage: "Record Homework Grade",
            description: "For a student in an online course",
          }),
          tip: intl.formatMessage({
            id: "course.student-assignment-info-header.grade.tooltip",
            defaultMessage:
              "Use this column to record the grade the student received on the assignment. Once the grade is recorded, you can return the assignment.  You can also export grades to a file in the Configuration tab.  Enter anything here; it does not have to be a number.",
            description: "For a student in an online course",
          }),
        };
      case "peer_assignment":
        return {
          title: intl.formatMessage({
            id: "course.student-assignment-info-header.peer_assignment.label",
            defaultMessage: "Assign Peer Grading",
            description: "For a group of students in an online course",
          }),
          tip: intl.formatMessage({
            id: "course.student-assignment-info-header.peer_assignment.tooltip",
            defaultMessage:
              "This column gives the status of sending out collected homework to students for peer grading.",
            description: "For a group of students in an online course",
          }),
        };

      case "peer_collect":
        return {
          title: intl.formatMessage({
            id: "course.student-assignment-info-header.peer_collect.label",
            defaultMessage: "Collect Peer Grading",
            description: "For a group of students in an online course",
          }),
          tip: intl.formatMessage({
            id: "course.student-assignment-info-header.peer_collect.tooltip",
            defaultMessage:
              "This column gives status information about collecting the peer grading work that students did, and lets you collect peer grading from one student at a time.",
            description: "For a group of students in an online course",
          }),
        };

      case "return_graded":
        return {
          title: intl.formatMessage({
            id: "course.student-assignment-info-header.return.label",
            defaultMessage: "Return to Student",
            description: "For a student in an online course",
          }),
          tip: intl.formatMessage({
            id: "course.student-assignment-info-header.return.tooltip",
            defaultMessage: "Return to Student",
            description:
              "This column gives status information about when you returned homework to the students.  Once you have entered a grade, you can return the assignment.",
          }),
        };
      default:
        unreachable(key);
    }
    throw new Error(`unknown key: ${key}`);
  }

  function render_col(key: AssignmentCopyStep | "grade", width: 4 | 6) {
    const { tip, title } = tip_title(key);

    return (
      <Col
        md={width}
        key={key}
        style={{ minWidth: 0, overflowX: "hidden", paddingRight: 8 }}
      >
        <Tip title={title} tip={tip}>
          <span
            style={{
              color: COLORS.GRAY_D,
              display: "block",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: 0,
              lineHeight: "15px",
              maxHeight: 30,
              minWidth: 0,
              overflow: "hidden",
              textTransform: "uppercase",
              overflowWrap: "anywhere",
            }}
          >
            {title}
          </span>
        </Tip>
      </Col>
    );
  }

  function render_headers() {
    const w = 6;
    return (
      <Row>
        {render_col("assignment", w)}
        {render_col("collect", w)}
        {render_col("grade", w)}
        {render_col("return_graded", w)}
      </Row>
    );
  }

  function render_headers_peer() {
    const w = 4;
    return (
      <Row>
        {render_col("assignment", w)}
        {render_col("collect", w)}
        {render_col("peer_assignment", w)}
        {render_col("peer_collect", w)}
        {render_col("grade", w)}
        {render_col("return_graded", w)}
      </Row>
    );
  }

  const tooltip = intl.formatMessage(
    {
      id: "course.student-assignment-info-header.row.tooltip",
      defaultMessage: `{key, select,
      Assignment {This column gives the directory name of the assignment.}
      other {This column gives the name of the student.}}`,
      description: "student in an online course",
    },
    { key: title },
  );

  function titleIntl(): string {
    switch (title) {
      case "Assignment":
        return intl.formatMessage(course.assignment);
      case "Handout":
        return intl.formatMessage(course.handout);
      case "Student":
        return intl.formatMessage(course.student);
      default:
        return title;
    }
  }

  return (
    <div>
      <Row
        style={{
          background: COLORS.GRAY_LLL,
          border: `1px solid ${COLORS.GRAY_L}`,
          borderRadius: 6,
          marginBottom: 6,
          padding: "8px 0 8px 0",
        }}
      >
        <Col
          md={4}
          key="title"
          style={{
            minWidth: 0,
            overflowX: "hidden",
            paddingLeft: 10,
            paddingRight: 12,
          }}
        >
          <Tip title={title} tip={tooltip}>
            <span
              style={{
                color: COLORS.GRAY_D,
                display: "block",
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {capitalize(titleIntl())}
            </span>
          </Tip>
        </Col>
        <Col md={20} key="rest" style={{ minWidth: 0, overflowX: "hidden" }}>
          {peer_grade ? render_headers_peer() : render_headers()}
        </Col>
      </Row>
    </div>
  );
}
