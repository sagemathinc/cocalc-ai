/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import {
  Alert,
  Button,
  Card,
  Col,
  Flex,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
  theme,
} from "antd";

import { Icon, isIconName, type IconName } from "@cocalc/frontend/components";
import { pathForAuthView } from "@cocalc/frontend/public/auth/routes";
import {
  PublicGrid,
  PublicPage,
  PublicSection,
} from "@cocalc/frontend/public/layout/shell";
import { PUBLIC_COLORS } from "@cocalc/frontend/public/theme";
import { rootfsThemeImageUrl } from "@cocalc/frontend/rootfs/catalog-ui";
import {
  managedRootfsCatalogUrl,
  useRootfsImages,
} from "@cocalc/frontend/rootfs/manifest";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type {
  RootfsContentAction,
  RootfsImageEntry,
} from "@cocalc/util/rootfs-images";
import { appPath, type PublicConfig } from "../common";
import type { PublicRootfsRoute } from "./routes";
import { rootfsEntryMatchesImageTarget, rootfsPath } from "./routes";

const { Paragraph, Text, Title } = Typography;

interface PublicRootfsAppProps {
  config?: PublicConfig;
  initialRoute: PublicRootfsRoute;
}

function trim(value?: string): string {
  return `${value ?? ""}`.trim();
}

function displayTitle(entry: RootfsImageEntry): string {
  return (
    trim(entry.content?.title) ||
    trim(entry.theme?.title) ||
    trim(entry.label) ||
    trim(entry.image) ||
    "Runtime image"
  );
}

function displayDescription(entry: RootfsImageEntry): string | undefined {
  return (
    trim(entry.content?.description) ||
    trim(entry.theme?.description) ||
    trim(entry.description) ||
    undefined
  );
}

function rootfsIconName(entry: RootfsImageEntry): IconName {
  return isIconName(entry.theme?.icon) ? entry.theme.icon : "docker";
}

function currentPathWithSearch(): string {
  if (typeof window === "undefined") return rootfsPath();
  return `${window.location.pathname}${window.location.search}`;
}

function authPath(view: "sign-in" | "sign-up"): string {
  return `${pathForAuthView(view)}?target=${encodeURIComponent(
    currentPathWithSearch(),
  )}`;
}

function metadataItems(entry: RootfsImageEntry): string[] {
  return [
    trim(entry.version) ? `Version ${trim(entry.version)}` : undefined,
    trim(entry.family),
    trim(entry.channel),
    entry.gpu ? "GPU" : undefined,
    Array.isArray(entry.arch) ? entry.arch.join(", ") : trim(entry.arch),
    trim(entry.owner_name) ? `by ${trim(entry.owner_name)}` : undefined,
  ].filter((item): item is string => !!item);
}

function actionKindLabel(kind: RootfsContentAction["kind"]): string {
  switch (kind) {
    case "browse":
      return "Browse";
    case "copy-to-home":
      return "Copy to HOME";
    case "external-link":
      return "External link";
    case "open":
    default:
      return "Open";
  }
}

function actionPathLabel(action: RootfsContentAction): string | undefined {
  if (action.kind === "copy-to-home") {
    const source = trim(action.source_path) || trim(action.path);
    const target = trim(action.target_path);
    if (source && target) return `${source} -> ${target}`;
    return source || target || undefined;
  }
  return trim(action.path) || trim(action.source_path) || trim(action.url);
}

function RootfsActionPreview({ action }: { action: RootfsContentAction }) {
  const { token } = theme.useToken();
  const label = trim(action.label) || actionKindLabel(action.kind);
  const description = trim(action.description);
  const pathLabel = actionPathLabel(action);
  const externalUrl = action.kind === "external-link" ? trim(action.url) : "";

  return (
    <Card
      size="small"
      style={{
        borderColor: token.colorBorderSecondary,
        height: "100%",
      }}
    >
      <Flex justify="space-between" gap="middle" wrap="wrap">
        <Flex vertical gap={4} style={{ minWidth: 0 }}>
          <Space wrap size={[6, 4]}>
            <Text strong>{label}</Text>
            <Tag style={{ marginInlineEnd: 0 }}>
              {actionKindLabel(action.kind)}
            </Tag>
          </Space>
          {description ? <Text type="secondary">{description}</Text> : null}
          {pathLabel ? (
            <code style={{ overflowWrap: "anywhere" }}>{pathLabel}</code>
          ) : null}
        </Flex>
        {externalUrl ? (
          <Button
            href={externalUrl}
            icon={<Icon name="external-link" />}
            rel="noreferrer"
            target="_blank"
          >
            Open
          </Button>
        ) : null}
      </Flex>
    </Card>
  );
}

function RootfsHighlights({ entry }: { entry: RootfsImageEntry }) {
  const highlights = entry.content?.highlights ?? [];
  if (highlights.length === 0 && (entry.tags ?? []).length === 0) return null;
  return (
    <Space wrap size={[8, 8]}>
      {highlights.map((highlight) => (
        <Tag key={`highlight:${highlight}`} color="blue">
          {highlight}
        </Tag>
      ))}
      {(entry.tags ?? []).map((tag) => (
        <Tag key={`tag:${tag}`}>{tag}</Tag>
      ))}
    </Space>
  );
}

