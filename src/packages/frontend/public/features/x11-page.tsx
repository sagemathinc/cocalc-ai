/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ReactNode } from "react";

import { Button, Col, Flex, Row, Typography } from "antd";

import { Icon, type IconName } from "@cocalc/frontend/components/icon";
import { CodeBlock } from "@cocalc/frontend/public/common";
import { PublicSection } from "@cocalc/frontend/public/layout/shell";
import {
  alpha,
  PUBLIC_COLORS,
  PUBLIC_ELEVATION,
  PUBLIC_RADIUS,
  PUBLIC_TYPE,
} from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";
import { FeatureInfo, FeatureInfoHeading } from "./feature-info";
import { ContextList, FeatureFinalBand, IconBadge } from "./feature-visuals";
import {
  BulletList,
  featureAppPath as appPath,
  featureSignUpPath,
  LinkButton,
} from "./page-components";

const { Paragraph, Text, Title } = Typography;

const GRAPHICAL_APPS_DOCS = appPath("app-docs/terminal/graphical-applications");
const BLIT_URL = "https://blit.sh/";

const X11_FEATURE_CSS = `
  .cocalc-x11-workspace-body {
    grid-template-columns: minmax(0, 1fr) 132px;
  }

  .cocalc-x11-app-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  @media (max-width: 620px) {
    .cocalc-x11-workspace-body {
      grid-template-columns: minmax(0, 1fr);
    }

    .cocalc-x11-surface-rail {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .cocalc-x11-app-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
`;

const LAUNCHER_APPS = [
  { icon: "desktop", label: "Chromium" },
  { icon: "python", label: "Python IDLE" },
  { icon: "file-image", label: "GIMP" },
  { icon: "edit", label: "Inkscape" },
  { icon: "image", label: "Krita" },
  { icon: "table", label: "Gnumeric" },
  { icon: "table", label: "LibreOffice Calc" },
  { icon: "code", label: "Emacs and GVim" },
  { icon: "tex", label: "TeXstudio" },
] satisfies { icon: IconName; label: string }[];

function SurfacePreview({
  accent,
  icon,
  label,
}: {
  accent: string;
  icon: IconName;
  label: string;
}) {
  return (
    <div
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.panel,
        minWidth: 0,
        padding: 9,
      }}
    >
      <Flex align="center" gap={7}>
        <Icon name={icon} style={{ color: accent, flex: "0 0 auto" }} />
        <Text
          strong
          style={{ fontSize: PUBLIC_TYPE.caption, overflow: "hidden" }}
          ellipsis
        >
          {label}
        </Text>
      </Flex>
      <div
        aria-hidden="true"
        style={{
          background: `linear-gradient(145deg, ${alpha(accent, 0.18)}, ${alpha(
            accent,
            0.04,
          )})`,
          borderRadius: 5,
          height: 42,
          marginTop: 8,
        }}
      />
    </div>
  );
}

