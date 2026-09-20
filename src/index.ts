import { resolve } from "node:path";
import { createApplication } from "./server/app";
import { createStaticHandler, PAGE_HEADERS } from "./http";

const assets = await createStaticHandler(process.env.PUBLIC_DIR ?? resolve(import.meta.dir, "client"));
const application = await createApplication();
const server = Bun.serve({
  hostname: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3210),
  // nginx rejects above 102 MiB; the API enforces its smaller exact envelope cap.
  // Keep Bun's emergency cap above nginx so public errors retain privacy headers.
  maxRequestBodySize: 128 * 1024 * 1024,
  idleTimeout: 120,
  development: false,
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/") || path === "/healthz") return application.handle(request, server.requestIP(request)?.address);
    return assets(request);
  },
  error() { return new Response("Service unavailable", { status: 500, headers: PAGE_HEADERS }); },
});
console.info(`Smallbin listening on http://localhost:${server.port}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await application.shutdown();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