function RootfsCatalogCard({ entry }: { entry: RootfsImageEntry }) {
  const { token } = theme.useToken();
  const imageUrl = rootfsThemeImageUrl(entry.theme);
  const title = displayTitle(entry);
  const description = displayDescription(entry);

  return (
    <a
      href={rootfsPath(entry)}
      style={{ color: "inherit", display: "block", textDecoration: "none" }}
    >
      <Card
        hoverable
        style={{
          height: "100%",
        }}
      >
        <Flex gap="middle">
          {imageUrl ? (
            <img
              alt=""
              src={imageUrl}
              style={{
                borderRadius: token.borderRadiusLG,
                height: 72,
                objectFit: "cover",
                width: 72,
              }}
            />
          ) : (
            <Flex
              align="center"
              justify="center"
              style={{
                background: token.colorFillAlter,
                borderRadius: token.borderRadiusLG,
                color: token.colorTextSecondary,
                flex: "0 0 auto",
                height: 72,
                width: 72,
              }}
            >
              <Icon name={rootfsIconName(entry)} />
            </Flex>
          )}
          <Flex vertical gap={4} style={{ minWidth: 0 }}>
            <Text ellipsis strong>
              {title}
            </Text>
            {description ? (
              <Text ellipsis type="secondary">
                {description}
              </Text>
            ) : null}
            <Space wrap size={[4, 4]}>
              {metadataItems(entry)
                .slice(0, 3)
                .map((item) => (
                  <Tag key={item} style={{ marginInlineEnd: 0 }}>
                    {item}
                  </Tag>
                ))}
            </Space>
          </Flex>
        </Flex>
      </Card>
    </a>
  );
}

function useSelectedRootfsImage(route: PublicRootfsRoute) {
  const query =
    route.view === "slug"
      ? route.slug
      : route.view === "image-id"
        ? route.imageId
        : undefined;
  const imageIds = route.view === "image-id" ? [route.imageId] : undefined;
  const { images, loading, error } = useRootfsImages(
    [managedRootfsCatalogUrl()],
    {
      imageIds,
      limit: route.view === "index" ? 200 : 20,
      query,
    },
  );
  const selected = useMemo(() => {
    if (route.view === "slug") {
      return images.find((entry) => entry.slug === route.slug);
    }
    if (route.view === "image-id") {
      return images.find((entry) =>
        rootfsEntryMatchesImageTarget(entry, route.imageId),
      );
    }
  }, [images, route]);
  return { error, images, loading, selected };
}