function GraphicalWorkspaceMock() {
  return (
    <div
      aria-label="Graphical application workspace with one focused application and surface previews"
      role="img"
      style={{
        background: PUBLIC_COLORS.surface,
        border: `1px solid ${PUBLIC_COLORS.border}`,
        borderRadius: PUBLIC_RADIUS.media,
        boxShadow: PUBLIC_ELEVATION.media,
        overflow: "hidden",
      }}
    >
      <Flex
        align="center"
        gap={9}
        style={{
          background: PUBLIC_COLORS.surfaceMuted,
          borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
          padding: "10px 14px",
        }}
      >
        <Icon name="desktop" style={{ color: COLORS.ANTD_LINK_BLUE_DARK }} />
        <Text strong>a.x11</Text>
        <Text style={{ color: PUBLIC_COLORS.mutedText, marginLeft: "auto" }}>
          one project display
        </Text>
      </Flex>
      <div
        className="cocalc-x11-workspace-body"
        style={{ display: "grid", gap: 12, padding: 12 }}
      >
        <div
          style={{
            background: `linear-gradient(150deg, ${alpha(
              COLORS.ANTD_LINK_BLUE_DARK,
              0.12,
            )}, ${alpha(COLORS.RUN, 0.08)})`,
            border: `1px solid ${alpha(COLORS.ANTD_LINK_BLUE_DARK, 0.2)}`,
            borderRadius: PUBLIC_RADIUS.panel,
            minHeight: 250,
            overflow: "hidden",
          }}
        >
          <Flex
            align="center"
            gap={8}
            style={{
              background: alpha(PUBLIC_COLORS.surface, 0.92),
              borderBottom: `1px solid ${PUBLIC_COLORS.border}`,
              padding: "9px 12px",
            }}
          >
            <Icon name="python" style={{ color: COLORS.BLUE_D }} />
            <Text strong>pygame: graphics and sound</Text>
          </Flex>
          <Flex
            align="center"
            justify="center"
            style={{ minHeight: 205, position: "relative" }}
          >
            <div
              aria-hidden="true"
              style={{
                background: COLORS.RUN,
                borderRadius: "50%",
                boxShadow: `46px 22px 0 ${alpha(
                  COLORS.ANTD_LINK_BLUE_DARK,
                  0.72,
                )}, -43px 28px 0 ${alpha(COLORS.BG_WARNING, 0.8)}`,
                height: 58,
                width: 58,
              }}
            />
          </Flex>
        </div>
        <div
          className="cocalc-x11-surface-rail"
          style={{ display: "grid", gap: 10 }}
        >
          <SurfacePreview accent={COLORS.BLUE_D} icon="python" label="IDLE" />
          <SurfacePreview
            accent={COLORS.ANTD_LINK_BLUE_DARK}
            icon="desktop"
            label="Chromium"
          />
          <SurfacePreview
            accent={COLORS.RUN}
            icon="file-image"
            label="GIMP dialog"
          />
        </div>
      </div>
    </div>
  );
}

function AppLauncherGrid() {
  return (
    <div className="cocalc-x11-app-grid" style={{ display: "grid", gap: 10 }}>
      {LAUNCHER_APPS.map(({ icon, label }) => (
        <Flex
          align="center"
          gap={10}
          key={label}
          style={{
            background: PUBLIC_COLORS.surface,
            border: `1px solid ${PUBLIC_COLORS.border}`,
            borderRadius: PUBLIC_RADIUS.panel,
            minHeight: 54,
            padding: "9px 12px",
          }}
        >
          <Icon
            name={icon}
            style={{
              color: COLORS.ANTD_LINK_BLUE_DARK,
              flex: "0 0 auto",
              fontSize: 17,
            }}
          />
          <Text strong>{label}</Text>
        </Flex>
      ))}
    </div>
  );
}

function AudioClipboardCards() {
  const cards: Array<{
    body: ReactNode;
    icon: IconName;
    title: string;
  }> = [
    {
      body: (
        <>
          Copy text in either direction with the normal browser clipboard,
          including between local and remote applications.
        </>
      ),
      icon: "clipboard",
      title: "Browser clipboard",
    },
    {
      body: (
        <>
          PipeWire audio is encoded and sent to the browser. Unmute the display
          before playing audio in Chromium, pygame, or another application.
        </>
      ),
      icon: "sound-outlined",
      title: "Application sound",
    },
  ];
  return (
    <Row gutter={[14, 14]}>
      {cards.map(({ body, icon, title }) => (
        <Col key={title} md={12} xs={24}>
          <Flex
            vertical
            gap={12}
            style={{
              background: PUBLIC_COLORS.surface,
              border: `1px solid ${PUBLIC_COLORS.border}`,
              borderRadius: PUBLIC_RADIUS.panel,
              height: "100%",
              padding: 18,
            }}
          >
            <IconBadge
              accent={COLORS.ANTD_LINK_BLUE_DARK}
              icon={icon}
              size="sm"
            />
            <Title level={4} style={{ margin: 0 }}>
              {title}
            </Title>
            <Paragraph style={{ margin: 0 }}>{body}</Paragraph>
          </Flex>
        </Col>
      ))}
    </Row>
  );
}

