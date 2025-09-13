import { Hono } from "hono";
import type { CloudflareBindings } from "../../worker-configuration";
import { verifySdkSignature } from "../auth";
import { UploadPutResult, FileMetadata } from "../interfaces";
import { combineStreams, calculateFileHash, generatePublicUrl } from "../utils";

const publicRoutes = new Hono<{ Bindings: CloudflareBindings }>();

publicRoutes.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "fukusu ingest",
    github: "https://github.com/heliumoss/fukusu",
  });
});

// HEAD endpoint for file upload preflight
publicRoutes.on("HEAD", "/:fileKey", async (c) => {
  // Verify signature for ingest requests
  if (!(await verifySdkSignature(c.req.url, c.env.UPLOADTHING_SECRET))) {
    console.error("Invalid signature for HEAD", c.req.url);
    return c.text("Invalid signature", 403);
  }

  const fileKey = c.req.param("fileKey");

  try {
    const file = await c.env.R2.head(fileKey);
    const rangeStart = file ? file.size : 0;

    c.header("x-ut-range-start", rangeStart.toString());
    c.header("Content-Length", "0");

    return new Response(null, { status: 200 });
  } catch (error) {
    c.header("x-ut-range-start", "0");
    c.header("Content-Length", "0");
    return new Response(null, { status: 200 });
  }
});

// PUT endpoint for file upload
publicRoutes.put("/:fileKey", async (c) => {
  // Verify signature for ingest requests
  if (!(await verifySdkSignature(c.req.url, c.env.UPLOADTHING_SECRET))) {
    console.error("Invalid signature for PUT", c.req.url);
    return c.text("Invalid signature", 403);
  }

  const fileKey = c.req.param("fileKey");

  try {
    const metadata = {
      identifier: c.req.query("x-ut-identifier"),
      fileName: c.req.query("x-ut-file-name"),
      fileSize: c.req.query("x-ut-file-size"),
      fileType: c.req.query("x-ut-file-type"),
      slug: c.req.query("x-ut-slug"),
      customId: c.req.query("x-ut-custom-id"),
      contentDisposition: c.req.query("x-ut-content-disposition") || "inline",
    };

    console.log("Upload request for:", fileKey, metadata);

    const rangeHeader = c.req.header("Range");
    let rangeStart = 0;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-/);
      if (match) {
        rangeStart = parseInt(match[1], 10);
      }
    }

    let fileData: ReadableStream | ArrayBuffer;
    let contentType = metadata.fileType || "application/octet-stream";

    const requestContentType = c.req.header("content-type");

    if (requestContentType?.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file") as File;

      if (!file) {
        return c.json({ error: "No file provided" }, 400);
      }

      fileData = file.stream();
      contentType = file.type || contentType;
    } else {
      const body = c.req.raw.body;
      if (!body) {
        return c.json({ error: "No file data provided" }, 400);
      }

      fileData = body;
    }

    let finalData: ReadableStream | ArrayBuffer = fileData;

    if (rangeStart > 0) {
      const existingObject = await c.env.R2.get(fileKey);
      if (existingObject) {
        finalData = combineStreams(existingObject.body as any, fileData);
      }
    }

    const r2Object = await c.env.R2.put(fileKey, finalData as any, {
      httpMetadata: {
        contentType: decodeURIComponent(contentType),
        contentDisposition: metadata.contentDisposition,
      },
      customMetadata: {
        originalName: decodeURIComponent(metadata.fileName || "unknown"),
        uploadedBy: metadata.identifier || "unknown",
        slug: metadata.slug || "unknown",
        customId: metadata.customId || "",
        uploadTimestamp: Date.now().toString(),
      },
    });

    let fileHash = "";
    if (r2Object.checksums?.md5) {
      if (r2Object.checksums.md5 instanceof ArrayBuffer) {
        const hashArray = Array.from(new Uint8Array(r2Object.checksums.md5));
        fileHash = hashArray
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } else {
        fileHash = r2Object.checksums.md5;
      }
    } else {
      fileHash = await calculateFileHash(fileKey, c.env);
    }

    if (c.env.KV) {
      const fileMetadata: FileMetadata = {
        key: fileKey,
        name: decodeURIComponent(metadata.fileName || "unknown"),
        size: parseInt(metadata.fileSize || "0", 10),
        type: decodeURIComponent(contentType),
        customId: metadata.customId || undefined,
        uploadedAt: Date.now(),
        fileHash,
      };

      await c.env.KV.put(`file:${fileKey}`, JSON.stringify(fileMetadata), {
        expirationTtl: 86400 * 30,
      });
    }

    const publicUrl = generatePublicUrl(c, fileKey);

    const response: UploadPutResult = {
      url: publicUrl,
      appUrl: publicUrl,
      ufsUrl: publicUrl,
      fileHash,
      serverData: null,
    };
    console.log(response);
    return c.json(response);
  } catch (error) {
    console.error("Upload error:", error);
    return c.json(
      {
        error: "Upload failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

publicRoutes.get("/f/:fileKey", async (c) => {
  const fileKey = c.req.param("fileKey");

  try {
    const file = await c.env.R2.get(fileKey);
    if (!file) {
      return c.json({ error: "File not found" }, 404);
    }

    const headers: Record<string, string> = {
      "Content-Type":
        file.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": file.size.toString(),
      ETag: file.etag,
    };

    if (file.httpMetadata?.contentDisposition) {
      headers["Content-Disposition"] = file.httpMetadata.contentDisposition;
    }

    const rangeHeader = c.req.header("Range");
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : file.size - 1;

        const rangedFile = await c.env.R2.get(fileKey, {
          range: { offset: start, length: end - start + 1 },
        });

        if (rangedFile) {
          headers["Content-Range"] = `bytes ${start}-${end}/${file.size}`;
          headers["Content-Length"] = (end - start + 1).toString();

          return new Response(rangedFile.body as any, {
            status: 206,
            headers,
          });
        }
      }
    }

    return new Response(file.body as any, { headers });
  } catch (error) {
    console.error("Download error:", error);
    return c.json({ error: "Download failed" }, 500);
  }
});

export default publicRoutes;
