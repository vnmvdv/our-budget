import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Our Budget API. Every record is its own blob (one key per expense, category,
 * goal, contribution) so two people saving at the same moment never overwrite
 * each other. Access is gated by one shared household passphrase.
 */

type Db = {
  get(key: string, opts?: { type: "json" }): Promise<any>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string }[] }>;
};

const db = (): Db =>
  (globalThis as any).__BUDGET_STORE ?? (getStore({ name: "household-budget", consistency: "strong" }) as unknown as Db);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (status: number, error: string) => json({ error }, status);

/* ---------- validation ---------- */
const ID = /^[a-z0-9-]{3,40}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 100) / 100;
};
const validDate = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = DATE.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 2000 || y > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return v;
};
const who = (v: unknown) => (v === "b" ? "b" : "a");

/* ---------- auth ---------- */
const okCache = new Map<string, string>(); // stored hash -> fingerprint of the correct key

async function authorized(req: Request, store: Db): Promise<boolean> {
  const key = req.headers.get("x-household-key") ?? "";
  if (!key || key.length > 200) return false;
  const rec = await store.get("auth", { type: "json" });
  if (!rec) return false;
  const fp = createHash("sha256").update(`${rec.salt}:${key}`).digest("hex");
  if (okCache.get(rec.hash) === fp) return true;
  const h = scryptSync(key, Buffer.from(rec.salt, "hex"), 32);
  const ok = timingSafeEqual(h, Buffer.from(rec.hash, "hex"));
  if (ok) okCache.set(rec.hash, fp);
  return ok;
}

function hashPassphrase(pass: string) {
  const salt = randomBytes(16);
  return { salt: salt.toString("hex"), hash: scryptSync(pass, salt, 32).toString("hex") };
}

/* ---------- starter budget (from "Our Monthly Budget") ---------- */
const STARTER = [
  ["rent", "Rent", "🏠", 750, true],
  ["bills", "Bills", "💡", 120, true],
  ["credits", "Credits", "💳", 270, true],
  ["food", "Food", "🛒", 150, false],
  ["snacks", "Snacks and lunches", "🥪", 100, false],
  ["household", "Household", "🧴", 30, false],
  ["subscriptions", "Subscriptions", "📺", 50, true],
  ["appearance", "Appearance", "💇", 200, false],
  ["cigarettes", "Cigarettes", "🚬", 210, false],
  ["social", "Social", "🥂", 100, false],
  ["transport", "Transport", "🚕", 300, false],
] as const;

/* ---------- helpers ---------- */
async function getMany(store: Db, keys: string[]) {
  const out: any[] = [];
  for (let i = 0; i < keys.length; i += 40) {
    const part = await Promise.all(keys.slice(i, i + 40).map((k) => store.get(k, { type: "json" })));
    out.push(...part);
  }
  return out.filter(Boolean);
}
const keysOf = async (store: Db, prefix: string) => (await store.list({ prefix })).blobs.map((b) => b.key);

async function readBody(req: Request) {
  const text = await req.text();
  if (text.length > 20_000) throw new Error("too-big");
  return text ? JSON.parse(text) : {};
}

