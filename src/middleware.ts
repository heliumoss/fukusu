import { Context, Next } from "hono";

export async function logger(c: Context, next: Next) {
  const start = Date.now();
  console.log(`${c.req.method} ${c.req.url}`);
  await next();
  console.log(`${c.req.method} ${c.req.url} - ${Date.now() - start}ms`);
}
