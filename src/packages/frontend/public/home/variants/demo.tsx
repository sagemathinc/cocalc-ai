/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// Home page version "demo" (util/public-home-experiment.ts): the shortest
// page. One sentence, then four tasks to switch between (a differential
// equation, a broken LaTeX build, autograder tests, an app), each shown as
// what you ask and what happens in the project. Little else.

import { Button } from "antd";
import { useRef, useState, type KeyboardEvent } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PUBLIC_COLORS,
  PUBLIC_DISPLAY_FONT_FAMILY,
} from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const appPath = (path: string) => joinUrlPath(appBasePath, path);

const C = PUBLIC_COLORS;

const CSS = `
.hd { color:${C.text}; font-size:17px; line-height:1.6; }
.hd h1,.hd h2,.hd h3 { font-family:${PUBLIC_DISPLAY_FONT_FAMILY}; color:${C.heading}; margin:0; text-wrap:balance; }
.hd p { margin:0; }
.hd a:focus-visible, .hd button:focus-visible { outline:3px solid ${C.link}; outline-offset:3px; border-radius:6px; }
.hd-hero { display:grid; gap:20px; justify-items:center; text-align:center; padding:clamp(36px,6vw,80px) 0 0; }
.hd-hero h1 { font-size:clamp(38px,5.6vw,72px); line-height:1.02; letter-spacing:-.035em; font-weight:650; max-width:18ch; }
.hd-lead { font-size:19px; max-width:60ch; color:${C.mutedText}; }
.hd-lead strong { color:${C.text}; font-weight:600; }
.hd-actions { display:flex; flex-wrap:wrap; gap:12px; justify-content:center; }
.hd-actions .ant-btn { height:auto; min-height:44px; padding:10px 22px; font-size:16px; white-space:normal; }

.hd-demo { margin-top:clamp(36px,5vw,56px); display:grid; gap:14px; }
.hd-tabs { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; }
.hd-tab { font:500 15px/1.2 ${PUBLIC_DISPLAY_FONT_FAMILY}; padding:10px 16px; min-height:44px; border-radius:999px; border:1px solid ${C.border}; background:${C.surface}; color:${C.text}; cursor:pointer; }
.hd-tab:hover { border-color:${C.brand}; }
.hd-tab[aria-selected="true"] { background:${C.heading}; border-color:${C.heading}; color:${C.surface}; }
.hd-panel { display:grid; grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr); border:1px solid ${C.border}; border-radius:16px; overflow:hidden; background:${C.surface}; box-shadow:0 30px 60px -34px color-mix(in srgb, ${C.shadowInk} 45%, transparent); text-align:left; }
.hd-ask { padding:clamp(20px,3vw,32px); background:${C.surfaceMuted}; border-right:1px solid ${C.border}; display:grid; gap:12px; align-content:start; }
.hd-label { font:600 12px/1.2 ${PUBLIC_DISPLAY_FONT_FAMILY}; letter-spacing:.12em; text-transform:uppercase; color:${C.mutedText}; }
.hd-prompt { font-size:19px; line-height:1.45; color:${C.heading}; }
.hd-prompt math { font-size:1.05em; }
.hd-file { display:inline-block; font:13px ui-monospace,Menlo,monospace; padding:1px 6px; border-radius:4px; background:${C.surface}; border:1px solid ${C.border}; }
.hd-result { padding:clamp(20px,3vw,32px); display:grid; gap:12px; align-content:start; min-width:0; }
.hd-agent { font-size:13px; font-weight:700; color:${C.brand}; }
.hd-code { font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; background:${C.surfaceMuted}; border:1px solid ${C.border}; border-radius:8px; padding:10px 12px; white-space:pre; overflow-x:auto; color:${C.text}; }
.hd-code .k { color:${C.codeDefinition}; }
.hd-code .ok { color:#2f8f5b; }
.hd-code .bad { color:#c0392b; }
.hd-code .dim { color:${C.mutedText}; }
.hd-math { font-size:22px; color:${C.heading}; padding:4px 0; }
.hd-plot { width:100%; max-width:420px; height:auto; display:block; color:${C.text}; }
.hd-done { color:${C.mutedText}; font-size:15px; }
.hd-note { text-align:center; color:${C.mutedText}; font-size:15px; }

.hd-facts { margin-top:clamp(56px,7vw,88px); display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:clamp(18px,3vw,40px); border-top:1px solid ${C.border}; padding-top:32px; }
.hd-facts h2 { font-size:20px; line-height:1.3; font-weight:600; margin-bottom:6px; }
.hd-facts p { color:${C.mutedText}; font-size:16px; }
.hd-final { margin-top:clamp(56px,7vw,88px); display:grid; gap:18px; justify-items:center; text-align:center; }
.hd-final h2 { font-size:clamp(28px,3.4vw,44px); line-height:1.12; letter-spacing:-.02em; font-weight:620; }
@media (max-width:820px) {
  .hd-panel { grid-template-columns:minmax(0,1fr); }
  .hd-ask { border-right:0; border-bottom:1px solid ${C.border}; }
  .hd-facts { grid-template-columns:minmax(0,1fr); }
}
@media (max-width:620px) {
  .hd-actions { width:100%; }
  .hd-actions .ant-btn { width:100%; }
  .hd-lead { font-size:18px; }
  .hd-tab { font-size:14px; padding:9px 13px; }
}
`;

