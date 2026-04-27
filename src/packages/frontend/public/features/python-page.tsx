/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { PublicSectionCard } from "@cocalc/frontend/public/layout/shell";
import { COLORS } from "@cocalc/util/theme";
import {
  BulletList,
  FeatureImage,
  featureAppPath as appPath,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

export default function PythonFeaturePage({
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
                PYTHON WORKFLOWS
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Run Python notebooks, scripts, and experiments in one shared
                environment
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc makes Python useful across notebooks, terminals, code
                editors, chat, and course workflows instead of forcing you to
                pick only one mode of work.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                The result is a Python environment that is immediately usable
                for teaching, data science, research, and collaborative
                development, with fewer setup problems and more shared context.
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
              alt="Editing Python code in CoCalc"
              src="/public/features/frame-editor-python.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Zero-setup Python for technical work
            </Title>
            <BulletList
              items={[
                "Start with a working Python environment in the browser.",
                "Use notebooks, scripts, terminals, and documents in the same project.",
                "Avoid repeating local installation and package setup on every machine.",
                "Keep the environment shareable for classes and collaborators.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This is especially valuable in teaching and team settings, where
              the cost of everyone managing their own inconsistent local Python
              stack adds up quickly.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Broad scientific and data workflow support
            </Title>
            <BulletList
              items={[
                "Data science and machine learning workflows.",
                "Scientific computing and symbolic mathematics.",
                "Statistical analysis and visualization.",
                "Teaching workflows built around executable notebooks and scripts.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              CoCalc is strongest when Python is part of a larger technical
              environment, not just an isolated interpreter.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Python in Jupyter notebooks on CoCalc"
              src="/public/features/cocalc-python-jupyter.png"
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
                Notebook-first workflows
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Python in Jupyter is a core use case
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc&apos;s collaborative notebook system is especially strong
                for Python, whether you are teaching, building a data science
                workflow, or doing exploratory computational work.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                The same `.ipynb` format remains compatible with the broader
                Jupyter ecosystem while adding collaboration, history, and
                course workflows around it.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Realtime collaborative Python notebook editing"
              src="/public/features/cocalc-real-time-jupyter.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Collaboration and help in context
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Python collaboration in CoCalc is not just version control after
              the fact. People can work in the same files and notebooks, add
              chat beside the work, and debug from a shared view of the current
              state.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That is useful for data science teams, students and TAs, and
              anyone doing technical support or pair work.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="PythonTeX workflow inside CoCalc"
              src="/public/features/cocalc-latex-pythontex.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Python also fits into document workflows
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Python is not limited to notebooks. It can also be part of LaTeX
              and report-generation workflows, including PythonTeX-style
              documents that mix code, computation, and technical writing.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              This is one of the reasons a unified project environment matters:
              code, notebooks, and documents can evolve together.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why people choose CoCalc for Python
        </Title>
        <BulletList
          items={[
            "Immediate Python workflows in notebooks, scripts, and terminals.",
            "A shared environment for collaboration, teaching, and support.",
            "History, chat, and project structure around the code instead of only a notebook tab.",
            "A broad technical stack that lets Python connect to the rest of the project.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button href={appPath("features/terminal")}>Linux terminal</Button>
          <Button href={appPath("features/latex-editor")}>LaTeX editor</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
