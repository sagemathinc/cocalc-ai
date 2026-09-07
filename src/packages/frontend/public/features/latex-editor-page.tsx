/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  PUBLIC_COLORS,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import {
  featureAppPath as appPath,
  featureSignUpPath,
  featureAsset,
  LinkButton,
} from "./page-components";
import { FeatureInfo, FeatureInfoHeading, ZoomableImage } from "./feature-info";
import { ContextList, FeatureFinalBand } from "./feature-visuals";

const { Paragraph, Text, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  border: 0,
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  height: 1,
  overflow: "hidden",
  position: "absolute",
  whiteSpace: "nowrap",
  width: 1,
};

const FIT_BUTTON_STYLE: CSSProperties = { width: "fit-content" };
const LEAD_STYLE: CSSProperties = {
  fontSize: PUBLIC_TYPE.lead,
  margin: 0,
};
const NO_MARGIN_STYLE: CSSProperties = { margin: 0 };
const FIT_PANEL_STYLE: CSSProperties = {
  background: PUBLIC_COLORS.surfaceMuted,
  border: `1px solid ${PUBLIC_COLORS.border}`,
  borderRadius: PUBLIC_RADIUS.panel,
  padding: 18,
};

const FIT_DECISION_ROWS = [
  ["Keyboard-driven offline craft", "Local TeX editor"],
  ["Collaborative paper editing", "Any hosted LaTeX editor, including CoCalc"],
  ["Paper plus computation, history, agents", "CoCalc"],
] as const;

