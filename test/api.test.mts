import assert from "node:assert/strict";
process.env.OPEN_MODE = "0"; // tests cover the login rules; open mode has its own test below

const mem = new Map<string, string>();
(globalThis as any).__BUDGET_STORE = {
  async get(k: string) { const v = mem.get(k); return v === undefined ? null : JSON.parse(v); },
  async setJSON(k: string, v: unknown) { mem.set(k, JSON.stringify(v)); }, // like the deployed @netlify/blobs: returns nothing
  async delete(k: string) { mem.delete(k); },
  async list(o?: { prefix?: string }) { return { blobs: [...mem.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).sort().map((key) => ({ key })) }; },
};
const mails: any[] = []; const pushes: any[] = [];
(globalThis as any).__BUDGET_MAIL = async (m: any) => { mails.push(m); };
(globalThis as any).__BUDGET_PUSH = async (uid: string, p: any) => { pushes.push({ uid, ...p }); };

const { default: api } = await import("../netlify/functions/api.mts");
async function call(method: string, path: string, body?: unknown, token: string | null = null) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await api(new Request(`https://x.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {} as any);
  return { status: r.status, data: await r.json() as any };
}

async function rawCall(method: string, path: string, headers: Record<string, string>) {
  const r = await api(new Request(`https://x.test${path}`, { method, headers }), {} as any);
  return { status: r.status, data: await r.json() as any };
}

/* ---- accounts ---- */
let r = await call("GET", "/api/status"); assert.equal(r.data.users, 0); assert.equal(r.data.emailEnabled, true);
assert.equal((await call("GET", "/api/state")).status, 401, "no login, no data");
assert.equal((await call("POST", "/api/register", { name: "V", email: "bad", password: "longenough1", partnerEmail: "g@x.com" })).status, 400);
assert.equal((await call("POST", "/api/register", { name: "V", email: "v@x.com", password: "short", partnerEmail: "g@x.com" })).status, 400);
assert.equal((await call("POST", "/api/register", { name: "V", email: "v@x.com", password: "longenough1" })).status, 400, "partner email required");
r = await call("POST", "/api/register", { name: "Vihren", email: "V@X.com", password: "vihren-pass-1", partnerEmail: "g@x.com" });
assert.equal(r.status, 200); const V = r.data.token; assert.equal(r.data.user.slot, "a"); assert.equal(r.data.user.email, "v@x.com");
assert.equal((await call("POST", "/api/register", { name: "Rando", email: "rando@x.com", password: "longenough1" })).status, 403, "only the invited email can join");
assert.equal((await call("POST", "/api/register", { name: "V2", email: "v@x.com", password: "longenough1" })).status, 409, "email already used");
r = await call("POST", "/api/register", { name: "Victoria", email: "g@x.com", password: "victoria-pass-1" });
assert.equal(r.status, 200); const G = r.data.token; assert.equal(r.data.user.slot, "b");
assert.equal((await call("POST", "/api/register", { name: "Third", email: "t@x.com", password: "longenough1" })).status, 403, "only two accounts");

r = await call("POST", "/api/login", { email: "v@x.com", password: "nope-nope-1" }); assert.equal(r.status, 401);
r = await call("POST", "/api/login", { email: "V@x.com ", password: "vihren-pass-1" }); assert.equal(r.status, 200);
const V2 = r.data.token;

r = await call("GET", "/api/state?from=2026-01", undefined, V);
assert.equal(r.data.me.name, "Vihren"); assert.equal(r.data.users.length, 2); assert.equal(r.data.cats.length, 11);
assert.equal(r.data.cats.reduce((s: number, c: any) => s + c.monthly, 0), 2280, "starter budget matches the PDF total");
assert.ok(r.data.vapidPublicKey === undefined || typeof r.data.vapidPublicKey === "string");

/* ---- lockout after repeated wrong passwords ---- */
for (let i = 0; i < 8; i++) await call("POST", "/api/login", { email: "g@x.com", password: "wrong-wrong" });
assert.equal((await call("POST", "/api/login", { email: "g@x.com", password: "victoria-pass-1" })).status, 429, "locked out for a while");
mem.delete(`fail/${(await import("node:crypto")).createHash("sha256").update("g@x.com").digest("hex")}`);

/* ---- expenses: add, edit own only, never delete directly ---- */
r = await call("PUT", "/api/expense", { id: "e-0001", catId: "food", amount: "12.345", note: "  Billa  ", who: "b", date: "2026-11-10" }, V);
assert.equal(r.status, 200);
r = await call("GET", "/api/state?from=2026-01", undefined, G);
assert.equal(r.data.expenses[0].by, "a", "server records who logged it"); assert.equal(r.data.expenses[0].amount, 12.35);
assert.equal((await call("PUT", "/api/expense", { id: "e-0001", catId: "food", amount: 1, date: "2026-11-10" }, G)).status, 403, "can't edit the other person's entry");
assert.equal((await call("PUT", "/api/expense", { id: "e-0002", catId: "food", amount: -5, date: "2026-11-10" }, V)).status, 400);
assert.equal((await call("PUT", "/api/expense", { id: "e-0003", catId: "food", amount: 5, date: "2026-02-31" }, V)).status, 400);
assert.equal((await call("DELETE", "/api/expense/2026-11/e-0001", undefined, V)).status, 404, "no direct delete route exists");
assert.equal((await call("PUT", "/api/expense", { id: "e-0001", catId: "food", amount: 20, note: "Billa", who: "b", date: "2026-11-10" }, V)).status, 200, "own edit allowed");

/* ---- both phones subscribe to push ---- */
for (const [tok, ep] of [[V, "https://push.example/v"], [G, "https://push.example/g"]] as const)
  assert.equal((await call("POST", "/api/push/subscribe", { subscription: { endpoint: ep, keys: { p256dh: "k", auth: "a" } } }, tok)).status, 200);

/* ---- delete needs the other person ---- */
pushes.length = 0;
r = await call("POST", "/api/expense/delete-request", { id: "e-0001", month: "2026-11" }, G); assert.equal(r.status, 200);
const reqId = r.data.id;
assert.equal(pushes.length, 1, "the other person is notified"); assert.match(pushes[0].title, /Victoria wants to delete/);
assert.equal((await call("POST", "/api/expense/delete-request", { id: "e-0001", month: "2026-11" }, V)).status, 409, "only one request at a time");
assert.equal((await call("PUT", "/api/expense", { id: "e-0001", catId: "food", amount: 1, date: "2026-11-10" }, V)).status, 409, "no editing while deletion is pending");
assert.equal((await call("POST", `/api/request/${reqId}/approve`, undefined, G)).status, 403, "can't approve your own request");
r = await call("GET", "/api/state?from=2026-01", undefined, V);
assert.equal(r.data.expenses.length, 1, "still there until approved"); assert.equal(r.data.requests[0].status, "pending");
// decline keeps it
pushes.length = 0;
assert.equal((await call("POST", `/api/request/${reqId}/decline`, undefined, V)).status, 200);
assert.match(pushes[0].title, /Vihren declined/);
r = await call("GET", "/api/state?from=2026-01", undefined, V); assert.equal(r.data.expenses.length, 1);
assert.equal((await call("POST", `/api/request/${reqId}/approve`, undefined, V)).status, 409, "already decided");
// ask again, approve this time
r = await call("POST", "/api/expense/delete-request", { id: "e-0001", month: "2026-11" }, G); const req2 = r.data.id;
assert.equal((await call("POST", `/api/request/${req2}/approve`, undefined, V)).status, 200);
r = await call("GET", "/api/state?from=2026-01", undefined, V); assert.equal(r.data.expenses.length, 0, "deleted once approved");
// requester can cancel
await call("PUT", "/api/expense", { id: "e-0004", catId: "social", amount: 40, who: "a", date: "2026-11-02" }, V);
r = await call("POST", "/api/expense/delete-request", { id: "e-0004", month: "2026-11" }, V); const req3 = r.data.id;
assert.equal((await call("POST", `/api/request/${req3}/cancel`, undefined, G)).status, 403);
assert.equal((await call("POST", `/api/request/${req3}/cancel`, undefined, V)).status, 200);

/* ---- budget changes need the other person ---- */
const food = { id: "food", name: "Food", icon: "🛒", monthly: 120, fixed: false, archived: false, order: 3 };
assert.equal((await call("POST", "/api/budget/request", { changes: [{ ...food, monthly: 150 }] }, V)).status, 400, "no-op change is rejected");
pushes.length = 0;
r = await call("POST", "/api/budget/request", { changes: [food, { id: "gym", name: "Gym", icon: "🏋️", monthly: 30, fixed: true, order: 20 }] }, V); assert.equal(r.status, 200);
const bReq = r.data.id; assert.equal(pushes.length, 1);
assert.equal((await call("POST", "/api/budget/request", { changes: [{ ...food, monthly: 90 }] }, G)).status, 409, "one budget change at a time");
r = await call("GET", "/api/state", undefined, G); assert.equal(r.data.cats.find((c: any) => c.id === "food").monthly, 150, "unchanged until approved");
assert.equal((await call("POST", `/api/request/${bReq}/approve`, undefined, V)).status, 403);
assert.equal((await call("POST", `/api/request/${bReq}/approve`, undefined, G)).status, 200);
r = await call("GET", "/api/state", undefined, G);
assert.equal(r.data.cats.find((c: any) => c.id === "food").monthly, 120); assert.equal(r.data.cats.length, 12);

/* ---- goals still work and are logged ---- */
assert.equal((await call("PUT", "/api/goal", { id: "trip", name: "Trip", target: 1500, deadline: "2027-06-01" }, G)).status, 200);
assert.equal((await call("PUT", "/api/contrib", { id: "c-0001", goalId: "trip", amount: 100, who: "a", date: "2026-11-10" }, G)).status, 200);
assert.equal((await call("PUT", "/api/contrib", { id: "c-0002", goalId: "trip", amount: 0, date: "2026-11-10" }, G)).status, 400);
assert.equal((await call("DELETE", "/api/goal/trip", undefined, G)).status, 200);

/* ---- history is complete and can't be changed ---- */
r = await call("GET", "/api/log?limit=500", undefined, V);
const types = r.data.entries.map((e: any) => e.type);
for (const t of ["user.register", "expense.add", "expense.edit", "expense.delete.request", "expense.delete.decline", "expense.delete.approve", "expense.delete.cancel", "budget.request", "budget.approve", "goal.add", "contrib.add", "goal.delete"])
  assert.ok(types.includes(t), `history has ${t}`);
assert.ok(r.data.entries[0].ts >= r.data.entries.at(-1).ts, "newest first");
const edit = r.data.entries.find((e: any) => e.type === "expense.edit");
assert.equal(edit.data.before.amount, 12.35); assert.equal(edit.data.after.amount, 20, "edits keep before and after");
const del = r.data.entries.find((e: any) => e.type === "expense.delete.approve");
assert.equal(del.data.exp.note, "Billa", "approved deletions keep a copy of what was deleted");
for (const m of ["DELETE", "PUT", "POST"]) assert.equal((await call(m, `/api/log/${r.data.entries[0].id}`, {}, V)).status, 404, "no way to change the log");

/* ---- password reset by email ---- */
mails.length = 0;
assert.equal((await call("POST", "/api/forgot", { email: "nobody@x.com" })).status, 200); assert.equal(mails.length, 0, "no hint whether an account exists");
assert.equal((await call("POST", "/api/forgot", { email: "g@x.com" })).status, 200); assert.equal(mails.length, 1);
const token = /#reset=([a-f0-9]+)/.exec(mails[0].text)![1];
assert.equal((await call("POST", "/api/reset", { token: "0".repeat(48), password: "new-password-1" })).status, 400);
assert.equal((await call("POST", "/api/reset", { token, password: "new-password-1" })).status, 200);
assert.equal((await call("POST", "/api/reset", { token, password: "new-password-2" })).status, 400, "link works once");
assert.equal((await call("GET", "/api/state", undefined, G)).status, 401, "old sessions end after a reset");
assert.equal((await call("POST", "/api/login", { email: "g@x.com", password: "new-password-1" })).status, 200);

/* ---- recovery key (no-email fallback) ---- */
assert.equal((await call("GET", "/api/status")).data.recoveryEnabled, false);
assert.equal((await call("POST", "/api/recover", { email: "g@x.com", key: "", password: "recovered-pass-1" })).status, 401, "no key configured = disabled");
process.env.RECOVERY_KEY = "a-long-secret-key-123";
assert.equal((await call("GET", "/api/status")).data.recoveryEnabled, true);
assert.equal((await call("POST", "/api/recover", { email: "g@x.com", key: "wrong-key-wrong-key", password: "recovered-pass-1" })).status, 401);
assert.equal((await call("POST", "/api/recover", { email: "nobody@x.com", key: "a-long-secret-key-123", password: "recovered-pass-1" })).status, 401);
r = await call("POST", "/api/recover", { email: "g@x.com", key: "a-long-secret-key-123", password: "recovered-pass-1" }); assert.equal(r.status, 200); assert.ok(r.data.token);
assert.equal((await call("POST", "/api/login", { email: "g@x.com", password: "recovered-pass-1" })).status, 200);
for (let i = 0; i < 5; i++) await call("POST", "/api/recover", { email: "g@x.com", key: "bad-bad-bad-bad", password: "recovered-pass-1" });
assert.equal((await call("POST", "/api/recover", { email: "g@x.com", key: "a-long-secret-key-123", password: "recovered-pass-1" })).status, 429, "guessing is rate limited");
delete process.env.RECOVERY_KEY;

/* ---- change password, name, push subscription ---- */
assert.equal((await call("POST", "/api/password", { current: "wrong", password: "another-pass-1" }, V)).status, 403);
assert.equal((await call("POST", "/api/password", { current: "vihren-pass-1", password: "another-pass-1" }, V)).status, 200);
assert.equal((await call("GET", "/api/state", undefined, V)).status, 200, "this session stays signed in");
assert.equal((await call("GET", "/api/state", undefined, V2)).status, 401, "other sessions are signed out");
assert.equal((await call("PUT", "/api/me", { name: "Vihren D" }, V)).status, 200);
assert.equal((await call("POST", "/api/push/subscribe", { subscription: { endpoint: "http://insecure", keys: {} } }, V)).status, 400);
assert.equal((await call("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } } }, V)).status, 200);
r = await call("GET", "/api/state", undefined, V); assert.equal(r.data.pushOn, true); assert.equal(r.data.me.name, "Vihren D");
assert.equal((await call("POST", "/api/logout", undefined, V)).status, 200);
assert.equal((await call("GET", "/api/state", undefined, V)).status, 401);
/* ---- open mode (no login) ---- */
process.env.OPEN_MODE = "1";
assert.equal((await call("GET", "/api/state")).status, 401, "still needs to say who you are");
const OA = { "x-open-who": "a" }, OB = { "x-open-who": "b" };
r = await rawCall("GET", "/api/state", OA); assert.equal(r.status, 200); assert.equal(r.data.me.slot, "a");
assert.equal((await rawCall("GET", "/api/state", { "x-open-who": "c" })).status, 401);
process.env.OPEN_MODE = "0";
assert.equal((await rawCall("GET", "/api/state", OA)).status, 401, "closed again when switched off");

console.log("all API tests passed");
