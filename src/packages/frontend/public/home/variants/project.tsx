/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// Home page version "project" (util/public-home-experiment.ts): a CoCalc
// project as a persistent computer that people and AI agents share. The hero
// is a rendered project (files, a terminal where an agent ran the tests, and
// the project's recent activity) on a dark panel.

import { Button } from "antd";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  PUBLIC_COLORS,
  PUBLIC_DISPLAY_FONT_FAMILY,
} from "@cocalc/frontend/public/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const appPath = (path: string) => joinUrlPath(appBasePath, path);
const C = PUBLIC_COLORS;
const NAVY = "#0E2B59";
const GOLD = "#fbb635";

const CSS = `
.hp { color:${C.text}; font-size:17px; line-height:1.6; }
.hp h1,.hp h2,.hp h3 { font-family:${PUBLIC_DISPLAY_FONT_FAMILY}; margin:0; text-wrap:balance; color:${C.heading}; }
.hp p { margin:0; }
.hp a:focus-visible { outline:3px solid ${C.link}; outline-offset:3px; border-radius:4px; }
.hp-hero { margin-top:clamp(16px,3vw,32px); border-radius:24px; background:radial-gradient(1200px 500px at 85% -10%, #2A5AA6 0%, transparent 60%), ${NAVY}; color:#fff; padding:clamp(28px,5vw,64px); display:grid; gap:36px; }
.hp-hero h1 { color:#fff; font-size:clamp(36px,5vw,62px); line-height:1.04; letter-spacing:-.03em; font-weight:650; max-width:16ch; }
.hp-hero .hp-lead { font-size:19px; color:rgba(255,255,255,.86); max-width:58ch; }
.hp-hero .hp-lead strong { color:#fff; }
.hp-eyebrow { font:600 13px/1.2 ${PUBLIC_DISPLAY_FONT_FAMILY}; letter-spacing:.14em; text-transform:uppercase; color:${GOLD}; }
.hp-copy { display:grid; gap:22px; align-content:center; }
.hp-actions { display:flex; flex-wrap:wrap; gap:12px; }
.hp-actions .ant-btn { height:auto; min-height:44px; padding:10px 20px; font-size:16px; white-space:normal; }
.hp-hero .hp-ghost.ant-btn { background:transparent; color:#fff; border-color:rgba(255,255,255,.5); }
.hp-hero .hp-ghost.ant-btn:hover { border-color:#fff; color:#fff; }

.hp-machine { border-radius:14px; border:1px solid rgba(255,255,255,.18); background:#0a1f42; box-shadow:0 30px 70px -30px rgba(0,0,0,.6); overflow:hidden; min-width:0; font-size:13px; }
.hp-bar { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid rgba(255,255,255,.12); color:rgba(255,255,255,.8); }
.hp-dot { width:9px; height:9px; border-radius:50%; background:#3ecf8e; box-shadow:0 0 0 3px rgba(62,207,142,.18); }
.hp-bar b { color:#fff; font-weight:600; }
.hp-bar small { margin-left:auto; color:rgba(255,255,255,.55); }
.hp-grid { display:grid; grid-template-columns:150px minmax(0,1fr); min-height:300px; }
.hp-files { border-right:1px solid rgba(255,255,255,.12); padding:10px 0; font:12.5px/1.9 ui-monospace,SFMono-Regular,Menlo,monospace; color:rgba(255,255,255,.75); }
.hp-files div { padding:0 12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hp-files .on { background:rgba(255,255,255,.08); color:#fff; }
.hp-main { display:grid; grid-template-rows:auto 1fr; min-width:0; }
.hp-term { font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; padding:12px 14px; color:#d6e2ff; white-space:pre; overflow:hidden; border-bottom:1px solid rgba(255,255,255,.12); }
.hp-term .p { color:${GOLD}; }
.hp-term .ok { color:#3ecf8e; }
.hp-term .dim { color:rgba(214,226,255,.55); }
.hp-feed { padding:10px 14px; display:grid; gap:8px; align-content:start; }
.hp-ev { display:grid; grid-template-columns:22px minmax(0,1fr) auto; gap:8px; align-items:center; color:rgba(255,255,255,.88); }
.hp-ev small { color:rgba(255,255,255,.5); }
.hp-av { width:22px; height:22px; border-radius:50%; display:grid; place-items:center; font-size:10px; font-weight:700; color:#fff; }
.hp-caption { font-size:13px; color:rgba(255,255,255,.6); margin-top:10px; text-align:center; }

.hp-section { margin-top:clamp(64px,8vw,104px); display:grid; gap:28px; }
.hp-head { display:grid; gap:14px; max-width:760px; }
.hp-head h2 { font-size:clamp(28px,3.2vw,42px); line-height:1.12; letter-spacing:-.02em; font-weight:620; }
.hp-head p { font-size:18px; color:${C.mutedText}; }
.hp-head .hp-eyebrow { color:${C.link}; }
.hp-tiles { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }
.hp-tile { border:1px solid ${C.border}; border-radius:14px; background:${C.surface}; padding:22px; display:grid; gap:8px; align-content:start; }
.hp-tile h3 { font-size:19px; }
.hp-tile p { color:${C.mutedText}; font-size:16px; }
.hp-glyph { font:600 15px ui-monospace,Menlo,monospace; color:${C.link}; background:${C.brandTint}; border-radius:8px; width:40px; height:40px; display:grid; place-items:center; }
.hp-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.2fr); gap:clamp(24px,4vw,56px); align-items:center; }
.hp-split ul { margin:0; padding-left:20px; display:grid; gap:6px; }
.hp-split img { width:100%; height:auto; display:block; border-radius:12px; border:1px solid ${C.border}; box-shadow:0 18px 40px -26px color-mix(in srgb, ${C.shadowInk} 50%, transparent); }
.hp-split figure { margin:0; }
.hp-timeline { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:0; border-top:2px solid ${C.brandSubtle}; }
.hp-step { padding:18px 16px 0 0; position:relative; display:grid; gap:6px; }
.hp-step::before { content:""; position:absolute; top:-7px; left:0; width:12px; height:12px; border-radius:50%; background:${C.brand}; }
.hp-step h3 { font-size:17px; }
.hp-step p { color:${C.mutedText}; font-size:15px; }
.hp-final { margin-top:clamp(64px,8vw,104px); border-radius:20px; background:${C.surfaceMuted}; padding:clamp(24px,4vw,44px); display:grid; grid-template-columns:minmax(0,1fr) auto; gap:24px; align-items:center; }
.hp-final p { color:${C.mutedText}; margin-top:10px; }
@media (min-width:980px) { .hp-hero { grid-template-columns:minmax(0,.95fr) minmax(0,1.1fr); } }
@media (max-width:900px) {
  .hp-tiles { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .hp-split, .hp-final { grid-template-columns:minmax(0,1fr); }
  .hp-timeline { grid-template-columns:repeat(2,minmax(0,1fr)); row-gap:22px; }
}
@media (max-width:620px) {
  .hp-tiles, .hp-timeline { grid-template-columns:minmax(0,1fr); }
  .hp-grid { grid-template-columns:minmax(0,1fr); }
  .hp-files { display:none; }
  .hp-bar small { display:none; }
  .hp-bar { white-space:nowrap; }
  .hp-actions .ant-btn { width:100%; }
  .hp-hero { border-radius:16px; }
}
`;

