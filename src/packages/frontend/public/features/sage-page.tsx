/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  featureAsset,
  LinkButton,
} from "./page-components";
import { FeatureInfo, FeatureInfoHeading, ZoomableImage } from "./feature-info";
import { ContextList, FeatureFinalBand } from "./feature-visuals";

const { Paragraph, Title } = Typography;

export default function SageFeaturePage({
  helpEmail,
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("sage");
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Start using SageMath";

  return (
    <Flex vertical gap={36}>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={20}>
              <Title level={2} style={{ margin: 0, maxWidth: 760 }}>
                Use SageMath online, without installing anything.
              </Title>
              <Paragraph
                style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: 720 }}
              >
                Choose a hosted Sage image to run Sage code in notebooks and
                terminals without installing Sage on your computer. SageTeX also
                needs a compatible TeX installation in the project. Native
                CoCalc Plus uses the software installed on your computer.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent={COLORS.RUN}
              items={[
                {
                  icon: "sagemath",
                  label: "SageMath preinstalled in the Sage image",
                },
                { icon: "jupyter", label: "Sage kernel in Jupyter notebooks" },
                { icon: "tex", label: "SageTeX in the LaTeX editor" },
                { icon: "terminal", label: "sage REPL and .sage scripts" },
              ]}
              title="Sage online"
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <div style={{ margin: "0 auto", maxWidth: 940 }}>
          <ZoomableImage
            alt="A Jupyter notebook running the SageMath kernel in CoCalc"
            priority
            src={featureAsset("sagemath-jupyter.png")}
          />
        </div>
      </PublicSection>

      <PublicSection>
        <FeatureInfoHeading
          anchor="a-overview"
          description={
            <>
              A hosted Sage image supplies the Sage runtime for your project.
              Open the project from a browser and check its Sage version and
              dependencies before reproducing an existing calculation.
            </>
          }
        >
          Feature overview
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.RUN}
          alt="Using the SageMath kernel in a Jupyter notebook"
          anchor="a-notebooks"
          icon="jupyter"
          image="sagemath-jupyter.png"
          title="SageMath in Jupyter notebooks"
        >
          <Paragraph>
            Sage images make the <strong>SageMath Jupyter kernel</strong> the
            default: create a SageMath notebook with one click and start
            computing. Symbolic math, number theory, plotting, and the rest of
            Sage work exactly as they do in a local Sage session.
          </Paragraph>
          <Paragraph>
            Because these are CoCalc notebooks, you get{" "}
            <strong>real-time collaboration</strong>, chat anchored to cells,
            and TimeTravel edit history on top. Legacy <code>.sagews</code>{" "}
            worksheets can open through an existing notebook or convert to a new
            one. Conversion omits historical outputs; inspect the source and
            select an available Sage kernel before rerunning. See the{" "}
            <a href={appPath("docs/jupyter/use-jupyter")}>
              worksheet migration notes
            </a>
            .
          </Paragraph>
          <Paragraph>
            <LinkButton href={appPath("features/jupyter-notebook")}>
              More about Jupyter in CoCalc
            </LinkButton>
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_PURPLE}
          anchor="a-versions"
          icon="server"
          title="SageMath preinstalled"
        >
          <Paragraph>
            Pick the Sage image and <strong>SageMath comes preinstalled</strong>
            : the Sage Jupyter kernel, the <code>sage</code> REPL in the
            terminal, <code>.sage</code> script support, and SageTeX for LaTeX
            documents. The components Sage builds on, such as Maxima, GAP, and
            PARI, are included and usable directly.
          </Paragraph>
          <Paragraph>
            You pick the hosted image per project and can switch to an available
            version later. Record the image and Sage version, then check custom
            packages and rerun the calculation after a change.
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
          accent={COLORS.FEATURE_ORANGE}
          alt="A LaTeX document with SageMath computations embedded via SageTeX"
          anchor="a-sagetex"
          icon="tex"
          image="cocalc-sagemath-sagetex.png"
          title="SageTeX: Sage inside LaTeX documents"
        >
          <Paragraph>
            Embed Sage computations and plots directly in a paper or handout.
            The <a href={appPath("features/latex-editor")}>LaTeX editor</a>{" "}
            detects <code>sagetex.sty</code> and{" "}
            <strong>runs the Sage pass automatically</strong> as part of the
            build, in an image that provides both Sage and TeX Live.
          </Paragraph>
          <Paragraph>
            No more copying output from a Sage session into your document by
            hand: <strong>results update when the document rebuilds</strong>,
            and collaborators see the same compiled PDF.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_BLUE}
          anchor="a-commandline"
          icon="terminal"
          title="The sage REPL and .sage scripts"
        >
          <Paragraph>
            In a project with Sage installed on the PATH, open a{" "}
            <a href={appPath("features/terminal")}>terminal</a> and run{" "}
            <code>sage</code>: use the <strong>interactive Sage REPL</strong>,
            run <code>.sage</code> scripts, or install extra packages into the
            session.
          </Paragraph>
          <Paragraph>
            Long computations can continue after you close the browser while the
            project runtime remains running. The terminal is shared: a
            collaborator can open the same session and inspect its output.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_RED}
          alt="Grading a SageMath notebook with nbgrader in a CoCalc course"
          anchor="a-teaching"
          icon="graduation-cap"
          image="sage-nbgrader.png"
          title="Teach with SageMath"
        >
          <Paragraph>
            Configure the course's student projects with the intended Sage image
            so students can start from a common version. Verify additional
            package requirements in those projects; sharing an image does not
            keep later package changes identical.
          </Paragraph>
          <Paragraph>
            The{" "}
            <a href={appPath("features/teaching")}>course management tools</a>{" "}
            distribute and collect assignments, and{" "}
            <strong>nbgrader works with SageMath notebooks</strong>. Choose
            student projects or a specific grading project in the course's
            nbgrader configuration, and ensure the selected location has the
            required Sage kernel and dependencies. See the{" "}
            <a href="https://cocalc.ai/docs/teaching/nbgrader">
              nbgrader workflow
            </a>
            .
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Create a project on a Sage image and start computing in a notebook, a terminal, or a LaTeX document.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Ready to run Sage in your browser?",
          }}
          relatedLinks={[
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            { href: appPath("features/latex-editor"), label: "LaTeX editor" },
            {
              href: appPath("features/software-environment"),
              label: "Software environments",
            },
            { href: appPath("features/teaching"), label: "Teaching" },
            ...(helpEmail
              ? [{ href: `mailto:${helpEmail}`, label: "Contact support" }]
              : []),
          ]}
          title="When SageMath belongs in CoCalc"
        >
          <Paragraph style={{ margin: 0 }}>
            William Stein, the founder of SageMath, is also the founder of
            SageMath, Inc., the company behind CoCalc, and works full-time on
            CoCalc.
          </Paragraph>
          <BulletList
            items={[
              "When a hosted Sage image fits better than maintaining a local installation.",
              "When a paper or handout should embed live Sage output via SageTeX in the collaborative LaTeX editor.",
              "When several people need to run, review, or continue the same computation in one shared project.",
              "When a course needs free open-source mathematics software that students can use without installing anything.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