function LatexFitTable() {
  return (
    <table
      aria-describedby="cocalc-latex-fit-table-caption"
      aria-label="LaTeX environment fit decisions"
      style={{
        borderCollapse: "separate",
        borderSpacing: "0 10px",
        width: "100%",
      }}
    >
      <caption
        id="cocalc-latex-fit-table-caption"
        style={VISUALLY_HIDDEN_STYLE}
      >
        Each row compares a writing task with the environment that best fits it.
      </caption>
      <thead>
        <tr>
          <th scope="col" style={VISUALLY_HIDDEN_STYLE}>
            Writing task
          </th>
          <th scope="col" style={VISUALLY_HIDDEN_STYLE}>
            Best fit
          </th>
        </tr>
      </thead>
      <tbody>
        {FIT_DECISION_ROWS.map(([task, fit]) => {
          const isCocalc = fit === "CoCalc";
          const background = isCocalc
            ? PUBLIC_COLORS.surfaceMuted
            : PUBLIC_COLORS.surface;
          const cellStyle: CSSProperties = {
            background,
            borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
            borderTop: `1px solid ${PUBLIC_COLORS.border}`,
            padding: 12,
            textAlign: "left",
          };

          return (
            <tr key={task}>
              <th
                scope="row"
                style={{
                  ...cellStyle,
                  borderLeft: `1px solid ${PUBLIC_COLORS.border}`,
                  borderRadius: `${PUBLIC_RADIUS.panel}px 0 0 ${PUBLIC_RADIUS.panel}px`,
                  fontWeight: 400,
                }}
              >
                <Text>{task}</Text>
              </th>
              <td
                style={{
                  ...cellStyle,
                  borderLeft: 0,
                  borderRadius: `0 ${PUBLIC_RADIUS.panel}px ${PUBLIC_RADIUS.panel}px 0`,
                  borderRight: `1px solid ${PUBLIC_COLORS.border}`,
                }}
              >
                <Text strong>{fit}</Text>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export default function LatexEditorFeaturePage({
  helpEmail,
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("latex");
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start writing LaTeX on CoCalc";

  return (
    <Flex vertical gap={36}>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={20}>
              <Title level={2} style={NO_MARGIN_STYLE}>
                An online LaTeX editor with a full project behind it
              </Title>
              <Paragraph style={LEAD_STYLE}>
                Coauthors edit in real time, with builds and full history in one
                project.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/cocalc-for-latex/`}>
                  Read the LaTeX guide
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent="#ad6800"
              items={[
                { icon: "users", label: "Real-time collaborative editing" },
                { icon: "comment", label: "Chat anchored to source lines" },
                {
                  icon: "calculator",
                  label: "Knitr, PythonTeX, and SageTeX support",
                },
                { icon: "history", label: "TimeTravel for quick recovery" },
              ]}
              title="Highlights"
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <Flex vertical gap={36}>
          <Row gutter={[24, 24]} align="top">
            <Col xs={24} lg={12}>
              <ZoomableImage
                alt="CoCalc LaTeX editor with a knitr .Rnw document: R code chunks in the source and the compiled PDF with the generated plot"
                priority
                src={featureAsset("latex-intro-rnw-20260730.png")}
              />
            </Col>
            <Col xs={24} lg={12}>
              <Flex vertical gap={12}>
                <Title level={3} style={NO_MARGIN_STYLE}>
                  A full workspace, not one document
                </Title>
                <Paragraph style={NO_MARGIN_STYLE}>
                  A CoCalc project is a complete file system, like on your own
                  computer: keep <strong>any number of LaTeX documents</strong>{" "}
                  in one project, typically a directory per paper, together with
                  figures, bibliographies, scripts, notebooks, and build logs.
                </Paragraph>
                <Paragraph style={NO_MARGIN_STYLE}>
                  Documents can reference shared files, and coauthors work in
                  the same project. Writing LaTeX here feels like working on a{" "}
                  <strong>shared desktop computer</strong>, not a confined
                  single-document session.
                </Paragraph>
                <Button href={appPath("features/ai")} style={FIT_BUTTON_STYLE}>
                  AI assistance
                </Button>
              </Flex>
            </Col>
          </Row>
          <div className="cocalc-latex-fit-panel" style={FIT_PANEL_STYLE}>
            <Row gutter={[18, 18]} align="middle">
              <Col xs={24} lg={11}>
                <Flex vertical gap={10}>
                  <Text strong>
                    Choose the writing environment around the task
                  </Text>
                  <Paragraph style={NO_MARGIN_STYLE}>
                    Any hosted LaTeX editor gives you collaborative paper
                    editing, and CoCalc does too. The difference: in CoCalc the
                    paper can also depend on computation, project files,
                    command-line tools, full history, and agent help without
                    leaving the project.
                  </Paragraph>
                  <LinkButton href={appPath("products")}>
                    Compare operating models
                  </LinkButton>
                </Flex>
              </Col>
              <Col xs={24} lg={13}>
                <LatexFitTable />
              </Col>
            </Row>
          </div>
        </Flex>
      </PublicSection>

      <PublicSection>
        <FeatureInfoHeading
          anchor="a-overview"
          description={
            <>
              Everything you expect from a full online LaTeX editor, inside a
              project that can also run the computations your document uses.
            </>
          }
        >
          Feature overview
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#389e0d"
          alt="Two users editing the same LaTeX file with visible cursors"
          anchor="a-collaboration"
          icon="users"
          image="latex-editor-realtime-sync-20251003.png"
          title="Real-time collaboration"
        >
          <Paragraph>
            Coauthors <strong>edit the same file at the same time</strong>: you
            see each other's cursors and changes as they type. Compilation
            status and the PDF output are synchronized too, so everyone
            experiences the document in exactly the same way.
          </Paragraph>
          <Paragraph>
            The document <strong>compiles automatically</strong> on save and
            problems are marked directly in the source file.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#7c3aed"
          alt="The same LaTeX file in the classic source view and in the rich text view, with formulas typeset and commands shown as chips"
          anchor="a-rich-text"
          caption={
            <>
              The same file in the classic source view (left) and as rich text
              (right): typeset formulas, text styles, and command chips.
            </>
          }
          icon="magic"
          image="latex-source-vs-widgets-20260730.png"
          title="Rich text editing, real LaTeX"
        >
          <Paragraph>
            You can edit your document as <strong>rich text</strong>: formulas
            and formatted text render as they appear in the final document,
            while you are still editing the LaTeX file itself. Switch between
            rich text and the classic source view at any time.
          </Paragraph>
          <Paragraph>
            Editing stays direct: put the cursor in a line and that line shows
            its plain LaTeX, ready to change. Labels, references, and titles
            appear as tidy interactive chips.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#096dd9"
          alt="The edit-formula dialog with a plain-language request, the agent working on the left, and the reworked formula computed step by step in the editor"
          anchor="a-formula-agent"
          caption={
            <>
              Ask in plain language (dialog); the agent reworks the formula in
              the live document.
            </>
          }
          icon="robot"
          image="latex-formula-agent-20260730.png"
          title="Edit formulas with the AI agent"
        >
          <Paragraph>
            In an editable Rich Text pane, Shift-click a rendered math formula,
            or focus it and press Shift+Enter, to open the agent edit dialog.{" "}
            <strong>Describe the change in plain language</strong>, like "turn
            this into the integral from 0 to 1 and calculate it step by step".
          </Paragraph>
          <Paragraph>
            The agent edits the live document: the formula is rewritten in
            place, in proper LaTeX, and the widgets view shows the typeset
            result right away.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#ad6800"
          alt="Video showing forward and inverse search between LaTeX source and PDF"
          anchor="a-forward-inverse"
          icon="sync"
          title="Forward and inverse search"
          video={[
            "latex-forward-inverse-20251006.webm",
            "latex-forward-inverse-20251006.mp4",
          ]}
        >
          <Paragraph>
            Navigate effortlessly between source and PDF, powered by SyncTeX.
          </Paragraph>
          <Paragraph>
            <strong>Forward search:</strong> click in your LaTeX source to jump
            to the corresponding place in the PDF preview.
          </Paragraph>
          <Paragraph>
            <strong>Inverse search:</strong> double-click anywhere in the PDF to
            jump back to the matching line in the source, even when it lives in
            an included subfile.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          alt="LaTeX source with a chat thread anchored to a line, showing an unread pill, a label chip, and a bookmark"
          anchor="a-anchored-chat"
          caption={
            <>
              A chat thread anchored to a line of the source. The red unread
              pill appears right where the conversation is.
            </>
          }
          icon="comment"
          image="latex-chat-notification-20260730.png"
          title="Chat and bookmarks anchored to your source"
        >
          <Paragraph>
            Pin a discussion to an exact place in the file:{" "}
            <strong>anchored chat threads</strong> attach to a line of your
            LaTeX source and move with the text as the document evolves. Unread
            pills show up right where the conversation is, collaborators get
            notified, and threads can be resolved once the point is settled.
          </Paragraph>
          <Paragraph>
            <strong>Collaborative bookmarks</strong> mark important spots for
            the whole team, and both anchors and bookmarks appear in the table
            of contents, across multi-file documents too.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#389e0d"
          alt="LaTeX source with PythonTeX code and the compiled PDF with a computed plot"
          anchor="a-computation"
          icon="calculator"
          image="latex-editor-pythontex-20251003.png"
          title="Computed results inside your document"
        >
          <Paragraph>
            <strong>Execute Python, SageMath, or R code</strong> directly within
            your LaTeX source to generate figures, tables, and results. CoCalc
            supports SageTeX, PythonTeX, and Knitr, orchestrating the full
            compilation pipeline automatically. Change your code, recompile, and
            your paper updates.
          </Paragraph>
          <Paragraph>
            Your analysis and your prose live in the same project, which makes
            the paper <strong>reproducible</strong> instead of a copy-paste
            destination.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          alt="Multi-file LaTeX document with a table of contents spanning subfiles, including bookmark and chat entries, next to the compiled PDF"
          anchor="a-multifile"
          caption={
            <>
              One table of contents across <code>main.tex</code> and its
              subfiles: sections, bookmarks, and chat anchors from every
              included file, next to the live PDF.
            </>
          }
          icon="folder-open"
          image="latex-widgets-chat-bookmark-20260730.png"
          title="Multi-file documents"
        >
          <Paragraph>
            Large documents split across files with <code>\include</code> and{" "}
            <code>\input</code> are <strong>discovered automatically</strong>,
            with easy navigation between all parts of the document.
          </Paragraph>
          <Paragraph>
            Inverse search opens the correct subfile for you, and anchored chats
            and bookmarks work across included files as well.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          alt="LaTeX editor and inverted PDF preview in dark mode"
          anchor="a-darkmode"
          icon="eye-slash"
          image="latex-editor-darkmode-20251003.png"
          title="Dark mode with PDF support"
        >
          <Paragraph>
            The editor features dark UI elements as you'd expect, and goes
            further by <strong>inverting the PDF preview colors</strong>. Your
            final PDF keeps its white background, but you can write and review
            it as bright text on dark for comfortable night-time work.
          </Paragraph>
          <Paragraph>
            The PDF dark mode can be toggled off instantly to double-check the
            actual output.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#ad6800"
          alt="Menu showing the LaTeX build engines available in CoCalc"
          anchor="a-build"
          caption="Pick an engine from the menu, or take over the full build command."
          icon="tex"
          image="latex-custom-command-02.png"
          title="A managed LaTeX build"
        >
          <Paragraph>
            You don't have to know how a LaTeX document gets built:{" "}
            <strong>CoCalc takes care of it</strong>. LatexMK runs the right
            engine the right number of times, together with bibliographies and
            the Knitr, PythonTeX, or SageTeX steps your document needs, so a
            plain "Build" just works.
          </Paragraph>
          <Paragraph>
            <strong>Power users stay in control</strong>: pick PDFLaTeX,
            XeLaTeX, or LuaTeX from the menu, edit the full build command, or
            plug in your own shell script or Makefile. Build directives in the
            source work too.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#7c3aed"
          alt="TimeTravel slider showing changes in a LaTeX document"
          anchor="a-timetravel"
          icon="history"
          image="latex-editor-timetravel-01.png"
          title="TimeTravel: every change, recorded"
        >
          <Paragraph>
            TimeTravel <strong>records all changes</strong> to the document in
            fine detail. Move across thousands of revisions with a slider to
            recover earlier edits and see who changed what.
          </Paragraph>
          <Paragraph>
            Especially helpful for pinpointing which recent change caused a
            compilation error.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project, create a .tex file, and keep the paper beside the work that supports it.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Ready to write LaTeX in CoCalc?",
          }}
          relatedLinks={[
            {
              href: `${GUIDE_BASE}/cocalc-for-latex/`,
              label: "LaTeX guide",
            },
            {
              href: `${GUIDE_BASE}/paper-polishing/`,
              label: "Paper polishing workflow",
            },
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            { href: appPath("features/terminal"), label: "Terminal workflows" },
            { href: appPath("products"), label: "Compare operating models" },
            ...(helpEmail
              ? [{ href: `mailto:${helpEmail}`, label: "Contact support" }]
              : []),
          ]}
          title="Where LaTeX belongs in the project"
        >
          {null}
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
