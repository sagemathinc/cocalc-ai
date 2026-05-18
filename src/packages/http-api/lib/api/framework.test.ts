/** @jest-environment node */

/*
This file gets unit tested both in prod and dev modes.  This is important to
ensure that in production the input validation is skipped (for now!).
*/

import { apiRoute, apiRouteOperation, z } from "./framework";
import { createMocks } from "./test-framework";

const handler = apiRoute({
  testValidation: apiRouteOperation({
    method: "POST",
  })
    .input({
      contentType: "application/json",
      body: z.object({
        code: z.string(),
      }),
    })
    .outputs([
      {
        status: 200,
        contentType: "application/json",
        body: z.object({
          result: z.string().optional(),
        }),
      },
    ])
    .handler((req, res) => {
      res.json({ result: req.body?.code });
    }),
});

describe("test that the API framework works in either dev or production mode", () => {
  test("error if code param not given in dev mode; no error in production mode", async () => {
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/test-validation",
      body: {},
    });

    await handler(req, res);
    if (process.env.NODE_ENV == "production") {
      expect(res.statusCode).toBe(200);
    } else {
      expect(res.statusCode).toBe(400);
    }
  });

  test("error if code is not a string in dev mode; no error in production mode", async () => {
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/test-validation",
      body: { code: 10 },
    });

    await handler(req, res);
    if (process.env.NODE_ENV == "production") {
      expect(res.statusCode).toBe(200);
    } else {
      expect(res.statusCode).toBe(400);
    }
  });
});
