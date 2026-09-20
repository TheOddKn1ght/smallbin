import index from "./index.html";
import { createApplication } from "./server/app";

const application = await createApplication();
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3210),
  maxRequestBodySize: 128 * 1024 * 1024,
  idleTimeout: 120,
  routes: { "/": index, "/privacy": index, "/b/*": index },
  fetch(request, server) { return application.handle(request, server.requestIP(request)?.address); },
  development: { hmr: true, console: false },
});
console.info(`Smallbin listening on http://localhost:${server.port}`);
async function shutdown() {
  await server.stop(true);
  await application.shutdown();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
