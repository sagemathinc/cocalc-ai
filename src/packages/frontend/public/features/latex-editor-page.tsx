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
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

export default function LatexEditorFeaturePage({
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
                ONLINE LATEX EDITOR
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                Focus on writing and collaboration instead of managing the TeX
                toolchain
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                CoCalc&apos;s LaTeX editor combines live collaboration,
                side-by-side preview, automatic compilation, history, and the
                broader project environment in one browser-based workflow.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This makes it useful for papers, lecture notes, problem sets,
                books, and computational documents where the source, output, and
                supporting code all need to stay close together.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <LinkButton href="https://doc.cocalc.com/latex.html">
                  LaTeX documentation
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Online LaTeX editor in CoCalc"
              src="/public/features/latex-editor-main-20251003.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Writing workflow that stays out of the way
            </Title>
            <BulletList
              items={[
                "Side-by-side source and PDF preview.",
                "Automatic compilation on save with errors marked in the source.",
                "Forward and inverse search between the TeX source and rendered PDF.",
                "A managed TeX environment that removes most local setup pain.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This is the basic workflow many people want from an online LaTeX
              editor, but CoCalc adds collaboration, history, and the rest of
              the project environment around it.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Realtime collaboration and discussion
            </Title>
            <BulletList
              items={[
                "Edit the same document simultaneously with visible cursors.",
                "Keep compilation status and preview shared across collaborators.",
                "Use side chat for discussion, questions, and AI-assisted help next to the document.",
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              This is especially useful for coauthors, student-teacher feedback,
              and iterative editorial work on technical documents.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Realtime collaborative LaTeX editing"
              src="/public/features/latex-editor-realtime-sync-20251003.png"
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
                Collaborative authoring
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Coauthor technical documents without email ping-pong
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Multiple collaborators can work on the same LaTeX project at the
                same time. That includes the source, the PDF preview, and the
                surrounding project files.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Because the document lives inside a full project, figures, code,
                data, and build helpers stay nearby instead of being split
                across several unrelated tools.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="TimeTravel in the LaTeX editor"
              src="/public/features/latex-editor-timetravel-01.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              TimeTravel and backups
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc records document history in a way that makes it practical
              to recover earlier versions, inspect what changed, and undo
              mistakes without relying entirely on external version control.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              This is particularly valuable for long-lived technical documents
              with several authors.
            </Paragraph>
            <LinkButton href="https://doc.cocalc.com/time-travel.html">
              Learn about TimeTravel
            </LinkButton>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="AI formula assistant for LaTeX"
              src="/public/features/latex-ai-formula.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              AI-assisted formula and writing support
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc&apos;s broader AI tooling can help with formula generation,
              explanations, and document-writing tasks, which is useful when a
              LaTeX project includes substantial mathematical or technical
              content.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              This is much more useful when it happens next to the source
              itself, not in a disconnected external assistant.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Multi-file LaTeX project support"
              src="/public/features/latex-editor-multifile-20251006.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Multi-file and computational documents
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc handles larger LaTeX projects with included files and also
              supports workflows that mix computation and typesetting, such as
              SageTeX, PythonTeX, and Knitr-style document generation.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That makes it a strong fit for technical notes, homework, books,
              and research documents that are generated from data or code.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Dark mode LaTeX editor"
              src="/public/features/latex-editor-darkmode-20251003.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Comfortable editing for long writing sessions
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Dark mode, synchronized preview, and the surrounding project
              tooling matter when you are working in a document for hours rather
              than doing a quick edit.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              CoCalc aims to make those longer technical writing sessions feel
              viable in the browser, not compromised.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why people use CoCalc for LaTeX
        </Title>
        <BulletList
          items={[
            "A managed online LaTeX environment with far less setup friction.",
            "Realtime collaboration for coauthors and teaching workflows.",
            "Integrated history, backups, and recovery.",
            "Support for computational and multi-file documents.",
            "A full project environment for code, figures, data, and discussion next to the document.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button href={appPath("features/terminal")}>
            Terminal workflows
          </Button>
          <Button href={appPath("features/ai")}>AI assistance</Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
