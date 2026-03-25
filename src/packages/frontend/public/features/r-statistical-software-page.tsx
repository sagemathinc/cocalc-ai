/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  FeatureImage,
  featureAppPath as appPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

export default function RStatisticalSoftwareFeaturePage({
  helpEmail,
}: {
  helpEmail?: string;
}) {
  return (
    <Flex vertical gap={18}>
      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Text strong type="secondary">
                R STATISTICAL SOFTWARE
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Use R in notebooks, terminals, and reproducible document
                workflows
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc supports R across Jupyter notebooks, command-line work,
                RMarkdown-style documents, and LaTeX/Knitr workflows.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That makes it possible to keep data exploration, collaboration,
                and report writing in the same online project.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <Button href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </Button>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="R in a Jupyter notebook"
              src="/public/features/cocalc-r-jupyter.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Zero-setup R for teaching and analysis
            </Title>
            <BulletList
              items={[
                "Start with a working online R environment.",
                "Use R in notebooks, the terminal, and document-generation workflows.",
                "Avoid repeating local R and package setup on every machine.",
                "Keep the environment shareable for collaborators and students.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              CoCalc reduces the operational overhead so people can focus on the
              statistical or data-analysis work itself.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Full workflow, not just a notebook
            </Title>
            <Paragraph style={{ margin: 0 }}>
              R work often spans more than a single notebook. Data files,
              reports, scripts, discussions, and publication outputs all need to
              stay coordinated.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              CoCalc is useful here because it keeps those pieces in one
              project.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Collaborative R notebook work"
              src="/public/features/cocalc-r-jupyter-collaborate.png"
            />
          </Col>
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Tag
                color="blue"
                style={{
                  alignSelf: "flex-start",
                  background: COLORS.ANTD_BG_BLUE_L,
                  color: COLORS.BLUE_D,
                }}
              >
                Collaborative analysis
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Work on the same R analysis together
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc&apos;s notebook and chat workflows make it practical to
                collaborate on R analysis, teaching materials, and statistical
                reports in real time.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This is especially valuable for teams and courses that need a
                common environment plus a shared view of the current work.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="R and LaTeX integration in CoCalc"
              src="/public/features/cocalc-r-latex.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              LaTeX, Knitr, and document generation
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc&apos;s LaTeX editor works well for R-enhanced document
              generation, including Knitr-style workflows where code and prose
              are part of the same technical document.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That makes it easier to keep analysis and reporting tightly
              coupled.
            </Paragraph>
            <LinkButton href={appPath("features/latex-editor")}>
              LaTeX editor
            </LinkButton>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="R environment in CoCalc"
              src="/public/features/cocalc-r-environment.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Project-wide R environment
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Whether you are working in R code, notebooks, or generated
              reports, the surrounding project gives you access to the same
              files, supporting scripts, and collaboration tools.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That is the difference between an online R demo and a usable
              shared workspace.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why use R on CoCalc
        </Title>
        <BulletList
          items={[
            "Notebook, terminal, and document workflows in one place.",
            "Collaboration and chat around statistical work.",
            "Practical support for R-enhanced technical documents.",
            "A managed shared environment for classes and teams.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button href={appPath("features/python")}>Python</Button>
          <Button href={appPath("features/teaching")}>Teaching</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
