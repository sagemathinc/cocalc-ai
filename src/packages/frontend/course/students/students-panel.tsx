import { UI_COLORS } from "@cocalc/util/appearance-palette";
/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Col, Input, Row } from "antd";
import { Set } from "immutable";
import { isEqual } from "lodash";
import { useEffect, useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  AppRedux,
  useRedux,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Gap, Icon, Tip } from "@cocalc/frontend/components";
import ScrollableList from "@cocalc/frontend/components/scrollable-list";
import { course, labels } from "@cocalc/frontend/i18n";
import { useProjectRunQuotaPrefetch } from "@cocalc/frontend/project/use-project-run-quota";
import { ProjectMap, UserMap } from "@cocalc/frontend/todo-types";
import type {
  CoursePaymentOverview,
  CourseStudentPaymentStatus,
} from "@cocalc/conat/hub/api/projects";
import { search_match, search_split } from "@cocalc/util/misc";
import type { CourseActions } from "../actions";
import {
  getCourseMembershipPackage,
  isMembershipPackageCurrentlyActive,
} from "../membership-packages";
import { getCoursePaymentOverview } from "../payment-api";
import {
  AssignmentsMap,
  IsGradingMap,
  NBgraderRunInfo,
  SortDescription,
  StudentRecord,
  StudentsMap,
} from "../store";
import * as util from "../util";
import { ManageSeats } from "./manage-seats";
import { Student, StudentNameDescription } from "./students-panel-student";

interface StudentsPanelReactProps {
  frame_id?: string; // used for state caching
  actions: CourseActions;
  name: string;
  redux: AppRedux;
  project_id: string;
  students: StudentsMap;
  user_map: UserMap;
  project_map: ProjectMap;
  assignments: AssignmentsMap;
  frameActions;
}

interface StudentList {
  students: any[];
  num_omitted: number;
  num_deleted: number;
}