function RootfsCreateProject({
  config,
  entry,
}: {
  config?: PublicConfig;
  entry: RootfsImageEntry;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const title = displayTitle(entry);

  async function createProject() {
    setCreating(true);
    setError(undefined);
    try {
      const projectId = await webapp_client.project_client.create({
        description: displayDescription(entry) ?? "",
        rootfs_image: entry.image,
        rootfs_image_id: entry.id,
        start: true,
        title,
      });
      window.location.href = appPath(`projects/${projectId}/rootfs`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
      setCreating(false);
    }
  }

  if (!config?.is_authenticated) {
    return (
      <Space wrap>
        <Button href={authPath("sign-up")} size="large" type="primary">
          Sign up to create this project
        </Button>
        <Button href={authPath("sign-in")} size="large">
          Sign in
        </Button>
      </Space>
    );
  }

  return (
    <Flex vertical gap="middle">
      <Button
        icon={<Icon name="plus-circle" />}
        loading={creating}
        onClick={createProject}
        size="large"
        type="primary"
      >
        Create project with this image
      </Button>
      {error ? (
        <Alert
          message="Project creation failed"
          description={error}
          showIcon
          type="error"
        />
      ) : null}
    </Flex>
  );
}

function RootfsLandingPage({
  config,
  entry,
}: {
  config?: PublicConfig;
  entry: RootfsImageEntry;
}) {
  const { token } = theme.useToken();
  const title = displayTitle(entry);
  const description = displayDescription(entry);
  const imageUrl = rootfsThemeImageUrl(entry.theme);
  const metadata = metadataItems(entry);
  const publisher = entry.content?.publisher;
  const license = entry.content?.license;

  useEffect(() => {
    document.title = `${title} - Rootfs image`;
  }, [title]);

  return (
    <PublicPage config={config}>
      <section>
        <Row gutter={[token.marginXL, token.marginXL]} align="middle">
          <Col lg={14} xs={24}>
            <Flex vertical gap="middle">
              <Space wrap size={[8, 8]}>
                <Tag color={entry.official ? "blue" : undefined}>
                  {entry.official ? "Official image" : "Runtime image"}
                </Tag>
                {entry.visibility === "public" ? (
                  <Tag color="green">Public</Tag>
                ) : null}
              </Space>
              <Title level={1} style={{ margin: 0 }}>
                {title}
              </Title>
              {entry.content?.subtitle ? (
                <Title
                  level={3}
                  style={{
                    color: PUBLIC_COLORS.mutedText,
                    fontWeight: 500,
                    margin: 0,
                  }}
                >
                  {entry.content.subtitle}
                </Title>
              ) : null}
              {description ? (
                <Paragraph style={{ fontSize: token.fontSizeLG, margin: 0 }}>
                  {description}
                </Paragraph>
              ) : null}
              {metadata.length ? (
                <Space wrap size={[6, 6]}>
                  {metadata.map((item) => (
                    <Tag key={item}>{item}</Tag>
                  ))}
                </Space>
              ) : null}
              <RootfsHighlights entry={entry} />
              <RootfsCreateProject config={config} entry={entry} />
            </Flex>
          </Col>
          <Col lg={10} xs={24}>
            <Card
              style={{
                background: entry.theme?.accent_color || token.colorBgContainer,
                borderColor: entry.theme?.color || token.colorBorderSecondary,
              }}
            >
              {imageUrl ? (
                <img
                  alt=""
                  src={imageUrl}
                  style={{
                    borderRadius: token.borderRadiusLG,
                    display: "block",
                    maxHeight: 320,
                    objectFit: "cover",
                    width: "100%",
                  }}
                />
              ) : (
                <Flex
                  align="center"
                  justify="center"
                  style={{
                    aspectRatio: "16 / 10",
                    color: entry.theme?.color || token.colorTextSecondary,
                  }}
                >
                  <Icon name={rootfsIconName(entry)} style={{ fontSize: 72 }} />
                </Flex>
              )}
            </Card>
          </Col>
        </Row>
      </section>
      {entry.content?.actions?.length ? (
        <PublicSection
          title="Included content"
          intro="This runtime image advertises these files, directories, or links. After creating a project, open the Rootfs panel to use project-aware actions such as copy to HOME."
        >
          <PublicGrid columns={2}>
            {entry.content.actions.map((action, index) => (
              <RootfsActionPreview
                key={`${action.kind}:${action.label}:${index}`}
                action={action}
              />
            ))}
          </PublicGrid>
        </PublicSection>
      ) : null}
      {publisher?.name || license?.name ? (
        <PublicSection title="Details">
          <Space direction="vertical" size="small">
            {publisher?.name ? (
              <Text>
                Publisher:{" "}
                {publisher.url ? (
                  <a href={publisher.url} rel="noreferrer" target="_blank">
                    {publisher.name}
                  </a>
                ) : (
                  publisher.name
                )}
              </Text>
            ) : null}
            {license?.name ? (
              <Text>
                License:{" "}
                {license.url ? (
                  <a href={license.url} rel="noreferrer" target="_blank">
                    {license.name}
                  </a>
                ) : (
                  license.name
                )}
              </Text>
            ) : null}
          </Space>
        </PublicSection>
      ) : null}
    </PublicPage>
  );
}

function RootfsIndexPage({
  config,
  images,
  loading,
}: {
  config?: PublicConfig;
  images: RootfsImageEntry[];
  loading: boolean;
}) {
  useEffect(() => {
    document.title = "Runtime images";
  }, []);

  return (
    <PublicPage config={config} title="Runtime images">
      <PublicSection intro="Discover project runtime images that include ready-to-use software, examples, and files. Choose an image to create a matching project.">
        {loading ? (
          <Flex align="center" gap="middle">
            <Spin size="small" />
            <Text>Loading runtime images...</Text>
          </Flex>
        ) : images.length ? (
          <PublicGrid columns={3}>
            {images.map((entry) => (
              <RootfsCatalogCard key={entry.id} entry={entry} />
            ))}
          </PublicGrid>
        ) : (
          <Alert
            message="No runtime images are available."
            showIcon
            type="info"
          />
        )}
      </PublicSection>
    </PublicPage>
  );
}

function RootfsNotFoundPage({
  config,
  loading,
}: {
  config?: PublicConfig;
  loading: boolean;
}) {
  useEffect(() => {
    document.title = loading
      ? "Loading runtime image..."
      : "Runtime image not found";
  }, [loading]);

  return (
    <PublicPage
      config={config}
      title={loading ? "Loading runtime image..." : "Runtime image not found"}
    >
      <PublicSection>
        {loading ? (
          <Flex align="center" gap="middle">
            <Spin size="small" />
            <Text>Loading runtime image...</Text>
          </Flex>
        ) : (
          <Alert
            message="This runtime image is not available."
            description="It may be private, hidden, deleted, or not visible to this account."
            showIcon
            type="warning"
          />
        )}
      </PublicSection>
    </PublicPage>
  );
}

export default function PublicRootfsApp({
  config,
  initialRoute,
}: PublicRootfsAppProps) {
  const { error, images, loading, selected } =
    useSelectedRootfsImage(initialRoute);

  if (initialRoute.view === "index") {
    return (
      <RootfsIndexPage config={config} images={images} loading={loading} />
    );
  }

  if (selected) {
    return <RootfsLandingPage config={config} entry={selected} />;
  }

  return <RootfsNotFoundPage config={config} loading={loading && !error} />;
}
