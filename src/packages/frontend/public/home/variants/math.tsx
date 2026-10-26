/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// Home page version "math" (util/public-home-experiment.ts): CoCalc as the
// place where mathematics, science and teaching happen, with Codex and Claude
// Code working inside the same project. The hero is a rendered project view
// (a Sage notebook beside an agent conversation) with real MathML
// (./mathml), so the math is sharp at any size and needs no script.

import { Button } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PUBLIC_COLORS,
  PUBLIC_DISPLAY_FONT_FAMILY,
} from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import { frac, m, math, mi, mn, mo, space, sup } from "./mathml";

const appPath = (path: string) => joinUrlPath(appBasePath, path);

const C = PUBLIC_COLORS;

const CSS = `
.hv-math { color:${C.text}; font-size:17px; line-height:1.6; }
.hv-math h1,.hv-math h2,.hv-math h3 { font-family:${PUBLIC_DISPLAY_FONT_FAMILY}; color:${C.heading}; margin:0; text-wrap:balance; }
.hv-math h1 { font-size:clamp(36px,5vw,64px); line-height:1.04; letter-spacing:-.03em; font-weight:650; }
.hv-math h2 { font-size:clamp(28px,3.2vw,42px); line-height:1.12; letter-spacing:-.02em; font-weight:620; }
.hv-math h3 { font-size:20px; line-height:1.3; font-weight:600; }
.hv-math p { margin:0; }
.hv-math a:focus-visible { outline:3px solid ${C.link}; outline-offset:3px; border-radius:4px; }
.hv-eyebrow { font:600 13px/1.2 ${PUBLIC_DISPLAY_FONT_FAMILY}; letter-spacing:.14em; text-transform:uppercase; color:${C.link}; }
.hv-hero { display:grid; gap:40px; align-items:center; padding:clamp(28px,5vw,64px) 0 8px; }
.hv-hero-copy { display:grid; gap:22px; }
.hv-lead { font-size:19px; max-width:56ch; color:${C.mutedText}; }
.hv-lead strong { color:${C.text}; font-weight:600; }
.hv-actions { display:flex; flex-wrap:wrap; gap:12px; }
.hv-actions .ant-btn { height:auto; min-height:44px; padding:10px 20px; font-size:16px; white-space:normal; }
.hv-nouns { display:flex; flex-wrap:wrap; gap:8px; padding:0; margin:0; list-style:none; }
.hv-nouns li { font-size:14px; padding:4px 10px; border:1px solid ${C.border}; border-radius:999px; background:${C.surface}; color:${C.text}; }

/* The rendered project view */
.hv-window { border:1px solid ${C.border}; border-radius:14px; background:${C.surface}; box-shadow:0 30px 60px -30px color-mix(in srgb, ${C.shadowInk} 45%, transparent), 0 2px 6px color-mix(in srgb, ${C.shadowInk} 8%, transparent); overflow:hidden; min-width:0; }
.hv-tabs { display:flex; gap:2px; align-items:flex-end; padding:8px 10px 0; background:${C.surfaceMuted}; border-bottom:1px solid ${C.border}; font-size:13px; overflow:hidden; }
.hv-tab { padding:6px 12px; border-radius:8px 8px 0 0; color:${C.mutedText}; white-space:nowrap; }
.hv-tab[data-active="true"] { background:${C.surface}; color:${C.heading}; border:1px solid ${C.border}; border-bottom-color:${C.surface}; margin-bottom:-1px; font-weight:600; }
.hv-presence { margin-left:auto; display:flex; gap:4px; padding-bottom:6px; }
.hv-presence span { width:24px; height:24px; border-radius:50%; display:grid; place-items:center; font-size:11px; font-weight:700; color:#fff; }
.hv-panes { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,1fr); }
.hv-nb { padding:16px 18px; border-right:1px solid ${C.border}; display:grid; gap:10px; min-width:0; align-content:start; }
.hv-cell { display:grid; grid-template-columns:52px minmax(0,1fr); gap:6px; font-size:13px; align-items:start; }
.hv-prompt { font:12px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace; color:${C.mutedText}; text-align:right; }
.hv-code { font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; background:${C.surfaceMuted}; border:1px solid ${C.border}; border-radius:6px; padding:6px 8px; overflow:hidden; white-space:pre; color:${C.text}; }
.hv-code .k { color:${C.codeDefinition}; }
.hv-out { padding:2px 4px; font-size:18px; color:${C.heading}; }
.hv-plot { width:100%; height:auto; display:block; color:${C.text}; }
.hv-chat { padding:16px; display:grid; gap:12px; align-content:start; background:color-mix(in srgb, ${C.brandTint} 45%, ${C.surface}); min-width:0; }
.hv-msg { border-radius:12px; padding:10px 12px; font-size:14px; line-height:1.5; }
.hv-msg-user { background:${C.surface}; border:1px solid ${C.border}; justify-self:end; max-width:92%; }
.hv-msg-agent { background:${C.surface}; border:1px solid ${C.brandSubtle}; }
.hv-who { display:block; font-size:12px; font-weight:700; color:${C.link}; margin-bottom:4px; }
.hv-msg math[display="block"] { margin:8px 0 6px; font-size:1.2em; }
.hv-file { display:inline-block; font:12px ui-monospace,Menlo,monospace; padding:1px 6px; border-radius:4px; background:${C.surfaceMuted}; border:1px solid ${C.border}; }
.hv-caption { font-size:13px; color:${C.mutedText}; margin-top:10px; text-align:center; }

/* Sections */
.hv-section { margin-top:clamp(64px,8vw,104px); display:grid; gap:28px; }
.hv-section-head { display:grid; gap:14px; max-width:760px; }
.hv-section-head p { font-size:18px; color:${C.mutedText}; }
.hv-trio { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
.hv-card { border:1px solid ${C.border}; border-radius:12px; background:${C.surface}; padding:24px; display:grid; gap:10px; align-content:start; }
.hv-card .hv-who { margin:0; font-size:13px; letter-spacing:.06em; text-transform:uppercase; }
.hv-band { background:${C.heroBackground}; color:#fff; border-radius:20px; padding:clamp(28px,4vw,52px); display:grid; gap:28px; }
.hv-band h2 { color:#fff; }
.hv-band p { color:rgba(255,255,255,.86); }
.hv-band .hv-card { background:rgba(255,255,255,.08); border-color:rgba(255,255,255,.22); color:#fff; }
.hv-band .hv-card h3 { color:#fff; }
.hv-band .hv-card .hv-who, .hv-band .hv-eyebrow { color:#ffe2a6; }
.hv-show { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.15fr); gap:clamp(24px,4vw,56px); align-items:center; }
.hv-show:nth-child(even) .hv-show-text { order:2; }
.hv-show-text { display:grid; gap:14px; }
.hv-show-text p { color:${C.mutedText}; }
.hv-show-text ul { margin:0; padding-left:20px; }
.hv-show-text li { margin:4px 0; }
.hv-show figure { margin:0; }
.hv-show img { display:block; width:100%; height:auto; border-radius:12px; border:1px solid ${C.border}; box-shadow:0 18px 40px -26px color-mix(in srgb, ${C.shadowInk} 50%, transparent); }
.hv-link { font-weight:600; }
.hv-paths { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:18px; }
.hv-paths ul { list-style:none; padding:0; margin:0; display:grid; gap:8px; }
.hv-final { margin-top:clamp(64px,8vw,104px); border-top:1px solid ${C.border}; padding:40px 0 8px; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:24px; align-items:center; }
.hv-final p { color:${C.mutedText}; margin-top:10px; }
@media (min-width:980px) { .hv-hero { grid-template-columns:minmax(0,1fr) minmax(0,1.08fr); gap:clamp(36px,4vw,64px); } }
@media (max-width:900px) {
  .hv-trio,.hv-paths { grid-template-columns:minmax(0,1fr); }
  .hv-show { grid-template-columns:minmax(0,1fr); }
  .hv-show:nth-child(even) .hv-show-text { order:0; }
  .hv-final { grid-template-columns:minmax(0,1fr); }
}
@media (max-width:620px) {
  .hv-panes { grid-template-columns:minmax(0,1fr); }
  .hv-nb { border-right:0; border-bottom:1px solid ${C.border}; }
  .hv-tab:nth-child(3) { display:none; }
  .hv-actions .ant-btn { width:100%; }
  .hv-lead { font-size:18px; }
}
`;

