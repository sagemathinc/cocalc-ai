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

export default function AIFeaturePage({ helpEmail }: { helpEmail?: string }) {
  return (
    <Flex vertical gap={18}>
      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={12}>
            <Flex vertical gap={12}>
              <Text strong type="secondary">
                CODING AGENTS
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Use AI where the technical work is already happening
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc&apos;s direction is not generic chat boxes floating next
                to your work. It is coding agents and model-assisted workflows
                embedded directly into the same chats, files, notebooks, and
                collaborative projects where people are already working.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                That means you can ask for help with code, shell commands,
                notebook errors, package installation, documentation, and math
                explanations without copying everything into an external tool
                first.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <LinkButton href="https://doc.cocalc.com/chat.html">
                  Chat and agents
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Coding agent helping fix code in CoCalc chat"
              src="/public/features/chatgpt-fix-code.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Code, explain, and fix in context
            </Title>
            <BulletList
              items={[
                "Explain error messages and suggest the next debugging step.",
                "Generate or rewrite code in the same project where it will actually run.",
                "Help install missing packages and diagnose environment problems.",
                "Turn rough instructions into scripts, notebooks, tests, or documentation.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              The practical value comes from context. When the model is next to
              the file, notebook, terminal, and chat history, it can help with
              the actual task instead of only offering disconnected suggestions.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Use AI across the workspace
            </Title>
            <BulletList
              items={[
                "Mention models in chat rooms and side chat discussions.",
                "Bring AI into notebook and editor workflows when you need help near the source.",
                "Keep collaborators, screenshots, files, and markdown in the same conversation.",
                "Use the same shared environment for humans and agents instead of juggling external tools.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This makes AI assistance part of the broader collaborative
              workflow instead of a separate app that loses the surrounding
              context every time.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Using AI from inside a Jupyter workflow"
              src="/public/features/chatgpt-jupyter-linear-regression-prompt.png"
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
                Notebook and editor workflows
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Ask for help inside the notebook, not in a separate tab
              </Title>
              <Paragraph style={{ margin: 0 }}>
                AI is especially useful when it stays close to execution:
                debugging a notebook cell, turning analysis notes into code,
                checking a LaTeX formula, or refining a script that will run in
                the project terminal.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc&apos;s strength is that these are not isolated modes. The
                same project can contain the chat, notebook, editor, and shell
                session needed to move the task forward.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="AI generating and running code"
              src="/public/features/chatgpt-generate-code-run.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Agent-native coding workflows
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Recent CoCalc work is increasingly focused on coding agents, not
              just answer generation. That means agents can inspect code, help
              patch files, reason about test failures, and work across a real
              workspace rather than a toy prompt box.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              This is useful for fixing bugs, migrating code, exploring a large
              project, or simply turning a vague technical request into
              something concrete.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="AI helping generate LaTeX formulas"
              src="/public/features/ai-latex-generate.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Useful outside of programming too
            </Title>
            <Paragraph style={{ margin: 0 }}>
              The same workflows help with writing, math, and documentation:
              drafting explanations, generating formulas, rewriting text, and
              adding structure around technical results.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That matters because real technical work usually mixes notebooks,
              code, documents, and conversation rather than staying inside one
              narrow interface.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Deployment flexibility matters
        </Title>
        <Paragraph style={{ margin: 0 }}>
          Depending on the deployment and admin configuration, CoCalc can work
          with commercial model providers or self-hosted/local backends. That
          makes the AI story relevant both for hosted CoCalc and for
          launchpad-style installations where administrators want tighter
          control over what models are available.
        </Paragraph>
        <Paragraph style={{ margin: 0 }}>
          The important part is the workflow integration, not a hard dependency
          on one specific provider.
        </Paragraph>
        <Flex wrap gap={12}>
          <Button href={appPath("features/jupyter-notebook")}>
            Jupyter workflows
          </Button>
          <Button href={appPath("features/terminal")}>
            Terminal workflows
          </Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
