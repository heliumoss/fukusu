import { Hono } from "hono";
import type { CloudflareBindings } from "../../worker-configuration";
import { generateFileKey, generateSignedUploadUrl } from "../utils";

const v7api = new Hono<{ Bindings: CloudflareBindings }>();

v7api.post("/getAppInfo", async (c) => {
  return c.json({
    appId: "fukusu-app",
    defaultACL: "public-read",
    allowACLOverride: false,
  });
});

v7api.post("/prepareUpload", async (c) => {
  try {
    const body = await c.req.json();
    const key = generateFileKey();
    const url = await generateSignedUploadUrl(
      c.env,
      {
        key,
        "x-ut-file-name": body.fileName,
        "x-ut-file-size": String(body.fileSize),
        "x-ut-file-type": body.fileType || "application/octet-stream",
        "x-ut-acl": body.acl || "private",
        "x-ut-content-disposition": body.contentDisposition || "inline",
      },
      body.expiresIn || 3600,
    );

    return c.json({ key, url });
  } catch (error) {
    console.error("Prepare upload error:", error);
    return c.json({ error: "Prepare upload failed" }, 500);
  }
});

export default v7api;
