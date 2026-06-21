/*
We import and export from here, so we can put some wrapping around these.
*/

export { z } from "zod";
import type { Request, Response } from "express";
import {
  apiRoute as apiRoute0,
  apiRouteOperation as apiRouteOperation0,
} from "next-rest-framework";

type ApiHandler = (req: Request, res: Response) => any;

export function apiRoute(obj): ApiHandler {
  if (
    process.env.NODE_ENV != "production" &&
    process.env.COCALC_DISABLE_API_VALIDATION != "yes"
  ) {
    // this actually does all the clever validation, etc.
    return apiRoute0(obj);
  } else {
    // this IGNORES all validation etc and just uses the original handler,
    // thus completely skipping next-rest-framework validation.
    // NOTE: We are assuming there is at most one handler defined per route!
    // That is the case in the current codebase.  I.e., our current handler
    // function internally handles all of POST, GET, etc. in one function,
    // and apiRoute is only called with one distinct handler.
    for (const k in obj) {
      return methodCheckedHandler(obj[k]);
    }
  }
  throw new Error("apiRoute requires at least one operation");
}

export { apiRouteOperation0 as apiRouteOperation };

function methodCheckedHandler(operation: {
  method?: string;
  handler: ApiHandler;
}): ApiHandler {
  const expected = operation.method?.toUpperCase();
  const handler = operation.handler;
  if (!expected) {
    return handler;
  }
  return (req: Request, res: Response) => {
    if (`${req.method ?? ""}`.toUpperCase() !== expected) {
      res.setHeader("Allow", expected);
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    return handler(req, res);
  };
}

/*
// When we want to check validation in production and log
// warnings, we'll use something based on this.

export function apiRouteOperation(obj): ReturnType<typeof apiRouteOperation0> {
  if (process.env.NODE_ENV != "production") {
    return apiRouteOperation0(obj);
  }
  // In production mode we disable all validation, since
  // we do not want to (1) slow things down, and
  // (2) break anything.
  // TODO: once things seem to work well in dev mode,
  // check validation in production and log failures
  // as WARNINGS to our database.  Only when this is stable
  // with zero errors for a while do we switch to actual
  // runtime validation.

  const x = apiRouteOperation0(obj);
  return neuterApiRouteOperation(x);
}

// The output of apiRouteOperation0 has methods:
//    input
//    outputs
//    middleware
//    handler
// which get chained together, e.g.,
//    x.input(...).outputs(...).middleware(...).handler(...)
// to define how the route is checked and handled.
// We have to fake that in such a way that input and outputs
// are ignored, but the rest work.
// The following takes
function neuterApiRouteOperation(x) {
  return {
    ...x,
    input: () => x,
    outputs: () => x,
    middleware: (...args) => {
      const y = x.middleware(...args);
      return neuterApiRouteOperation(y);
    },
    handler: (...args) => {
      const y = x.handler(...args);
      return neuterApiRouteOperation(y);
    },
  };
}
*/
