/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Tag, Typography } from "antd";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PublicSectionCard } from "@cocalc/frontend/public/ui/shell";
import { COLORS } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph, Text, Title } = Typography;

function appPath(path: string): string {
  return joinUrlPath(appBasePath, path);
}

function FeatureImage({ alt, src }: { alt: string; src: string }) {
  return (
    <img
      src={src}
      alt={alt}
      style={{
        width: "100%",
        aspectRatio: "16 / 9",
        objectFit: "cover",
        borderRadius: 14,
      }}
    />
  );
}

function BulletList({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 20 }}>
      {items.map((item, i) => (
        <li key={i} style={{ marginBottom: 8 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button type="link" href={href} style={{ paddingInline: 0 }}>
      {children}
    </Button>
  );
}

export default function JupyterNotebookFeaturePage({
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
                ONLINE JUPYTER
              </Text>
              <Title level={2} style={{ margin: 0 }}>
                CoCalc&apos;s collaborative, fully compatible, supercharged
                Jupyter notebooks
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                Run notebooks directly in the browser, collaborate live, keep
                the exact edit history, and teach from the same environment.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                This page restores the richer public Jupyter landing content
                from the old site while keeping it inside the new standalone
                AntD public frontend.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={appPath("auth/sign-up")}>
                  Create account
                </Button>
                <Button href={appPath("features/teaching")}>
                  Teaching workflows
                </Button>
                <LinkButton href="https://doc.cocalc.com/jupyter.html">
                  Jupyter documentation
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={12}>
            <FeatureImage
              alt="Using Pandas and Tensorflow in a Jupyter notebook"
              src="/public/features/cocalc-jupyter2-20170508.png"
            />
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Jupyter notebooks made for teaching
            </Title>
            <BulletList
              items={[
                <>
                  A sophisticated{" "}
                  <a href={appPath("features/teaching")}>
                    course management system
                  </a>{" "}
                  keeps track of all notebooks of all students, including
                  distributing and collecting work.
                </>,
                <>
                  The collaborative whiteboard supports presentations that mix
                  notebook cells, mathematics, and sketching.
                </>,
                <>
                  Flexible{" "}
                  <a href="https://doc.cocalc.com/teaching-nbgrader.html">
                    nbgrader workflows
                  </a>{" "}
                  support automatic grading, test cells, and tabulated results.
                </>,
              ]}
            />
            <Paragraph style={{ margin: 0 }}>
              CoCalc ships with many kernels out of the box: multiple Python
              environments, SageMath, R, Octave, Julia, and more.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              No software setup
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc is an online service where you can run Jupyter notebooks
              right in your browser and share them privately with project
              collaborators.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              You do not have to manage Python environments, package installs,
              machine-specific setup, or backup scripts just to get productive.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              CoCalc handles the underlying environment while keeping your
              notebooks compatible with the broader Jupyter ecosystem.
            </Paragraph>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Two browser windows editing the same Jupyter notebook"
              src="/public/features/cocalc-real-time-jupyter.png"
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
                Collaborative editing
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Everyone sees the same notebook session
              </Title>
              <Paragraph style={{ margin: 0 }}>
                Share notebooks privately with collaborators and edit them in
                real time with visible cursors and synchronized presence.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc also synchronizes kernel output and interactive widgets,
                so the current live notebook state is shared instead of being a
                local browser illusion.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                You can mix code cells with markdown or rich text between cells,
                which is especially useful for teaching and collaborative
                research notes.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="TimeTravel slider in a Jupyter notebook"
              src="/public/features/cocalc-jupyter2-20170508.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              TimeTravel
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc records fine-grained notebook history, so you can move back
              and forth across edits, recover deleted work, and inspect how a
              notebook evolved.
            </Paragraph>
            <LinkButton href="https://doc.cocalc.com/time-travel.html">
              Learn about TimeTravel
            </LinkButton>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Creating an nbgrader-enhanced Jupyter notebook"
              src="/public/features/cocalc-jupyter-nbgrader-overview.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              nbgrader support
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc supports both automatic and manual grading workflows,
              including teacher notebooks with exercise cells, hidden tests, and
              immediate feedback cells for students.
            </Paragraph>
            <LinkButton href="https://doc.cocalc.com/teaching-nbgrader.html">
              nbgrader in CoCalc
            </LinkButton>
          </PublicSectionCard>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Preinstalled Jupyter kernels"
              src="/public/features/cocalc-jupyter-kernels.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Managed kernels
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Choose from many preinstalled, fully managed kernels, or create a{" "}
              <a href="https://doc.cocalc.com/howto/custom-jupyter-kernel.html">
                custom kernel
              </a>{" "}
              when you need something more specific.
            </Paragraph>
            <LinkButton href={appPath("features/linux")}>
              Available software
            </LinkButton>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Chatting about a Jupyter notebook"
              src="/public/features/cocalc-chat-jupyter-20171120-2.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Chat alongside the notebook
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Each notebook can have a chat side panel for collaboration,
              questions, pasted screenshots, file drops, markdown, and LaTeX
              formulas.
            </Paragraph>
            <LinkButton href="https://doc.cocalc.com/chat.html">
              Chat documentation
            </LinkButton>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Running JupyterLab inside a CoCalc workspace"
              src="/public/features/jupyter-lab.png"
            />
          </Col>
          <Col xs={24} lg={13}>
            <Flex vertical gap={12}>
              <Title level={3} style={{ margin: 0 }}>
                CoCalc Jupyter, JupyterLab, and Jupyter Classic
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc&apos;s notebook UI is a complete collaborative rewrite
                that stays compatible with the underlying `.ipynb` format.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                You can still run standard JupyterLab and Jupyter Classic
                servers from a CoCalc project when that better matches your
                workflow or extension stack.
              </Paragraph>
              <Flex wrap gap={12}>
                <LinkButton href="https://doc.cocalc.com/jupyter.html#alternatives-plain-jupyter-server-and-jupyterlab-server">
                  Jupyter alternatives
                </LinkButton>
                <LinkButton href="http://blog.sagemath.com/jupyter/2017/05/05/jupyter-rewrite-for-smc.html">
                  Background on the rewrite
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Notebook CPU and memory indicators"
              src="/public/features/cocalc-jupyter2-memory-cpu.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              CPU and memory monitoring
            </Title>
            <Paragraph style={{ margin: 0 }}>
              Per-notebook resource indicators help you notice runaway kernels
              and heavy computations before they surprise you.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              You can also close the browser during long computations and come
              back later without losing notebook output.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} xl={12}>
          <PublicSectionCard>
            <FeatureImage
              alt="Shared Jupyter notebook hosted publicly"
              src="/public/features/cocalc-jupyter-share-nasa.png"
            />
            <Title level={3} style={{ margin: 0 }}>
              Publishing notebooks
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc can publish notebook output as fast server-rendered static
              HTML, including pre-rendered mathematics, for lightweight public
              sharing.
            </Paragraph>
            <LinkButton href={appPath("share")}>Sharing overview</LinkButton>
          </PublicSectionCard>
        </Col>
      </Row>

      <PublicSectionCard>
        <Title level={3} style={{ margin: 0 }}>
          Why teams choose CoCalc for Jupyter
        </Title>
        <BulletList
          items={[
            "Live collaboration instead of taking turns emailing notebooks.",
            "Built-in history, backups, and recovery paths instead of hoping local files survive.",
            "Teaching and grading workflows in the same environment as the notebooks.",
            "Managed kernels and shared Linux projects for reproducible technical work.",
          ]}
        />
        <Flex wrap gap={12}>
          <Button type="primary" href={appPath("auth/sign-up")}>
            Start using Jupyter on CoCalc
          </Button>
          {helpEmail ? (
            <Button href={`mailto:${helpEmail}`}>Contact support</Button>
          ) : null}
        </Flex>
      </PublicSectionCard>
    </Flex>
  );
}
