import { Hono } from "hono";
import { verifySdkSignature } from "../auth";
import { UploadPutResult, FileMetadata } from "../interfaces";
import { combineStreams, calculateFileHash, generatePublicUrl } from "../utils";

const internalRoutes = new Hono<{ Bindings: CloudflareBindings }>();

internalRoutes.get("/genkey", (c) => {
  const secret = c.req.query("secret");
  if (!secret) {
    c.status(400);
    return c.json({ error: "invalid secret" });
  }

  const keyData = {
    appId: "fkapp",
    apiKey: secret,
    regions: ["fukusu-server"],
  };

  const encodedKey = btoa(JSON.stringify(keyData));

  return c.json({
    status: "ok",
    key: encodedKey,
  });
});

export default internalRoutes;