// Partial sums of 1/n^2 for n = 1..40, scaled into the plot box below
// (computed, not drawn by hand).
const PARTIAL_SUMS =
  "28.0,120.3 35.3,81.6 42.6,64.4 49.8,54.7 57.1,48.6 64.4,44.3 71.7,41.1 79.0,38.7 86.3,36.8 93.5,35.2 100.8,34.0 108.1,32.9 115.4,32.0 122.7,31.2 129.9,30.5 137.2,29.9 144.5,29.4 151.8,28.9 159.1,28.4 166.4,28.1 173.6,27.7 180.9,27.4 188.2,27.1 195.5,26.8 202.8,26.6 210.1,26.4 217.3,26.1 224.6,25.9 231.9,25.8 239.2,25.6 246.5,25.4 253.7,25.3 261.0,25.1 268.3,25.0 275.6,24.9 282.9,24.8 290.2,24.6 297.4,24.5 304.7,24.4 312.0,24.3";

const BASEL_SUM = math(
  "block",
  m(
    "munderover",
    null,
    mo("∑"),
    m("mrow", null, mi("n"), mo("="), mn("1")),
    mi("∞"),
  ),
  frac(mn("1"), sup(mi("n"), mn("2"))),
  mo("="),
  frac(sup(mi("π"), mn("2")), mn("6")),
);
const SIXTH_PI_SQUARED = math(
  "inline",
  frac(mn("1"), mn("6")),
  space("0.15em"),
  sup(mi("π"), mn("2")),
);

