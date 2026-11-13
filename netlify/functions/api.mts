import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Our Budget API: two accounts, shared data.
 *  - every record is its own blob, so two people saving at once never overwrite each other
 *  - nothing is ever deleted without the other person approving it
 *  - every action is written to an append-only history ("log/…") that no endpoint can change or remove
 */

type Db = {
  get(key: string, opts?: { type: "json" }): Promise<any>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string }[] }>;
};
const db = (): Db =>
  (globalThis as any).__BUDGET_STORE ?? (getStore({ name: "household-budget", consistency: "strong" }) as unknown as Db);
const env = (k: string): string | undefined => (globalThis as any).Netlify?.env?.get?.(k) ?? process.env[k];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);

/* ---------- small helpers ---------- */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const rid = (bytes = 6) => randomBytes(bytes).toString("hex");
const ID = /^[a-z0-9-]{3,40}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,200}\.[^\s@]{2,}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  return !Number.isFinite(n) || n < min || n > max ? null : Math.round(n * 100) / 100;
};
const validDate = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = DATE.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return y < 2000 || y > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d ? null : v;
};
const normEmail = (v: unknown) => str(v, 120).toLowerCase();
const slotOf = (v: unknown) => (v === "b" ? "b" : "a");

async function getMany(store: Db, keys: string[]) {
  const out: any[] = [];
  for (let i = 0; i < keys.length; i += 40) out.push(...(await Promise.all(keys.slice(i, i + 40).map((k) => store.get(k, { type: "json" })))));
  return out.filter(Boolean);
}
const keysOf = async (store: Db, prefix: string) => (await store.list({ prefix })).blobs.map((b) => b.key);

/* ---------- passwords, users, sessions ---------- */
function hashPw(pw: string) {
  const salt = randomBytes(16);
  return { pwSalt: salt.toString("hex"), pwHash: scryptSync(pw, salt, 32).toString("hex") };
}
const checkPw = (pw: string, u: { pwSalt: string; pwHash: string }) =>
  timingSafeEqual(scryptSync(pw, Buffer.from(u.pwSalt, "hex"), 32), Buffer.from(u.pwHash, "hex"));
const publicUser = (u: any) => ({ id: u.id, slot: u.slot, name: u.name, email: u.email });
const pwOk = (pw: unknown): pw is string => typeof pw === "string" && pw.length >= 8 && pw.length <= 200;

async function newSession(store: Db, uid: string) {
  const token = randomBytes(32).toString("hex");
  await store.setJSON(`session/${sha(token)}`, { uid, exp: Date.now() + 180 * 864e5 });
  return token;
}
async function userFromRequest(req: Request, store: Db) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const s = await store.get(`session/${sha(m[1])}`, { type: "json" });
  if (!s || s.exp < Date.now()) return null;
  return (await store.get(`user/${s.uid}`, { type: "json" })) ?? null;
}
async function dropSessions(store: Db, uid: string, keep?: string) {
  const keys = await keysOf(store, "session/");
  const recs = await Promise.all(keys.map(async (k) => [k, await store.get(k, { type: "json" })] as const));
  await Promise.all(recs.filter(([k, r]) => r?.uid === uid && k !== keep).map(([k]) => store.delete(k)));
}

/* ---------- history (append-only) ---------- */
async function log(store: Db, uid: string, type: string, data: unknown) {
  const ts = Date.now();
  const id = `${String(ts).padStart(13, "0")}-${rid(3)}`;
  await store.setJSON(`log/${id}`, { id, ts, uid, type, data });
}

const recoveryKey = () => env("RECOVERY_KEY") ?? "";

