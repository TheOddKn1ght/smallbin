import { join, resolve } from "node:path";

export const HTML_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
export const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": HTML_CSP,
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export async function createStaticHandler(directory: string) {
  const root = resolve(directory);
  const assets = new Map<string, ReturnType<typeof Bun.file>>();
  for await (const name of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true, followSymlinks: false })) {
    if (!/\.(?:html|css|js|svg|png|ico|woff2)$/.test(name)) continue;
    assets.set(`/${name}`, Bun.file(join(root, name)));
  }
  const html = assets.get("/index.html");
  if (!html || !(await html.exists())) throw new Error("Frontend assets are missing. Run bun run build first.");
  return (request: Request): Response => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { ...PAGE_HEADERS, Allow: "GET, HEAD" } });
    const path = new URL(request.url).pathname;
    const page = path === "/" || path === "/privacy" || /^\/b\/[A-Za-z0-9_-]{20,64}$/.test(path);
    const file = page ? html : assets.get(path);
    if (!file) return new Response("Not found", { status: 404, headers: PAGE_HEADERS });
    return new Response(request.method === "HEAD" ? null : file, { headers: { ...PAGE_HEADERS, "Content-Type": file.type } });
  };
}
