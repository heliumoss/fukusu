import { Hono } from "hono";
import type { CloudflareBindings } from "../../worker-configuration";
import { FileMetadata } from "../interfaces";
import {
  generateFileKey,
  generateSignedUploadUrl,
  generatePublicUrl,
} from "../utils";

const v6api = new Hono<{ Bindings: CloudflareBindings }>();

v6api.post("/deleteFiles", async (c) => {
  try {
    const { fileKeys, customIds } = await c.req.json();

    if (!fileKeys && !customIds) {
      return c.json({ error: "Must provide fileKeys or customIds" }, 400);
    }

    let filesToDelete: string[] = [];

    if (fileKeys) {
      filesToDelete = fileKeys;
    } else if (customIds && c.env.KV) {
      for (const customId of customIds) {
        const keys = await c.env.KV.list({ prefix: `file:` });
        for (const key of keys.keys) {
          const metadataJson = await c.env.KV.get(key.name);
          if (metadataJson) {
            const metadata = JSON.parse(metadataJson);
            if (metadata.customId === customId) {
              filesToDelete.push(metadata.key);
            }
          }
        }
      }
    }

    let deletedCount = 0;
    for (const fileKey of filesToDelete) {
      try {
        await c.env.R2.delete(fileKey);
        if (c.env.KV) {
          await c.env.KV.delete(`file:${fileKey}`);
        }
        deletedCount++;
      } catch (error) {
        console.error(`Failed to delete ${fileKey}:`, error);
      }
    }

    return c.json({ success: true, deletedCount });
  } catch (error) {
    console.error("Delete files error:", error);
    return c.json({ error: "Delete failed" }, 500);
  }
});

v6api.post("/listFiles", async (c) => {
  try {
    const { limit = 20, offset = 0 } = await c.req.json();

    if (!c.env.KV) {
      return c.json({ files: [], hasMore: false });
    }

    const keys = await c.env.KV.list({ prefix: `file:`, limit: limit + 1 });
    const files = [];

    for (const key of keys.keys.slice(0, limit)) {
      const metadataJson = await c.env.KV.get(key.name);
      if (metadataJson) {
        const metadata: FileMetadata = JSON.parse(metadataJson);
        files.push({
          id: metadata.key,
          customId: metadata.customId || null,
          key: metadata.key,
          name: metadata.name,
          size: metadata.size,
          status: "Uploaded",
          uploadedAt: metadata.uploadedAt,
        });
      }
    }

    return c.json({
      hasMore: keys.keys.length > limit,
      files,
    });
  } catch (error) {
    console.error("List files error:", error);
    return c.json({ error: "List failed" }, 500);
  }
});

v6api.post("/getUsageInfo", async (c) => {
  try {
    if (!c.env.KV) {
      return c.json({
        totalBytes: 0,
        appTotalBytes: 0,
        filesUploaded: 0,
        limitBytes: -1,
      });
    }

    let totalBytes = 0;
    let filesUploaded = 0;

    const keys = await c.env.KV.list({ prefix: `file:` });

    for (const key of keys.keys) {
      const metadataJson = await c.env.KV.get(key.name);
      if (metadataJson) {
        const metadata: FileMetadata = JSON.parse(metadataJson);
        totalBytes += metadata.size;
        filesUploaded++;
      }
    }

    return c.json({
      totalBytes,
      appTotalBytes: totalBytes,
      filesUploaded,
      limitBytes: -1,
    });
  } catch (error) {
    console.error("Usage info error:", error);
    return c.json({ error: "Usage info failed" }, 500);
  }
});

v6api.post("/requestFileAccess", async (c) => {
  try {
    const { fileKey, customId } = await c.req.json();

    if (!fileKey && !customId) {
      return c.json({ error: "Must provide fileKey or customId" }, 400);
    }

    let targetFileKey = fileKey;

    if (!targetFileKey && customId && c.env.KV) {
      const keys = await c.env.KV.list({ prefix: `file:` });
      for (const key of keys.keys) {
        const metadataJson = await c.env.KV.get(key.name);
        if (metadataJson) {
          const metadata = JSON.parse(metadataJson);
          if (metadata.customId === customId) {
            targetFileKey = metadata.key;
            break;
          }
        }
      }
    }

    if (!targetFileKey) {
      return c.json({ error: "File not found" }, 404);
    }

    const url = generatePublicUrl(c.env, targetFileKey);
    return c.json({ url, ufsUrl: url });
  } catch (error) {
    console.error("Request file access error:", error);
    return c.json({ error: "Access request failed" }, 500);
  }
});

v6api.get("/pollUpload/:fileKey", async (c) => {
  const fileKey = c.req.param("fileKey");

  try {
    if (!c.env.KV) {
      return c.json({ error: "KV not available" }, 500);
    }

    const metadataJson = await c.env.KV.get(`file:${fileKey}`);
    if (!metadataJson) {
      return c.json({ error: "File not found" }, 404);
    }

    const metadata = JSON.parse(metadataJson);
    const isDone = !!metadata.uploadedAt;

    return c.json({
      status: isDone ? "done" : "still working",
      file: isDone
        ? {
            fileKey: metadata.key,
            fileName: metadata.name,
            fileSize: metadata.size,
            fileType: metadata.type,
            fileUrl: generatePublicUrl(c.env, metadata.key),
            customId: metadata.customId,
          }
        : null,
      metadata: null,
      callbackData: null,
    });
  } catch (error) {
    console.error("Poll upload error:", error);
    return c.json({ error: "Poll failed" }, 500);
  }
});