function ProjectView() {
  return (
    <figure style={{ margin: 0, minWidth: 0 }}>
      <div
        className="hv-window"
        role="img"
        aria-label="Illustration of a CoCalc project: a SageMath notebook computes the sum of 1 over n squared as pi squared over 6 and plots its partial sums, while Claude Code, in the conversation beside it, reports that it added the proof to paper.tex. Two collaborators are in the project."
      >
        <div className="hv-tabs" aria-hidden="true">
          <span className="hv-tab" data-active="true">
            basel.ipynb
          </span>
          <span className="hv-tab">paper.tex</span>
          <span className="hv-tab">notes.md</span>
          <span className="hv-presence">
            <span style={{ background: "#2A5AA6" }}>AL</span>
            <span style={{ background: "#8a5a00" }}>MK</span>
          </span>
        </div>
        <div className="hv-panes" aria-hidden="true">
          <div className="hv-nb">
            <div className="hv-cell">
              <span className="hv-prompt">In [1]:</span>
              <div className="hv-code">
                <span className="k">var</span>('n'){"\n"}
                <span className="k">sum</span>(1/n^2, n, 1, oo)
              </div>
            </div>
            <div className="hv-cell">
              <span className="hv-prompt">Out[1]:</span>
              <div className="hv-out">{SIXTH_PI_SQUARED}</div>
            </div>
            <div className="hv-cell">
              <span className="hv-prompt">In [2]:</span>
              <div className="hv-code">
                <span className="k">list_plot</span>(partial_sums(40))
              </div>
            </div>
            <div className="hv-cell">
              <span className="hv-prompt" />
              <svg className="hv-plot" viewBox="0 0 320 150">
                <line
                  x1="28"
                  y1="128"
                  x2="314"
                  y2="128"
                  stroke="currentColor"
                  opacity=".25"
                />
                <line
                  x1="28"
                  y1="10"
                  x2="28"
                  y2="128"
                  stroke="currentColor"
                  opacity=".25"
                />
                <line
                  x1="28"
                  y1="20.5"
                  x2="314"
                  y2="20.5"
                  stroke="#bf7b00"
                  strokeDasharray="5 4"
                />
                <text x="252" y="15" fontSize="10" style={{ fill: C.warning }}>
                  π²/6 ≈ 1.645
                </text>
                <polyline
                  points={PARTIAL_SUMS}
                  fill="none"
                  stroke="#4474c0"
                  strokeWidth="2"
                />
                {PARTIAL_SUMS.split(" ")
                  .filter((_, i) => i % 3 === 0)
                  .map((p) => {
                    const [x, y] = p.split(",");
                    return (
                      <circle key={p} cx={x} cy={y} r="2.4" fill="#4474c0" />
                    );
                  })}
                <text
                  x="25"
                  y="141"
                  fontSize="9"
                  fill="currentColor"
                  opacity=".6"
                >
                  1
                </text>
                <text
                  x="304"
                  y="141"
                  fontSize="9"
                  fill="currentColor"
                  opacity=".6"
                >
                  40
                </text>
              </svg>
            </div>
          </div>
          <div className="hv-chat">
            <div className="hv-msg hv-msg-user">
              Prove the Basel sum in <span className="hv-file">paper.tex</span>{" "}
              and check it numerically.
            </div>
            <div className="hv-msg hv-msg-agent">
              <span className="hv-who">Claude Code</span>
              Added a proof to §2 of <span className="hv-file">
                paper.tex
              </span>{" "}
              and checked it in Sage. The partial sums approach
              {BASEL_SUM}
              Review the diff, or compare versions in TimeTravel.
            </div>
          </div>
        </div>
      </div>
      <figcaption className="hv-caption">
        Illustration: a notebook, a paper and an agent conversation in one
        project.
      </figcaption>
    </figure>
  );
}

