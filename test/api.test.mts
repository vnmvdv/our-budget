import assert from "node:assert/strict";

const mem = new Map<string, string>();
(globalThis as any).__BUDGET_STORE = {
  async get(k: string) { const v = mem.get(k); return v === undefined ? null : JSON.parse(v); },
  async setJSON(k: string, v: unknown, o?: { onlyIfNew?: boolean }) {
    mem.set(k, JSON.stringify(v)); // like the deployed @netlify/blobs: returns nothing useful

  },
  async delete(k: string) { mem.delete(k); },
  async list(o?: { prefix?: string }) { return { blobs: [...mem.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).sort().map((key) => ({ key })) }; },
};

const { default: api } = await import("../netlify/functions/api.mts");
const KEY = "correct horse battery";
async function call(method: string, path: string, body?: unknown, key: string | null = KEY) {
  const headers: Record<string, string> = {};
  if (key) headers["x-household-key"] = key;
  const r = await api(new Request(`https://x.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), {} as any);
  return { status: r.status, data: await r.json() as any };
}

// a half-finished earlier setup (auth saved, no meta) must not block a fresh setup
mem.set("auth", JSON.stringify({ salt: "00", hash: "00" }));
let r = await call("GET", "/api/status", undefined, null);
assert.equal(r.data.configured, false);
r = await call("POST", "/api/setup", { passphrase: "short" }, null); assert.equal(r.status, 400);
r = await call("POST", "/api/setup", { passphrase: KEY, nameA: "Vihren", nameB: "G" }, null); assert.equal(r.status, 200);
r = await call("POST", "/api/setup", { passphrase: "another passphrase" }, null); assert.equal(r.status, 409, "setup can only happen once");
r = await call("GET", "/api/status", undefined, null); assert.equal(r.data.configured, true);

assert.equal((await call("GET", "/api/state", undefined, null)).status, 401);
assert.equal((await call("GET", "/api/state", undefined, "wrong passphrase")).status, 401);

r = await call("GET", "/api/state?from=2026-01");
assert.equal(r.status, 200);
assert.equal(r.data.cats.length, 11);
assert.equal(r.data.cats.reduce((s: number, c: any) => s + c.monthly, 0), 2280, "starter budget matches the PDF total");
assert.deepEqual(r.data.meta.names, { a: "Vihren", b: "G" });

// expenses
r = await call("PUT", "/api/expense", { id: "e-0001", catId: "food", amount: "12.345", note: "  Billa  ", who: "b", date: "2026-11-10" });
assert.equal(r.status, 200);
assert.equal((await call("PUT", "/api/expense", { id: "e-0002", catId: "food", amount: -5, date: "2026-11-10" })).status, 400);
assert.equal((await call("PUT", "/api/expense", { id: "e-0003", catId: "food", amount: 5, date: "2026-02-31" })).status, 400);
assert.equal((await call("PUT", "/api/expense", { id: "../x", catId: "food", amount: 5, date: "2026-11-10" })).status, 400);
await call("PUT", "/api/expense", { id: "e-0004", catId: "social", amount: 40, who: "a", date: "2026-09-02" });
r = await call("GET", "/api/state?from=2026-10");
assert.equal(r.data.expenses.length, 1, "from= filters older months");
assert.equal(r.data.expenses[0].amount, 12.35);
assert.equal(r.data.expenses[0].note, "Billa");
assert.equal(r.data.expenses[0].who, "b");
r = await call("GET", "/api/state?from=2026-01"); assert.equal(r.data.expenses.length, 2);
assert.equal((await call("DELETE", "/api/expense/2026-11/e-0001")).status, 200);
r = await call("GET", "/api/state?from=2026-01"); assert.equal(r.data.expenses.length, 1);

// categories
assert.equal((await call("PUT", "/api/cat", { id: "gym", name: "Gym", icon: "🏋️", monthly: 30, fixed: true, order: 20 })).status, 200);
assert.equal((await call("PUT", "/api/cat", { id: "gym", name: "", monthly: 30 })).status, 400);
r = await call("GET", "/api/state"); assert.equal(r.data.cats.length, 12);

// goals + contributions
assert.equal((await call("PUT", "/api/goal", { id: "trip", name: "Trip", target: 1500, deadline: "2027-06-01" })).status, 200);
assert.equal((await call("PUT", "/api/goal", { id: "bad1", name: "x", target: 0 })).status, 400);
assert.equal((await call("PUT", "/api/contrib", { id: "c-0001", goalId: "trip", amount: 100, who: "a", date: "2026-11-10" })).status, 200);
assert.equal((await call("PUT", "/api/contrib", { id: "c-0002", goalId: "trip", amount: 0, date: "2026-11-10" })).status, 400);
r = await call("GET", "/api/state"); assert.equal(r.data.goals.length, 1); assert.equal(r.data.contribs.length, 1);
assert.equal((await call("DELETE", "/api/goal/trip")).status, 200);
r = await call("GET", "/api/state"); assert.equal(r.data.goals.length, 0); assert.equal(r.data.contribs.length, 0, "deleting a goal removes its contributions");

// meta + passphrase change
assert.equal((await call("PUT", "/api/meta", { nameA: "V", nameB: "" })).status, 400);
assert.equal((await call("PUT", "/api/meta", { nameA: "V", nameB: "Gf" })).status, 200);
assert.equal((await call("POST", "/api/passphrase", { passphrase: "a brand new phrase" })).status, 200);
assert.equal((await call("GET", "/api/state")).status, 401, "old passphrase stops working");
assert.equal((await call("GET", "/api/state", undefined, "a brand new phrase")).status, 200);
assert.equal((await call("GET", "/api/nope", undefined, "a brand new phrase")).status, 404);
console.log("all API tests passed");