// Add missing endpoints from reference implementation
v6api.post("/renameFiles", async (c) => {
  try {
    const { updates } = await c.req.json();

    if (!c.env.KV || !updates) {
      return c.json({ error: "Updates required" }, 400);
    }

    let renamedCount = 0;
    for (const update of updates) {
      if (!update.newName) continue;

      let targetFileKey = update.fileKey;

      if (!targetFileKey && update.customId) {
        const keys = await c.env.KV.list({ prefix: `file:` });
        for (const key of keys.keys) {
          const metadataJson = await c.env.KV.get(key.name);
          if (metadataJson) {
            const metadata = JSON.parse(metadataJson);
            if (metadata.customId === update.customId) {
              targetFileKey = metadata.key;
              break;
            }
          }
        }
      }

      if (targetFileKey) {
        const metadataJson = await c.env.KV.get(`file:${targetFileKey}`);
        if (metadataJson) {
          const metadata = JSON.parse(metadataJson);
          metadata.name = update.newName;
          await c.env.KV.put(
            `file:${targetFileKey}`,
            JSON.stringify(metadata),
            { expirationTtl: 86400 * 30 },
          );
          renamedCount++;
        }
      }
    }

    return c.json({ success: true, renamedCount });
  } catch (error) {
    console.error("Rename files error:", error);
    return c.json({ error: "Rename failed" }, 500);
  }
});

v6api.post("/updateACL", async (c) => {
  try {
    const { updates } = await c.req.json();

    if (!c.env.KV || !updates) {
      return c.json({ error: "Updates required" }, 400);
    }

    let updatedCount = 0;
    for (const update of updates) {
      if (!update.acl) continue;

      let targetFileKey = update.fileKey;

      if (!targetFileKey && update.customId) {
        const keys = await c.env.KV.list({ prefix: `file:` });
        for (const key of keys.keys) {
          const metadataJson = await c.env.KV.get(key.name);
          if (metadataJson) {
            const metadata = JSON.parse(metadataJson);
            if (metadata.customId === update.customId) {
              targetFileKey = metadata.key;
              break;
            }
          }
        }
      }

      if (targetFileKey) {
        const metadataJson = await c.env.KV.get(`file:${targetFileKey}`);
        if (metadataJson) {
          const metadata = JSON.parse(metadataJson);
          metadata.acl = update.acl;
          await c.env.KV.put(
            `file:${targetFileKey}`,
            JSON.stringify(metadata),
            { expirationTtl: 86400 * 30 },
          );
          updatedCount++;
        }
      }
    }

    return c.json({ success: true, updatedCount });
  } catch (error) {
    console.error("Update ACL error:", error);
    return c.json({ error: "ACL update failed" }, 500);
  }
});

v6api.post("/uploadFiles", async (c) => {
  try {
    const {
      files,
      acl = "private",
      contentDisposition = "inline",
    } = await c.req.json();

    if (!files || !Array.isArray(files)) {
      return c.json({ error: "Files array required" }, 400);
    }

    const responseData = [];
    for (const fileInfo of files) {
      const key = generateFileKey();
      const url = await generateSignedUploadUrl(
        c.env,
        {
          key,
          "x-ut-file-name": fileInfo.name,
          "x-ut-file-size": String(fileInfo.size),
          "x-ut-file-type": fileInfo.type,
          "x-ut-acl": acl,
          "x-ut-content-disposition": contentDisposition,
        },
        3600,
      );

      responseData.push({
        key,
        fileName: fileInfo.name,
        fileType: fileInfo.type,
        fileUrl: generatePublicUrl(c.env, key),
        url,
        customId: fileInfo.customId,
        contentDisposition,
        pollingJwt: "not-implemented",
        pollingUrl: `${c.env.API_BASE_URL}/v6/pollUpload/${key}`,
        fields: {},
      });
    }

    return c.json({ data: responseData });
  } catch (error) {
    console.error("Upload files error:", error);
    return c.json({ error: "Upload preparation failed" }, 500);
  }
});

v6api.post("/completeMultipart", async (c) => {
  try {
    const { fileKey } = await c.req.json();

    if (c.env.KV) {
      const metadataJson = await c.env.KV.get(`file:${fileKey}`);
      if (metadataJson) {
        const metadata = JSON.parse(metadataJson);
        metadata.uploadedAt = Date.now();
        await c.env.KV.put(`file:${fileKey}`, JSON.stringify(metadata), {
          expirationTtl: 86400 * 30,
        });
      }
    }

    return c.json({ success: true });
  } catch (error) {
    console.error("Complete multipart error:", error);
    return c.json({ error: "Completion failed" }, 500);
  }
});

v6api.post("/failureCallback", async (c) => {
  try {
    const { fileKey, uploadId } = await c.req.json();
    console.error("Received failure callback for", { fileKey, uploadId });

    if (c.env.KV) {
      await c.env.KV.put(
        `error:${fileKey}`,
        JSON.stringify({
          error: "Upload failed",
          uploadId,
          timestamp: Date.now(),
        }),
        { expirationTtl: 86400 },
      );
    }

    return c.json({ success: true });
  } catch (error) {
    console.error("Failure callback error:", error);
    return c.json({ error: "Callback failed" }, 500);
  }
});

export default v6api;
