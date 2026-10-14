import { rm } from "node:fs/promises";
import { renderPrivacyPage } from "./src/privacy-page";
await rm("dist", { recursive: true, force: true });
const client = await Bun.build({
  entrypoints: ["src/index.html"], outdir: "dist/client", target: "browser",
  minify: true, sourcemap: "none", publicPath: "/",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!client.success) throw new AggregateError(client.logs, "Frontend build failed");
await Bun.write("dist/client/privacy.html", await renderPrivacyPage(await Bun.file("dist/client/index.html").text()));
const server = await Bun.build({
  entrypoints: ["src/index.ts"], outdir: "dist", target: "bun", packages: "external",
  minify: false, sourcemap: "none",
});
if (!server.success) throw new AggregateError(server.logs, "Server build failed");
console.info(`Built ${client.outputs.length} browser assets, the static privacy page, and the Smallbin server.`);
