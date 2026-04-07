import { useMemo, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { useProjectCourseInfo } from "@cocalc/frontend/project/use-project-course";
import type { CourseInfo } from "@cocalc/util/db-schema/projects";
import type { PurchaseInfo } from "@cocalc/util/purchases/quota/types";
import dayjs from "dayjs";
import PayNow from "./pay-now";
import PaySoon from "./pay-soon";
import InstructorBanner from "./instructor-banner";
import { DEFAULT_PURCHASE_INFO } from "@cocalc/util/purchases/quota/student-pay";

export default function StudentPayUpgrade({
  project_id,
  style,
}: {
  project_id: string;
  style?;
}) {
  const [open, setOpen] = useState<boolean>(false);
  const { course: courseInfo } = useProjectCourseInfo(project_id);
  const course = useMemo(() => courseInfo?.toJS(), [courseInfo]);
  const account_id = useTypedRedux("account", "account_id");
  const email_address = useTypedRedux("account", "email_address");

  const {
    when,
    paid,
    purchaseInfo,
    student_account_id,
    student_email_address,
  } = useMemo(() => {
    if (course == null) {
      return { when: null, purchaseInfo: null, paid: null };
    }
    if (new Date(course.pay) < new Date("2023-08-01")) {
      // grandfather in all projects from before we switched to the new format,
      // no matter what their status
      return { when: null, purchaseInfo: null, paid: null };
    }

    if (
      course.payInfo?.end != null &&
      new Date(course.payInfo.end) <= new Date()
    ) {
      // no pay requirement after course is over
      return { when: null, purchaseInfo: null, paid: null };
    }

    const purchaseInfo = (course.payInfo ??
      DEFAULT_PURCHASE_INFO) as PurchaseInfo;

    // during the course, required to pay, etc.
    return {
      when: course.pay ? dayjs(course.pay) : null,
      paid: course.paid ? dayjs(course.paid) : null,
      purchaseInfo,
      student_account_id: course.account_id,
      student_email_address: course.email_address,
    };
  }, [course]);

  if (!when) {
    return null;
  }
  let body;
  if (
    account_id == student_account_id ||
    email_address == student_email_address
  ) {
    if (paid) {
      return null;
    }
    if (when <= dayjs()) {
      body = (
        <PayNow
          project_id={project_id}
          when={when}
          purchaseInfo={purchaseInfo}
          open={true}
        />
      );
    } else {
      body = (
        <>
          <PaySoon when={when} purchaseInfo={purchaseInfo} setOpen={setOpen} />
          <PayNow
            open={open}
            setOpen={setOpen}
            project_id={project_id}
            when={when}
            purchaseInfo={purchaseInfo}
          />
        </>
      );
    }
  } else {
    if (course == null) {
      return null;
    }
    const instructorCourse = course as CourseInfo;
    body = (
      <InstructorBanner
        when={when}
        purchaseInfo={purchaseInfo}
        paid={paid}
        course={instructorCourse}
      />
    );
  }
  return <div style={style}>{body}</div>;
}