const FILES = [
  "data/",
  "analysis.ipynb",
  "paper.tex",
  "app.py",
  "tests/",
  "dev.term",
] as const;

const EVENTS = [
  {
    who: "CC",
    color: "#5b3fd6",
    text: "Claude Code ran the tests and fixed app.py",
    when: "now",
  },
  {
    who: "AL",
    color: "#2A5AA6",
    text: "Ana commented on paper.tex, line 42",
    when: "4 min",
  },
  {
    who: "CX",
    color: "#0b7558",
    text: "Codex re-ran analysis.ipynb",
    when: "12 min",
  },
  {
    who: "MK",
    color: "#8a5a00",
    text: "Mo restored a section with TimeTravel",
    when: "1 h",
  },
] as const;

function Machine() {
  return (
    <figure style={{ margin: 0, minWidth: 0 }}>
      <div
        className="hp-machine"
        role="img"
        aria-label="Illustration of a running CoCalc project: its files (a dataset, a Jupyter notebook, a LaTeX paper, an app and its tests), a terminal where Claude Code ran the tests and they passed, and recent activity by two collaborators, Claude Code and Codex."
      >
        <div className="hp-bar" aria-hidden="true">
          <span className="hp-dot" />
          <b>thesis-analysis</b>
          <span>· running</span>
          <small>Ubuntu · Python · R · SageMath · TeX</small>
        </div>
        <div className="hp-grid" aria-hidden="true">
          <div className="hp-files">
            {FILES.map((f) => (
              <div key={f} className={f === "dev.term" ? "on" : undefined}>
                {f}
              </div>
            ))}
          </div>
          <div className="hp-main">
            <div className="hp-term">
              <span className="p">~/thesis-analysis$</span> pytest -q{"\n"}
              <span className="ok">..........</span>{" "}
              <span className="dim">[100%]</span>
              {"\n"}
              <span className="ok">10 passed</span> in 1.42s{"\n"}
              <span className="p">~/thesis-analysis$</span> python app.py
              {"\n"}
              <span className="dim">Serving on port 8050</span>
            </div>
            <div className="hp-feed">
              {EVENTS.map((e) => (
                <div className="hp-ev" key={e.text}>
                  <span className="hp-av" style={{ background: e.color }}>
                    {e.who}
                  </span>
                  <span>{e.text}</span>
                  <small>{e.when}</small>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <figcaption className="hp-caption">
        Illustration of a project shared by two people and two agents.
      </figcaption>
    </figure>
  );
}

const TILES = [
  {
    glyph: "[ ]",
    title: "Jupyter notebooks",
    body: "Python, R, Julia and SageMath kernels, shared live, with chat on any cell.",
    href: "features/jupyter-notebook",
  },
  {
    glyph: "TeX",
    title: "LaTeX papers",
    body: "Source beside the PDF, with SageTeX and PythonTeX, edited together.",
    href: "features/latex-editor",
  },
  {
    glyph: "$_",
    title: "Linux terminals",
    body: "A real shell with the project's software. Share it, or let an agent use it.",
    href: "features/terminal",
  },
  {
    glyph: "www",
    title: "A web browser",
    body: "Agents browse in a real Chromium you can watch, and take over to sign in.",
    href: "features/web-browser",
  },
  {
    glyph: "app",
    title: "Your own apps",
    body: "Run a dashboard or a web app in the project, behind an authenticated URL.",
    href: "features/linux",
  },
  {
    glyph: "↺",
    title: "History and recovery",
    body: "TimeTravel shows every edit, and snapshots and backups keep earlier files.",
    href: "docs/files/timetravel",
  },
] as const;

const STEPS = [
  {
    title: "Ask",
    body: "Tell Codex or Claude Code what you need, in the project.",
  },
  {
    title: "It works there",
    body: "It runs code, edits files and uses the terminal and browser.",
  },
  {
    title: "You review",
    body: "Open the result beside the conversation. See every change.",
  },
  {
    title: "Anyone continues",
    body: "You, a collaborator or another agent picks up where it stopped.",
  },
] as const;

export default function ProjectHome({
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
    <div className="hp">
      <style>{CSS}</style>
      <section className="hp-hero" aria-labelledby="hp-title">
        <div className="hp-copy">
          <span className="hp-eyebrow">The project is the computer</span>
          <h1 id="hp-title">
            One computer for you, your team and your AI agents.
          </h1>
          <p className="hp-lead">
            Every CoCalc project is a persistent Linux machine in the browser,
            with <strong>Jupyter, LaTeX, SageMath, Python, R</strong>, terminals
            and a web browser. <strong>Codex and Claude Code</strong> work in it
            beside your collaborators, on the same files, and TimeTravel keeps
            every version.
          </p>
          <div className="hp-actions">
            <Button type="primary" size="large" href={appPath(primary.href)}>
              {primary.label}
            </Button>
            <Button
              className="hp-ghost"
              size="large"
              href={appPath("features/compare")}
            >
              Compare with agent sandboxes
            </Button>
          </div>
        </div>
        <Machine />
      </section>

      <section className="hp-section" aria-labelledby="hp-inside">
        <div className="hp-head">
          <span className="hp-eyebrow">Inside every project</span>
          <h2 id="hp-inside">Everything the work needs, already there.</h2>
          <p>
            Nothing to install, and nothing disappears when a session ends. The
            files, software and history stay with the project.
          </p>
        </div>
        <div className="hp-tiles">
          {TILES.map((tile) => (
            <a
              key={tile.title}
              className="hp-tile"
              href={appPath(tile.href)}
              style={{ color: "inherit", textDecoration: "none" }}
            >
              <span className="hp-glyph" aria-hidden="true">
                {tile.glyph}
              </span>
              <h3>{tile.title}</h3>
              <p>{tile.body}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="hp-section" aria-labelledby="hp-agents">
        <div className="hp-split">
          <div className="hp-head">
            <span className="hp-eyebrow">Agents with a real computer</span>
            <h2 id="hp-agents">They don't just suggest. They do the work.</h2>
            <p>
              Codex and Claude Code run commands, start servers and test web
              apps in your project. When a site needs you to sign in, take over
              the browser, then hand it back.
            </p>
            <ul>
              <li>Watch the agent's browser live</li>
              <li>Read every command and change</li>
              <li>Stop it, or continue yourself, at any point</li>
            </ul>
          </div>
          <figure>
            <img
              src={appPath("/public/landing/project-web-browser-20261011.jpg")}
              width={1600}
              height={800}
              loading="lazy"
              decoding="async"
              alt="A CoCalc project's web browser showing arXiv's number theory listings, with a banner saying the agent is driving and a Take over button"
            />
          </figure>
        </div>
      </section>

      <section className="hp-section" aria-labelledby="hp-loop">
        <div className="hp-head">
          <span className="hp-eyebrow">How work moves</span>
          <h2 id="hp-loop">From a question to a result anyone can pick up.</h2>
        </div>
        <ol
          className="hp-timeline"
          style={{ listStyle: "none", padding: 0, margin: 0 }}
        >
          {STEPS.map((step) => (
            <li className="hp-step" key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="hp-final" aria-labelledby="hp-final">
        <div>
          <h2 id="hp-final" style={{ fontSize: "clamp(26px,3vw,36px)" }}>
            Start a project. Invite a person, or an agent.
          </h2>
          <p>
            For coursework, research, papers and the apps you build along the
            way.
          </p>
        </div>
        <div className="hp-actions">
          <Button type="primary" size="large" href={appPath(primary.href)}>
            {primary.label}
          </Button>
          <Button size="large" href={appPath("features")}>
            Explore features
          </Button>
        </div>
      </section>
    </div>
  );
}
