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
