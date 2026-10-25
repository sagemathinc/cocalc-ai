/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const NOTEBOOK_SECURITY_BODY = String.raw`
## Short answer

Classic Jupyter asks whether you **trust** a notebook because it renders a
notebook's active output (HTML, JavaScript, widgets) inside the same web page
that holds your login. Trusting a notebook lets its code use your login: it
can read and change your files and projects, and do anything else you can do
in the app.

CoCalc takes a different approach: **no notebook content runs as code in the
CoCalc page.** Content that is only text and formatting (sanitized HTML,
Markdown, LaTeX) is shown in the page as inert markup. Anything that runs
(JavaScript, widgets, HTML that sanitizing would change) runs in a sandboxed
frame that cannot reach your session, your files or other notebooks. With
nothing left for a trust decision to protect, CoCalc has no Trust button.
Leaving it out is a security decision, not the absence of one.

## Why a trust switch is the wrong tool in a collaborative notebook

A trust switch asks a person to judge whether a notebook's outputs are safe.
In CoCalc that judgment is rarely possible:

- Notebooks are shared and edited in real time. A collaborator, or a student
  in a course, can change outputs after you decided to trust the notebook.
- Saved outputs and widget state are data anyone with edit access can write.
  They don't have to come from code you ran.
- CoCalc used to mark a notebook trusted as soon as you ran any cell, so in
  practice almost every notebook was trusted.
- Trust applies to a whole notebook, while a single output can be enough to
  cause harm.

So instead of asking you, CoCalc isolates the content.

## What CoCalc does instead

All of this is automatic:

- **HTML output** renders inline only after sanitizing, when sanitizing
  doesn't change how it looks. Otherwise (for example, output with its own
  \`<style>\` or \`<script>\`, such as a Plotly figure) it renders in a sandboxed
  frame with its own isolated origin, which can't read the CoCalc page or your
  session. Scripts in that HTML run inside the frame when it is shown.
- **CSS in output** applies only to that output. A \`<style>\` in one output
  can't restyle the notebook, other outputs or CoCalc itself, so the classic
  Jupyter trick of displaying CSS to change the notebook's layout has no
  effect. A frame starts with the notebook's own look (font, colors, links,
  headings, tables, light or dark theme), so framed output looks like the
  rest of the notebook unless its own CSS says otherwise.
- **JavaScript output** (the \`application/javascript\` output type, used for
  example by Bokeh) always runs in a sandboxed frame together with its cell's
  HTML, never in the CoCalc page. It runs as soon as it is shown, like
  scripts in HTML output and widgets: isolation, not a click, is what keeps
  you safe.
- **Widgets** (ipywidgets, including third-party widget libraries): each
  displayed widget runs in its own sandboxed frame, as soon as it is shown.
  A widget frame sees the notebook's widget state, which is shared with
  everyone working on the notebook anyway. It talks to the notebook only
  through a narrow channel that CoCalc checks: it can change the values of
  widgets in the notebook (never what kind of widget they are), and send
  widget messages to the kernel for the widgets it displays. It cannot do
  anything else in CoCalc.
- **Markdown** is always sanitized.
- **Printing** produces a passive document: scripts are blocked.
- **Download as HTML** produces a file with scripts disabled.
- **Read-only views**, TimeTravel history and public notebook pages don't run
  JavaScript outputs and don't show live widgets. HTML output renders there
  exactly as in the notebook, so a Plotly figure, whose scripts are part of its
  HTML, stays interactive inside its sandboxed frame.

## Files and web apps

The same principle covers HTML files and web apps you run in a project, such as
JupyterLab or your own web server:

- A site can be configured with a separate **content domain**. Then HTML
  files and project apps are served from addresses on that domain, separate
  for each project and each app. They can't read your CoCalc session or
  reach other projects. Links to files are short-lived and can be revoked.
  Opening an app uses a single-use link, so a link copied out of a browser
  can't be used to sign someone else in.
- On sites without a content domain, such as some self-hosted installations,
  HTML files show a safe preview by default, and a **Trusted** option renders
  them fully. That option exists only for files, because without a separate
  domain full rendering runs with the site's address. Project web apps on
  such sites are served from the project host's own address, so only open
  apps from projects you trust.

## What isolation does not do

A sandboxed output or widget is still code that runs in your browser:

- It can use the network, for example to load a plotting library or send its
  own data somewhere.
- It can use CPU and memory, and can draw anything inside its own box. In
  some browsers a busy script can slow down or freeze the whole tab.
- It cannot read your CoCalc session, cookies or the rest of the page. It
  cannot open your files or other notebooks, and cannot act as you in CoCalc.

As with any shared document, think twice before entering secrets into a form
that appears inside a notebook output.

## Questions

**Can I turn the Trust button back on?**
There's nothing to turn on. Outputs render the same for every notebook, and
the isolation doesn't depend on a choice.

**What happens to the trust flag in my .ipynb files?**
It is kept in the file, so other Jupyter tools still see it, but CoCalc
ignores it. \`cocalc project jupyter trust\` only edits that metadata.

**Why does notebook JavaScript run without asking me first?**
Asking would not make you safer. Every script from a notebook, whether in a
JavaScript output, inside HTML output (such as a Plotly figure) or in a
widget, runs in its own sandboxed frame that cannot reach your session,
files or the CoCalc page, no matter who wrote the notebook. A prompt would
only add clicks.
`;