// MathML, rendered by the browser itself (no script). Static strings: React's
// types do not include the MathML elements.
const PRIME2 = '<mi>y</mi><mo lspace="0" rspace="0">″</mo>';
const PRIME1 = '<mi>y</mi><mo lspace="0" rspace="0">′</mo>';
const SIN = '<mi>sin</mi><mo>⁡</mo><mspace width="0.17em"></mspace>';
const at0 = (f: string) =>
  `${f}<mo stretchy="false">(</mo><mn>0</mn><mo stretchy="false">)</mo>`;
const ODE_MATHML = `<math><mrow>${PRIME2}<mo>+</mo><mi>y</mi><mo>=</mo>${SIN}<mn>2</mn><mi>t</mi></mrow></math>`;
const INITIAL_MATHML = `<math><mrow>${at0("<mi>y</mi>")}<mo>=</mo><mn>0</mn><mo separator="true">,</mo><mspace width="0.4em"></mspace>${at0(PRIME1)}<mo>=</mo><mn>1</mn></mrow></math>`;
const SOLUTION_MATHML = `<math display="block"><mrow><mi>y</mi><mo stretchy="false">(</mo><mi>t</mi><mo stretchy="false">)</mo><mo>=</mo><mfrac><mn>5</mn><mn>3</mn></mfrac>${SIN}<mi>t</mi><mo>−</mo><mfrac><mn>1</mn><mn>3</mn></mfrac>${SIN}<mn>2</mn><mi>t</mi></mrow></math>`;

// The solution on 0 <= t <= 4 pi, scaled into the plot box below (computed,
// not drawn by hand).
const ODE_PLOT = Array.from({ length: 121 }, (_, i) => {
  const t = (4 * Math.PI * i) / 120;
  const y = (5 / 3) * Math.sin(t) - (1 / 3) * Math.sin(2 * t);
  return `${(24 + (i / 120) * 270).toFixed(1)},${(55 - 24 * y).toFixed(1)}`;
}).join(" ");

function OdePlot() {
  return (
    <svg
      className="hd-plot"
      viewBox="0 0 300 110"
      role="img"
      aria-label="Plot of the solution over two periods: a wave between about -1.8 and 1.8"
    >
      <line
        x1="24"
        y1="55"
        x2="294"
        y2="55"
        stroke="currentColor"
        opacity=".25"
      />
      <line
        x1="24"
        y1="6"
        x2="24"
        y2="104"
        stroke="currentColor"
        opacity=".25"
      />
      <polyline
        points={ODE_PLOT}
        fill="none"
        stroke="#4474c0"
        strokeWidth="2"
      />
      <text x="282" y="68" fontSize="9" fill="currentColor" opacity=".6">
        4π
      </text>
      <text x="14" y="58" fontSize="9" fill="currentColor" opacity=".6">
        0
      </text>
    </svg>
  );
}

function MathML({ markup }: { markup: string }) {
  return <span dangerouslySetInnerHTML={{ __html: markup }} />;
}

