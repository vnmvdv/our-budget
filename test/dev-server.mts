// Local preview: serves /public and routes /api/* to the real handler with an in-memory store.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

const mem = new Map<string, string>();
(globalThis as any).__BUDGET_STORE = {
  async get(k: string) { const v = mem.get(k); return v === undefined ? null : JSON.parse(v); },
  async setJSON(k: string, v: unknown, o?: { onlyIfNew?: boolean }) { if (o?.onlyIfNew && mem.has(k)) return { modified: false }; mem.set(k, JSON.stringify(v)); return { modified: true }; },
  async delete(k: string) { mem.delete(k); },
  async list(o?: { prefix?: string }) { return { blobs: [...mem.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).sort().map((key) => ({ key })) }; },
};
const { default: api } = await import("../netlify/functions/api.mts");
const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const root = join(process.cwd(), "public");
http.createServer(async (req, res) => {
  const url = new URL(req.url!, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const r = await api(new Request(url, { method: req.method, headers: req.headers as any, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks) }), {} as any);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
  }
  const f = join(root, url.pathname === "/" ? "index.html" : url.pathname);
  if (!f.startsWith(root) || !existsSync(f)) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": types[extname(f)] || "application/octet-stream" }); res.end(readFileSync(f));
}).listen(8787, () => console.log("dev server on :8787"));
