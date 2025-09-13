import { Context, Next } from "hono";
import type { CloudflareBindings } from "../worker-configuration";

// Authentication utilities
export function parseApiToken(
  token: string,
): { appId: string; apiKey: string; regions: string[] } | null {
  if (!token.includes(".") && token.length <= 64) {
    return { appId: "fkapp", apiKey: token, regions: ["fukusu-server"] };
  }

  let json: string;
  try {
    json = atob(token);
  } catch {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || typeof parsed.apiKey !== "string") {
    return null;
  }

  return {
    appId: typeof parsed.appId === "string" ? parsed.appId : "fkapp",
    apiKey: parsed.apiKey,
    regions:
      typeof parsed.regions === "string" ? [parsed.regions] : ["fukusu-server"],
  };
}

export function validateApiKey(apiKey: string, secret: string): boolean {
  return apiKey === secret;
}

export async function verifySdkSignature(
  requestUrl: string,
  secret: string,
): Promise<boolean> {
  const url = new URL(requestUrl);
  const rawSig = url.searchParams.get("signature");
  if (!rawSig) return false;

  url.searchParams.delete("signature");
  const payload = url.toString();

  let sig = rawSig;
  const signaturePrefix = "hmac-sha256=";
  if (sig.startsWith(signaturePrefix)) {
    sig = sig.substring(signaturePrefix.length);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  let sigBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(
      sig.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [],
    ) as Uint8Array;
  } catch {
    return false;
  }

  return await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    encoder.encode(payload),
  );
}

// Authentication middleware
export async function authMiddleware(
  c: Context<{ Bindings: CloudflareBindings }>,
  next: Next,
) {
  if (c.req.path.startsWith("/f/") || c.req.path === "/") {
    return await next();
  }

  const authHeader = c.req.header("x-uploadthing-api-key");
  if (!authHeader) {
    return c.json({ error: "Missing API key" }, 401);
  }

  const tokenData = parseApiToken(authHeader);
  if (!tokenData) {
    return c.json({ error: "Invalid API token format" }, 401);
  }

  if (!validateApiKey(tokenData.apiKey, c.env.UPLOADTHING_SECRET)) {
    return c.json({ error: "Invalid API key" }, 403);
  }

  (c as any).set("auth", tokenData);
  await next();
}

// Signature verification middleware for ingest endpoints
export async function ingestAuthMiddleware(
  c: Context<{ Bindings: CloudflareBindings }>,
  next: Next,
) {
  if (!(await verifySdkSignature(c.req.url, c.env.UPLOADTHING_SECRET))) {
    console.error("Invalid signature for", c.req.url);
    return c.text("Invalid signature", 403);
  }
  await next();
}