const TASKS = [
  {
    id: "ode",
    tab: "Solve an equation",
    agent: "Claude Code",
    ask: (
      <>
        Solve <MathML markup={ODE_MATHML} /> with{" "}
        <MathML markup={INITIAL_MATHML} />, check it, and plot it in{" "}
        <span className="hd-file">ode.ipynb</span>.
      </>
    ),
    result: (
      <>
        <div className="hd-code">
          <span className="k">t</span> = var('t'); y = function('y')(t){"\n"}
          <span className="k">desolve</span>(diff(y,t,2) + y == sin(2*t),
          {"\n        "}y, ics=[0,0,1])
        </div>
        <div className="hd-math">
          <MathML markup={SOLUTION_MATHML} />
        </div>
        <OdePlot />
        <p className="hd-done">
          Solved in SageMath, checked by substituting back, and plotted in the
          notebook.
        </p>
      </>
    ),
  },
  {
    id: "latex",
    tab: "Fix a paper",
    agent: "Codex",
    ask: (
      <>
        <span className="hd-file">thesis.tex</span> stopped compiling after I
        merged Ana's chapter. Fix it.
      </>
    ),
    result: (
      <>
        <div className="hd-code">
          <span className="bad">! Undefined control sequence.</span>
          {"\n"}l.212 the eigenvalues lie in <span className="k">\mathbb</span>
          {"{C}"}
          {"\n"}
          <span className="dim">…</span>
          {"\n"}+ <span className="k">\usepackage</span>
          {"{amssymb}"}
          <span className="dim"> % preamble, line 9</span>
          {"\n"}
          <span className="ok">Output written on thesis.pdf (42 pages)</span>
        </div>
        <p className="hd-done">
          Chapter 4 used a symbol package the main file didn't load. Added it,
          rebuilt the PDF and left the change for you to review in TimeTravel.
        </p>
      </>
    ),
  },
  {
    id: "grade",
    tab: "Grade a class",
    agent: "Codex",
    ask: (
      <>
        Write autograder tests for question 3 of{" "}
        <span className="hd-file">hw5.ipynb</span>. Include the edge cases.
      </>
    ),
    result: (
      <>
        <div className="hd-code">
          <span className="k">assert</span> np.allclose(lstsq(A, b), x_true)
          {"\n"}
          <span className="k">assert</span> lstsq(A_rank_deficient, b) is not
          None{"\n"}
          <span className="k">assert</span> raises(ValueError, lstsq,
          A_wrong_shape, b){"\n"}
          <span className="dim">### BEGIN HIDDEN TESTS …</span>
        </div>
        <p className="hd-done">
          Six nbgrader tests, three of them hidden. All pass against your
          solution and fail on the starter code, as they should.
        </p>
      </>
    ),
  },
  {
    id: "app",
    tab: "Ship an app",
    agent: "Claude Code",
    ask: (
      <>
        Turn the plots in <span className="hd-file">analysis.ipynb</span> into a
        small dashboard and run it.
      </>
    ),
    result: (
      <>
        <div className="hd-code">
          <span className="dim">~/project$</span> pytest -q{"\n"}
          <span className="ok">8 passed</span> in 0.94s{"\n"}
          <span className="dim">~/project$</span> python app.py{"\n"}
          Serving on port 8050
        </div>
        <p className="hd-done">
          Wrote <span className="hd-file">app.py</span> and its tests, started
          it in the project, and checked it in the project's web browser. Your
          collaborators can open it too.
        </p>
      </>
    ),
  },
] as const;

function Demo() {
  const [selected, setSelected] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (i: number) => {
    const next = (i + TASKS.length) % TASKS.length;
    setSelected(next);
    tabs.current[next]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      select(0);
    } else if (e.key === "End") {
      e.preventDefault();
      select(TASKS.length - 1);
    }
  };
  const task = TASKS[selected];
  return (
    <section className="hd-demo" aria-label="Examples of work in a project">
      <div
        className="hd-tabs"
        role="tablist"
        aria-label="Examples"
        onKeyDown={onKeyDown}
      >
        {TASKS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`hd-tab-${t.id}`}
            className="hd-tab"
            aria-selected={i === selected}
            aria-controls={`hd-panel-${t.id}`}
            tabIndex={i === selected ? 0 : -1}
            onClick={() => setSelected(i)}
          >
            {t.tab}
          </button>
        ))}
      </div>
      <div
        className="hd-panel"
        role="tabpanel"
        id={`hd-panel-${task.id}`}
        aria-labelledby={`hd-tab-${task.id}`}
      >
        <div className="hd-ask">
          <span className="hd-label">You ask</span>
          <p className="hd-prompt">{task.ask}</p>
        </div>
        <div className="hd-result">
          <span className="hd-label">
            <span className="hd-agent">{task.agent}</span> in your project
          </span>
          {task.result}
        </div>
      </div>
      <p className="hd-note">
        Illustrations of typical requests. Each runs in a CoCalc project, on
        files your collaborators can open.
      </p>
    </section>
  );
}

export default function DemoHome({
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
    <div className="hd">
      <style>{CSS}</style>
      <section className="hd-hero" aria-labelledby="hd-title">
        <h1 id="hd-title">Bring a problem. Work it out with people and AI.</h1>
        <p className="hd-lead">
          A CoCalc project has <strong>Jupyter, LaTeX, SageMath</strong>, R,
          Python and a terminal, ready in the browser.{" "}
          <strong>Codex and Claude Code</strong> work in it beside you and your
          collaborators.
        </p>
        <div className="hd-actions">
          <Button type="primary" size="large" href={appPath(primary.href)}>
            {primary.label}
          </Button>
        </div>
      </section>

      <Demo />

      <section className="hd-facts" aria-label="What a project keeps">
        <div>
          <h2>It's your computer, not a chat.</h2>
          <p>
            Files, software and running servers stay in the project between
            sessions.
          </p>
        </div>
        <div>
          <h2>Everyone sees the same thing.</h2>
          <p>
            Collaborators edit live, and every change, an agent's included, is
            in TimeTravel.
          </p>
        </div>
        <div>
          <h2>Made for technical work.</h2>
          <p>
            CoCalc grew up alongside SageMath, and hosts notebooks, papers and
            courses.
          </p>
        </div>
      </section>

      <section className="hd-final" aria-labelledby="hd-final">
        <h2 id="hd-final">What will you work on first?</h2>
        <div className="hd-actions">
          <Button type="primary" size="large" href={appPath(primary.href)}>
            {primary.label}
          </Button>
          <Button size="large" href={appPath("features")}>
            See everything a project can do
          </Button>
        </div>
      </section>
    </div>
  );
}