const SHOWCASE = [
  {
    eyebrow: "Research computing",
    title: "Explore with SageMath, Python, R or Julia.",
    body: "Run Jupyter notebooks on a full Linux environment. Ask an agent to try the next experiment, then question the result in the same notebook.",
    bullets: [
      "Shared kernels and real-time collaboration",
      "Chat anchored to individual cells",
      "TimeTravel history of every edit",
    ],
    link: { href: "features/sage", label: "SageMath in CoCalc" },
    img: {
      src: "/public/features/sagemath-jupyter.png",
      width: 1508,
      height: 858,
      alt: "A SageMath Jupyter notebook in CoCalc plotting a function and solving a system of equations",
    },
  },
  {
    eyebrow: "Papers and handouts",
    title: "Write LaTeX beside its PDF.",
    body: "Edit with collaborators in real time and jump between source and output. An agent can derive a formula, fix a build error or tidy a section, and you review the change.",
    bullets: [
      "SageTeX, PythonTeX and Knitr",
      "Discussions attached to lines",
      "Bibliographies and data in the same project",
    ],
    link: { href: "features/latex-editor", label: "The LaTeX editor" },
    img: {
      src: "/public/features/latex-formula-agent-20260730.png",
      width: 873,
      height: 688,
      alt: "The CoCalc LaTeX editor with an agent editing an integral formula step by step beside the source",
    },
  },
  {
    eyebrow: "Teaching",
    title: "Run a course, not an IT project.",
    body: "Give every student the same software, then distribute assignments, collect them and grade notebooks, including with nbgrader.",
    bullets: [
      "Assign, collect, grade and return",
      "One environment for the whole class",
      "Students need only a browser",
    ],
    link: { href: "features/teaching", label: "Teaching with CoCalc" },
    img: {
      src: "/public/features/cocalc-course-assignments-2019.png",
      width: 1734,
      height: 1006,
      alt: "CoCalc's course management view listing assignments with buttons to assign, collect, grade and return them",
    },
  },
] as const;

const PATHS = [
  {
    who: "Students and teachers",
    links: [
      { href: "features/teaching", label: "Teach a course" },
      { href: "features/jupyter-notebook", label: "Jupyter notebooks" },
      { href: "features/exam-scratchpads", label: "Computational exams" },
    ],
  },
  {
    who: "Researchers",
    links: [
      { href: "features/sage", label: "SageMath" },
      { href: "features/latex-editor", label: "LaTeX papers" },
      { href: "features/r-statistical-software", label: "R and Quarto" },
    ],
  },
  {
    who: "Developers and teams",
    links: [
      { href: "features/ai", label: "Codex and Claude Code" },
      { href: "features/terminal", label: "Linux terminals" },
      { href: "features/web-browser", label: "A browser for agents" },
    ],
  },
] as const;

const NOUNS = [
  "Jupyter",
  "LaTeX",
  "SageMath",
  "Python",
  "R",
  "Julia",
  "Terminals",
  "TimeTravel",
] as const;

