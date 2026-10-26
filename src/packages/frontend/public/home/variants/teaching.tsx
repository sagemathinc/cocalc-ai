/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// Home page version "teaching" (util/public-home-experiment.ts): CoCalc for
// instructors of technical courses. The hero is a rendered course view (an
// assignment table beside a grading notebook and an agent's note), so the
// first screen shows the workflow instead of describing it.

import { Button } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PUBLIC_COLORS,
  PUBLIC_DISPLAY_FONT_FAMILY,
} from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const appPath = (path: string) => joinUrlPath(appBasePath, path);

const C = PUBLIC_COLORS;

const CSS = `
.ht { color:${C.text}; font-size:17px; line-height:1.6; }
.ht h1,.ht h2,.ht h3 { font-family:${PUBLIC_DISPLAY_FONT_FAMILY}; color:${C.heading}; margin:0; text-wrap:balance; }
.ht h1 { font-size:clamp(36px,5vw,62px); line-height:1.04; letter-spacing:-.03em; font-weight:650; }
.ht h2 { font-size:clamp(28px,3.2vw,42px); line-height:1.12; letter-spacing:-.02em; font-weight:620; }
.ht h3 { font-size:20px; line-height:1.3; font-weight:600; }
.ht p { margin:0; }
.ht a:focus-visible { outline:3px solid ${C.link}; outline-offset:3px; border-radius:4px; }
.ht-eyebrow { font:600 13px/1.2 ${PUBLIC_DISPLAY_FONT_FAMILY}; letter-spacing:.14em; text-transform:uppercase; color:${C.success}; }
.ht-hero { display:grid; gap:40px; align-items:center; padding:clamp(28px,5vw,64px) 0 8px; }
.ht-copy { display:grid; gap:22px; }
.ht-lead { font-size:19px; max-width:56ch; color:${C.mutedText}; }
.ht-lead strong { color:${C.text}; font-weight:600; }
.ht-actions { display:flex; flex-wrap:wrap; gap:12px; }
.ht-actions .ant-btn { height:auto; min-height:44px; padding:10px 20px; font-size:16px; white-space:normal; }

/* The rendered course view */
.ht-course { border:1px solid ${C.border}; border-radius:14px; background:${C.surface}; overflow:hidden; min-width:0; box-shadow:0 30px 60px -30px color-mix(in srgb, ${C.shadowInk} 45%, transparent), 0 2px 6px color-mix(in srgb, ${C.shadowInk} 8%, transparent); font-size:13.5px; }
.ht-course-head { display:flex; align-items:baseline; gap:10px; padding:12px 16px; border-bottom:1px solid ${C.border}; background:${C.surfaceMuted}; }
.ht-course-head b { font-family:${PUBLIC_DISPLAY_FONT_FAMILY}; font-size:15px; color:${C.heading}; }
.ht-course-head small { color:${C.mutedText}; margin-left:auto; white-space:nowrap; }
.ht-table { width:100%; border-collapse:collapse; }
.ht-table th { text-align:left; font-weight:600; font-size:12px; letter-spacing:.04em; text-transform:uppercase; color:${C.mutedText}; padding:9px 12px; border-bottom:1px solid ${C.border}; }
.ht-table td { padding:10px 12px; border-bottom:1px solid ${C.border}; vertical-align:middle; }
.ht-table td:first-child { font-weight:600; color:${C.heading}; }
.ht-bar { position:relative; height:6px; border-radius:3px; background:${C.surfaceMuted}; min-width:56px; overflow:hidden; }
.ht-bar i { position:absolute; inset:0 auto 0 0; background:${C.success}; border-radius:3px; }
.ht-num { font-variant-numeric:tabular-nums; color:${C.mutedText}; font-size:12px; white-space:nowrap; }
.ht-step { display:grid; gap:4px; }
.ht-lower { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(0,1fr); border-top:1px solid ${C.border}; }
.ht-grade { padding:14px 16px; border-right:1px solid ${C.border}; display:grid; gap:8px; min-width:0; }
.ht-code { font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; background:${C.surfaceMuted}; border:1px solid ${C.border}; border-radius:6px; padding:6px 8px; white-space:pre; overflow:hidden; }
.ht-code .k { color:${C.codeDefinition}; }
.ht-pass { display:flex; gap:8px; align-items:center; font-size:13px; }
.ht-pass b { color:${C.success}; }
.ht-note { padding:14px 16px; background:color-mix(in srgb, ${C.brandTint} 45%, ${C.surface}); display:grid; gap:8px; align-content:start; min-width:0; }
.ht-who { font-size:12px; font-weight:700; color:${C.link}; }
.ht-file { display:inline-block; font:12px ui-monospace,Menlo,monospace; padding:1px 6px; border-radius:4px; background:${C.surface}; border:1px solid ${C.border}; }
.ht-caption { font-size:13px; color:${C.mutedText}; margin-top:10px; text-align:center; }

/* Sections */
.ht-section { margin-top:clamp(64px,8vw,104px); display:grid; gap:28px; }
.ht-head { display:grid; gap:14px; max-width:760px; }
.ht-head p { font-size:18px; color:${C.mutedText}; }
.ht-semester { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:16px; counter-reset:week; }
.ht-semester li { border:1px solid ${C.border}; border-radius:14px; background:${C.surface}; padding:22px; display:grid; gap:8px; align-content:start; counter-increment:week; }
.ht-semester li::before { content:counter(week); width:32px; height:32px; border-radius:50%; display:grid; place-items:center; font:600 15px ${PUBLIC_DISPLAY_FONT_FAMILY}; color:${C.surface}; background:${C.success}; }
.ht-semester p { color:${C.mutedText}; font-size:16px; }
.ht-band { background:${C.heroBackground}; color:#fff; border-radius:20px; padding:clamp(28px,4vw,52px); display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:clamp(24px,4vw,56px); align-items:center; }
.ht-band h2 { color:#fff; }
.ht-band p, .ht-band li { color:rgba(255,255,255,.86); }
.ht-band .ht-eyebrow { color:#ffe2a6; }
.ht-band ul { margin:0; padding-left:20px; display:grid; gap:8px; }
.ht-band figure { margin:0; }
.ht-band img { border-color:rgba(255,255,255,.22); }
.ht-show { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.15fr); gap:clamp(24px,4vw,56px); align-items:center; }
.ht-show-text { display:grid; gap:14px; }
.ht-show-text p { color:${C.mutedText}; }
.ht-show figure { margin:0; }
.ht img { display:block; width:100%; height:auto; border-radius:12px; border:1px solid ${C.border}; box-shadow:0 18px 40px -26px color-mix(in srgb, ${C.shadowInk} 50%, transparent); }
.ht-cards { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
.ht-card { border:1px solid ${C.border}; border-radius:12px; background:${C.surface}; padding:24px; display:grid; gap:10px; align-content:start; }
.ht-card p { color:${C.mutedText}; font-size:16px; }
.ht-link { font-weight:600; }
.ht-final { margin-top:clamp(64px,8vw,104px); border-radius:20px; background:color-mix(in srgb, ${C.success} 10%, ${C.surface}); border:1px solid color-mix(in srgb, ${C.success} 30%, ${C.border}); padding:clamp(24px,4vw,44px); display:grid; grid-template-columns:minmax(0,1fr) auto; gap:24px; align-items:center; }
.ht-final h2 { line-height:1.15; }
.ht-final p { color:${C.mutedText}; margin-top:10px; }
@media (min-width:980px) { .ht-hero { grid-template-columns:minmax(0,1fr) minmax(0,1.1fr); gap:clamp(36px,4vw,64px); } }
@media (max-width:900px) {
  .ht-semester { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .ht-band, .ht-show, .ht-final { grid-template-columns:minmax(0,1fr); }
  .ht-cards { grid-template-columns:minmax(0,1fr); }
}
@media (max-width:620px) {
  .ht-semester { grid-template-columns:minmax(0,1fr); }
  .ht-lower { grid-template-columns:minmax(0,1fr); }
  .ht-grade { border-right:0; border-bottom:1px solid ${C.border}; }
  .ht-table .ht-hide-sm { display:none; }
  .ht-course-head small { display:none; }
  .ht-actions .ant-btn { width:100%; }
  .ht-lead { font-size:18px; }
}
`;

