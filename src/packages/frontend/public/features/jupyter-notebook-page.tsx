/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { CodeBlock } from "@cocalc/frontend/public/common";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  featureAsset,
  LinkButton,
} from "./page-components";
import { FeatureInfo, FeatureInfoHeading, ZoomableImage } from "./feature-info";
import { ContextList, FeatureFinalBand, StoryCard } from "./feature-visuals";

const { Paragraph, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

export default function JupyterNotebookFeaturePage({
  helpEmail,
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("jupyter-python");
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start using Jupyter in CoCalc";

  return (
    <Flex vertical gap={36}>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={20}>
              <Title level={2} style={{ margin: 0 }}>
                Online Jupyter notebooks, built for collaboration
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Collaborative Jupyter notebooks in your browser. Computations
                can continue after you close the tab while the kernel runtime
                remains running, and collaborators and Codex can inspect the
                session.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={`${GUIDE_BASE}/jupyter-notebooks/`}>
                  Read the Jupyter guide
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent="#f37726"
              items={[
                {
                  icon: "stopwatch",
                  label: "Close the tab while the kernel keeps running",
                },
                { icon: "comment", label: "Chat anchored to any cell" },
                {
                  icon: "history",
                  label: "TimeTravel document edit history",
                },
                {
                  icon: "server",
                  label: "Python, R, Julia, and SageMath kernels",
                },
              ]}
              title="Highlights"
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <div style={{ margin: "0 auto", maxWidth: 940 }}>
          <ZoomableImage
            alt="A Jupyter notebook in CoCalc with code cells, printed output, a matplotlib plot, and a minimap of the notebook on the right"
            priority
            src={featureAsset("jupyter-classic-20260817.png")}
          />
        </div>
      </PublicSection>

      <Row className="cocalc-jupyter-story-row" gutter={[16, 16]}>
        <Col xs={24} md={8}>
          <StoryCard icon="stopwatch" title="Keep runs alive">
            Closing a tab does not stop the shared kernel. Keep its runtime
            running and save intermediate results so you can recover if the
            kernel or project stops.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard accent="#389e0d" icon="users" title="Work together live">
            Everyone edits with visible cursors and shares the same kernel
            session, with no screen-share workarounds.
          </StoryCard>
        </Col>
        <Col xs={24} md={8}>
          <StoryCard
            accent="#7c3aed"
            icon="history"
            title="Review and recover changes"
          >
            TimeTravel keeps document edit history with authorship. Recover work
            and see how an analysis evolved.
          </StoryCard>
        </Col>
      </Row>

      <PublicSection>
        <FeatureInfoHeading
          anchor="a-overview"
          description={
            <>
              CoCalc's collaborative Jupyter notebooks are fully compatible with
              the <code>.ipynb</code> format, and they add what plain Jupyter is
              missing.
            </>
          }
        >
          Feature overview
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#389e0d"
          alt="Two browser windows editing the same Jupyter notebook cell, with the collaborator's cursor and name label visible in the other window"
          anchor="a-collaboration"
          caption={
            <>
              The same cell in two browser windows: each side sees the other
              collaborator's cursor, with a name label, exactly where they are
              typing.
            </>
          }
          icon="users"
          image="jupyter-cursor-sync-20260730.png"
          title="Real-time collaborative editing"
        >
          <Paragraph>
            Share a notebook with collaborators and{" "}
            <strong>edit it together</strong>: everyone sees each other's
            cursors and changes as they type, and you see who is online.
          </Paragraph>
          <Paragraph>
            Collaborators share the notebook's kernel session. Its status and
            results are <strong>synchronized</strong>, including supported
            interactive ipywidgets, so you can inspect the same computation
            together.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          alt="A chat thread anchored to a Jupyter cell, with the unread count on the cell's chat button and the anchored cell shown in the side panel"
          anchor="a-cell-chat"
          caption={
            <>
              A discussion attached to one cell: the cell's chat button shows
              the unread count, and the thread in the side panel links back to
              its cell.
            </>
          }
          icon="comment"
          image="jupyter-cell-chat-20260730.png"
          title="Chat anchored to any cell"
        >
          <Paragraph>
            Start a discussion thread <strong>on a specific cell</strong>. The
            thread stays attached to that cell, an unread badge appears right
            where the conversation is, and collaborators are notified about new
            messages.
          </Paragraph>
          <Paragraph>
            There is also a classic side chat for the notebook as a whole, with
            markdown formatting and LaTeX formulas in messages.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#f37726"
          alt="A Jupyter notebook in the Studio view, with a mini table of contents on the left, rendered cells in the middle, and collapsed source code with a minimap on the right"
          anchor="a-studio"
          caption={
            <>
              The Studio view of a notebook: mini table of contents on the left,
              content in the middle, collapsed source code and a minimap on the
              right.
            </>
          }
          icon="layout"
          image="jupyter-studio-20260817.png"
          title="Jupyter Studio: a content-first notebook view"
        >
          <Paragraph>
            Every notebook can switch between the classic interface and{" "}
            <strong>Jupyter Studio</strong>, a calm view that puts results
            first: outputs and prose get the main column, while the source code
            stays one glance away. A sticky mini table of contents and a minimap
            keep long notebooks navigable, and reading mode hides the code
            entirely when you want to read or present.
          </Paragraph>
          <Paragraph>
            Switch between the views at any time; both work on the same live
            notebook, together with collaborators and anchored chats.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#7c3aed"
          alt="Video of the TimeTravel slider moving through the history of a Jupyter notebook"
          anchor="a-timetravel"
          icon="history"
          title="TimeTravel: document edit history"
          video={[
            "cocalc-jupyter2-timetravel-20170515-3x.webm",
            "cocalc-jupyter2-timetravel-20170515-3x.mp4",
          ]}
        >
          <Paragraph>
            Browse the notebook's recorded revisions and authorship with
            TimeTravel, then copy content you need back into the current
            version. This is document history, not a saved running kernel.
          </Paragraph>
          <Paragraph>
            This makes it easy to recover lost work, review how an analysis
            evolved, or understand what a student or collaborator tried along
            the way.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          alt="The kernel panel of a Jupyter notebook, listing the kernels of the project's software environment with restart, halt, and install controls"
          anchor="a-software"
          caption={
            <>
              The kernel panel: switch between the kernels your software
              environment provides, restart or halt the session, and install
              additional kernels.
            </>
          }
          icon="server"
          image="jupyter-kernel-selector-20260730.png"
          title="Kernels from your software environment"
        >
          <Paragraph>
            Choose a <strong>software environment</strong> that provides your
            language and packages. Hosted images can supply Python, SageMath, R,
            Julia, Octave, and other kernels. Registered{" "}
            <a href={appPath("docs/jupyter/remote-kernels")}>remote kernels</a>{" "}
            can instead run on another machine.
          </Paragraph>
          <Paragraph>
            Hosted project images provide Linux software; native CoCalc Plus
            uses your computer's operating system and installed tools. Select
            the kernel that has the dependencies your notebook needs, or follow
            the{" "}
            <a href={appPath("docs/jupyter/custom-kernels")}>
              custom kernel instructions
            </a>{" "}
            to register another environment.
          </Paragraph>
          <Paragraph>
            <LinkButton href={appPath("features/software-environment")}>
              Learn about software environments
            </LinkButton>
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          alt="A busy Jupyter notebook with live CPU and RAM gauges in the toolbar, a running-time counter on the cell, and a Stop button"
          anchor="a-monitoring"
          caption={
            <>
              A runaway cell: the toolbar gauges show CPU and RAM load, the cell
              displays how long it has been running, and the Stop button
              interrupts it.
            </>
          }
          icon="line-chart"
          image="jupyter-cpu-memory-20260730.png"
          title="CPU and memory monitoring"
        >
          <Paragraph>
            Per-notebook <strong>CPU and memory indicators</strong> help you
            keep an eye on resource consumption before a heavy computation slows
            everything down or terminates the session.
          </Paragraph>
          <Paragraph>
            Use the indicators to decide when to interrupt or restart a kernel.
            They do not prevent resource exhaustion; save intermediate results
            before a long run and remember that restarting clears kernel state.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#389e0d"
          alt="Overview of an nbgrader-enhanced Jupyter notebook"
          anchor="a-nbgrader"
          icon="graduation-cap"
          image="cocalc-jupyter-nbgrader-overview.png"
          title="nbgrader: grading assignments"
        >
          <Paragraph>
            CoCalc's notebooks support both{" "}
            <strong>automatic and manual grading</strong> via nbgrader. The
            teacher's notebook contains exercise and test cells; students run
            some of them for immediate feedback. After collecting assignments,
            instructors run the autograder and review the results. The course's
            nbgrader settings choose whether grading runs in student projects or
            a selected grading project; see the{" "}
            <a href={appPath("docs/teaching/nbgrader")}>nbgrader workflow</a>.
          </Paragraph>
          <Paragraph>
            <LinkButton href={appPath("features/teaching")}>
              Explore the course management workflow
            </LinkButton>
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent="#7c3aed"
          anchor="a-codex"
          icon="robot"
          imageComponent={
            <CodeBlock
              ariaLabel="Project-scoped Jupyter commands"
              code={`cocalc project jupyter cells --path analysis.ipynb
cocalc project jupyter run --path analysis.ipynb --cell-index 3
cocalc project jupyter exec --path analysis.ipynb --stdin`}
            />
          }
          title="Codex works with the live notebook"
        >
          <Paragraph>
            A saved <code>.ipynb</code> file is not the same as the running
            session. In CoCalc, Codex gets{" "}
            <strong>project-scoped notebook commands</strong>: it can list your
            cells, run one, and read the actual outputs and errors.
          </Paragraph>
          <Paragraph>
            That means AI help starts from the{" "}
            <strong>real state of your analysis</strong>, not from guessing what
            a stale file might have produced.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a hosted notebook on CoCalc.ai and bring your team into the same workspace.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Ready to use Jupyter in CoCalc?",
          }}
          relatedLinks={[
            {
              href: `${GUIDE_BASE}/cocalc-for-jupyter/`,
              label: "Compatibility guide",
            },
            { href: appPath("features/terminal"), label: "Terminal workflows" },
            { href: appPath("features/linux"), label: "Linux environment" },
            { href: appPath("features/teaching"), label: "Teaching" },
            { href: appPath("features/whiteboard"), label: "Whiteboards" },
            ...(helpEmail
              ? [{ href: `mailto:${helpEmail}`, label: "Contact support" }]
              : []),
          ]}
          title="Jupyter notebooks, with a whole project behind them"
        >
          <BulletList
            items={[
              <>
                Your notebooks stay standard <code>.ipynb</code> files —
                download them anytime and keep working anywhere.
              </>,
              "The same project gives you terminals, LaTeX documents, files, and Codex right next to the notebook.",
              "For courses, notebooks become assignments: distribute, collect, and grade them with nbgrader.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