export default function MathHome({
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
    <div className="hv-math">
      <style>{CSS}</style>
      <section className="hv-hero" aria-labelledby="hv-math-title">
        <div className="hv-hero-copy">
          <span className="hv-eyebrow">Mathematics · Science · Teaching</span>
          <h1 id="hv-math-title">
            Do mathematics with your collaborators and AI agents.
          </h1>
          <p className="hv-lead">
            CoCalc is a shared Linux project in your browser:{" "}
            <strong>Jupyter, LaTeX, SageMath, R and terminals</strong>, with
            collaborators editing live. <strong>Codex and Claude Code</strong>{" "}
            work in the same files, and TimeTravel keeps every version.
          </p>
          <div className="hv-actions">
            <Button type="primary" size="large" href={appPath(primary.href)}>
              {primary.label}
            </Button>
            <Button size="large" href={appPath("features/ai")}>
              See the agents at work
            </Button>
          </div>
          <ul className="hv-nouns" aria-label="Tools in every project">
            {NOUNS.map((noun) => (
              <li key={noun}>{noun}</li>
            ))}
          </ul>
        </div>
        <ProjectView />
      </section>

      <section className="hv-section" aria-labelledby="hv-math-one">
        <div className="hv-band">
          <div className="hv-section-head">
            <span className="hv-eyebrow">Why CoCalc</span>
            <h2 id="hv-math-one">One project. Everyone works in it.</h2>
            <p>
              A CoCalc project is a persistent Linux environment with your
              files, software and history. People and agents don't pass files
              back and forth: they work in the same place, and you can see who
              changed what.
            </p>
          </div>
          <div className="hv-trio">
            <div className="hv-card">
              <span className="hv-who">You</span>
              <h3>Nothing to install</h3>
              <p>
                Notebooks, papers and terminals open in the browser, on software
                that is already set up and stays set up.
              </p>
            </div>
            <div className="hv-card">
              <span className="hv-who">Collaborators</span>
              <h3>Edit together, live</h3>
              <p>
                Share a notebook kernel or a terminal, discuss a cell or a line,
                and recover earlier versions with TimeTravel.
              </p>
            </div>
            <div className="hv-card">
              <span className="hv-who">Agents</span>
              <h3>Codex and Claude Code</h3>
              <p>
                They run code, edit files and use the terminal in your project.
                You see their changes and can take over at any point.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="hv-section" aria-labelledby="hv-math-work">
        <div className="hv-section-head">
          <h2 id="hv-math-work">Built for technical work.</h2>
          <p>
            CoCalc grew up alongside SageMath and has hosted notebooks, papers
            and courses for years. The agents are new; the place they work in is
            not.
          </p>
        </div>
        <div style={{ display: "grid", gap: "clamp(48px,6vw,80px)" }}>
          {SHOWCASE.map((item) => (
            <div className="hv-show" key={item.title}>
              <div className="hv-show-text">
                <span className="hv-eyebrow">{item.eyebrow}</span>
                <h3 style={{ fontSize: 28, lineHeight: 1.2 }}>{item.title}</h3>
                <p>{item.body}</p>
                <ul>
                  {item.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                <a className="hv-link" href={appPath(item.link.href)}>
                  {item.link.label}
                </a>
              </div>
              <figure>
                <img
                  src={appPath(item.img.src)}
                  width={item.img.width}
                  height={item.img.height}
                  alt={item.img.alt}
                  loading="lazy"
                  decoding="async"
                />
              </figure>
            </div>
          ))}
        </div>
      </section>

      <section className="hv-section" aria-labelledby="hv-math-paths">
        <div className="hv-section-head">
          <h2 id="hv-math-paths">Start where you are.</h2>
        </div>
        <nav className="hv-paths" aria-label="Guides by audience">
          {PATHS.map((path) => (
            <div className="hv-card" key={path.who}>
              <h3>{path.who}</h3>
              <ul>
                {path.links.map((link) => (
                  <li key={link.href}>
                    <a href={appPath(link.href)}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </section>

      <section className="hv-final" aria-labelledby="hv-math-final">
        <div>
          <h2 id="hv-math-final">Bring your next problem.</h2>
          <p>
            Open a notebook, a paper or a terminal, and ask an agent to help.
          </p>
        </div>
        <div className="hv-actions">
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
