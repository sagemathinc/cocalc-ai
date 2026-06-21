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
requirement. If a student switches classes or sections and has already bought a
sufficient membership, they can usually keep using it without purchasing
another membership.

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

export const COURSE_RESTRICT_STUDENT_PROJECTS_BODY = String.raw`
## What this panel controls

**Restrict Student Projects** writes a
\`student_project_functionality\` policy into each student project's course
metadata. The CoCalc frontend reads that policy and hides or disables matching
UI features inside student projects.

These options are useful for exams, guided labs, and courses where students
should focus on a narrow set of tools. They are not a hard security boundary:
students may still have other ways to communicate, copy data, or use tools
outside CoCalc.

## When the settings take effect

After changing options, save the panel and reconfigure student projects. New
student projects get the current policy when they are created. Existing student
projects get the policy when course configuration is pushed to them, for
example by **Reconfigure all projects** or other course maintenance actions.

## File and upload restrictions

- **Disable file actions** hides or disables common file-management actions in
  the file browser, such as delete, download, copy, move, publish, and related
  context-menu actions. It also disables drag-and-drop file reordering where
  that would otherwise expose file actions.
- **Disable file uploads** disables the Upload button and drag-and-drop upload
  paths in the project file UI.

These settings are meant to reduce accidental or casual use of those actions.
They do not rewrite assignments or make files cryptographically immutable.

## Notebook and server restrictions

- **Disable toggling whether cells are editable or deletable** disables
  notebook UI that lets students change Jupyter cell editability/deletability.
  It also disables the raw JSON editor and Jupyter command-list dialog.
- **Disable Jupyter Classic notebook server** hides the Jupyter Classic server
  launcher for student projects.
- **Disable JupyterLab notebook server** hides the JupyterLab launcher.
- **Disable VS Code IDE Server** hides the VS Code server launcher.
- **Disable Pluto Julia notebook server** hides the Pluto launcher.
- **Disable R IDE Server** hides the R IDE launcher.

The server-launcher options matter because external IDEs and notebook servers
can have their own file browsers, download tools, terminals, or editing
interfaces outside the main CoCalc course UI.

## Terminal and collaborator restrictions

- **Disable command line terminal** disables opening terminal sessions from the
  main project UI and flyouts.
- **Disable adding or removing collaborators** removes the collaborators UI for
  student projects. Students should not be able to use the standard project UI
  to add other people or remove course staff.

The course still manages student-project collaborators during reconfiguration:
students, instructors, and TAs are kept in sync based on the course roster and
the collaborators on the instructor project.

## AI restrictions

- **Disable all AI integration** hides CoCalc AI features in the student
  project.
- **Disable some AI integration** keeps limited help such as explain, hint, and
  chat replies, but disables stronger "complete the work for me" style actions
  such as solution-oriented Help Me Fix flows.

These AI settings are course UI policy. They do not stop a student from using
an external AI tool in another browser tab.
`;

export const COURSE_SHARED_PROJECT_BODY = String.raw`
## What the shared project is

A course shared project is one ordinary CoCalc project that is shared with the
whole course. Students, instructors, and TAs all get write access to the same
project.

It is separate from each student's private course project. Use it when students
should collaborate in a common workspace instead of each working in their own
copy.

## What happens when you create it

When you click **Create shared project**, CoCalc creates a new project with a
course-specific title and description, saves its project id in the course
settings, and configures collaborators.

The collaborator set is kept as:

- all collaborators on the instructor project that contains the course file
- all students in the course who have CoCalc accounts

Whenever the course is reopened or reconfigured, CoCalc tries to add missing
course staff and students to the shared project. If the course is configured to
disallow arbitrary extra collaborators, reconfiguration also removes people who
are not course staff or students.

## What gets synchronized

The shared project receives course metadata of type \`shared\`. Course datastore
configuration and environment variables are pushed to it so shared-project
software can see the same course-level settings that student projects see.

Student-project restrictions do not apply to the shared project. The shared
project is intentionally collaborative and writable by everyone in the course.

## Why it is useful

Use a shared project for:

- live in-class labs where everybody edits or runs code together
- a course-wide chat or scratch workspace
- shared datasets, examples, or notebooks students should experiment with
- demonstrations where students should see the same running files

Do not use it for private student submissions, grades, or work that must remain
separate by student. Use assignments and student projects for that.

## Resource planning

The shared project is a real project. If many students use it at once, it may
need enough CPU, RAM, disk, and network capacity for the class activity. After
creating it, consider assigning an appropriate membership, pay-as-you-go
resources, or project host placement before class starts.
`;

export const COURSE_STUDENT_PROJECT_ROOTFS_BODY = String.raw`
## What this setting controls

**Student Project RootFS Image** controls the base software image used by
student projects. The RootFS image is the visible \`/\` filesystem and provides
system packages, language runtimes, command line tools, and other managed
software.

By default, new student projects follow the RootFS image configured on the
instructor project that contains the course file. Set an override only when the
course should force a specific managed image for student projects.

## New student projects

When a new student project is created, the course copies the current course
RootFS choice into that project:

- if no override is saved, the student project follows the instructor
  project's current RootFS image
- if an override is saved, the student project uses the selected managed image
  and image id

This makes it possible to prepare a course against a known software stack and
avoid per-student environment drift.

## Existing student projects

Existing student projects do not change automatically just because you save a
new RootFS choice. Use **Apply To Existing Student Projects...** when you are
ready to roll the image out to already-created projects.

Applying to existing projects updates each student project's RootFS image. Any
student project that is currently running is restarted so the new image takes
effect immediately.

## Data safety

Changing the RootFS changes the managed base filesystem. It is appropriate for
course software, installed packages, system libraries, and base image updates.

Important student data should live in persistent project storage such as
\`/root\`. Treat \`/tmp\` as temporary workspace storage. Do not ask students to
store important work only in paths that belong to the base RootFS image.

## Image selection

The selector shows managed RootFS catalog entries. It hides older versions by
default, but you can show older versions when you need to pin a course to a
previous image. Hidden or blocked catalog entries are not offered for new
selection.

If the course is already configured to use an image that is no longer visible
in the catalog, the panel warns you. Save a new selection to move the course to
a current managed image.
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