/* ---------- handler ---------- */
export default async (req: Request, _ctx: Context) => {
  const store = db();
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const route = parts[0] ?? "";
  const method = req.method;

  try {
    if (route === "status" && method === "GET") {
      const [auth, meta] = await Promise.all([store.get("auth", { type: "json" }), store.get("meta", { type: "json" })]);
      return json({ configured: !!(auth && meta) });
    }

    if (route === "setup" && method === "POST") {
      const body = await readBody(req);
      const pass = typeof body.passphrase === "string" ? body.passphrase : "";
      if (pass.length < 8 || pass.length > 200) return fail(400, "Use at least 8 characters for the passphrase.");
      // Setup is finished once "meta" exists. A half-finished earlier attempt (auth saved, nothing else) may be redone.
      if (await store.get("meta", { type: "json" })) return fail(409, "This budget is already set up.");
      await store.setJSON("auth", { ...hashPassphrase(pass), created: Date.now() });
      const a = str(body.nameA, 20) || "Me";
      const b = str(body.nameB, 20) || "Partner";
      await store.setJSON("meta", { names: { a, b } });
      await Promise.all(
        STARTER.map(([id, name, icon, monthly, fixed], i) =>
          store.setJSON(`cat/${id}`, { id, name, icon, monthly, fixed, archived: false, order: i }),
        ),
      );
      return json({ ok: true });
    }

    if (!(await authorized(req, store))) return fail(401, "Wrong or missing passphrase.");

    if (route === "state" && method === "GET") {
      const from = url.searchParams.get("from") ?? "2000-01";
      const expKeys = (await keysOf(store, "exp/")).filter((k) => k.split("/")[1] >= from);
      const [meta, cats, goals, contribs, expenses] = await Promise.all([
        store.get("meta", { type: "json" }),
        keysOf(store, "cat/").then((k) => getMany(store, k)),
        keysOf(store, "goal/").then((k) => getMany(store, k)),
        keysOf(store, "contrib/").then((k) => getMany(store, k)),
        getMany(store, expKeys),
      ]);
      return json({ meta: meta ?? { names: { a: "Me", b: "Partner" } }, cats, goals, contribs, expenses });
    }

    if (route === "passphrase" && method === "POST") {
      const body = await readBody(req);
      const pass = typeof body.passphrase === "string" ? body.passphrase : "";
      if (pass.length < 8 || pass.length > 200) return fail(400, "Use at least 8 characters for the passphrase.");
      await store.setJSON("auth", { ...hashPassphrase(pass), created: Date.now() });
      return json({ ok: true });
    }

    if (route === "meta" && method === "PUT") {
      const body = await readBody(req);
      const a = str(body.nameA, 20);
      const b = str(body.nameB, 20);
      if (!a || !b) return fail(400, "Both names are required.");
      await store.setJSON("meta", { names: { a, b } });
      return json({ ok: true });
    }

    if (route === "expense") {
      if (method === "PUT") {
        const b = await readBody(req);
        const date = validDate(b.date);
        const amount = num(b.amount, 0.01, 100000);
        if (!ID.test(b.id ?? "") || !ID.test(b.catId ?? "") || !date || amount === null) return fail(400, "Invalid expense.");
        const rec = { id: b.id, catId: b.catId, amount, note: str(b.note, 80), who: who(b.who), date, ts: Date.now() };
        await store.setJSON(`exp/${date.slice(0, 7)}/${rec.id}`, rec);
        return json({ ok: true });
      }
      if (method === "DELETE" && parts.length === 3 && /^\d{4}-\d{2}$/.test(parts[1]) && ID.test(parts[2])) {
        await store.delete(`exp/${parts[1]}/${parts[2]}`);
        return json({ ok: true });
      }
    }

    if (route === "cat") {
      if (method === "PUT") {
        const b = await readBody(req);
        const monthly = num(b.monthly, 0, 100000);
        const name = str(b.name, 30);
        if (!ID.test(b.id ?? "") || !name || monthly === null) return fail(400, "Invalid category.");
        const rec = {
          id: b.id,
          name,
          icon: str(b.icon, 8) || "•",
          monthly,
          fixed: !!b.fixed,
          archived: !!b.archived,
          order: Number.isFinite(Number(b.order)) ? Math.trunc(Number(b.order)) : 99,
        };
        await store.setJSON(`cat/${rec.id}`, rec);
        return json({ ok: true });
      }
    }

    if (route === "goal") {
      if (method === "PUT") {
        const b = await readBody(req);
        const target = num(b.target, 1, 10_000_000);
        const name = str(b.name, 40);
        const deadline = b.deadline ? validDate(b.deadline) : "";
        if (!ID.test(b.id ?? "") || !name || target === null || deadline === null) return fail(400, "Invalid goal.");
        await store.setJSON(`goal/${b.id}`, { id: b.id, name, target, deadline, archived: !!b.archived, created: Number(b.created) || Date.now() });
        return json({ ok: true });
      }
      if (method === "DELETE" && parts.length === 2 && ID.test(parts[1])) {
        await store.delete(`goal/${parts[1]}`);
        const cs = await keysOf(store, `contrib/${parts[1]}/`);
        await Promise.all(cs.map((k) => store.delete(k)));
        return json({ ok: true });
      }
    }

    if (route === "contrib") {
      if (method === "PUT") {
        const b = await readBody(req);
        const date = validDate(b.date);
        const amount = num(b.amount, -10_000_000, 10_000_000);
        if (!ID.test(b.id ?? "") || !ID.test(b.goalId ?? "") || !date || amount === null || amount === 0) return fail(400, "Invalid amount.");
        await store.setJSON(`contrib/${b.goalId}/${b.id}`, { id: b.id, goalId: b.goalId, amount, who: who(b.who), date, note: str(b.note, 60) });
        return json({ ok: true });
      }
      if (method === "DELETE" && parts.length === 3 && ID.test(parts[1]) && ID.test(parts[2])) {
        await store.delete(`contrib/${parts[1]}/${parts[2]}`);
        return json({ ok: true });
      }
    }

    return fail(404, "Not found.");
  } catch (err: any) {
    if (err?.message === "too-big") return fail(413, "Request too large.");
    if (err instanceof SyntaxError) return fail(400, "Bad request.");
    console.error("api error", err);
    return fail(500, "Something went wrong on the server.");
  }
};

export const config: Config = {
  path: "/api/*",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 120 },
};
