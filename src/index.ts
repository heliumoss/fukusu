import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "./auth";
import { logger } from "./middleware";
import publicRoutes from "./routes/public";
import v6api from "./routes/v6";
import v7api from "./routes/v7";
import internalRoutes from "./routes/internal";

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Middleware
app.use(cors());
app.use(logger);

// Apply auth middleware selectively
app.use("/route-metadata", authMiddleware);
app.use("/callback-result", authMiddleware);
// app.use("/v6/*", authMiddleware);
// app.use("/v7/*", authMiddleware);

// Routes
app.route("/", publicRoutes);
app.route("/__fukusu", internalRoutes);
app.route("/v6", v6api);
app.route("/v7", v7api);

app.post("/route-metadata", async (c) => {
  try {
    const {
      fileKeys,
      metadata,
      isDev,
      callbackUrl,
      callbackSlug,
      awaitServerData,
    } = await c.req.json();

    if (c.env.KV) {
      for (const fileKey of fileKeys) {
        await c.env.KV.put(
          `metadata:${fileKey}`,
          JSON.stringify({
            middlewareMetadata: metadata,
            callbackUrl,
            callbackSlug,
            awaitServerData,
            registeredAt: Date.now(),
          }),
          { expirationTtl: 3600 },
        );
      }
    }

    return c.json({ ok: true });
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

app.post("/callback-result", async (c) => {
  try {
    const { fileKey, error } = await c.req.json();
    console.log("Callback result received:", { fileKey, error });

    if (c.env.KV && error) {
      await c.env.KV.put(
        `error:${fileKey}`,
        JSON.stringify({ error, timestamp: Date.now() }),
        { expirationTtl: 86400 },
      );
    }

    return c.json({ ok: true });
  } catch (error) {
    console.error("Callback result error:", error);
    return c.json({ ok: false }, 500);
  }
});

export default app;
