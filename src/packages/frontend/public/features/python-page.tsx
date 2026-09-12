/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Col, Flex, Row, Typography } from "antd";

import { CodeBlock } from "@cocalc/frontend/public/common";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import { COLORS } from "@cocalc/util/theme";
import { PUBLIC_TYPE } from "@cocalc/frontend/public/theme";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  LinkButton,
} from "./page-components";
import { FeatureInfo, FeatureInfoHeading } from "./feature-info";
import { ContextList, FeatureFinalBand } from "./feature-visuals";

const { Paragraph, Title } = Typography;

const GUIDE_BASE = "https://sagemathinc.github.io/cocalc-guides";

export default function PythonFeaturePage({
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
    : "Start using Python";

  return (
    <Flex vertical gap={36}>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={20}>
              <Title level={2} style={{ margin: 0, maxWidth: 760 }}>
                A full Python environment online, set up the way you want.
              </Title>
              <Paragraph
                style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: 720 }}
              >
                Hosted CoCalc projects run Linux with the software supplied by
                their selected image. Choose a Python image for scientific
                packages, notebooks, scripts, and terminals in your browser.
                Local CoCalc Plus uses your computer's operating system and
                installed software.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={appPath("features/jupyter-notebook")}>
                  Jupyter notebooks
                </LinkButton>
                <LinkButton href={appPath("features/software-environment")}>
                  Software environments
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent={COLORS.FEATURE_BLUE}
              items={[
                { icon: "python", label: "NumPy, pandas, SciPy, scikit-learn" },
                { icon: "jupyter", label: "Jupyter notebooks and JupyterLab" },
                { icon: "download", label: "uv, pip, conda, and apt installs" },
                { icon: "server", label: "Larger machines and NVIDIA GPUs" },
              ]}
              title="Python online"
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <FeatureInfoHeading
          anchor="a-overview"
          description={
            <>
              Keep scripts, notebooks, terminal sessions, and web apps beside
              the same project files. Select and check the Python environment
              used by each tool so package versions match the work you intend to
              run.
            </>
          }
        >
          Scientific Python, in an environment you control
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_PURPLE}
          alt="A Python script in the CoCalc editor with a terminal running it next to the source"
          anchor="a-scripts"
          icon="terminal"
          image="cocalc-python-script-terminal-20260811.png"
          title="Scripts, the shell, and long-running jobs"
        >
          <Paragraph>
            <code>.py</code> files open in the collaborative code editor with a{" "}
            <strong>terminal pane right next to the source</strong>: run{" "}
            <code>python3 script.py</code>, read the output, fix a line, and run
            it again without leaving the file. The editor's Shell button opens a{" "}
            <code>python3</code> session the same way.
          </Paragraph>
          <Paragraph>
            Longer work belongs in a{" "}
            <a href={appPath("features/terminal")}>project terminal</a>:{" "}
            <code>python train.py</code> runs in a session that{" "}
            <strong>keeps going when you close the browser</strong> while the
            project runtime remains running. Reconnect to inspect its output and
            save the results you need.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.RUN}
          anchor="a-packages"
          icon="download"
          imageComponent={
            <CodeBlock
              ariaLabel="Installing and checking Python packages in one virtual environment"
              code={`uv venv .venv
uv pip install --python .venv/bin/python polars scikit-image tqdm
.venv/bin/python -c "import polars; print(polars.__version__)"`}
            />
          }
          title="Install the packages you want, at any layer"
        >
          <Paragraph>
            In a Linux project with <code>uv</code> available, the example
            installs packages and checks them using the same virtual
            environment. Use an unused <code>.venv</code> directory. Register
            that environment as a{" "}
            <a href={appPath("docs/jupyter/custom-kernels")}>
              custom Jupyter kernel
            </a>{" "}
            when a notebook should use it; installing packages does not select
            the notebook's interpreter. Native Windows Plus needs commands and
            paths for Windows.
          </Paragraph>
          <Paragraph>
            System package commands depend on the image and your permissions. On
            Linux images with <code>apt-get</code> and permitted sudo access,
            use them for system libraries; use your chosen environment's package
            manager for Python dependencies.
          </Paragraph>
          <Paragraph>
            In hosted Linux projects, environments under HOME are project files;
            system packages belong to the runtime filesystem. Temporary paths
            have different retention. Record the image and dependency versions,
            and check the configured HOME and RootFS backup coverage before
            relying on a restore, move, or image change. Local Plus uses local
            storage and your computer's backup arrangements.
          </Paragraph>
          <Paragraph>
            <LinkButton href={appPath("features/software-environment")}>
              How software environments work
            </LinkButton>
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_BLUE}
          alt="A Python Jupyter notebook in CoCalc with code, output, and a matplotlib plot"
          anchor="a-notebooks"
          icon="jupyter"
          image="jupyter-classic-20260817.png"
          title="Python in Jupyter notebooks"
        >
          <Paragraph>
            Python images ship the scientific stack and a Python 3 kernel, so a
            new notebook runs NumPy, pandas, SciPy, scikit-learn, SymPy, and
            matplotlib right away, with{" "}
            <strong>plots rendered inline next to the code</strong>.
          </Paragraph>
          <Paragraph>
            CoCalc notebooks add <strong>real-time collaboration</strong>:
            everyone sees the same cells, output, and kernel session, chat
            threads attach to individual cells, and TimeTravel records every
            edit. The{" "}
            <a href={appPath("features/jupyter-notebook")}>
              Jupyter notebooks page
            </a>{" "}
            covers the editor in detail.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_ORANGE}
          anchor="a-ide"
          icon="server"
          title="JupyterLab and VS Code in the browser"
        >
          <Paragraph>
            Prefer a full IDE? With the required software installed, the
            project's Apps panel launches{" "}
            <strong>JupyterLab and VS Code</strong> inside the project. They
            work with the project's files, while each notebook kernel or IDE can
            select its own Python environment.
          </Paragraph>
          <Paragraph>
            They run <strong>behind your login</strong>, so there is nothing to
            install locally and no second copy of the code to keep in sync.
          </Paragraph>
          <Paragraph>
            Check <code>sys.executable</code> inside the running Python code
            before comparing packages or results across interfaces. See{" "}
            <a href={appPath("docs/jupyter/custom-kernels")}>
              custom Jupyter kernels
            </a>{" "}
            for selecting a separate environment.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_RED}
          anchor="a-compute"
          icon="tachometer-alt"
          title="Heavy computations and GPUs"
        >
          <Paragraph>
            When a hosted computation outgrows its resources, use memory and CPU
            monitoring to size the next run. Where your deployment offers
            suitable capacity, move the project to an available host. Check the
            destination image, architecture, and dependencies before rerunning.
          </Paragraph>
          <Paragraph>
            Deployments with compatible GPU hosts can use prepared PyTorch or
            TensorFlow images. Check the available hardware and verify device
            access from the selected notebook kernel before starting training.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.FEATURE_TEAL}
          anchor="a-webapps"
          icon="network-wired"
          title="Python web apps and services"
        >
          <Paragraph>
            Start a Flask, FastAPI, or any other Python server on a port in your
            project, and the project's Apps panel{" "}
            <strong>lists it as a detected running HTTP app</strong>. Turn it
            into an app entry with one click and open it through a project URL,
            proxied behind your login with websocket support.
          </Paragraph>
          <Paragraph>
            An app can also be <strong>defined up front</strong>, with its
            command and port, so CoCalc can start it for you. Enable its wake
            policy when requests should start a stopped app. When the app needs
            more than the Python process itself, the web development image adds
            Node, PostgreSQL, and Redis next to Python.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project on a Python image and use notebooks, scripts, or the terminal as the work demands.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Start using Python",
          }}
          relatedLinks={[
            {
              href: appPath("features/jupyter-notebook"),
              label: "Jupyter notebooks",
            },
            {
              href: appPath("features/software-environment"),
              label: "Software environments",
            },
            { href: appPath("features/linux"), label: "Linux environment" },
            { href: appPath("features/terminal"), label: "Linux terminal" },
            {
              href: `${GUIDE_BASE}/software-install/`,
              label: "Software install guide",
            },
            ...(helpEmail
              ? [{ href: `mailto:${helpEmail}`, label: "Contact support" }]
              : []),
          ]}
          title="One project, from first cell to a heavy run"
        >
          <BulletList
            items={[
              "Explore in a notebook, then move stable code into modules and scripts in the same project.",
              "Record package versions and install locations so you can recreate the environment your code needs.",
              "Choose available hosted compute for the workload and check its software and hardware before rerunning.",
              "Share code and environment records so collaborators can verify the setup used for each run.",
            ]}
          />
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
