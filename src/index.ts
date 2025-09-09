import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono<{ Bindings: CloudflareBindings }>();

interface UploadPutResult {
  url: string;
  appUrl: string;
  ufsUrl: string;
  fileHash: string; // Change from string | ArrayBuffer to just string
  serverData: any;
}

interface RouteMetadataRequest {
  fileKeys: string[];
  metadata: Record<string, any>;
  isDev: boolean;
  callbackUrl: string;
  callbackSlug: string;
  awaitServerData: boolean;
}

interface MetadataFetchStreamPart {
  payload: string;
  signature: string;
  hook: "callback" | "error";
}

app.use(cors());
app.use(async (c, next) => {
  console.log(c.req.method, c.req.url);
  if (c.req.header("Content-Type") === "application/json") {
    console.log(await c.req.json());
  }
  await next();
});
app.get("/message", (c) => {
  return c.text("Hello Hono!");
});

app.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "fukusu ingest",
    github: "https://github.com/heliumoss/fukusu",
  });
});

app.post("/route-metadata", async (c) => {
  try {
    const {
      fileKeys,
      metadata, // This contains the metadata from your middleware
      isDev,
      callbackUrl,
      callbackSlug,
      awaitServerData,
    }: RouteMetadataRequest = await c.req.json();

    console.log("Received metadata registration:", {
      fileKeys,
      metadata, // Log this to see what metadata is being passed
      isDev,
      callbackUrl,
      callbackSlug,
    });

    // Store metadata for each file key
    if (c.env.KV) {
      for (const fileKey of fileKeys) {
        await c.env.KV.put(
          `metadata:${fileKey}`,
          JSON.stringify({
            middlewareMetadata: metadata, // Store the actual metadata here
            callbackUrl,
            callbackSlug,
            awaitServerData,
            registeredAt: Date.now(),
          }),
          { expirationTtl: 3600 },
        );
      }
    }

    if (isDev) {
      // In development, return a streaming response that simulates file upload callbacks
      return handleDevMetadataStream(c, {
        fileKeys,
        metadata,
        callbackUrl,
        callbackSlug,
        awaitServerData,
      });
    } else {
      // In production, just acknowledge receipt
      return c.json({ ok: true });
    }
  } catch (error) {
    console.error("Route metadata error:", error);
    return c.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

async function handleDevMetadataStream(
  c: any,
  options: {
    fileKeys: string[];
    metadata: Record<string, any>;
    callbackUrl: string;
    callbackSlug: string;
    awaitServerData: boolean;
  },
) {
  // Create a streaming response that will send callbacks as files are uploaded
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Start monitoring for file uploads in the background
  c.executionCtx.waitUntil(monitorFileUploads(writer, encoder, options, c.env));

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson", // Newline-delimited JSON
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

async function monitorFileUploads(
  writer: WritableStreamDefaultWriter,
  encoder: TextEncoder,
  options: {
    fileKeys: string[];
    metadata: Record<string, any>;
    callbackUrl: string;
    callbackSlug: string;
    awaitServerData: boolean;
  },
  env: CloudflareBindings,
) {
  try {
    // Poll for uploaded files (in a real implementation, you might use R2 event notifications)
    const maxWaitTime = 300000; // 5 minutes
    const startTime = Date.now();
    const checkInterval = 1000; // Check every second
    const uploadedFiles = new Set<string>();

    while (Date.now() - startTime < maxWaitTime) {
      for (const fileKey of options.fileKeys) {
        if (uploadedFiles.has(fileKey)) continue;

        try {
          const file = await env.R2.head(fileKey);
          if (file) {
            uploadedFiles.add(fileKey);

            // Retrieve stored metadata
            let storedMetadata = {};
            if (env.KV) {
              try {
                const metadataJson = await env.KV.get(`metadata:${fileKey}`);
                if (metadataJson) {
                  const parsed = JSON.parse(metadataJson);
                  storedMetadata = parsed.middlewareMetadata || {};
                }
              } catch (error) {
                console.error("Failed to retrieve stored metadata:", error);
              }
            }

            // Calculate proper file hash
            let fileHash = "";
            if (file.checksums?.md5) {
              // Convert ArrayBuffer to hex string if needed
              if (file.checksums.md5 instanceof ArrayBuffer) {
                const hashArray = Array.from(
                  new Uint8Array(file.checksums.md5),
                );
                fileHash = hashArray
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join("");
              } else {
                fileHash = file.checksums.md5;
              }
            } else {
              fileHash = await calculateFileHash(fileKey, env);
            }

            const callbackPayload = {
              status: "uploaded",
              file: {
                key: fileKey,
                name: file.customMetadata?.originalName || fileKey,
                size: file.size,
                type:
                  file.httpMetadata?.contentType || "application/octet-stream",
                lastModified: file.uploaded?.getTime() || Date.now(),
                customId: file.customMetadata?.customId || null,
                url: generatePublicUrl(env, fileKey),
                appUrl: generateAppUrl(
                  env,
                  file.customMetadata?.uploadedBy || "unknown",
                  fileKey,
                ),
                ufsUrl: `https://${file.customMetadata?.uploadedBy || "unknown"}.ufs.sh/f/${fileKey}`,
                fileHash: fileHash,
              },
              origin: env.API_BASE_URL || "http://localhost:8787",
              metadata: storedMetadata, // Include the middleware metadata
            };

            // Generate signature for the callback
            const payloadString = JSON.stringify(callbackPayload);
            const signature = await generateSignature(
              payloadString,
              "sk_live_fukusudev",
            );

            // Create the stream part
            const streamPart: MetadataFetchStreamPart = {
              payload: payloadString,
              signature,
              hook: "callback",
            };

            // Write to stream as newline-delimited JSON
            await writer.write(
              encoder.encode(JSON.stringify(streamPart) + "\n"),
            );

            console.log(`Sent callback for file: ${fileKey}`);
          }
        } catch (error) {
          console.error(`Error checking file ${fileKey}:`, error);
        }
      }

      // If all files are uploaded, close the stream
      if (uploadedFiles.size === options.fileKeys.length) {
        break;
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    // Close the stream
    await writer.close();
  } catch (error) {
    console.error("Error in monitorFileUploads:", error);

    // Send error callback
    const errorPayload = {
      error: error instanceof Error ? error.message : "Unknown error",
      fileKeys: options.fileKeys,
    };

    const signature = await generateSignature(
      JSON.stringify(errorPayload),
      "sk_live_fukusudev",
    );

    const errorStreamPart: MetadataFetchStreamPart = {
      payload: JSON.stringify(errorPayload),
      signature,
      hook: "error",
    };

    try {
      await writer.write(
        encoder.encode(JSON.stringify(errorStreamPart) + "\n"),
      );
    } catch (writeError) {
      console.error("Failed to write error to stream:", writeError);
    }

    await writer.close();
  }
}

// Also add /callback-result endpoint for error reporting
app.post("/callback-result", async (c) => {
  try {
    const { fileKey, error } = await c.req.json();

    console.log("Callback result received:", { fileKey, error });

    // You could store this error information or take corrective action
    if (c.env.KV) {
      await c.env.KV.put(
        `error:${fileKey}`,
        JSON.stringify({
          error,
          timestamp: Date.now(),
        }),
        { expirationTtl: 86400 }, // 24 hours
      );
    }

    return c.json({ ok: true });
  } catch (error) {
    console.error("Callback result error:", error);
    return c.json({ ok: false }, 500);
  }
});

app.on("HEAD", "/:fileKey", async (c) => {
  const fileKey = c.req.param("fileKey");

  try {
    const file = await c.env.R2.get(fileKey);

    let rangeStart = 0;
    if (file) {
      rangeStart = file.size;
    }

    c.header("x-ut-range-start", rangeStart.toString());
    c.header("Content-Length", "0");

    return new Response(null, { status: 200 });
  } catch (error) {
    c.header("x-ut-range-start", "0");
    c.header("Content-Length", "0");
    return new Response(null, { status: 200 });
  }
});

app.put("/:fileKey", async (c) => {
  const fileKey = c.req.param("fileKey");

  try {
    // Extract metadata from query parameters
    const metadata = {
      identifier: c.req.query("x-ut-identifier"),
      fileName: c.req.query("x-ut-file-name"),
      fileSize: c.req.query("x-ut-file-size"),
      fileType: c.req.query("x-ut-file-type"),
      slug: c.req.query("x-ut-slug"),
      customId: c.req.query("x-ut-custom-id"),
      contentDisposition: c.req.query("x-ut-content-disposition") || "inline",
      acl: c.req.query("x-ut-acl") || "public-read",
    };

    // Handle Range header for resumable uploads
    const rangeHeader = c.req.header("Range");
    let rangeStart = 0;

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-/);
      if (match) {
        rangeStart = parseInt(match[1], 10);
      }
    }

    // Get the file data
    let fileData: ReadableStream | ArrayBuffer;
    let contentType = metadata.fileType || "application/octet-stream";

    const requestContentType = c.req.header("content-type");

    if (requestContentType?.includes("multipart/form-data")) {
      // Handle FormData upload (standard UploadThing format)
      const formData = await c.req.formData();
      const file = formData.get("file") as File;

      if (!file) {
        return c.json({ error: "No file provided" }, 400);
      }

      fileData = file.stream();
      contentType = file.type || contentType;
    } else {
      // Handle direct binary upload
      const body = c.req.raw.body;
      if (!body) {
        return c.json({ error: "No file data provided" }, 400);
      }

      fileData = body;
    }

    // Handle resumable upload by appending to existing file
    let finalData: ReadableStream | ArrayBuffer = fileData;

    if (rangeStart > 0) {
      const existingObject = await c.env.R2.get(fileKey);
      if (existingObject) {
        finalData = combineStreams(existingObject.body, fileData);
      }
    }

    const r2Object = await c.env.R2.put(fileKey, finalData, {
      httpMetadata: {
        contentType,
        contentDisposition: metadata.contentDisposition,
      },
      customMetadata: {
        originalName: metadata.fileName || "unknown",
        uploadedBy: metadata.identifier || "unknown",
        slug: metadata.slug || "unknown",
        customId: metadata.customId || "",
        uploadTimestamp: Date.now().toString(),
      },
    });

    // Calculate file hash - ensure it's always a string
    let fileHash = "";
    if (r2Object.checksums?.md5) {
      // Convert ArrayBuffer to hex string if needed
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

    // Generate URLs
    const publicUrl = generatePublicUrl(c.env, fileKey);
    const appUrl = generateAppUrl(c.env, metadata.identifier!, fileKey);
    const ufsUrl = `http://localhost:8787/get/${fileKey}`;

    // Trigger callback to main API (async)
    if (c.env.API_BASE_URL && metadata.slug) {
      c.executionCtx.waitUntil(
        triggerCallback(c.env, metadata, fileKey, {
          url: publicUrl,
          appUrl,
          ufsUrl,
          fileHash,
        }),
      );
    }

    // Return response matching UploadThing's format
    const response: UploadPutResult = {
      url: publicUrl,
      appUrl,
      ufsUrl,
      fileHash, // Now guaranteed to be a string
      serverData: null,
    };

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

app.get("/get/:key", async (c) => {
  const key = c.req.param("key");
  const file = await c.env.R2.get(key);
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }
  c.body(file.httpMetadata?.contentType!);
  return c.body(await file.arrayBuffer());
});

// Utility functions
function combineStreams(
  stream1: ReadableStream,
  stream2: ReadableStream | ArrayBuffer,
): ReadableStream {
  return new ReadableStream({
    start(controller) {
      const reader1 = stream1.getReader();
      const reader2 =
        stream2 instanceof ReadableStream
          ? stream2.getReader()
          : new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(stream2 as ArrayBuffer));
                c.close();
              },
            }).getReader();

      async function pump(reader: ReadableStreamDefaultReader<Uint8Array>) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      }

      pump(reader1)
        .then(() => pump(reader2))
        .then(() => controller.close());
    },
  });
}

function generatePublicUrl(env: CloudflareBindings, fileKey: string): string {
  return `${env.PUBLIC_URL}/${fileKey}`;
}

function generateAppUrl(
  env: CloudflareBindings,
  identifier: string | null,
  fileKey: string,
): string {
  return `${env.PUBLIC_URL}/a/${identifier}/${fileKey}`;
}

async function calculateFileHash(
  fileKey: string,
  env: CloudflareBindings,
): Promise<string> {
  try {
    const object = await env.R2.get(fileKey);
    if (!object) return "";

    const arrayBuffer = await object.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("MD5", arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    console.error("Error calculating file hash:", error);
    return ""; // Return empty string instead of undefined
  }
}

async function generateSignature(
  payload: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  const hashArray = Array.from(new Uint8Array(signature));
  const hexSignature = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `hmac-sha256=${hexSignature}`;
}

async function triggerCallback(
  env: CloudflareBindings,
  metadata: any,
  fileKey: string,
  fileData: Omit<UploadPutResult, "serverData">,
): Promise<void> {
  try {
    if (!env.API_BASE_URL) return;

    console.log(metadata, fileKey);

    // Ensure we have a valid slug or use 'default'
    const slug = metadata.slug || "default";
    const callbackUrl = `${env.CLIENT_BASE_URL}/api/uploadthing?slug=${slug}`;

    // Retrieve stored metadata from KV
    let storedMetadata = {};
    if (env.KV) {
      try {
        const metadataJson = await env.KV.get(`metadata:${fileKey}`);
        if (metadataJson) {
          const parsed = JSON.parse(metadataJson);
          storedMetadata = parsed.middlewareMetadata || {};
        }
      } catch (error) {
        console.error("Failed to retrieve stored metadata:", error);
      }
    }

    console.log("Retrieved metadata for callback:", storedMetadata);

    const payload = {
      status: "uploaded",
      file: {
        key: fileKey,
        name: metadata.fileName,
        size: parseInt(metadata.fileSize || "0"),
        type: decodeURIComponent(
          metadata.fileType || "application/octet-stream",
        ),
        lastModified: Date.now(),
        customId: metadata.customId || null,
        url: fileData.url,
        appUrl: fileData.appUrl,
        ufsUrl: fileData.ufsUrl,
        fileHash: fileData.fileHash,
      },
      origin: env.CLIENT_BASE_URL,
      metadata: storedMetadata, // Use the stored metadata from your middleware
    };

    const payloadString = JSON.stringify(payload);
    const signature = await generateSignature(
      payloadString,
      "sk_live_fukusudev",
    );

    console.log("Sending callback to:", callbackUrl);
    console.log(
      "Sending callback with payload:",
      JSON.stringify(payload).substring(0, 500) + "...",
    );

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "uploadthing-hook": "callback",
        "x-uploadthing-signature": signature,
      },
      body: payloadString,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Callback failed with ${response.status}: ${errorText}`);
    } else {
      console.log("✅ Callback successful");
    }
  } catch (error) {
    console.error("Callback failed:", error);
  }
}

export default app;
