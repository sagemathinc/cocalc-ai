/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { Alert, Button, Card, Col, Flex, Row, Spin, Typography } from "antd";
import MarkdownIt from "markdown-it";

import api from "@cocalc/frontend/client/api";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { to_human_list } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

import { pathForSSO } from "@cocalc/frontend/public/auth/routes";

const { Paragraph, Text, Title } = Typography;

const md = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
});

export interface PublicSSOStrategy {
  backgroundColor?: string;
  descr?: string;
  display: string;
  domains?: string[];
  icon?: string;
  id: string;
}

const ICON_BOX_STYLE: CSSProperties = {
  alignItems: "center",
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 14,
  display: "flex",
  height: 72,
  justifyContent: "center",
  overflow: "hidden",
  width: 72,
} as const;

function strategyHref(id: string): string {
  return joinUrlPath(appBasePath, "auth", id);
}

function StrategyIcon({ strategy }: { strategy: PublicSSOStrategy }) {
  if (strategy.icon?.includes("://")) {
    return (
      <div style={ICON_BOX_STYLE}>
        <img
          alt={`${strategy.display} icon`}
          src={strategy.icon}
          style={{ height: 44, objectFit: "contain", width: 44 }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        ...ICON_BOX_STYLE,
        background: strategy.backgroundColor ?? COLORS.GRAY_LL,
        color: strategy.backgroundColor ? "white" : COLORS.GRAY_D,
        fontSize: 30,
        fontWeight: 700,
      }}
    >
      {strategy.display.slice(0, 1).toUpperCase()}
    </div>
  );
}

function StrategyDomains({ domains }: { domains?: string[] }) {
  if (!domains?.length) {
    return null;
  }
  return <Text type="secondary">{to_human_list(domains)}</Text>;
}

function useStrategies(initialStrategies?: PublicSSOStrategy[]): {
  error: string;
  loading: boolean;
  strategies: PublicSSOStrategy[];
} {
  const [strategies, setStrategies] = useState(initialStrategies ?? []);
  const [loading, setLoading] = useState(initialStrategies == null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialStrategies != null) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await api("auth/sso-strategies");
        if (!cancelled) {
          setStrategies(Array.isArray(result) ? result : []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`${err}`);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialStrategies]);

  return { error, loading, strategies };
}

export function PublicSSOIndexView({
  initialStrategies,
}: {
  initialStrategies?: PublicSSOStrategy[];
}) {
  const { error, loading, strategies } = useStrategies(initialStrategies);

  if (loading) {
    return (
      <Flex align="center" gap={12}>
        <Spin />
        <Text>Loading identity providers...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Alert
        title="Could not load single sign-on providers"
        description={error}
        showIcon
        type="error"
      />
    );
  }

  if (strategies.length === 0) {
    return (
      <Alert
        title="No single sign-on providers are configured"
        description="This site does not currently expose any public third-party sign-on providers."
        showIcon
        type="info"
      />
    );
  }

  return (
    <Flex vertical gap={16}>
      <Paragraph style={{ margin: 0 }}>
        Choose an identity provider to continue. This is usually the right path
        when your organization manages access through Google, GitHub, SAML,
        OpenID Connect, or another external login system.
      </Paragraph>
      <Row gutter={[16, 16]}>
        {strategies.map((strategy) => (
          <Col key={strategy.id} xs={24} md={12}>
            <Card
              styles={{
                body: {
                  display: "grid",
                  gap: 12,
                },
              }}
              variant="outlined"
            >
              <Flex align="center" gap={16}>
                <StrategyIcon strategy={strategy} />
                <div>
                  <Title level={4} style={{ margin: 0 }}>
                    {strategy.display}
                  </Title>
                  <StrategyDomains domains={strategy.domains} />
                </div>
              </Flex>
              <Flex wrap gap={12}>
                <Button href={strategyHref(strategy.id)} type="primary">
                  Continue
                </Button>
                <Button href={pathForSSO(strategy.id)}>More</Button>
              </Flex>
            </Card>
          </Col>
        ))}
      </Row>
    </Flex>
  );
}

export function PublicSSODetailView({
  id,
  initialStrategies,
}: {
  id: string;
  initialStrategies?: PublicSSOStrategy[];
}) {
  const { error, loading, strategies } = useStrategies(initialStrategies);
  const strategy = useMemo(
    () => strategies.find((item) => item.id === id),
    [id, strategies],
  );

  if (loading) {
    return (
      <Flex align="center" gap={12}>
        <Spin />
        <Text>Loading provider details...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Alert
        title="Could not load single sign-on provider"
        description={error}
        showIcon
        type="error"
      />
    );
  }

  if (!strategy) {
    return (
      <Alert
        title="Single sign-on provider not found"
        description="This provider is not configured or is no longer available."
        showIcon
        type="error"
      />
    );
  }

  const fallback = `If you have an account with ${strategy.display}, you can continue here to access this CoCalc deployment.`;

  return (
    <Flex vertical gap={16}>
      <Flex align="center" gap={16}>
        <StrategyIcon strategy={strategy} />
        <div>
          <Title level={3} style={{ margin: 0 }}>
            {strategy.display}
          </Title>
          <StrategyDomains domains={strategy.domains} />
        </div>
      </Flex>
      <div
        dangerouslySetInnerHTML={{
          __html: md.render(strategy.descr?.trim() || fallback),
        }}
      />
      {strategy.domains?.length ? (
        <Alert
          title="Restricted email domains"
          description={`This provider is intended for ${to_human_list(strategy.domains)} email addresses.`}
          showIcon
          type="info"
        />
      ) : null}
      <Flex wrap gap={12}>
        <Button href={strategyHref(strategy.id)} size="large" type="primary">
          Continue with {strategy.display}
        </Button>
        <Button href={pathForSSO()}>All providers</Button>
      </Flex>
    </Flex>
  );
}