const ASSIGNMENTS = [
  {
    name: "HW 3 · Eigenvalues",
    step: "Returned",
    done: 48,
    graded: "48 graded",
  },
  {
    name: "HW 4 · SVD",
    step: "Grading",
    done: 41,
    graded: "41 of 46 graded",
  },
  {
    name: "Lab 5 · PageRank",
    step: "Collecting",
    done: 22,
    graded: "22 of 48 collected",
  },
  {
    name: "HW 5 · Least squares",
    step: "Draft",
    done: 0,
    graded: "not assigned",
  },
] as const;

const STUDENTS = 48;

function CourseView() {
  return (
    <figure style={{ margin: 0, minWidth: 0 }}>
      <div
        className="ht-course"
        role="img"
        aria-label="Illustration of a CoCalc course: four assignments with their progress from draft to returned, an autograded notebook cell whose tests pass, and a note from Codex that it drafted autograder tests for the next homework for the instructor to review."
      >
        <div className="ht-course-head" aria-hidden="true">
          <b>MATH 241 · Linear Algebra</b>
          <small>{STUDENTS} students · Jupyter, SageMath, LaTeX</small>
        </div>
        <table className="ht-table" aria-hidden="true">
          <thead>
            <tr>
              <th>Assignment</th>
              <th>Status</th>
              <th className="ht-hide-sm">Progress</th>
            </tr>
          </thead>
          <tbody>
            {ASSIGNMENTS.map((a) => (
              <tr key={a.name}>
                <td>{a.name}</td>
                <td>
                  <div className="ht-step">
                    <span>{a.step}</span>
                    <span className="ht-num">{a.graded}</span>
                  </div>
                </td>
                <td className="ht-hide-sm">
                  <div className="ht-bar">
                    <i style={{ width: `${(100 * a.done) / STUDENTS}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ht-lower" aria-hidden="true">
          <div className="ht-grade">
            <span className="ht-who">HW 4 · question 2 (autograded)</span>
            <div className="ht-code">
              <span className="k">assert</span> np.allclose(U @ S @ Vt, A)
              {"\n"}
              <span className="k">assert</span> is_orthogonal(U)
            </div>
            <div className="ht-pass">
              <b>3 / 3</b> points · tests passed
            </div>
          </div>
          <div className="ht-note">
            <span className="ht-who">Codex</span>
            <span>
              Drafted 6 autograder tests for HW 5 in{" "}
              <span className="ht-file">hw5.ipynb</span>. Two cover the
              rank-deficient case. Review them before you assign.
            </span>
          </div>
        </div>
      </div>
      <figcaption className="ht-caption">
        Illustration: a course in CoCalc, with grading and an agent helping the
        instructor.
      </figcaption>
    </figure>
  );
}

const SEMESTER = [
  {
    title: "Set up once",
    body: "Pick the software: Jupyter, SageMath, Python, R, LaTeX. Every student gets the same environment. They need only a browser.",
  },
  {
    title: "Assign",
    body: "Distribute notebooks and handouts to every student's own project, with due dates, from one course file.",
  },
  {
    title: "Help while they work",
    body: "Open a student's project and see the notebook as it is, live. Answer in a chat anchored to the cell.",
  },
  {
    title: "Collect, grade, return",
    body: "Collect every copy, grade by hand or with nbgrader autograding, and return the feedback.",
  },
] as const;

export default function TeachingHome({
  authenticated,
  signUpPath,
  signUpLabel,
}: {
  authenticated: boolean;
  signUpPath: string;
  signUpLabel: string;
}) {
  const primary = authenticated
    ? { href: "projects", label: "Open projects" }
    : { href: signUpPath, label: signUpLabel };
  return (
    <div className="ht">
      <style>{CSS}</style>
      <section className="ht-hero" aria-labelledby="ht-title">
        <div className="ht-copy">
          <span className="ht-eyebrow">For instructors</span>
          <h1 id="ht-title">Teach the math. Skip the IT.</h1>
          <p className="ht-lead">
            Every student gets the same{" "}
            <strong>Jupyter, SageMath, LaTeX, Python and R</strong> environment
            in the browser. You assign, collect, grade and return work in one
            place, and <strong>Codex and Claude Code</strong> help you build the
            materials.
          </p>
          <div className="ht-actions">
            <Button type="primary" size="large" href={appPath(primary.href)}>
              {primary.label}
            </Button>
            <Button size="large" href={appPath("features/teaching")}>
              How teaching works
            </Button>
          </div>
        </div>
        <CourseView />
      </section>

      <section className="ht-section" aria-labelledby="ht-semester">
        <div className="ht-head">
          <span className="ht-eyebrow">A semester in CoCalc</span>
          <h2 id="ht-semester">One course file runs the whole term.</h2>
        </div>
        <ol className="ht-semester">
          {SEMESTER.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="ht-section" aria-labelledby="ht-agents">
        <div className="ht-band">
          <div className="ht-head">
            <span className="ht-eyebrow">Agents for the instructor</span>
            <h2 id="ht-agents">Write the problem set, not the boilerplate.</h2>
            <p>
              Codex and Claude Code work inside your course project, on the same
              files you do:
            </p>
            <ul>
              <li>draft a problem set and its solutions in LaTeX</li>
              <li>check every answer numerically in SageMath</li>
              <li>write nbgrader tests, including the edge cases</li>
              <li>fix the notebook that broke on a new library version</li>
            </ul>
            <p>You review each change, and TimeTravel keeps every version.</p>
          </div>
          <figure>
            <img
              src={appPath("/public/features/latex-formula-agent-20260730.png")}
              width={873}
              height={688}
              alt="The CoCalc LaTeX editor with an agent editing an integral formula step by step beside the source"
              loading="lazy"
              decoding="async"
            />
          </figure>
        </div>
      </section>

      <section className="ht-section" aria-labelledby="ht-grading">
        <div className="ht-show">
          <div className="ht-show-text">
            <span className="ht-eyebrow">Grading</span>
            <h2 id="ht-grading">Autograde the routine. Read the rest.</h2>
            <p>
              Mark notebook cells as autograded answers, tests or manually
              graded work. CoCalc generates the student version, runs the tests
              on collected work and keeps your hidden tests hidden.
            </p>
            <a className="ht-link" href={appPath("features/teaching")}>
              Course management and nbgrader
            </a>
          </div>
          <figure>
            <img
              src={appPath(
                "/public/features/cocalc-jupyter-nbgrader-overview.png",
              )}
              width={1001}
              height={704}
              alt="A Jupyter notebook in CoCalc set up for nbgrader, with cells marked as a manually graded answer, an autograded answer and autograder tests with points"
              loading="lazy"
              decoding="async"
            />
          </figure>
        </div>
      </section>

      <section className="ht-section" aria-labelledby="ht-more">
        <div className="ht-head">
          <h2 id="ht-more">For the whole department.</h2>
        </div>
        <div className="ht-cards">
          <div className="ht-card">
            <h3>Office hours in the notebook</h3>
            <p>
              Students and TAs discuss a specific cell or line, and everyone
              sees the same code and output.
            </p>
            <a className="ht-link" href={appPath("features/jupyter-notebook")}>
              Jupyter in CoCalc
            </a>
          </div>
          <div className="ht-card">
            <h3>Computational exams</h3>
            <p>
              Clean, network-isolated scratchpads for in-person exams, erased
              automatically at the deadline.
            </p>
            <a className="ht-link" href={appPath("features/exam-scratchpads")}>
              Exam scratchpads
            </a>
          </div>
          <div className="ht-card">
            <h3>Lectures that run code</h3>
            <p>
              Slides with math, diagrams and Jupyter cells you can run, in the
              same project as the homework.
            </p>
            <a className="ht-link" href={appPath("features/slides")}>
              Slides
            </a>
          </div>
        </div>
      </section>

      <section className="ht-final" aria-labelledby="ht-final">
        <div>
          <h2 id="ht-final">Set up next term's course this week.</h2>
          <p>Start with one assignment. Your students need only a browser.</p>
        </div>
        <div className="ht-actions">
          <Button type="primary" size="large" href={appPath(primary.href)}>
            {primary.label}
          </Button>
          <Button size="large" href={appPath("pricing")}>
            Compare memberships
          </Button>
        </div>
      </section>
    </div>
  );
}
