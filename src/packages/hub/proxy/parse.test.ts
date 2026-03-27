import {
  API_COOKIE_NAME,
  REMEMBER_ME_COOKIE_NAME,
} from "@cocalc/backend/auth/cookie-names";

import { parseReq } from "./parse";
import stripRememberMeCookie from "./strip-remember-me-cookie";

describe("hub proxy route helpers", () => {
  it("parses server proxy routes with internal urls", () => {
    expect(
      parseReq(
        "/00000000-1000-4000-8000-000000000000/server/jupyter/api/kernels",
        "remember",
        "api",
      ),
    ).toEqual({
      key: "remember-api-00000000-1000-4000-8000-000000000000-server-jupyter-api/kernels",
      type: "server",
      route: {
        type: "server",
        requiresPortDesc: true,
        allowsInternalUrl: true,
        access: "write",
      },
      project_id: "00000000-1000-4000-8000-000000000000",
      port_desc: "jupyter",
      internal_url: "api/kernels",
    });
  });

  it("strips remember-me cookies before proxying", () => {
    expect(
      stripRememberMeCookie(
        `theme=dark; ${REMEMBER_ME_COOKIE_NAME}=secret; ${API_COOKIE_NAME}=api-key; session=ok`,
      ),
    ).toEqual({
      cookie: "theme=dark; session=ok",
      remember_me: "secret",
      api_key: "api-key",
    });
  });
});
