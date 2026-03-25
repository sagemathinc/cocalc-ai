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
                Jupyter notebooks for collaborative technical work, teaching,
                and custom environments
              </Title>
              <Paragraph style={{ fontSize: 17, margin: 0 }}>
                Run Jupyter in the browser, collaborate live, keep the full
                history, and build the software environment your work actually
                needs instead of being trapped in a fixed hosted stack.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                CoCalc starts from a working notebook environment, then lets you
                keep going: install packages, customize the environment, and
                keep those changes reusable for collaborators, students, or a
                whole class.
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
              The point is not only that notebooks open in the browser. It is
              that the same environment can be used to distribute assignments,
              collect submissions, collaborate with TAs, and grade at scale.
            </Paragraph>
          </PublicSectionCard>
        </Col>
        <Col xs={24} lg={12}>
          <PublicSectionCard>
            <Title level={3} style={{ margin: 0 }}>
              Start instantly in the browser, or run CoCalc Plus locally
            </Title>
            <Paragraph style={{ margin: 0 }}>
              CoCalc still gives you an immediate browser-based Jupyter
              experience for collaboration and teaching, but it is no longer
              accurate to describe the product as browser-only.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              CoCalc Plus brings the same broader environment to a single-user
              local install on your own machine, closer to how people think
              about VS Code or JupyterLab.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              Project-local Linux environments, persistent package installs, and
              project backups make it practical to install what your notebook
              actually requires and keep that environment reusable.
            </Paragraph>
            <div>
              <LinkButton href={appPath("software/cocalc-plus")}>
                Learn about CoCalc Plus
              </LinkButton>
            </div>
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
                Recent work has gone into making this robust under reruns,
                refreshes, reconnects, and widget-heavy workflows, which is the
                difference between a demo and a notebook system people can
                actually rely on.
              </Paragraph>
            </Flex>
          </Col>
        </Row>
      </PublicSectionCard>

      <PublicSectionCard>
        <Row gutter={[24, 24]} align="middle">
          <Col xs={24} lg={11}>
            <FeatureImage
              alt="Managed Jupyter kernels and environments"
              src="/public/features/cocalc-jupyter-kernels.png"
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
                Custom environments
              </Tag>
              <Title level={3} style={{ margin: 0 }}>
                Install what you need and keep the environment reusable
              </Title>
              <Paragraph style={{ margin: 0 }}>
                CoCalc is not limited to a fixed hosted stack. Projects can be
                extended with the packages and tooling your notebook workflow
                actually needs.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                Project-local Linux environments, persistent package installs,
                and backup/recovery support make longer-lived notebook
                environments much more practical than the usual “hope this VM
                does not drift” workflow.
              </Paragraph>
              <Paragraph style={{ margin: 0 }}>
                AI agent integration also lowers the cost of getting difficult
                environments working, since the agent can help diagnose and
                install the missing pieces instead of leaving users to chase
                package errors manually.
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
            <Paragraph style={{ margin: 0 }}>
              That matters especially when notebooks are shared among several
              people or used in classes, where understanding how something broke
              can be as important as recovering the final answer.
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
            <Paragraph style={{ margin: 0 }}>
              This is one of the areas where collaborative infrastructure,
              notebook execution, and course workflows really need to live in
              the same product.
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
              Managed kernels and practical compatibility
            </Title>
            <Paragraph style={{ margin: 0 }}>
              You can start with working kernels immediately, then create a{" "}
              <a href="https://doc.cocalc.com/howto/custom-jupyter-kernel.html">
                custom kernel
              </a>{" "}
              or extend the base environment when the default options are not
              enough.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              The goal is compatibility with the broader Jupyter ecosystem
              without treating users as if they must stay inside a frozen image
              forever.
            </Paragraph>
            <LinkButton href={appPath("features/linux")}>
              Linux workflow
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
            <Paragraph style={{ margin: 0 }}>
              In practice this matters because notebook work is rarely just a
              single user editing cells. There are code reviews, debugging
              discussions, teaching interactions, and increasingly AI-assisted
              workflows happening around the notebook.
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
              <Paragraph style={{ margin: 0 }}>
                That gives you a practical spectrum: use CoCalc&apos;s notebook
                experience when collaboration and integrated workflow matter
                most, and drop into classical Jupyter interfaces when you need
                them.
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
              back later without losing notebook output, which is essential when
              the computation matters more than the browser tab.
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
              CoCalc can publish notebook output through static app server
              support in projects, which makes notebook results easy to share
              without exposing a full collaborative workspace.
            </Paragraph>
            <Paragraph style={{ margin: 0 }}>
              That makes public notebook output easier to share without asking
              readers to run a whole notebook server just to view results.
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
            "A notebook system that holds up under refreshes, reconnects, long runs, and shared widget sessions.",
            "Built-in history, backups, and recovery paths instead of hoping local files survive.",
            "Teaching and grading workflows in the same environment as the notebooks.",
            "A Linux environment you can actually customize and reuse, rather than a locked-down hosted stack.",
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
