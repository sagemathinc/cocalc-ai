import { docsApiRoute } from "next-rest-framework";
import { join } from "node:path";
import type { Request, Response } from "express";

import ROOT_PATH from "@cocalc/http-api/lib/root-path";
import { DOMAIN_URL } from "@cocalc/util/theme";

const handler = docsApiRoute({
  deniedPaths: ["/api/conat/**", "/api/share/**", "/api/v2/**/*.test"],
  // allowedPaths: [...], // Explicitly set which endpoints to include in the generated OpenAPI spec.
  openApiObject: {
    info: {
      title: "CoCalc API",
      version: "2.0.0",
      summary: `This is the CoCalc HTTP API. To get started, you'll need to
                [create a scoped API key](/docs/api/http-api).`,
      description: `This is the CoCalc HTTP API. To get started, you'll need to
                [create a scoped API key](/docs/api/http-api). CoCalc-ai API
                keys are intentionally limited; prefer cocalc-cli for many
                automation workflows.`,
    },
    externalDocs: {
      url: "/docs/api/http-api",
      description: "CoCalc-ai HTTP API and API key guidance.",
    },
    components: {
      securitySchemes: {
        BasicAuth: {
          type: "http",
          scheme: "basic",
          description: `The \`password\` field should be left blank, and the \`username\`
                        field should contain the client's API key.`,
        },
      },
    },
    security: [
      {
        BasicAuth: [],
      },
    ],
    servers: [
      {
        description: "CoCalc Production",
        url: DOMAIN_URL,
        variables: {
          apiKey: {
            default: "",
            description: `API key to use for the request. An account-wide key may be
            obtained by visiting ${DOMAIN_URL}/settings/keys`,
          },
        },
      },
      {
        description: "CoCalc Dev",
        url: "http://localhost:5000",
        variables: {
          apiKey: {
            default: "",
            description: `API key to use for the request. An account-wide key may be
            obtained by visiting http://localhost:5000/settings/keys`,
          },
        },
      },
    ],
  },
  openApiJsonPath: join(ROOT_PATH, "openapi.json"),
  docsConfig: {
    provider: "redoc", // redoc | swagger-ui
    title: "CoCalc API",
    description: "",
    logoUrl: `${DOMAIN_URL}/_next/static/media/full.0a70e50d.svg`,
    ogConfig: {
      title: "CoCalc HTTP API (v2)",
      type: "website",
      url: `${DOMAIN_URL}/api/v2`,
      imageUrl: `${DOMAIN_URL}/webapp/favicon.ico`,
    },
  },
});

export default handler as unknown as (req: Request, res: Response) => any;