export function StudentsPanel({
  actions,
  frame_id,
  name,
  redux,
  project_id,
  students,
  user_map,
  project_map,
  assignments,
  frameActions,
}: StudentsPanelReactProps) {
  const intl = useIntl();

  const expanded_students: Set<string> | undefined = useRedux(
    name,
    "expanded_students",
  );
  const active_student_sort: SortDescription | undefined = useRedux(
    name,
    "active_student_sort",
  );
  const active_feedback_edits: IsGradingMap = useRedux(
    name,
    "active_feedback_edits",
  );
  const nbgrader_run_info: NBgraderRunInfo | undefined = useRedux(
    name,
    "nbgrader_run_info",
  );
  const assignmentFilter = useRedux(name, "assignmentFilter");
  const pageFilter = useRedux(name, "pageFilter");
  const settings = useRedux(name, "settings");
  const filter = pageFilter?.get("students") ?? "";
  const setFilter = (filter: string) => {
    actions.setPageFilter("students", filter);
  };
  const institutePay = !!settings?.get("institute_pay");
  const studentPay = !!settings?.get("student_pay");
  const paymentEnabled = institutePay || studentPay;
  const currentAccountId = useTypedRedux("account", "account_id");
  const isAdmin = !!useTypedRedux("account", "is_admin");
  const [coursePaymentOverview, setCoursePaymentOverview] =
    useState<CoursePaymentOverview>();
  const [coursePaymentError, setCoursePaymentError] = useState<string>("");
  const manageSeatsOpen = !!useRedux(name, "manage_seats_open");
  const setManageSeatsOpen = (open: boolean) => {
    actions.set_manage_seats_open(open);
  };

  // the type is copy/paste from what TS infers in the util.parse_students function
  const [students_unordered, set_students_unordered] = useState<
    {
      create_project?: number;
      account_id?: string;
      student_id: string;
      display_name?: string;
      first_name?: string;
      last_name?: string;
      last_active?: number;
      hosting?: string;
      email_address?: string;
      project_id?: string;
      deleted?: boolean;
      deleted_account?: boolean;
      note?: string;
      last_email_invite?: number;
    }[]
  >([]);
  const [show_deleted, set_show_deleted] = useState<boolean>(false);
  const studentProjectIds = useMemo(
    () =>
      students
        .valueSeq()
        .map((student) => student.get("project_id"))
        .toArray()
        .filter(
          (studentProjectId): studentProjectId is string =>
            typeof studentProjectId === "string",
        ),
    [students],
  );
  const studentProjectIdsKey = studentProjectIds.join(",");
  const runQuotaVersion = useProjectRunQuotaPrefetch(studentProjectIds);

  async function refreshCoursePaymentOverview() {
    try {
      setCoursePaymentError("");
      const overview = await getCoursePaymentOverview({
        course_project_id: project_id,
        student_project_ids: studentProjectIds,
      });
      setCoursePaymentOverview(overview);
      if (overview.package_errors.length > 0) {
        setCoursePaymentError(
          `Unable to load ${overview.package_errors.length} course manager seat package${overview.package_errors.length === 1 ? "" : "s"}.`,
        );
      }
    } catch (err) {
      setCoursePaymentError(`${err}`);
    }
  }

  // this updates a JS list from the ever changing user_map immutableMap
  useEffect(() => {
    const v = util.parse_students(students, user_map, redux, intl);
    if (!isEqual(v, students_unordered)) {
      set_students_unordered(v);
    }
  }, [students, user_map, runQuotaVersion]);

  useEffect(() => {
    if (!paymentEnabled) {
      setCoursePaymentOverview(undefined);
      return;
    }
    refreshCoursePaymentOverview();
  }, [paymentEnabled, project_id, studentProjectIdsKey]);

  const coursePackages = useMemo(
    () => coursePaymentOverview?.packages ?? [],
    [coursePaymentOverview],
  );
  const coursePackage = useMemo(() => {
    const ownedPackages = coursePackages.filter(
      (membershipPackage) =>
        membershipPackage.owner_account_id === currentAccountId,
    );
    const selected = getCourseMembershipPackage(
      ownedPackages.length > 0 || !isAdmin ? ownedPackages : coursePackages,
      project_id,
    );
    return isMembershipPackageCurrentlyActive(selected) ? selected : undefined;
  }, [coursePackages, currentAccountId, isAdmin, project_id]);
  const paymentStatusByProject = useMemo(
    () =>
      new Map<string, CourseStudentPaymentStatus>(
        (coursePaymentOverview?.students ?? []).map((status) => [
          status.project_id,
          status,
        ]),
      ),
    [coursePaymentOverview],
  );

  // student_list not a list, but has one, plus some extra info.
  const student_list: StudentList = useMemo(() => {
    // turn map of students into a list
    // account_id     : "bed84c9e-98e0-494f-99a1-ad9203f752cb" # Student's CoCalc account ID
    // email_address  : "4@student.com"                        # Email the instructor signed the student up with.
    // display_name   : "Rachel Florence"                      # Student's name
    // first_name     : "Rachel"                               # Derived from display_name for legacy columns
    // last_name      : "Florence"                             # Derived from display_name for legacy columns
    // project_id     : "6bea25c7-da96-4e92-aa50-46ebee1994ca" # Student's project ID for this course
    // student_id     : "920bdad2-9c3a-40ab-b5c0-eb0b3979e212" # Student's id for this course
    // last_active    : 2357025
    // create_project : number -- server timestamp of when create started
    // deleted        : False
    // note           : "Is younger sister of Abby Florence (TA)"

    const students_ordered = [...students_unordered];

    if (active_student_sort != null) {
      students_ordered.sort(
        util.pick_student_sorter(active_student_sort.toJS()),
      );
    }

    // Deleted and non-deleted students
    const deleted: any[] = [];
    const non_deleted: any[] = [];
    for (const x of students_ordered) {
      if (x.deleted) {
        deleted.push(x);
      } else {
        non_deleted.push(x);
      }
    }
    const num_deleted = deleted.length;

    const students_shown = show_deleted
      ? non_deleted.concat(deleted) // show deleted ones at the end...
      : non_deleted;

    let num_omitted = 0;
    const students_next = (function () {
      if (filter) {
        const words = search_split(filter.toLowerCase());
        const students_filtered: any[] = [];
        for (const x of students_shown) {
          const target = [
            x.display_name ?? "",
            x.first_name ?? "",
            x.last_name ?? "",
            x.email_address ?? "",
          ]
            .join(" ")
            .toLowerCase();
          if (search_match(target, words)) {
            students_filtered.push(x);
          } else {
            num_omitted += 1;
          }
        }
        return students_filtered;
      } else {
        return students_shown;
      }
    })();

    return { students: students_next, num_omitted, num_deleted };
  }, [students, students_unordered, show_deleted, filter, active_student_sort]);

  function render_header(num_omitted) {
    // TODO: get rid of all of the bootstrap form crap below.  I'm basically
    // using inline styles to undo the spacing screwups they cause, so it doesn't
    // look like total crap.

    return (
      <div>
        <Row align="middle" gutter={[8, 8]} style={{ marginBottom: 10 }}>
          <Col flex="none">
            <Button
              type="primary"
              onClick={() => frameActions.setModal("add-students")}
            >
              <Icon name="user-plus" /> Add Students
            </Button>
          </Col>
          {institutePay && (
            <Col flex="none">
              <Button onClick={() => setManageSeatsOpen(true)}>
                <Icon name="users" /> Manage seats
              </Button>
            </Col>
          )}
          <Col flex="320px">
            <Input.Search
              allowClear
              placeholder={intl.formatMessage({
                id: "course.students-panel.filter_students.placeholder",
                defaultMessage: "Filter existing students...",
              })}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </Col>
          <Col flex="auto">
            {num_omitted ? (
              <span style={{ color: UI_COLORS.text }}>
                {intl.formatMessage(
                  {
                    id: "course.students-panel.filter_students.info",
                    defaultMessage: "(Omitting {num_omitted} students)",
                  },
                  { num_omitted },
                )}
              </span>
            ) : undefined}
          </Col>
        </Row>
      </div>
    );
  }

  function render_sort_icon(column_name: string) {
    if (
      active_student_sort == null ||
      active_student_sort.get("column_name") != column_name
    )
      return;
    return (
      <Icon
        style={{ marginRight: "10px" }}
        name={
          active_student_sort.get("is_descending") ? "caret-up" : "caret-down"
        }
      />
    );
  }

  function render_sort_link(column_name: string, display_name: string) {
    return (
      <a
        href=""
        onClick={(e) => {
          e.preventDefault();
          actions.students.set_active_student_sort(column_name);
        }}
      >
        {display_name}
        <Gap />
        {render_sort_icon(column_name)}
      </a>
    );
  }

  function render_student_table_header(num_deleted: number) {
    // HACK: that marginRight is to get things to line up with students.
    const firstName = intl.formatMessage(labels.account_first_name);
    const lastName = intl.formatMessage(labels.account_last_name);
    const lastActive = intl.formatMessage(labels.last_active);
    const projectStatus = intl.formatMessage(labels.project_status);
    const emailAddress = intl.formatMessage(labels.email_address);

    return (
      <div>
        <Row style={{ marginRight: 0 }}>
          <Col md={paymentEnabled ? 5 : 6}>
            <div style={{ display: "inline-block", width: "50%" }}>
              {render_sort_link("first_name", firstName)}
            </div>
            <div style={{ display: "inline-block" }}>
              {render_sort_link("last_name", lastName)}
            </div>
          </Col>
          <Col md={4}>{render_sort_link("email", emailAddress)}</Col>
          <Col md={paymentEnabled ? 6 : 8}>
            {render_sort_link("last_active", lastActive)}
          </Col>
          {paymentEnabled && <Col md={4}>Paid seat</Col>}
          <Col md={3}>{render_sort_link("hosting", projectStatus)}</Col>
          <Col md={paymentEnabled ? 2 : 3}>
            {num_deleted ? render_show_deleted(num_deleted) : undefined}
          </Col>
        </Row>
      </div>
    );
  }

  function get_student(id: string): StudentRecord {
    const student = students.get(id);
    if (student == null) {
      console.warn(`Tried to access undefined student ${id}`);
    }
    return student as StudentRecord;
  }

  function render_student(student_id: string, index: number) {
    const x = student_list.students[index];
    if (x == null) return null;
    const store = actions.get_store();
    if (store == null) return null;
    const studentName: StudentNameDescription = {
      full: store.get_student_name(x.student_id),
      display: x.display_name ?? "",
    };
    const student = get_student(student_id);
    if (student == null) {
      // temporary and better than crashing
      return null;
    }
    return (
      <Student
        background={index % 2 === 0 ? UI_COLORS.inset : undefined}
        key={student_id}
        student_id={student_id}
        student={student}
        user_map={user_map}
        redux={redux}
        name={name}
        project_map={project_map}
        assignments={assignments}
        is_expanded={expanded_students?.has(student_id) ?? false}
        student_name={studentName}
        display_account_name={true}
        active_feedback_edits={active_feedback_edits}
        nbgrader_run_info={nbgrader_run_info}
        assignmentFilter={assignmentFilter?.get(student_id)}
        coursePackage={coursePackage}
        coursePackages={coursePackages}
        refreshCoursePackage={refreshCoursePaymentOverview}
        paymentMode={institutePay ? "institute" : studentPay ? "student" : null}
        paymentStatus={
          x.project_id ? paymentStatusByProject.get(x.project_id) : undefined
        }
        currentAccountId={currentAccountId}
        isAdmin={isAdmin}
        onManageSeats={() => setManageSeatsOpen(true)}
      />
    );
  }

  function render_students(students) {
    if (students.length == 0) {
      return render_no_students();
    }
    return (
      <>
        {coursePaymentError && (
          <Alert
            type="error"
            style={{ marginBottom: "15px" }}
            title={coursePaymentError}
          />
        )}
        {institutePay && (
          <Alert
            type={coursePackages.length > 0 ? "info" : "warning"}
            showIcon
            style={{ marginBottom: 12 }}
            title={
              coursePackages.length > 0
                ? `${coursePackages.length} seat package${coursePackages.length === 1 ? " is" : "s are"} linked to this course`
                : "No seat package is linked to this course"
            }
            description={
              coursePackages.length > 0
                ? `${coursePackages.reduce((sum, membershipPackage) => sum + membershipPackage.active_assignment_count, 0)} assigned or reserved of ${coursePackages.reduce((sum, membershipPackage) => sum + membershipPackage.seat_count, 0)} purchased seats. Use Manage seats to inspect package ownership and change assignments.`
                : "Purchase seats in the course payment configuration, then assign them here."
            }
            action={
              <Button size="small" onClick={() => setManageSeatsOpen(true)}>
                Manage seats
              </Button>
            }
          />
        )}
        <ScrollableList
          virtualize
          rowCount={students.length}
          rowRenderer={({ key, index }) => render_student(key, index)}
          rowKey={(index) =>
            students[index] != null ? students[index].student_id : undefined
          }
          cacheId={`course-student-${name}-${frame_id}`}
        />
      </>
    );
  }

  function render_no_students() {
    return (
      <div>
        <Alert
          type="info"
          style={{
            margin: "15px auto",
            fontSize: "12pt",
            maxWidth: "800px",
          }}
          title={
            <b>
              <a onClick={() => frameActions.setModal("add-students")}>
                <FormattedMessage
                  id="course.students-panel.no_students.title"
                  defaultMessage="Add Students to your Course"
                />
              </a>
            </b>
          }
          description={
            <div>
              <FormattedMessage
                id="course.students-panel.no_students.descr"
                defaultMessage={`<A>Add some students</A> by pasting their email addresses or roster.
                    CoCalc will create student projects and secure invite links.`}
                values={{
                  A: (c) => (
                    <a onClick={() => frameActions.setModal("add-students")}>
                      {c}
                    </a>
                  ),
                }}
              />
            </div>
          }
        />
      </div>
    );
  }

  function render_show_deleted(num_deleted: number) {
    if (show_deleted) {
      return (
        <a onClick={() => set_show_deleted(false)}>
          <Tip
            placement="left"
            title="Hide deleted"
            tip={intl.formatMessage(course.show_deleted_students_tooltip, {
              show: false,
            })}
          >
            {intl.formatMessage(course.show_deleted_students_msg, {
              num_deleted,
              show: false,
            })}
          </Tip>
        </a>
      );
    } else {
      return (
        <a
          onClick={() => {
            set_show_deleted(true);
            setFilter("");
          }}
        >
          <Tip
            placement="left"
            title="Show deleted"
            tip={intl.formatMessage(course.show_deleted_students_tooltip, {
              show: true,
            })}
          >
            {intl.formatMessage(course.show_deleted_students_msg, {
              num_deleted,
              show: true,
            })}
          </Tip>
        </a>
      );
    }
  }

  function render_student_info(students, num_deleted) {
    /* The "|| num_deleted > 0" below is because we show
      header even if no non-deleted students if there are deleted
      students, since it's important to show the link to show
      deleted students if there are any. */
    return (
      <div className="smc-vfill">
        {students.length > 0 || num_deleted > 0
          ? render_student_table_header(num_deleted)
          : undefined}
        {render_students(students)}
      </div>
    );
  }

  {
    const { students, num_omitted, num_deleted } = student_list;
    return (
      <div className="smc-vfill" style={{ margin: "0" }}>
        {render_header(num_omitted)}
        {render_student_info(students, num_deleted)}
        <ManageSeats
          open={manageSeatsOpen}
          onClose={() => setManageSeatsOpen(false)}
          courseProjectId={project_id}
          courseTitle={coursePaymentOverview?.course_title ?? ""}
          coursePath={actions.get_store()?.get("course_filename") ?? ""}
          packages={coursePackages}
          students={students_unordered.filter((student) => !student.deleted)}
          currentAccountId={currentAccountId}
          isAdmin={isAdmin}
          ownerName={(account_id) =>
            redux.getStore("users")?.get_name(account_id)?.trim() || account_id
          }
          onRefresh={refreshCoursePaymentOverview}
        />
      </div>
    );
  }
}
