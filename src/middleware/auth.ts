import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function createGatewayAuth(expectedToken: string) {
  const expectedDigest = createHash("sha256").update(expectedToken).digest();

  return (req: Request, res: Response, next: NextFunction): void => {
    const supplied = bearerToken(req.header("authorization"));
    if (!supplied) {
      res.status(401).json({ error: { code: "unauthorized", message: "Missing gateway bearer token" } });
      return;
    }

    const suppliedDigest = createHash("sha256").update(supplied).digest();
    if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
      res.status(401).json({ error: { code: "unauthorized", message: "Invalid gateway bearer token" } });
      return;
    }

    next();
  };
}
