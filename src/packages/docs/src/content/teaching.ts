/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const COURSE_ASSIGNMENT_BODY = String.raw`
## What CoCalc assignments are for

CoCalc courses distribute computational work into student projects. Students do
not need a separate submission step: instructors assign files, students work in
their projects, and instructors collect the results.

## Create an assignment

1. Open a course file.
2. Add or select students.
3. Create an assignment from files in the instructor project.
4. Assign it to student projects.
5. Collect, grade, return, or peer grade as needed.

For notebooks, use nbgrader when you need automated grading cells and structured
feedback.

## What makes this different from an LMS

Canvas and Moodle organize course communication, calendars, and grades. CoCalc
organizes live computational work: notebooks, terminals, LaTeX, code, datasets,
software environments, realtime help, and TimeTravel.

## Why this matters in CoCalc

Instructors can see what students are doing, help in realtime, recover mistakes,
configure a shared runtime image, and run a course where the computational
environment is part of the assignment instead of a prerequisite.
`;

export const COURSE_WORKFLOW_BODY = String.raw`
## What courses are for

CoCalc courses manage computational classes where files, notebooks, terminals,
software environments, realtime help, and grading all live in student projects.
The course file is the instructor control center; student work happens in
ordinary CoCalc projects.

Use courses when students need to run code, write notebooks, edit LaTeX, submit
files, receive feedback, or get help in the same environment where the work
runs.

## Core workflow

1. Create a course file in an instructor project.
2. Add students or invite them by email.
3. Prepare assignment files in the instructor project.
4. Assign files into student projects.
5. Monitor progress, answer questions, and open student work when needed.
6. Collect, grade, return, or peer grade the assignment.

For the assignment-specific flow, see
[Create a course assignment](/docs/teaching/create-assignment).

## Student projects

Each student gets a project for course work. That project can contain notebooks,
scripts, terminals, data, output, and chat. Instructors can open student
projects to help, inspect files, use TimeTravel, or run grading workflows.

When the class needs a shared software stack, use a runtime image or project
host setup that every student project can run. This avoids per-student package
installation drift.

## Grading

Use ordinary collect/grade/return workflows for file-based assignments. Use
[nbgrader](/docs/teaching/nbgrader) when notebooks need autograded cells,
hidden tests, structured feedback, or a more formal grading pipeline.

## Operational advice

Test assignments in a student-style project before releasing them. Keep starter
files small, put large datasets in a durable shared location, and make setup
steps reproducible. For large classes, choose project hosts and runtime images
that match the expected memory, disk, and package needs.
`;

export const COURSE_STUDENT_PAY_BODY = String.raw`
## What student pay is

Student pay lets an instructor require a course membership for each student
project. Students can join the course during a grace period, then purchase the
course membership when payment is required.

This is a course access workflow, not a general billing page. Configure it in
the course file under **Course Payment Options**.

## Payment choices

Each course has one payment mode:

1. **Student pays directly**. Each student buys the selected course membership.
2. **Institute or instructor pays directly**. The instructor buys course seats
   for students instead of making students pay individually.
3. **Site license**. A matching institutional site license covers students when
   one is available. If no matching site license is found, students can still
   pay directly or the instructor can buy seats.

When a matching site license is available, CoCalc selects it by default. When
there is no matching site license, student pay is the default.

## Choose the required membership

Select the membership tier students need for the course. The course membership
tier determines:

- the student price
- how long the course membership lasts
- the grace period length
- the project resources and limits students receive

If a student already has an active membership whose tier priority is at least
the required course tier, they do not need to buy the course membership. This
means one sufficiently high membership can cover multiple courses at the same
time, and a student's own higher-tier membership can satisfy the course
requirement.

## Set the course start date

The grace period is counted from the course start date. Set this to the first
day students should have full access.

Do not rely on the day you configure the course as the start date. Instructors
often prepare courses days or weeks before students start working, so the start
date must be explicit.

## What students see

During the grace period, students see a warning banner in their course project.
They can dismiss it and continue working.

After the grace period ends, the student project shows a payment-required page
with a purchase button. This is meant as a frontend course workflow gate, not as
a hard security or abuse boundary.

After a student buys the course membership, or claims a matching site license,
the project becomes active again.

## Instructor-paid seats

Use **Institute or instructor pays directly** when students should not enter
payment information themselves. The instructor buys a course seat package for
the selected membership tier and assigns seats to students.

This is useful for workshops, institutional courses, and settings where payment
is handled outside the student account.

## Site licenses

A site license is an institution-managed membership pool. CoCalc can use it for
course access when the instructor's verified email domain and the license terms
match the selected course membership.

If the course UI says no matching site license is found, it usually means one
of the following:

- the instructor email address is not verified
- the verified email domain does not match the site license
- the site license has no appropriate membership tier or available seats
- there is no site license for this institution

Students can still use student pay or instructor-paid seats when a site license
is not available.

## Operational checklist

Before inviting students:

1. Select the required course membership tier.
2. Set the course start date.
3. Confirm the grace period shown in the panel.
4. Choose student pay, instructor pay, or site license.
5. Add one test student and verify what that student sees.
6. If students will pay directly, test the purchase flow before class starts.
`;

export const NBGRADER_BODY = String.raw`
## What nbgrader is for

nbgrader is a Jupyter-based grading workflow for notebook assignments. It lets
instructors create notebooks with graded cells, tests, hidden tests, feedback,
and scores, then autograde submitted notebooks.

Use nbgrader when the assignment is naturally a notebook and needs structured
grading. Use normal CoCalc collect/grade/return when the work is file-based,
manual, or not organized around notebook cells.

## Use nbgrader in a course

1. Enable nbgrader in the course configuration.
2. Create an instructor version of the notebook with graded cells and tests.
3. Assign the notebook to students.
4. Let students complete the notebook in their projects.
5. Collect submissions.
6. Autograde, inspect results, adjust feedback, and return grades.

Run a small test assignment first. nbgrader depends on notebook metadata, so
editing cells carelessly or copying content through tools that drop metadata can
break grading.

## Resource planning

Autograding runs code. It can use significant CPU, RAM, disk, and time,
especially for large classes or heavy notebooks. Tune the parallel grading
limit based on the host where grading runs and the expected memory per
submission.

If grading frequently hits memory limits, reduce parallelism, simplify tests,
or move grading to a host with more RAM. For the memory side of these failures,
see [Low memory and out-of-memory crashes](/docs/troubleshooting/memory).

## Common problems

If cells are not graded, check that the instructor notebook has the expected
nbgrader metadata. If autograding hangs, inspect the exact student notebook and
run the failing cells manually in a fresh kernel. If every submission fails, the
course environment or runtime image probably differs from the environment used
to author the assignment.
`;
