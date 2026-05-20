import type { PublicPolicy } from "./policy";

export const ferpaPolicy: PublicPolicy = {
  description:
    "How CoCalc addresses FERPA-related questions for educational institutions.",
  navLabel: "FERPA",
  slug: "ferpa",
  title: "FERPA Compliance Statement",
  updated: "September 1, 2020",
  content: (
    <>
      <p>
        Educational institutions must take steps to ensure that the companies
        that they work with will help comply with FERPA. FERPA requires that
        reasonable measures be taken to ensure the security of personally
        identifiable information (PII) from student academic records. PII may
        only be shared with a student's instructor or other school officials
        (the school is responsible for responding to parent requests for
        information). Schools and educators are allowed to divulge 'directory
        information', such as name and email address, unless a student has asked
        to opt-out of directory information disclosure, which means that in most
        cases instructors may submit student email addresses when adding
        students to a course.
      </p>
      <p>
        SageMath, Inc. will make every effort to comply with FERPA disclosures
        policies. If you represent an academic institution and require access to
        a student's PII under FERPA, please contact{" "}
        <a href="mailto:office@sagemath.com">office@sagemath.com</a>.
      </p>
    </>
  ),
};

export default ferpaPolicy;
