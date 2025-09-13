import type { CloudflareBindings } from "../worker-configuration";

// Utility functions
export function combineStreams(
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
        .then(() => controller.close())
        .catch((error) => controller.error(error));
    },
  });
}

export function generatePublicUrl(
  env: CloudflareBindings,
  fileKey: string,
): string {
  return `${env.API_BASE_URL}/f/${fileKey}`;
}

export async function calculateFileHash(
  fileKey: string,
  env: CloudflareBindings,
): Promise<string> {
  try {
    const object = await env.R2.get(fileKey);
    if (!object) return "";

    const arrayBuffer = await object.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (error) {
    console.error("Error calculating file hash:", error);
    return "";
  }
}

export function generateFileKey(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function generateSignedUploadUrl(
  env: CloudflareBindings,
  params: Record<string, string>,
  expiresIn: number,
): Promise<string> {
  const url = new URL(`${env.API_BASE_URL}/${params.key}`);
  const expirationTimestampMs = Date.now() + expiresIn * 1000;
  url.searchParams.set("expires", expirationTimestampMs.toString());

  for (const [key, value] of Object.entries(params)) {
    if (key !== "key") {
      url.searchParams.set(key, value);
    }
  }

  const payload = url.toString();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.UPLOADTHING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  url.searchParams.set("signature", `hmac-sha256=${sigHex}`);
  return url.toString();
}
