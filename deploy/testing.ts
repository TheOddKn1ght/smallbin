/** Exercise the real proxy directives without provisioning TLS in disposable tests. */
export function smokeNginxConfig(template: string, upstream: string): string {
  if (!/^[a-z0-9-]+$/.test(upstream)) throw new Error("Invalid test upstream name");
  const firstServer = template.indexOf("server {");
  const tlsServer = template.indexOf("server {", firstServer + 1);
  if (firstServer < 0 || tlsServer < 0) throw new Error("Expected HTTP and HTTPS template servers");
  const map = template.slice(0, firstServer);
  const proxy = template.slice(tlsServer)
    .replace(/^\s*listen 443 ssl;$/m, "    listen 8080;")
    .replace(/^\s*listen \[::\]:443 ssl;\n/m, "")
    .replace(/^\s*ssl_[^\n]*\n/gm, "")
    .replace("proxy_pass http://127.0.0.1:3210;", `proxy_pass http://${upstream}:3210;`);
  return `events {}\nhttp {\n${map}\n${proxy}\n}\n`;
}
