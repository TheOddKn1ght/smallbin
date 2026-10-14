import index from "./index.html";
import { createApplication } from "./server/app";
import { PAGE_HEADERS } from "./http";
import { renderPrivacyPage } from "./privacy-page";

const privacy = await renderPrivacyPage(await Bun.file(new URL("./index.html", import.meta.url)).text(), "/privacy.css");
const privacyAssets = new Map<string, { body: string | ReturnType<typeof Bun.file>; type: string }>([
  ["/privacy", { body: privacy, type: "text/html; charset=utf-8" }],
  ["/privacy.css", { body: Bun.file(new URL("./index.css", import.meta.url)), type: "text/css; charset=utf-8" }],
  ["/favicon.svg", { body: Bun.file(new URL("./favicon.svg", import.meta.url)), type: "image/svg+xml" }],
]);

const application = await createApplication();
const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3210),
  maxRequestBodySize: 128 * 1024 * 1024,
  idleTimeout: 120,
  routes: { "/": index, "/b/*": index },
  fetch(request, server) {
    const asset = privacyAssets.get(new URL(request.url).pathname);
    if (asset) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { ...PAGE_HEADERS, Allow: "GET, HEAD" } });
      return new Response(request.method === "HEAD" ? null : asset.body, { headers: { ...PAGE_HEADERS, "Content-Type": asset.type } });
    }
    return application.handle(request, server.requestIP(request)?.address);
  },
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
