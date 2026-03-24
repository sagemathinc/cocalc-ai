// This is for unit testing.

import { createRequest, createResponse } from "node-mocks-http";
import type { Request, Response } from "express";

export function createMocks(x, y?): { req: any; res: any } {
  const req = createRequest<Request>({
    headers: { "content-type": "application/json" },
    ...x,
  });
  const res = createResponse<Response>(y);
  return { req, res };
}
