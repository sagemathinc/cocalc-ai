/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { COLORS } from "@cocalc/util/theme";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  featureAsset,
  LinkButton,
} from "./page-components";
import { FeatureInfo, FeatureInfoHeading, ZoomableImage } from "./feature-info";
import { FeatureFinalBand } from "./feature-visuals";

const { Paragraph, Title } = Typography;

const OCTAVE_KERNEL_GUIDE = "docs/jupyter/install-octave-kernel";
const OCTAVE_IMAGE = "rootfs/octave-11-3";

export default function OctaveFeaturePage({
  helpEmail,
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("code");
  const primaryLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalLabel = isAuthenticated ? "Open projects" : "Start using Octave";

  return (
    <Flex vertical gap={36}>
      <PublicSection>
        <Row align="top" gutter={[28, 28]}>
          <Col xs={24} lg={11}>
            <Flex vertical gap={14}>
              <Title level={2} style={{ margin: 0 }}>
                Run GNU Octave online in a project you control.
              </Title>
              <Paragraph style={{ fontSize: PUBLIC_TYPE.lead, margin: 0 }}>
                Octave is the free numerical computing language that is largely
                compatible with MATLAB. Choose an available Octave image for its
                packages and Jupyter kernel, or follow the kernel setup guide to
                install Octave in a compatible project environment.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryHref}>
                  {primaryLabel}
                </Button>
                <LinkButton href={appPath(OCTAVE_IMAGE)}>
                  See the Octave image
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={13}>
            <ZoomableImage
              alt="An Octave session in a CoCalc terminal: matrix work and a plot drawn as text"
              priority
              src={featureAsset("cocalc-octave-terminal-20260811.png")}
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <FeatureInfoHeading
          anchor="a-overview"
          description={
            <>
              The hosted image supplies Octave, while collaborators work with
              shared project files and edit history. System installation
              permissions and snapshot coverage depend on the selected image and
              deployment. Native CoCalc Plus uses your computer's operating
              system and installed tools.
            </>
          }
        >
          Octave in a full Linux environment
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_OCTAVE_BLUE}
          alt="A 3D sombrero surface plotted by Octave in a CoCalc Jupyter notebook"
          anchor="a-notebooks"
          icon="jupyter"
          image="cocalc-octave-sombrero-20260811.png"
          title="Octave in Jupyter notebooks"
        >
          <Paragraph>
            On the Octave image, <strong>Octave is the default kernel</strong>{" "}
            for new notebooks: run cells, render plots inline, and keep
            narrative text next to the code. A Python kernel is there too, for
            the parts that are easier in Python.
          </Paragraph>
          <Paragraph>
            The notebook itself is a collaborative CoCalc document:{" "}
            <strong>real-time editing with visible cursors</strong>, chat
            threads anchored to cells, and TimeTravel document edit history. The{" "}
            <a href={appPath("features/jupyter-notebook")}>
              Jupyter notebooks page
            </a>{" "}
            covers the editor in detail.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_TEAL}
          alt="An Octave notebook integrating a function symbolically and plotting it with its antiderivative"
          anchor="a-image"
          icon="cube"
          image="cocalc-octave-symbolic-20260811.png"
          title="Octave, with the packages you expect"
        >
          <Paragraph>
            The <a href={appPath(OCTAVE_IMAGE)}>Octave image</a> is{" "}
            <strong>built from source</strong> and ships the common Octave
            packages: statistics, control, signal, image, optim, and symbolic.
            Jupyter kernels for Octave and Python come with it, and JupyterLab
            starts from the project's Apps panel.
          </Paragraph>
          <Paragraph>
            Pick an available Octave image when creating a hosted project, or
            check dependencies before switching an existing project to it.
            Packages under HOME and system packages in the runtime filesystem
            have different restore and image-change considerations. Record
            package versions and installation locations, and check the
            configured backup coverage. System installs also require the
            appropriate permissions. To add Octave to a different image, follow
            the <a href={appPath(OCTAVE_KERNEL_GUIDE)}>kernel setup guide</a>.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.RUN}
          anchor="a-scripts"
          icon="terminal"
          title=".m files, plots, and the command line"
        >
          <Paragraph>
            <code>.m</code> files open in the collaborative code editor with{" "}
            <strong>Octave syntax highlighting</strong>, and the editor's Shell
            button starts <code>octave</code> in a pane right next to your file.
          </Paragraph>
          <Paragraph>
            Longer runs belong in the{" "}
            <a href={appPath("features/terminal")}>terminal</a>:{" "}
            <strong>sessions can survive browser disconnects</strong> while the
            project runtime remains running. Save intermediate results and plan
            how to restart an interrupted calculation.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project and keep the numerical work in one durable place.",
            href: primaryHref,
            label: finalLabel,
            title: "Start in a project",
          }}
          relatedLinks={[
            { href: appPath(OCTAVE_IMAGE), label: "Octave image" },
            {
              href: appPath(OCTAVE_KERNEL_GUIDE),
              label: "Octave setup guide",
            },
            {
              href: appPath("features/software-environment"),
              label: "Software environments",
            },
            { href: appPath("features/linux"), label: "Linux environment" },
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            { href: appPath("features/teaching"), label: "Teaching" },
            ...(helpEmail
              ? [{ href: `mailto:${helpEmail}`, label: "Contact support" }]
              : []),
          ]}
          title="When Octave belongs in CoCalc"
        >
          <BulletList
            items={[
              "Numerical research and prototyping that benefits from shared files and history.",
              "Work that mixes Octave with notebooks, data, and write-ups in one project.",
              "A team that opens each other's Octave work and reviews it together.",
              "A numerical course whose student projects are configured with the intended Octave image and packages.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