/* ---------- email + push (both overridable in tests) ---------- */
const mailEnabled = () => !!((globalThis as any).__BUDGET_MAIL || (env("SMTP_HOST") && env("SMTP_USER") && env("SMTP_PASS")));
async function sendMail(to: string, subject: string, text: string) {
  const hook = (globalThis as any).__BUDGET_MAIL;
  if (hook) return hook({ to, subject, text });
  const nmMod: any = await import("nodemailer");
  const nm = nmMod.default ?? nmMod;
  const port = Number(env("SMTP_PORT") || 465);
  const t = nm.createTransport({ host: env("SMTP_HOST"), port, secure: port === 465, auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") } });
  await t.sendMail({ from: env("MAIL_FROM") || env("SMTP_USER"), to, subject, text });
}

async function vapid(store: Db) {
  let v = await store.get("vapid", { type: "json" });
  if (!v) {
    const wpMod: any = await import("web-push");
    v = (wpMod.default ?? wpMod).generateVAPIDKeys();
    await store.setJSON("vapid", v);
  }
  return v as { publicKey: string; privateKey: string };
}
async function pushTo(store: Db, uid: string, payload: { title: string; body: string; tag?: string }, origin: string) {
  try {
    const keys = await keysOf(store, `push/${uid}/`);
    if (!keys.length) return;
    const hook = (globalThis as any).__BUDGET_PUSH;
    if (hook) return hook(uid, payload);
    const wpMod: any = await import("web-push");
    const wp = wpMod.default ?? wpMod;
    const v = await vapid(store);
    const subs = await Promise.all(keys.map(async (k) => [k, await store.get(k, { type: "json" })] as const));
    await Promise.allSettled(
      subs.map(async ([k, rec]) => {
        try {
          await wp.sendNotification(rec.sub, JSON.stringify(payload), { vapidDetails: { subject: origin, ...v }, TTL: 86400 });
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) await store.delete(k);
        }
      }),
    );
  } catch (e) {
    console.error("push failed", e);
  }
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

function cleanCat(b: any) {
  const monthly = num(b?.monthly, 0, 100000);
  const name = str(b?.name, 30);
  if (!ID.test(b?.id ?? "") || !name || monthly === null) return null;
  return {
    id: b.id as string,
    name,
    icon: str(b.icon, 8) || "•",
    monthly,
    fixed: !!b.fixed,
    archived: !!b.archived,
    order: Number.isFinite(Number(b.order)) ? Math.trunc(Number(b.order)) : 99,
  };
}
const eur = (n: number) => `€${Number.isInteger(n) ? n : n.toFixed(2)}`;

async function readBody(req: Request) {
  const text = await req.text();
  if (text.length > 30_000) throw new Error("too-big");
  return text ? JSON.parse(text) : {};
}

/* ---------- requests that need the other person ---------- */
async function pendingRequests(store: Db) {
  const reqs = await getMany(store, await keysOf(store, "req/"));
  return reqs;
}

async function applyRequest(store: Db, r: any) {
  if (r.type === "expense.delete") {
    await store.delete(`exp/${r.payload.month}/${r.payload.expenseId}`);
  } else if (r.type === "budget.change") {
    for (const c of r.payload.changes) await store.setJSON(`cat/${c.id}`, c);
  }
}
const describe = (r: any) =>
  r.type === "expense.delete"
    ? `deleting ${eur(r.payload.snapshot.amount)}${r.payload.snapshot.note ? ` “${r.payload.snapshot.note}”` : ""}`
    : "the budget change";

/* ---------- handler ---------- */
export default async (req: Request, _ctx: Context) => {
  const store = db();
  const url = new URL(req.url);
  const origin = url.origin;
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const route = parts[0] ?? "";
  const method = req.method;

  try {
    /* ----- public routes ----- */
    if (route === "status" && method === "GET") {
      const users = await keysOf(store, "user/");
      return json({ users: users.length, emailEnabled: mailEnabled(), recoveryEnabled: recoveryKey().length >= 12 });
    }

    if (route === "register" && method === "POST") {
      const b = await readBody(req);
      const name = str(b.name, 20), email = normEmail(b.email);
      if (!name) return fail(400, "Enter your name.");
      if (!EMAIL.test(email)) return fail(400, "Enter a valid email address.");
      if (!pwOk(b.password)) return fail(400, "Use at least 8 characters for the password.");
      const userKeys = await keysOf(store, "user/");
      if (userKeys.length >= 2) return fail(403, "This budget already has two accounts.");
      if (await store.get(`email/${sha(email)}`, { type: "json" })) return fail(409, "That email already has an account. Log in instead.");
      let slot: "a" | "b" = "a";
      if (userKeys.length === 0) {
        const partner = normEmail(b.partnerEmail);
        if (!EMAIL.test(partner) || partner === email) return fail(400, "Enter your partner's email address (different from yours).");
        await store.setJSON(`invite/${sha(partner)}`, { email: partner, ts: Date.now() });
        await Promise.all(STARTER.map(([id, nm, icon, monthly, fixed], i) => store.setJSON(`cat/${id}`, { id, name: nm, icon, monthly, fixed, archived: false, order: i })));
      } else {
        const inv = await store.get(`invite/${sha(email)}`, { type: "json" });
        if (!inv) return fail(403, "Use the email address your partner invited.");
        slot = "b";
        await store.delete(`invite/${sha(email)}`);
      }
      const id = "u-" + rid(6);
      const user = { id, slot, name, email, ...hashPw(b.password), created: Date.now() };
      await store.setJSON(`user/${id}`, user);
      await store.setJSON(`email/${sha(email)}`, { id });
      await log(store, id, "user.register", { name });
      return json({ token: await newSession(store, id), user: publicUser(user) });
    }

    if (route === "login" && method === "POST") {
      const b = await readBody(req);
      const email = normEmail(b.email);
      const failKey = `fail/${sha(email)}`;
      const f = (await store.get(failKey, { type: "json" })) ?? { count: 0, until: 0 };
      if (f.until > Date.now()) return fail(429, "Too many tries. Wait 15 minutes, then try again.");
      const ref = await store.get(`email/${sha(email)}`, { type: "json" });
      const user = ref ? await store.get(`user/${ref.id}`, { type: "json" }) : null;
      const pw = typeof b.password === "string" ? b.password.slice(0, 200) : "";
      if (!user || !checkPw(pw, user)) {
        const count = f.count + 1;
        await store.setJSON(failKey, count >= 8 ? { count: 0, until: Date.now() + 15 * 60_000 } : { count, until: 0 });
        return fail(401, "Wrong email or password.");
      }
      if (f.count) await store.setJSON(failKey, { count: 0, until: 0 });
      return json({ token: await newSession(store, user.id), user: publicUser(user) });
    }

    if (route === "forgot" && method === "POST") {
      const b = await readBody(req);
      const email = normEmail(b.email);
      if (mailEnabled() && EMAIL.test(email)) {
        const ref = await store.get(`email/${sha(email)}`, { type: "json" });
        const user = ref ? await store.get(`user/${ref.id}`, { type: "json" }) : null;
        if (user && !(user.lastReset > Date.now() - 60_000)) {
          const token = randomBytes(24).toString("hex");
          await store.setJSON(`reset/${sha(token)}`, { uid: user.id, exp: Date.now() + 3600_000 });
          await store.setJSON(`user/${user.id}`, { ...user, lastReset: Date.now() });
          await sendMail(email, "Reset your Our budget password", `Hi ${user.name},\n\nOpen this link to choose a new password (valid for 1 hour):\n${origin}/#reset=${token}\n\nIf you didn't ask for this, ignore this email.`);
        }
      }
      return json({ ok: true });
    }

    if (route === "reset" && method === "POST") {
      const b = await readBody(req);
      if (!pwOk(b.password)) return fail(400, "Use at least 8 characters for the password.");
      const token = typeof b.token === "string" ? b.token : "";
      const rec = /^[a-f0-9]{48}$/.test(token) ? await store.get(`reset/${sha(token)}`, { type: "json" }) : null;
      if (!rec || rec.exp < Date.now()) return fail(400, "This reset link has expired. Ask for a new one.");
      const user = await store.get(`user/${rec.uid}`, { type: "json" });
      if (!user) return fail(400, "This reset link is not valid.");
      await store.setJSON(`user/${user.id}`, { ...user, ...hashPw(b.password) });
      await store.delete(`reset/${sha(token)}`);
      await dropSessions(store, user.id);
      await log(store, user.id, "user.password", { how: "reset-link" });
      return json({ token: await newSession(store, user.id), user: publicUser(user) });
    }

    if (route === "recover" && method === "POST") {
      // Fallback when email isn't set up: a secret RECOVERY_KEY set in Netlify lets you choose a new password.
      const b = await readBody(req);
      const email = normEmail(b.email);
      const key = recoveryKey();
      const failKey = `fail/rec-${sha(email)}`;
      const f = (await store.get(failKey, { type: "json" })) ?? { count: 0, until: 0 };
      if (f.until > Date.now()) return fail(429, "Too many tries. Wait 15 minutes, then try again.");
      if (!pwOk(b.password)) return fail(400, "Use at least 8 characters for the password.");
      const given = typeof b.key === "string" ? b.key.slice(0, 200) : "";
      const ref = await store.get(`email/${sha(email)}`, { type: "json" });
      const user = ref ? await store.get(`user/${ref.id}`, { type: "json" }) : null;
      const a = createHash("sha256").update(given).digest(), c = createHash("sha256").update(key).digest();
      if (key.length < 12 || !user || !timingSafeEqual(a, c)) {
        const count = f.count + 1;
        await store.setJSON(failKey, count >= 5 ? { count: 0, until: Date.now() + 15 * 60_000 } : { count, until: 0 });
        return fail(401, "Wrong email or recovery key.");
      }
      await store.setJSON(`user/${user.id}`, { ...user, ...hashPw(b.password) });
      await dropSessions(store, user.id);
      await log(store, user.id, "user.password", { how: "recovery-key" });
      return json({ token: await newSession(store, user.id), user: publicUser(user) });
    }

    /* ----- everything below needs a login ----- */
    const me = await userFromRequest(req, store);
    if (!me) return fail(401, "Please log in.");
    const other = async () => {
      const ks = await keysOf(store, "user/");
      return (await getMany(store, ks)).find((u) => u.id !== me.id) ?? null;
    };
    const notifyOther = async (payload: { title: string; body: string; tag?: string }) => {
      const o = await other();
      if (o) await pushTo(store, o.id, payload, origin);
    };

    if (route === "logout" && method === "POST") {
      const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") ?? "");
      if (m) await store.delete(`session/${sha(m[1])}`);
      return json({ ok: true });
    }

    if (route === "state" && method === "GET") {
      const from = url.searchParams.get("from") ?? "2000-01";
      const expKeys = (await keysOf(store, "exp/")).filter((k) => k.split("/")[1] >= from);
      const [users, invites, cats, goals, contribs, expenses, requests, pushKeys, v] = await Promise.all([
        keysOf(store, "user/").then((k) => getMany(store, k)),
        keysOf(store, "invite/").then((k) => getMany(store, k)),
        keysOf(store, "cat/").then((k) => getMany(store, k)),
        keysOf(store, "goal/").then((k) => getMany(store, k)),
        keysOf(store, "contrib/").then((k) => getMany(store, k)),
        getMany(store, expKeys),
        pendingRequests(store),
        keysOf(store, `push/${me.id}/`),
        vapid(store),
      ]);
      const cutoff = Date.now() - 14 * 864e5;
      return json({
        me: publicUser(me),
        users: users.map(publicUser),
        invites: invites.map((i) => i.email),
        cats, goals, contribs, expenses,
        requests: requests.filter((r) => r.status === "pending" || (r.decidedAt ?? r.ts) > cutoff).sort((a, b) => a.ts - b.ts),
        vapidPublicKey: v.publicKey,
        pushOn: pushKeys.length > 0,
        emailEnabled: mailEnabled(),
      });
    }

    if (route === "log" && method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      const before = url.searchParams.get("before");
      let keys = (await keysOf(store, "log/")).sort();
      if (before) keys = keys.filter((k) => k < `log/${before}`);
      const page = keys.slice(-limit).reverse();
      return json({ entries: await getMany(store, page), more: keys.length > limit });
    }

    if (route === "me" && method === "PUT") {
      const b = await readBody(req);
      const name = str(b.name, 20);
      if (!name) return fail(400, "Enter a name.");
      if (name !== me.name) {
        await store.setJSON(`user/${me.id}`, { ...me, name });
        await log(store, me.id, "user.name", { from: me.name, to: name });
      }
      return json({ ok: true });
    }

    if (route === "password" && method === "POST") {
      const b = await readBody(req);
      if (!pwOk(b.password)) return fail(400, "Use at least 8 characters for the new password.");
      if (typeof b.current !== "string" || !checkPw(b.current.slice(0, 200), me)) return fail(403, "Your current password is wrong.");
      await store.setJSON(`user/${me.id}`, { ...me, ...hashPw(b.password) });
      const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") ?? "");
      await dropSessions(store, me.id, m ? `session/${sha(m[1])}` : undefined);
      await log(store, me.id, "user.password", { how: "changed" });
      return json({ ok: true });
    }

    if (route === "push" && method === "POST" && (parts[1] === "subscribe" || parts[1] === "unsubscribe")) {
      const b = await readBody(req);
      const endpoint = b.subscription?.endpoint ?? b.endpoint;
      if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 600) return fail(400, "Invalid subscription.");
      const key = `push/${me.id}/${sha(endpoint)}`;
      if (parts[1] === "unsubscribe") { await store.delete(key); return json({ ok: true }); }
      const k = b.subscription?.keys;
      if (typeof k?.p256dh !== "string" || typeof k?.auth !== "string") return fail(400, "Invalid subscription.");
      await store.setJSON(key, { sub: { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } }, ts: Date.now() });
      return json({ ok: true });
    }

    /* ----- expenses ----- */
    if (route === "expense" && method === "PUT") {
      const b = await readBody(req);
      const date = validDate(b.date);
      const amount = num(b.amount, 0.01, 100000);
      if (!ID.test(b.id ?? "") || !ID.test(b.catId ?? "") || !date || amount === null) return fail(400, "Invalid expense.");
      const month = date.slice(0, 7);
      const oldMonth = typeof b.oldMonth === "string" && /^\d{4}-\d{2}$/.test(b.oldMonth) ? b.oldMonth : month;
      const existingKey = (await store.get(`exp/${month}/${b.id}`, { type: "json" })) ? `exp/${month}/${b.id}` : `exp/${oldMonth}/${b.id}`;
      const existing = await store.get(existingKey, { type: "json" });
      const rec: any = { id: b.id, catId: b.catId, amount, note: str(b.note, 80), who: slotOf(b.who), date, by: existing?.by ?? me.slot, ts: existing?.ts ?? Date.now() };
      if (existing) {
        if (existing.by !== me.slot) return fail(403, "You can only edit expenses you added yourself.");
        if ((await pendingRequests(store)).some((r) => r.status === "pending" && r.payload?.expenseId === b.id)) return fail(409, "A deletion is waiting for approval on this expense.");
        const changed = ["catId", "amount", "note", "who", "date"].some((f) => existing[f] !== rec[f]);
        if (!changed) return json({ ok: true });
        rec.editedAt = Date.now();
        await store.setJSON(`exp/${month}/${rec.id}`, rec);
        if (existingKey !== `exp/${month}/${rec.id}`) await store.delete(existingKey);
        await log(store, me.id, "expense.edit", { before: existing, after: rec });
      } else {
        await store.setJSON(`exp/${month}/${rec.id}`, rec);
        await log(store, me.id, "expense.add", { exp: rec });
      }
      return json({ ok: true });
    }

    if (route === "expense" && method === "POST" && parts[1] === "delete-request") {
      const b = await readBody(req);
      if (!ID.test(b.id ?? "") || !/^\d{4}-\d{2}$/.test(b.month ?? "")) return fail(400, "Invalid request.");
      const exp = await store.get(`exp/${b.month}/${b.id}`, { type: "json" });
      if (!exp) return fail(404, "That expense no longer exists.");
      if ((await pendingRequests(store)).some((r) => r.status === "pending" && r.payload?.expenseId === b.id)) return fail(409, "A deletion is already waiting for approval.");
      const r = { id: "r-" + rid(6), type: "expense.delete", by: me.slot, uid: me.id, ts: Date.now(), status: "pending", payload: { month: b.month, expenseId: b.id, snapshot: exp } };
      await store.setJSON(`req/${r.id}`, r);
      await log(store, me.id, "expense.delete.request", { reqId: r.id, exp });
      await notifyOther({ title: `${me.name} wants to delete an expense`, body: `${eur(exp.amount)}${exp.note ? ` · ${exp.note}` : ""}. Tap to approve or decline.`, tag: r.id });
      return json({ ok: true, id: r.id });
    }

    /* ----- budget changes ----- */
    if (route === "budget" && method === "POST" && parts[1] === "request") {
      const b = await readBody(req);
      const changes = Array.isArray(b.changes) ? b.changes.map(cleanCat) : [];
      if (!changes.length || changes.some((c: any) => !c) || changes.length > 40) return fail(400, "Invalid budget change.");
      if ((await pendingRequests(store)).some((r) => r.status === "pending" && r.type === "budget.change")) return fail(409, "A budget change is already waiting for approval.");
      const current = Object.fromEntries((await getMany(store, await keysOf(store, "cat/"))).map((c) => [c.id, c]));
      const real = changes.filter((c: any) => JSON.stringify(current[c.id] ?? null) !== JSON.stringify(c));
      if (!real.length) return fail(400, "Nothing changed.");
      const r = { id: "r-" + rid(6), type: "budget.change", by: me.slot, uid: me.id, ts: Date.now(), status: "pending", payload: { changes: real, before: real.map((c: any) => current[c.id] ?? null) } };
      await store.setJSON(`req/${r.id}`, r);
      await log(store, me.id, "budget.request", { reqId: r.id, changes: r.payload.changes, before: r.payload.before });
      await notifyOther({ title: `${me.name} wants to change the budget`, body: `${real.length} ${real.length === 1 ? "change" : "changes"} waiting for your approval.`, tag: r.id });
      return json({ ok: true, id: r.id });
    }

    /* ----- approving, declining, cancelling ----- */
    if (route === "request" && method === "POST" && ID.test(parts[1] ?? "") && ["approve", "decline", "cancel"].includes(parts[2])) {
      const r = await store.get(`req/${parts[1]}`, { type: "json" });
      if (!r) return fail(404, "Request not found.");
      if (r.status !== "pending") return fail(409, `This request was already ${r.status}.`);
      const action = parts[2];
      if (action === "cancel") {
        if (r.uid !== me.id) return fail(403, "Only the person who asked can cancel.");
      } else if (r.uid === me.id) return fail(403, "The other person has to decide this one.");
      if (action === "approve") await applyRequest(store, r);
      const status = action === "approve" ? "approved" : action === "decline" ? "declined" : "cancelled";
      await store.setJSON(`req/${r.id}`, { ...r, status, decidedBy: me.id, decidedAt: Date.now() });
      await log(store, me.id, `${r.type === "expense.delete" ? "expense.delete" : "budget"}.${action}`, { reqId: r.id, exp: r.payload.snapshot, changes: r.payload.changes, requestedBy: r.uid });
      if (action !== "cancel") {
        const requester = await store.get(`user/${r.uid}`, { type: "json" });
        if (requester) await pushTo(store, requester.id, { title: `${me.name} ${status} ${describe(r)}`, body: action === "approve" ? "It's done." : "Nothing was changed.", tag: r.id }, origin);
      }
      return json({ ok: true });
    }

    /* ----- goals ----- */
    if (route === "goal") {
      if (method === "PUT") {
        const b = await readBody(req);
        const target = num(b.target, 1, 10_000_000);
        const name = str(b.name, 40);
        const deadline = b.deadline ? validDate(b.deadline) : "";
        if (!ID.test(b.id ?? "") || !name || target === null || deadline === null) return fail(400, "Invalid goal.");
        const before = await store.get(`goal/${b.id}`, { type: "json" });
        const rec = { id: b.id, name, target, deadline, archived: !!b.archived, created: before?.created ?? (Number(b.created) || Date.now()) };
        await store.setJSON(`goal/${b.id}`, rec);
        await log(store, me.id, before ? "goal.edit" : "goal.add", { before, after: rec });
        return json({ ok: true });
      }
      if (method === "DELETE" && parts.length === 2 && ID.test(parts[1])) {
        const g = await store.get(`goal/${parts[1]}`, { type: "json" });
        const cKeys = await keysOf(store, `contrib/${parts[1]}/`);
        const cs = await getMany(store, cKeys);
        await store.delete(`goal/${parts[1]}`);
        await Promise.all(cKeys.map((k) => store.delete(k)));
        await log(store, me.id, "goal.delete", { goal: g, contribs: cs });
        return json({ ok: true });
      }
    }

    if (route === "contrib") {
      if (method === "PUT") {
        const b = await readBody(req);
        const date = validDate(b.date);
        const amount = num(b.amount, -10_000_000, 10_000_000);
        if (!ID.test(b.id ?? "") || !ID.test(b.goalId ?? "") || !date || amount === null || amount === 0) return fail(400, "Invalid amount.");
        const before = await store.get(`contrib/${b.goalId}/${b.id}`, { type: "json" });
        const rec = { id: b.id, goalId: b.goalId, amount, who: slotOf(b.who), date, note: str(b.note, 60), by: before?.by ?? me.slot };
        await store.setJSON(`contrib/${b.goalId}/${b.id}`, rec);
        await log(store, me.id, before ? "contrib.edit" : "contrib.add", { before, after: rec });
        return json({ ok: true });
      }
      if (method === "DELETE" && parts.length === 3 && ID.test(parts[1]) && ID.test(parts[2])) {
        const c = await store.get(`contrib/${parts[1]}/${parts[2]}`, { type: "json" });
        await store.delete(`contrib/${parts[1]}/${parts[2]}`);
        await log(store, me.id, "contrib.delete", { contrib: c });
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