export default function X11FeaturePage({
  isAuthenticated,
}: {
  helpEmail?: string;
  isAuthenticated?: boolean;
}) {
  const primaryCtaHref = isAuthenticated
    ? appPath("projects")
    : featureSignUpPath("code");
  const primaryCtaLabel = isAuthenticated ? "Open projects" : "Create account";
  const finalCtaLabel = isAuthenticated
    ? "Open projects"
    : "Run graphical applications";

  return (
    <Flex vertical gap={36}>
      <style>{X11_FEATURE_CSS}</style>
      <PublicSection>
        <Row align="top" gutter={[44, 32]} style={{ padding: "22px 0 14px" }}>
          <Col xs={24} lg={14}>
            <Flex vertical gap={20}>
              <Title level={2} style={{ margin: 0, maxWidth: 760 }}>
                Linux graphical applications, directly in your browser.
              </Title>
              <Paragraph
                style={{ fontSize: PUBLIC_TYPE.lead, margin: 0, maxWidth: 720 }}
              >
                Launch Wayland and X11 applications inside a Linux CoCalc
                project with graphical support installed. Each application
                appears as its own browser-streamed window, without putting a
                traditional Linux desktop between you and the program.
              </Paragraph>
              <Flex wrap gap={12}>
                <Button type="primary" href={primaryCtaHref}>
                  {primaryCtaLabel}
                </Button>
                <LinkButton href={GRAPHICAL_APPS_DOCS}>
                  Graphical applications guide
                </LinkButton>
              </Flex>
            </Flex>
          </Col>
          <Col xs={24} lg={10}>
            <ContextList
              accent={COLORS.ANTD_LINK_BLUE_DARK}
              items={[
                { icon: "desktop", label: "Wayland and X11 applications" },
                { icon: "clipboard", label: "Integrated browser clipboard" },
                { icon: "sound-outlined", label: "PipeWire browser audio" },
                { icon: "users", label: "One shared project display" },
              ]}
              title="Graphical Linux"
            />
          </Col>
        </Row>
      </PublicSection>

      <PublicSection>
        <FeatureInfoHeading
          anchor="a-overview"
          description={
            <>
              Open an <code>.x11</code> file, launch a program, and work with
              each Linux window as a focused browser surface.
            </>
          }
        >
          Applications, not a remote desktop
        </FeatureInfoHeading>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.ANTD_LINK_BLUE_DARK}
          anchor="a-surfaces"
          icon="window-restore"
          imageComponent={<GraphicalWorkspaceMock />}
          title="Focus one application, keep every window visible"
        >
          <Paragraph>
            CoCalc uses the open-source <a href={BLIT_URL}>Blit</a> headless
            Wayland compositor. The focused application fills the workspace
            while every other top-level window remains visible as a compact
            preview. Click a preview to bring that surface forward.
          </Paragraph>
          <Paragraph>
            Dialogs and pop-up windows are separate surfaces too. If an
            application appears frozen while waiting for a dialog, look in the
            preview rail for the new window and select it.
          </Paragraph>
          <Paragraph>
            This is a new implementation, not the legacy XPRA client. Blit
            streams changed surfaces efficiently and CoCalc supplies project
            lifecycle, permissions, installation, and launch controls.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.RUN}
          anchor="a-launchers"
          icon="play"
          imageComponent={<AppLauncherGrid />}
          title="Launch common applications, install them when needed"
        >
          <Paragraph>
            Start programs from the terminal in the center of the workspace or
            use a launcher button. When a launcher application is missing,
            CoCalc offers to install the required Ubuntu package before starting
            it. Automatic installation requires compatible package tools and
            permitted sudo access.
          </Paragraph>
          <Paragraph>
            Choose the <strong>X11 software environment</strong> for a project
            with the launcher catalog, Python, Jupyter, IDLE, Tkinter, pygame,
            browser audio support, and basic LaTeX already installed.
          </Paragraph>
          <BulletList
            items={[
              "Browsers, image editors, office applications, and editors",
              "Python graphics with IDLE, Tkinter, and pygame",
              "TeXstudio with a working basic LaTeX toolchain",
            ]}
          />
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.BLUE_D}
          anchor="a-browser-integration"
          icon="clipboard-check"
          imageComponent={<AudioClipboardCards />}
          title="Clipboard and sound cross the browser boundary"
        >
          <Paragraph>
            Copy and paste connects your local browser and graphical
            applications when browser clipboard permissions allow it.
            Application sound runs through a private PipeWire server in the
            project, is encoded by Blit, and plays in the browser.
          </Paragraph>
          <Paragraph>
            Browsers block unsolicited audio, so a new display starts muted. Use
            the musical-note control or the Desktop sound setting once before
            testing sound.
          </Paragraph>
          <CodeBlock
            ariaLabel="A minimal pygame sound example"
            code={`import pygame

pygame.mixer.init()
pygame.mixer.Sound("effect.wav").play()`}
          />
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.BG_WARNING}
          anchor="a-project-display"
          icon="users"
          title="One persistent graphical display per project"
        >
          <Paragraph>
            Every <code>.x11</code> file in a project opens the same graphical
            session. That deliberate project-wide model avoids several hidden
            desktops and gives applications a predictable display. Closing a
            browser tab does not itself terminate the session, but stopping the
            project or its graphical app ends running applications. Use the
            shutdown button when you want to stop the shared display.
          </Paragraph>
          <Paragraph>
            Multiple browsers and collaborators can open that display at the
            same time. They see and control the same live applications, just as
            collaborators can share a CoCalc terminal or notebook kernel.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureInfo
          accent={COLORS.ANTD_LINK_BLUE_DARK}
          anchor="a-display-variable"
          icon="terminal"
          imageComponent={
            <Flex vertical gap={12}>
              <CodeBlock
                ariaLabel="Check the display in the graphical workspace terminal"
                code={`# In the running graphical workspace terminal
echo "$DISPLAY"
xclock`}
              />
              <CodeBlock
                ariaLabel="Launch Tkinter from Python in the same project runtime"
                code={`# Python in the same project runtime
# Replace :20 with the graphical terminal's DISPLAY value.
import os
os.environ["DISPLAY"] = ":20"

import tkinter as tk
tk.Tk().mainloop()`}
              />
            </Flex>
          }
          title="Launch X11 applications from anywhere in the project"
        >
          <Paragraph>
            The terminal inside the graphical workspace already has its display
            environment configured. Start the graphical session and check{" "}
            <code>DISPLAY</code> there before using another terminal, script, or
            notebook in the same project runtime. Set that value before
            launching an X11 program; <code>:20</code> is a common value, not a
            display that exists without a running session. Its window appears in
            the same surface rail.
          </Paragraph>
          <Paragraph>
            Native Wayland applications use the compositor socket directly; X11
            applications connect through <code>xwayland-satellite</code>. You
            can use both application types in the same project display.
          </Paragraph>
        </FeatureInfo>
      </PublicSection>

      <PublicSection>
        <FeatureFinalBand
          action={{
            body: "Open a project, create an .x11 file, and launch a graphical Linux application.",
            href: primaryCtaHref,
            label: finalCtaLabel,
            title: "Try graphical Linux",
          }}
          relatedLinks={[
            { href: GRAPHICAL_APPS_DOCS, label: "Graphical apps guide" },
            { href: BLIT_URL, label: "Blit project" },
            { href: appPath("features/linux"), label: "Online Linux" },
            {
              href: appPath("features/software-environment"),
              label: "Software environments",
            },
          ]}
          relatedTitle="Learn more"
          title="A practical Linux GUI without a desktop-in-a-browser"
        >
          <Paragraph style={{ margin: 0 }}>
            Use graphical programs beside the files, terminals, notebooks, and
            collaborators already in your CoCalc project. Start with the X11
            software environment or install only the applications your project
            needs.
          </Paragraph>
        </FeatureFinalBand>
      </PublicSection>
    </Flex>
  );
}
