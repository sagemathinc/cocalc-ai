import type { Request, Response } from "express";

export default function isPost(req: Request, res: Response): boolean {
  if (`${req?.method ?? ""}`.toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
    return false;
  }
  return true;
}
