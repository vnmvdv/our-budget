/* Our budget — shared monthly budget for two. Vanilla JS, no build step. */

/* ============ helpers ============ */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))
    .toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthOf = (ds) => ds.slice(0, 7);
const ymd = (m) => m.split("-").map(Number);
const addMonths = (m, k) => { const [y, mo] = ymd(m); const d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const daysIn = (m) => { const [y, mo] = ymd(m); return new Date(y, mo, 0).getDate(); };
const monthName = (m, o = { month: "long", year: "numeric" }) => { const [y, mo] = ymd(m); return new Date(y, mo - 1, 1).toLocaleDateString("en-GB", o); };
const dateObj = (ds) => { const [y, m, d] = ds.split("-").map(Number); return new Date(y, m - 1, d); };
const dowMon = (ds) => (dateObj(ds).getDay() + 6) % 7; // Monday = 0
const ymdOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLabel = (ds) => {
  if (ds === todayStr()) return "Today";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (ds === ymdOf(y)) return "Yesterday";
  return dateObj(ds).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};
const timeLabel = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function eur(n) {
  if (!Number.isFinite(n)) n = 0;
  const neg = n < -0.004;
  const a = Math.abs(n);
  const whole = a >= 100 || Math.abs(a - Math.round(a)) < 0.005;
  const s = a.toLocaleString("en-GB", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  return `${neg ? "−" : ""}€${s}`;
}
const eur0 = (n) => `${n < -0.5 ? "−" : ""}€${Math.abs(Math.round(n)).toLocaleString("en-GB")}`;

/* ============ state ============ */
const S = {
  token: localStorage.getItem("ob.token") || "",
  who: localStorage.getItem("ob.who") || "",
  data: null,
  status: { users: 0, emailEnabled: false },
  tab: "today",
  month: monthOf(todayStr()),
  filterCat: "all",
  filterWho: "all",
  sheet: false,
  stale: false,
  lastSig: "",
  lastCat: localStorage.getItem("ob.lastcat") || "",
  draft: null,
  log: null,
  logWho: "all",
  logOnly: false,
};
const meUser = () => S.data.me;
const mySlot = () => S.data.me.slot;
const names = () => {
  const u = S.data?.users ?? [];
  const f = (s) => u.find((x) => x.slot === s)?.name;
  return { a: f("a") || "Partner", b: f("b") || "Partner" };
};
const otherSlot = () => (mySlot() === "a" ? "b" : "a");
const otherName = () => names()[otherSlot()];
const userName = (id) => S.data.users.find((u) => u.id === id)?.name ?? "Someone";
const catById = () => Object.fromEntries(S.data.cats.map((c) => [c.id, c]));
const catName = (id) => catById()[id]?.name ?? "Category";
const activeCats = () => S.data.cats.filter((c) => !c.archived).sort((a, b) => a.order - b.order);

/* requests that need approval */
const pendingReqs = () => (S.data.requests ?? []).filter((r) => r.status === "pending");
const toApprove = () => pendingReqs().filter((r) => r.uid !== meUser().id);
const waitingOn = () => pendingReqs().filter((r) => r.uid === meUser().id);
const pendingDeleteFor = (expId) => pendingReqs().find((r) => r.type === "expense.delete" && r.payload.expenseId === expId);
const pendingBudget = () => pendingReqs().find((r) => r.type === "budget.change");
const decidedNotices = () => {
  const seen = Number(localStorage.getItem("ob.seen")) || 0;
  return (S.data.requests ?? []).filter((r) => r.uid === meUser().id && (r.status === "approved" || r.status === "declined") && (r.decidedAt ?? 0) > seen);
};

/* ============ api ============ */
async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(S.token && !S.status.open ? { authorization: `Bearer ${S.token}` } : {}), ...(S.status.open && S.who ? { "x-open-who": S.who } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token && S.data && !S.status.open) { signOutLocal(); throw Object.assign(new Error("Please log in again."), { status: 401 }); }
  if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status });
  return data;
}

async function refresh(force = false) {
  const from = addMonths(monthOf(todayStr()), -11);
  const data = await api("GET", `/state?from=${from}`);
  const sig = JSON.stringify(data);
  if (sig === S.lastSig && !force) return;
  S.lastSig = sig;
  S.data = data;
  if (S.sheet && !force) { S.stale = true; return; }
  render();
}

/** Apply a change locally right away, then save it; if saving fails, show why and reload the truth. */
async function mutate(applyLocal, request) {
  applyLocal();
  S.lastSig = "";
  render();
  try { await request(); }
  catch (e) { toast(e.message || "Couldn't save. Check your connection."); await refresh(true).catch(() => {}); }
}

/* ============ calculations ============ */
function calc(month) {
  const cats = activeCats();
  const byId = catById();
  const exps = S.data.expenses.filter((e) => e.date.startsWith(month));
  const spent = {};
  for (const e of exps) spent[e.catId] = (spent[e.catId] || 0) + e.amount;
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const budget = cats.reduce((s, c) => s + c.monthly, 0);
  const flexCats = cats.filter((c) => !c.fixed);
  const fixedCats = cats.filter((c) => c.fixed);
  const flexBudget = flexCats.reduce((s, c) => s + c.monthly, 0);
  const isFlexExp = (e) => byId[e.catId] && !byId[e.catId].fixed;
  const flexByDay = {};
  for (const e of exps) if (isFlexExp(e)) flexByDay[e.date] = (flexByDay[e.date] || 0) + e.amount;

  const dim = daysIn(month);
  const today = todayStr();
  const isCur = month === monthOf(today);
  const out = { cats, flexCats, fixedCats, exps, spent, total, budget, flexBudget, dim, isCur, byId };
  const flexSpent = Object.values(flexByDay).reduce((s, v) => s + v, 0);
  out.flexSpent = flexSpent;

  // allowance for each day, as if you re-plan every morning
  const days = [];
  let before = 0;
  for (let d = 1; d <= dim; d++) {
    const ds = `${month}-${pad(d)}`;
    const allowance = (flexBudget - before) / (dim - d + 1);
    const spentD = flexByDay[ds] || 0;
    days.push({ ds, d, allowance, spent: spentD });
    before += spentD;
  }
  out.days = days;
  if (isCur) {
    const dom = Number(today.slice(8));
    const t = days[dom - 1];
    out.dom = dom;
    out.daysLeft = dim - dom + 1;
    out.todayAllowance = t.allowance;
    out.todaySpent = t.spent;
    out.todayLeft = t.allowance - t.spent;
    out.flexRemaining = flexBudget - flexSpent;
    const weekStartDay = Math.max(1, dom - dowMon(today));
    const weekEndDay = Math.min(dim, dom + (6 - dowMon(today)));
    const wd = weekEndDay - weekStartDay + 1;
    const beforeWeek = days.slice(0, weekStartDay - 1).reduce((s, x) => s + x.spent, 0);
    out.weekAllowance = ((flexBudget - beforeWeek) / (dim - weekStartDay + 1)) * wd;
    out.weekSpent = days.slice(weekStartDay - 1, weekEndDay).reduce((s, x) => s + x.spent, 0);
    out.weekLeft = out.weekAllowance - out.weekSpent;
  }
  return out;
}

/* ============ icons ============ */
const svg = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const I = {
  today: svg('<path d="M4 13a8 8 0 0 1 16 0"/><path d="M12 13l4-4"/><path d="M4 18h16"/>'),
  list: svg('<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>'),
  chart: svg('<path d="M5 20V11M12 20V5M19 20v-6"/>'),
  goal: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 'stroke-width="2.6"'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  prev: svg('<path d="M15 5l-7 7 7 7"/>', 'stroke-width="2.4"'),
  next: svg('<path d="M9 5l7 7-7 7"/>', 'stroke-width="2.4"'),
};

/* ============ shared pieces ============ */
const app = $("#app");

function topbar(title, sub, { back = false } = {}) {
  const n = toApprove().length;
  return `<header class="topbar"><div class="topbar-l">${back ? `<button class="icon-btn" data-action="tab" data-tab="today" aria-label="Back">${I.prev}</button>` : ""}<div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}</div></div>
    <div class="topbar-r"><button class="icon-btn" data-action="tab" data-tab="history" aria-label="${n ? `History, ${n} waiting for you` : "History"}">${I.clock}${n ? `<span class="badge">${n}</span>` : ""}</button>
    <button class="icon-btn" data-action="settings" aria-label="Settings">${I.gear}</button></div></header>`;
}

function expLabel(x) { return `${eur(x.amount)} · ${catName(x.catId)}${x.note ? ` · ${x.note}` : ""}`; }

function budgetLines(changes, before) {
  return changes.map((c, i) => {
    const b = before?.[i];
    const tag = `${c.icon} ${c.name}`;
    if (!b) return `New: ${tag}, ${eur(c.monthly)} a month${c.fixed ? " (fixed)" : ""}`;
    if (c.archived && !b.archived) return `Remove: ${tag}`;
    const bits = [];
    if (b.name !== c.name) bits.push(`renamed from “${b.name}”`);
    if (b.monthly !== c.monthly) bits.push(`${eur(b.monthly)} → ${eur(c.monthly)}`);
    if (b.fixed !== c.fixed) bits.push(c.fixed ? "now a fixed cost" : "now an everyday cost");
    if (b.icon !== c.icon) bits.push("new icon");
    return `${tag}: ${bits.join(", ") || "updated"}`;
  });
}

/** The cards at the top of every screen: things waiting on you, things you're waiting on, news. */
function approvals() {
  const out = [];
  for (const r of toApprove()) {
    const who = userName(r.uid);
    if (r.type === "expense.delete") {
      const x = r.payload.snapshot;
      out.push(`<section class="ask" aria-label="Approval needed"><p class="ask-title">${esc(who)} wants to delete an expense</p>
        <div class="ask-item"><span class="glyph" aria-hidden="true">${esc(catById()[x.catId]?.icon || "•")}</span><div class="row-main"><div class="row-title">${esc(x.note || catName(x.catId))}</div><div class="row-sub">${esc(catName(x.catId))} · ${esc(dayLabel(x.date))} · added by ${esc(names()[x.by])}</div></div><span class="row-amt num">${eur(x.amount)}</span></div>
        <div class="btn-row"><button class="btn small" data-action="decide" data-id="${esc(r.id)}" data-op="approve">Approve deletion</button><button class="btn small alt" data-action="decide" data-id="${esc(r.id)}" data-op="decline">Keep it</button></div></section>`);
    } else {
      out.push(`<section class="ask" aria-label="Approval needed"><p class="ask-title">${esc(who)} wants to change the budget</p>
        <ul class="ask-list">${budgetLines(r.payload.changes, r.payload.before).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
        <div class="btn-row"><button class="btn small" data-action="decide" data-id="${esc(r.id)}" data-op="approve">Approve change</button><button class="btn small alt" data-action="decide" data-id="${esc(r.id)}" data-op="decline">Decline</button></div></section>`);
    }
  }
  for (const r of waitingOn()) {
    const what = r.type === "expense.delete" ? `deleting ${expLabel(r.payload.snapshot)}` : "your budget change";
    out.push(`<section class="note"><p>Waiting for ${esc(otherName())} to approve ${esc(what)}.</p><button class="link" data-action="decide" data-id="${esc(r.id)}" data-op="cancel">Cancel request</button></section>`);
  }
  for (const r of decidedNotices()) {
    const what = r.type === "expense.delete" ? `deleting ${expLabel(r.payload.snapshot)}` : "your budget change";
    out.push(`<section class="note ${r.status === "declined" ? "no" : "yes"}"><p>${esc(userName(r.decidedBy))} ${r.status} ${esc(what)}.</p><button class="link" data-action="dismiss-notices">Dismiss</button></section>`);
  }
  if (pushSupported() && Notification.permission === "default" && !S.data.pushOn && !localStorage.getItem("ob.pushno")) {
    const ios = isIos() && !isStandalone();
    out.push(`<section class="note"><p><b>Get notified on your phone</b> when ${esc(otherName())} needs your approval.${ios ? " On iPhone, first add this app to your Home Screen (Share, then Add to Home Screen) and open it from there." : ""}</p>
      <div class="btn-row">${ios ? "" : '<button class="btn small" data-action="push-on">Turn on</button>'}<button class="link" data-action="push-no">Not now</button></div></section>`);
  }
  return out.join("");
}

/* ============ rendering ============ */
function render() {
  if (!S.data) return;
  const y = window.scrollY;
  const views = { today: viewToday, spending: viewSpending, insights: viewInsights, goals: viewGoals, history: viewHistory };
  app.innerHTML = `<div class="shell">${(views[S.tab] || viewToday)()}</div>${tabbar()}`;
  window.scrollTo(0, y);
}

function tabbar() {
  const t = (id, label, icon) => `<button class="tab" data-action="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ""}>${icon}<span>${label}</span></button>`;
  return `<nav class="tabbar" aria-label="Main"><div class="tabbar-in">
    ${t("today", "Today", I.today)}${t("spending", "Spending", I.list)}
    <button class="fab" data-action="add" aria-label="Add expense">${I.plus}</button>
    ${t("insights", "Insights", I.chart)}${t("goals", "Goals", I.goal)}
  </div></nav>`;
}

function envelope(c, k, isCur) {
  const spent = k.spent[c.id] || 0;
  const left = c.monthly - spent;
  const pct = c.monthly > 0 ? Math.min(100, (spent / c.monthly) * 100) : spent > 0 ? 100 : 0;
  const over = left < -0.004;
  let hint = "";
  if (c.fixed) hint = spent >= c.monthly - 0.005 && c.monthly > 0 ? '<span class="paid">Paid</span>' : "Due this month";
  else if (isCur && !over && k.daysLeft) hint = `about ${eur(left / k.daysLeft)} a day left`;
  else if (over) hint = "Over budget";
  else hint = `${eur(c.monthly / 30.4)} a day`;
  return `<button class="env" data-action="filter-cat" data-id="${esc(c.id)}">
    <div class="env-top"><span class="glyph" aria-hidden="true">${esc(c.icon)}</span>
      <div class="env-main"><div class="env-name">${esc(c.name)}</div><div class="env-hint">${hint}</div></div>
      <div class="env-amt"><div class="env-left num ${over ? "neg" : ""}">${over ? `${eur(-left)} over` : `${eur(left)} left`}</div><div class="env-of">${eur(spent)} of ${eur(c.monthly)}</div></div></div>
    <div class="bar" role="img" aria-label="${eur(spent)} of ${eur(c.monthly)} spent"><i class="${over ? "over" : ""}" style="width:${pct}%"></i></div>
  </button>`;
}

function viewToday() {
  const month = monthOf(todayStr());
  const k = calc(month);
  const over = k.todayLeft < -0.004;
  const used = k.flexRemaining <= 0.004;
  const monthShort = monthName(month, { month: "long" });
  let label = "Left to spend today", num = eur0(Math.max(0, k.todayLeft)), sub = `of ${eur0(Math.max(0, k.todayAllowance))} for today · ${k.daysLeft} ${k.daysLeft === 1 ? "day" : "days"} left in ${monthShort}`;
  if (over) { label = "Over today's budget by"; num = eur0(-k.todayLeft); sub = `Tomorrow's budget adjusts to what's left in ${monthShort}`; }
  if (used) { label = "Everyday budget used up"; num = eur0(k.flexRemaining); sub = `You're past the everyday total for ${monthShort}. Fixed bills are separate.`; }
  const ruler = k.days.map((d) => {
    const isToday = d.d === k.dom;
    const future = d.d > k.dom;
    let cls = future ? "" : d.spent <= 0.004 ? "nospend" : d.spent <= d.allowance + 0.005 ? "ok" : "over";
    if (isToday) cls += " today";
    return `<i class="${cls}" title="${esc(dayLabel(d.ds))}: ${eur(d.spent)}"></i>`;
  }).join("");
  const wkPct = k.weekAllowance > 0 ? Math.min(100, (k.weekSpent / k.weekAllowance) * 100) : 100;
  const moPct = k.budget > 0 ? Math.min(100, (k.total / k.budget) * 100) : 0;
  const title = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return `${topbar(title, `Hi ${meUser().name}`)}${approvals()}
  <section class="hero ${over || used ? "is-over" : ""}" aria-label="Today">
    <p class="hero-label">${label}</p>
    <p class="hero-num">${num}</p>
    <p class="hero-sub">${sub}</p>
    <div class="ruler" role="img" aria-label="Each bar is a day this month. Full bars are days within the everyday budget, coral bars are days over it.">${ruler}</div>
    <p class="hero-note">Each bar is a day. Coral means you went over that day. Counts everyday categories only.</p>
  </section>
  <section class="panel duo" aria-label="Week and month">
    <div><p class="k">This week</p><p class="v num ${k.weekLeft < 0 ? "neg" : ""}">${eur0(k.weekLeft)}</p><p class="v-sub">left of ${eur0(k.weekAllowance)} everyday</p>
      <div class="bar"><i class="${k.weekLeft < 0 ? "over" : ""}" style="width:${wkPct}%"></i></div></div>
    <div><p class="k">${esc(monthShort)}</p><p class="v num ${k.total > k.budget ? "neg" : ""}">${eur0(k.total)}</p><p class="v-sub">spent of ${eur0(k.budget)}</p>
      <div class="bar"><i class="${k.total > k.budget ? "over" : ""}" style="width:${moPct}%"></i></div></div>
  </section>
  <p class="group-title">Everyday</p>
  ${k.flexCats.map((c) => envelope(c, k, true)).join("") || '<p class="hint">No everyday categories yet. Add some in settings.</p>'}
  <p class="group-title">Fixed monthly</p>
  ${k.fixedCats.map((c) => envelope(c, k, true)).join("")}`;
}

function viewSpending() {
  const k = calc(S.month);
  const byId = k.byId;
  const nm = names();
  let list = k.exps.slice();
  if (S.filterCat !== "all") list = list.filter((e) => e.catId === S.filterCat);
  if (S.filterWho !== "all") list = list.filter((e) => e.who === S.filterWho);
  list.sort((a, b) => (a.date === b.date ? b.ts - a.ts : a.date < b.date ? 1 : -1));
  const groups = [];
  for (const e of list) {
    const g = groups[groups.length - 1];
    if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, items: [e] });
  }
  const sum = list.reduce((s, e) => s + e.amount, 0);
  const catChips = [`<button class="chip" data-action="set-filter" data-kind="cat" data-id="all" aria-pressed="${S.filterCat === "all"}">All</button>`]
    .concat(activeCats().map((c) => `<button class="chip" data-action="set-filter" data-kind="cat" data-id="${esc(c.id)}" aria-pressed="${S.filterCat === c.id}">${esc(c.icon)} ${esc(c.name)}</button>`)).join("");
  const whoChips = ["all", "a", "b"].map((w) => `<button class="chip" data-action="set-filter" data-kind="who" data-id="${w}" aria-pressed="${S.filterWho === w}">${w === "all" ? "Both of us" : esc(nm[w])}</button>`).join("");
  const body = groups.length
    ? groups.map((g) => `<div class="day"><div class="day-head"><span>${esc(dayLabel(g.date))}</span><span class="num">${eur(g.items.reduce((s, e) => s + e.amount, 0))}</span></div>
        <div class="rows">${g.items.map((e) => {
          const c = byId[e.catId];
          const pend = pendingDeleteFor(e.id);
          return `<button class="row" data-action="edit-expense" data-id="${esc(e.id)}"><span class="glyph" aria-hidden="true">${esc(c?.icon || "•")}</span>
            <div class="row-main"><div class="row-title">${esc(e.note || c?.name || "Expense")}</div>
            <div class="row-sub"><span class="dot ${e.who === "b" ? "b" : ""}"></span>${esc(nm[e.who])}${e.note ? ` · ${esc(c?.name || "")}` : ""}${pend ? ' <span class="tag">Deletion requested</span>' : ""}</div></div>
            <span class="row-amt num">${eur(e.amount)}</span></button>`;
        }).join("")}</div></div>`).join("")
    : `<div class="empty"><b>Nothing here yet</b>${S.filterCat !== "all" || S.filterWho !== "all" ? "No expenses match these filters." : `No expenses logged for ${esc(monthName(S.month))}. Tap + to add the first one.`}</div>`;
  return `${topbar("Spending", `${eur(sum)} in ${monthName(S.month)}`)}${approvals()}
  ${monthNav()}
  <div class="chips" aria-label="Filter by category">${catChips}</div>
  <div class="chips" aria-label="Filter by person" style="margin-top:-6px">${whoChips}</div>
  ${body}`;
}

function monthNav() {
  const canNext = S.month < monthOf(todayStr());
  return `<div class="monthnav"><button data-action="month" data-dir="-1" aria-label="Previous month">${I.prev}</button><b>${esc(monthName(S.month))}</b>
    <button data-action="month" data-dir="1" aria-label="Next month" ${canNext ? "" : "disabled"}>${I.next}</button></div>`;
}

function viewInsights() {
  const nm = names();
  const k = calc(S.month);
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(addMonths(S.month, -i));
  const totals = months.map((m) => S.data.expenses.filter((e) => e.date.startsWith(m)).reduce((s, e) => s + e.amount, 0));
  const budget = k.budget;
  const max = Math.max(budget, ...totals, 1) * 1.12;
  const W = 340, H = 190, L = 6, R = 6, T = 14, B = 26;
  const cw = (W - L - R) / months.length;
  const bw = Math.min(34, cw * 0.62);
  const yv = (v) => T + (H - T - B) * (1 - v / max);
  const bars = months.map((m, i) => {
    const x = L + i * cw + (cw - bw) / 2;
    const h = Math.max(0, H - B - yv(totals[i]));
    const overB = totals[i] > budget && budget > 0;
    const tip = `${monthName(m, { month: "long", year: "numeric" })}: ${eur(totals[i])}${budget ? ` of ${eur(budget)}` : ""}${overB ? " (over)" : ""}`;
    return `<g><rect class="bar-m ${overB ? "over" : ""} ${m === S.month && !overB ? "cur" : ""}" x="${x.toFixed(1)}" y="${yv(totals[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="5"/>
      <rect class="hit" x="${(L + i * cw).toFixed(1)}" y="${T}" width="${cw.toFixed(1)}" height="${H - T - B}" data-tip="${esc(tip)}" data-tx="${(L + i * cw + cw / 2).toFixed(1)}" data-ty="${yv(totals[i]).toFixed(1)}"/>
      <text x="${(L + i * cw + cw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(monthName(m, { month: "short" }))}</text></g>`;
  }).join("");
  const ref = budget ? `<line class="ref" x1="${L}" x2="${W - R}" y1="${yv(budget).toFixed(1)}" y2="${yv(budget).toFixed(1)}"/><text x="${W - R}" y="${(yv(budget) - 5).toFixed(1)}" text-anchor="end">${eur0(budget)} budget</text>` : "";
  const chart = `<div class="chart" id="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending per month for the last six months: ${months.map((m, i) => `${monthName(m, { month: "long" })} ${eur0(totals[i])}`).join(", ")}">
    <line class="ax" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>${ref}${bars}</svg>
    <div class="tip" hidden></div></div>
    <div class="legend"><span><i class="dot"></i>Spent</span><span><i class="dot" style="background:var(--poppy)"></i>Over budget</span>${budget ? '<span><i class="ln"></i>Monthly budget</span>' : ""}</div>`;

  const nonzero = k.cats.concat(S.data.cats.filter((c) => c.archived && k.spent[c.id])).filter((c) => (k.spent[c.id] || 0) > 0)
    .sort((a, b) => (k.spent[b.id] || 0) - (k.spent[a.id] || 0));
  const topSpent = Math.max(...nonzero.map((c) => k.spent[c.id]), 1);
  const rank = nonzero.length
    ? `<div class="rank">${nonzero.map((c) => {
        const sp = k.spent[c.id];
        const over = c.monthly > 0 && sp > c.monthly + 0.004;
        return `<div><div class="rank-top"><b>${esc(c.icon)} ${esc(c.name)}</b><span>${eur(sp)}${c.monthly ? ` of ${eur(c.monthly)}` : ""}${over ? ` <span class="flag">▲ ${eur(sp - c.monthly)} over</span>` : ""}</span></div>
        <div class="bar"><i class="${over ? "over" : ""}" style="width:${(sp / topSpent) * 100}%"></i></div></div>`;
      }).join("")}</div>`
    : '<p class="hint">No spending logged this month yet.</p>';

  const byWho = { a: 0, b: 0 };
  for (const e of k.exps) byWho[e.who] += e.amount;
  const whoTotal = byWho.a + byWho.b;
  const who = whoTotal
    ? `<div class="split" role="img" aria-label="${esc(nm.a)} ${eur(byWho.a)}, ${esc(nm.b)} ${eur(byWho.b)}"><i style="width:${(byWho.a / whoTotal) * 100}%"></i><i class="b" style="width:${(byWho.b / whoTotal) * 100}%"></i></div>
       <div class="split-keys"><div><span class="dot"></span><span>${esc(nm.a)} <b class="num">${eur(byWho.a)}</b></span></div><div><span class="dot b"></span><span>${esc(nm.b)} <b class="num">${eur(byWho.b)}</b></span></div></div>`
    : '<p class="hint">Nothing logged this month yet.</p>';

  const elapsed = k.isCur ? k.dom : k.dim;
  const noSpend = k.days.slice(0, elapsed).filter((d) => !k.exps.some((e) => e.date === d.ds)).length;
  const biggest = k.exps.reduce((m, e) => (e.amount > (m?.amount || 0) ? e : m), null);
  return `${topbar("Insights", monthName(S.month))}${approvals()}
  ${monthNav()}
  <section class="panel"><h2>Last six months</h2>${chart}</section>
  <section class="panel"><h2>Where it went <small>${monthName(S.month, { month: "long" })}</small></h2>${rank}</section>
  <section class="panel"><h2>Who spent</h2>${who}</section>
  <section class="panel"><h2>${monthName(S.month, { month: "long" })} at a glance</h2><div class="stats">
    <div><p class="k">Average a day</p><p class="v num">${eur(k.total / Math.max(1, elapsed))}</p></div>
    <div><p class="k">No-spend days</p><p class="v num">${noSpend}</p></div>
    <div><p class="k">Biggest</p><p class="v num">${biggest ? eur(biggest.amount) : "—"}</p></div></div></section>`;
}

function goalSaved(g) { return S.data.contribs.filter((c) => c.goalId === g.id).reduce((s, c) => s + c.amount, 0); }

function viewGoals() {
  const nm = names();
  const goals = S.data.goals.filter((g) => !g.archived).sort((a, b) => a.created - b.created);
  const body = goals.length
    ? goals.map((g) => {
        const saved = goalSaved(g);
        const pct = Math.max(0, Math.min(100, (saved / g.target) * 100));
        const done = saved >= g.target;
        let need = "";
        if (done) need = '<span class="reached">Goal reached</span>';
        else if (g.deadline) {
          const days = Math.ceil((dateObj(g.deadline) - dateObj(todayStr())) / 86400000);
          if (days <= 0) need = `${eur0(g.target - saved)} still to go. The date has passed.`;
          else { const months = Math.max(1, Math.ceil(days / 30.4)); need = `Save ${eur0((g.target - saved) / months)} a month to reach it by ${dateObj(g.deadline).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.`; }
        } else need = `${eur0(g.target - saved)} to go.`;
        const recent = S.data.contribs.filter((c) => c.goalId === g.id).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3);
        return `<article class="goal"><div class="goal-head"><h3>${esc(g.name)}</h3><button class="edit" data-action="edit-goal" data-id="${esc(g.id)}">Edit</button></div>
          <p class="goal-amt num">${eur0(saved)} <span>of ${eur0(g.target)}</span></p>
          <div class="bar" role="img" aria-label="${Math.round(pct)} percent saved"><i style="width:${pct}%"></i></div>
          <p class="goal-need">${need}</p>
          <button class="btn small" data-action="add-contrib" data-id="${esc(g.id)}">Add money</button>
          ${recent.length ? `<div class="goal-recent">${recent.map((c) => `<button data-action="edit-contrib" data-id="${esc(c.id)}" data-goal="${esc(g.id)}"><span>${esc(dayLabel(c.date))} · ${esc(nm[c.who])}${c.note ? ` · ${esc(c.note)}` : ""}</span><span class="num">${c.amount < 0 ? "−" : "+"}${eur(Math.abs(c.amount))}</span></button>`).join("")}</div>` : ""}
        </article>`;
      }).join("")
    : '<div class="empty"><b>No goals yet</b>Set something you are saving for together, like a trip or a deposit.</div>';
  return `${topbar("Goals", "Saving together")}${approvals()}${body}
  <button class="btn alt" style="margin-top:4px" data-action="new-goal">New goal</button>`;
}

/* ============ history ============ */
function diffExp(a, b) {
  const out = [];
  if (a.amount !== b.amount) out.push(`amount ${eur(a.amount)} → ${eur(b.amount)}`);
  if (a.catId !== b.catId) out.push(`category ${catName(a.catId)} → ${catName(b.catId)}`);
  if ((a.note || "") !== (b.note || "")) out.push(`note “${a.note || ""}” → “${b.note || ""}”`);
  if (a.who !== b.who) out.push(`paid by ${names()[a.who]} → ${names()[b.who]}`);
  if (a.date !== b.date) out.push(`date ${a.date} → ${b.date}`);
  return out.join(" · ");
}
function logLine(e) {
  const n = userName(e.uid), d = e.data || {};
  const nm = names();
  switch (e.type) {
    case "user.register": return [`${n} created their account`, ""];
    case "user.name": return [`${n} changed their name`, `${d.from} → ${d.to}`];
    case "user.password": return [`${n} ${d.how ? "reset" : "changed"} their password`, ""];
    case "expense.add": return [`${n} added ${expLabel(d.exp)}`, `Paid by ${nm[d.exp.who]} · ${dayLabel(d.exp.date)}`];
    case "expense.edit": return [`${n} edited an expense`, `${expLabel(d.before)}: ${diffExp(d.before, d.after)}`];
    case "expense.delete.request": return [`${n} asked to delete ${expLabel(d.exp)}`, `Added by ${nm[d.exp.by]} on ${dayLabel(d.exp.date)}`];
    case "expense.delete.approve": return [`${n} approved deleting ${expLabel(d.exp)}`, `Added by ${nm[d.exp.by]}. It was removed from the budget.`];
    case "expense.delete.decline": return [`${n} kept ${expLabel(d.exp)}`, "Deletion declined"];
    case "expense.delete.cancel": return [`${n} withdrew the request to delete ${expLabel(d.exp)}`, ""];
    case "budget.request": return [`${n} asked to change the budget`, budgetLines(d.changes, d.before).join(" · ")];
    case "budget.approve": return [`${n} approved a budget change`, budgetLines(d.changes, []).length ? d.changes.map((c) => `${c.icon} ${c.name} ${eur(c.monthly)}`).join(" · ") : ""];
    case "budget.decline": return [`${n} declined a budget change`, ""];
    case "budget.cancel": return [`${n} withdrew a budget change`, ""];
    case "goal.add": return [`${n} created the goal “${d.after.name}”`, `Target ${eur(d.after.target)}`];
    case "goal.edit": return [`${n} edited the goal “${d.after.name}”`, d.before ? `${d.before.name} ${eur(d.before.target)} → ${d.after.name} ${eur(d.after.target)}` : ""];
    case "goal.delete": return [`${n} deleted the goal “${d.goal?.name ?? ""}”`, `It had ${eur((d.contribs || []).reduce((s, c) => s + c.amount, 0))} saved`];
    case "contrib.add": return [`${n} ${d.after.amount < 0 ? "took out" : "added"} ${eur(Math.abs(d.after.amount))} ${d.after.amount < 0 ? "from" : "to"} a goal`, `${nm[d.after.who]} · ${dayLabel(d.after.date)}${d.after.note ? ` · ${d.after.note}` : ""}`];
    case "contrib.edit": return [`${n} edited a goal entry`, `${eur(d.before.amount)} → ${eur(d.after.amount)}`];
    case "contrib.delete": return [`${n} deleted a goal entry of ${eur(d.contrib?.amount ?? 0)}`, ""];
    default: return [`${n}: ${e.type}`, ""];
  }
}
const isSensitive = (t) => /delete|budget|edit|password/.test(t);

function viewHistory() {
  const nm = names();
  let list = S.log;
  let body;
  if (!list) body = '<div class="loading">Loading…</div>';
  else {
    if (S.logWho !== "all") list = list.filter((e) => S.data.users.find((u) => u.id === e.uid)?.slot === S.logWho);
    if (S.logOnly) list = list.filter((e) => isSensitive(e.type));
    const groups = [];
    for (const e of list) {
      const ds = ymdOf(new Date(e.ts));
      const g = groups[groups.length - 1];
      if (g && g.ds === ds) g.items.push(e); else groups.push({ ds, items: [e] });
    }
    body = groups.length
      ? groups.map((g) => `<div class="day"><div class="day-head"><span>${esc(dayLabel(g.ds))}</span></div><div class="rows">${g.items.map((e) => {
          const [t, sub] = logLine(e);
          const slot = S.data.users.find((u) => u.id === e.uid)?.slot;
          return `<div class="row log"><span class="dot ${slot === "b" ? "b" : ""}" aria-hidden="true"></span><div class="row-main"><div class="log-t">${esc(t)}</div>${sub ? `<div class="row-sub">${esc(sub)}</div>` : ""}</div><span class="log-time num">${timeLabel(e.ts)}</span></div>`;
        }).join("")}</div></div>`).join("")
      : '<div class="empty"><b>Nothing here</b>No entries match.</div>';
  }
  const chips = `<button class="chip" data-action="log-who" data-id="all" aria-pressed="${S.logWho === "all"}">Both of us</button>` +
    ["a", "b"].map((w) => `<button class="chip" data-action="log-who" data-id="${w}" aria-pressed="${S.logWho === w}">${esc(nm[w])}</button>`).join("") +
    `<button class="chip" data-action="log-only" aria-pressed="${S.logOnly}">Deletions, edits and budget</button>`;
  return `${topbar("History", "Everything either of you has done", { back: true })}${approvals()}
  <p class="hint" style="margin:0 4px 12px">This list can't be edited or cleared by either of you. Deleted items stay recorded here.</p>
  <div class="chips">${chips}</div>${body}`;
}

async function loadLog(quiet) {
  try {
    const r = await api("GET", "/log?limit=300");
    const sig = JSON.stringify(r.entries.map((e) => e.id));
    if (quiet && S.log && JSON.stringify(S.log.map((e) => e.id)) === sig) return;
    S.log = r.entries;
    if (S.tab === "history" && !S.sheet) render();
  } catch (e) { if (!quiet) toast(e.message); }
}

/* ============ sheets ============ */
const sheetRoot = $("#sheet-root");
function openSheet(title, inner, { dismissible = true } = {}) {
  S.sheet = true;
  sheetRoot.innerHTML = `<div class="scrim" ${dismissible ? 'data-action="close-sheet"' : ""}></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div>
    <div class="sheet-head"><h2>${esc(title)}</h2>${dismissible ? '<button class="sheet-x" data-action="close-sheet" aria-label="Close">×</button>' : ""}</div>${inner}</section>`;
  const first = $("[data-autofocus]", sheetRoot);
  if (first) setTimeout(() => first.focus({ preventScroll: true }), 60);
}
function closeSheet() { S.sheet = false; sheetRoot.innerHTML = ""; S.draft = null; S.stale = false; render(); }
function closeSheetQuiet() { S.sheet = false; sheetRoot.innerHTML = ""; S.draft = null; }

function whoSeg(sel, name = "who") {
  const nm = names();
  return `<div class="seg" role="group" aria-label="Who">${["a", "b"].map((w) => `<button type="button" data-action="pick-who" data-who="${w}" aria-pressed="${sel === w}">${esc(nm[w])}</button>`).join("")}<input type="hidden" name="${name}" value="${sel}"></div>`;
}

function expenseSheet(exp) {
  const editing = !!exp;
  if (editing) {
    const pend = pendingDeleteFor(exp.id);
    if (exp.by !== mySlot() || pend) return expenseDetailSheet(exp, pend);
  }
  const cats = activeCats();
  const byId = catById();
  const catList = cats.slice();
  if (editing && byId[exp.catId]?.archived) catList.push(byId[exp.catId]);
  const selCat = exp?.catId || (cats.some((c) => c.id === S.lastCat) ? S.lastCat : "");
  const who = exp?.who || mySlot();
  openSheet(editing ? "Edit expense" : "Add expense", `<form data-form="expense" class="stack" ${editing ? `data-id="${esc(exp.id)}" data-month="${esc(monthOf(exp.date))}"` : ""} novalidate>
    <div class="field"><label for="f-amount" class="lbl">Amount</label><div class="amount-wrap"><span>€</span><input id="f-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${editing ? exp.amount : ""}" ${editing ? "" : "data-autofocus"}></div></div>
    <div class="field"><span class="lbl">Category</span><div class="cats" role="group" aria-label="Category">${catList.map((c) => `<button type="button" class="cat-pick" data-action="pick-cat" data-id="${esc(c.id)}" aria-pressed="${selCat === c.id}"><span class="e">${esc(c.icon)}</span>${esc(c.name)}</button>`).join("")}</div><input type="hidden" name="catId" value="${esc(selCat)}"></div>
    <div class="field"><span class="lbl">Paid by</span>${whoSeg(who)}</div>
    <div class="field"><label for="f-note" class="lbl">Note (optional)</label><input class="input" id="f-note" name="note" maxlength="80" autocomplete="off" placeholder="Billa, taxi to work…" value="${esc(exp?.note || "")}"></div>
    <div class="field"><label for="f-date" class="lbl">Date</label><input class="input" id="f-date" name="date" type="date" value="${esc(exp?.date || todayStr())}"></div>
    <p class="err" data-err></p>
    <button class="btn" type="submit">${editing ? "Save changes" : "Add expense"}</button>
    ${editing ? `<button class="btn danger" type="button" data-action="ask-delete" data-id="${esc(exp.id)}" data-month="${esc(monthOf(exp.date))}">Ask ${esc(otherName())} to approve deleting</button><p class="hint">Entries can't be deleted on your own. ${esc(otherName())} has to approve first, and every edit is kept in History.</p>` : `<p class="hint">Once added, an entry can only be removed if ${esc(otherName())} approves.</p>`}
  </form>`);
}

function expenseDetailSheet(exp, pend) {
  const c = catById()[exp.catId];
  const mine = exp.by === mySlot();
  openSheet("Expense", `<div class="stack">
    <div class="detail"><span class="glyph" aria-hidden="true">${esc(c?.icon || "•")}</span><div class="row-main"><div class="row-title">${esc(exp.note || c?.name || "Expense")}</div><div class="row-sub">${esc(c?.name || "")} · ${esc(dayLabel(exp.date))}</div></div><span class="row-amt num">${eur(exp.amount)}</span></div>
    <p class="hint">Paid by ${esc(names()[exp.who])}. Added by ${esc(names()[exp.by])}${exp.editedAt ? ", edited later (see History)" : ""}.${mine ? "" : " Only the person who added it can edit it."}</p>
    ${pend ? `<p class="note-inline">${pend.uid === meUser().id ? `Waiting for ${esc(otherName())} to approve deleting this.` : `${esc(userName(pend.uid))} asked to delete this. Approve or decline above.`}</p>${pend.uid === meUser().id ? `<button class="btn alt" data-action="decide" data-id="${esc(pend.id)}" data-op="cancel" data-close="1">Cancel the request</button>` : ""}`
        : `<button class="btn danger" data-action="ask-delete" data-id="${esc(exp.id)}" data-month="${esc(monthOf(exp.date))}">Ask ${esc(otherName())} to approve deleting</button>`}
  </div>`);
}

function parseAmount(v) {
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function goalSheet(g) {
  openSheet(g ? "Edit goal" : "New goal", `<form data-form="goal" class="stack" ${g ? `data-id="${esc(g.id)}"` : ""} novalidate>
    <div class="field"><label class="lbl" for="g-name">What are you saving for?</label><input class="input" id="g-name" name="name" maxlength="40" placeholder="Summer trip" value="${esc(g?.name || "")}" data-autofocus></div>
    <div class="field"><label class="lbl" for="g-target">Target amount (€)</label><input class="input" id="g-target" name="target" inputmode="decimal" placeholder="1500" value="${g ? g.target : ""}"></div>
    <div class="field"><label class="lbl" for="g-date">Reach it by (optional)</label><input class="input" id="g-date" name="deadline" type="date" value="${esc(g?.deadline || "")}"></div>
    <p class="err" data-err></p>
    <button class="btn" type="submit">${g ? "Save changes" : "Create goal"}</button>
    ${g ? '<button class="btn danger" type="button" data-action="delete-goal">Delete goal</button><p class="hint">Goal changes are recorded in History.</p>' : ""}
  </form>`);
}

function contribSheet(goalId, c) {
  const g = S.data.goals.find((x) => x.id === goalId);
  const neg = c && c.amount < 0;
  openSheet(c ? "Edit entry" : `Add to ${g?.name || "goal"}`, `<form data-form="contrib" class="stack" data-goal="${esc(goalId)}" ${c ? `data-id="${esc(c.id)}"` : ""} novalidate>
    <div class="seg" role="group" aria-label="Type"><button type="button" data-action="pick-dir" data-dir="1" aria-pressed="${!neg}">Add money</button><button type="button" data-action="pick-dir" data-dir="-1" aria-pressed="${!!neg}">Take out</button><input type="hidden" name="dir" value="${neg ? -1 : 1}"></div>
    <div class="field"><label class="lbl" for="c-amount">Amount</label><div class="amount-wrap"><span>€</span><input id="c-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${c ? Math.abs(c.amount) : ""}" data-autofocus></div></div>
    <div class="field"><span class="lbl">Who</span>${whoSeg(c?.who || mySlot())}</div>
    <div class="field"><label class="lbl" for="c-note">Note (optional)</label><input class="input" id="c-note" name="note" maxlength="60" value="${esc(c?.note || "")}"></div>
    <div class="field"><label class="lbl" for="c-date">Date</label><input class="input" id="c-date" name="date" type="date" value="${esc(c?.date || todayStr())}"></div>
    <p class="err" data-err></p>
    <button class="btn" type="submit">${c ? "Save changes" : "Save"}</button>
    ${c ? '<button class="btn danger" type="button" data-action="delete-contrib">Delete entry</button>' : ""}
  </form>`);
}

/* ----- settings: budget edits are a draft that the other person has to approve ----- */
const catKeys = ["name", "icon", "monthly", "fixed", "archived", "order"];
const sameCat = (a, b) => !!a && !!b && catKeys.every((k) => a[k] === b[k]);
function draftChanges() {
  const cur = catById();
  return (S.draft || []).filter((d) => !sameCat(cur[d.id], d));
}

function pushState() {
  if (!pushSupported()) return { on: false, note: "This browser can't show notifications." };
  if (isIos() && !isStandalone()) return { on: false, note: "On iPhone, add this app to your Home Screen first (Share, then Add to Home Screen) and open it from there." };
  if (Notification.permission === "denied") return { on: false, note: "Notifications are blocked. Allow them for this app in your phone's settings." };
  return { on: !!S.data.pushOn, note: "" };
}

function settingsSheet() {
  if (!S.draft) S.draft = S.data.cats.filter((c) => !c.archived).sort((a, b) => a.order - b.order).map((c) => ({ ...c }));
  const pb = pendingBudget();
  const locked = !!pb;
  const rows = S.draft.filter((c) => !c.archived).map((c) => `<div class="set-cat" data-cat="${esc(c.id)}">
      <input class="input icon-in" data-field="icon" value="${esc(c.icon)}" maxlength="4" aria-label="Icon for ${esc(c.name)}" ${locked ? "disabled" : ""}>
      <input class="input" data-field="name" value="${esc(c.name)}" maxlength="30" aria-label="Category name" ${locked ? "disabled" : ""}>
      <input class="input" data-field="monthly" inputmode="decimal" value="${c.monthly}" aria-label="Monthly budget for ${esc(c.name)}" ${locked ? "disabled" : ""}>
      <div class="set-cat-foot"><label class="check"><input type="checkbox" data-field="fixed" ${c.fixed ? "checked" : ""} ${locked ? "disabled" : ""}> Fixed monthly cost</label>${locked ? "" : `<button class="link" data-action="archive-cat" data-id="${esc(c.id)}">Remove</button>`}</div></div>`).join("");
  const total = S.draft.filter((c) => !c.archived).reduce((s, c) => s + c.monthly, 0);
  const n = draftChanges().length;
  const ps = pushState();
  const users = S.data.users;
  const waitingInvite = S.data.invites?.[0];
  openSheet("Settings", `<div class="stack">
    <div class="field"><span class="lbl">Your account</span>
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px"><input class="input" id="myname" value="${esc(meUser().name)}" maxlength="20" aria-label="Your name"><button class="btn alt small" data-action="save-name">Save</button></div>
      <p class="hint">${S.status.open ? "Open mode: no password" : esc(meUser().email)}${users.length < 2 && waitingInvite ? ` · Waiting for your partner (${esc(waitingInvite)}) to create their account.` : ""}</p></div>
    <div class="field"><span class="lbl">Notifications</span>
      ${ps.on ? `<p class="hint">On for this phone. You'll get a message when ${esc(otherName())} needs your approval or answers yours.</p><button class="btn alt small" data-action="push-off">Turn off</button>`
        : ps.note ? `<p class="hint">${esc(ps.note)}</p>` : `<p class="hint">Get a message on this phone when ${esc(otherName())} needs your approval.</p><button class="btn alt small" data-action="push-on">Turn on notifications</button>`}</div>
    <div class="field"><span class="lbl">Monthly budget <span class="hint num" id="set-total">${eur0(total)} total</span></span>
      ${locked ? `<p class="note-inline">${pb.uid === meUser().id ? `Waiting for ${esc(otherName())} to approve your change. You can't edit the budget until they answer.` : `${esc(userName(pb.uid))} proposed a change. Approve or decline it at the top of the screen.`}</p>${pb.uid === meUser().id ? `<button class="btn alt small" data-action="decide" data-id="${esc(pb.id)}" data-op="cancel" data-close="1">Cancel my request</button>` : ""}` : `<p class="hint">Changes here are sent to ${esc(otherName())} and only take effect once they approve. Fixed costs (rent, bills) are left out of the daily allowance.</p>`}
      <div class="rows" style="padding:0 14px">${rows}</div>
      ${locked ? "" : `<button class="btn alt small" data-action="add-cat" style="margin-top:4px">Add category</button>
      <button class="btn" id="send-budget" data-action="send-budget" ${n ? "" : "disabled"}>${n ? `Ask ${esc(otherName())} to approve ${n} ${n === 1 ? "change" : "changes"}` : "No changes yet"}</button>`}</div>
    ${S.status.open ? "" : `<details class="fold"><summary>Change password</summary><div class="stack"><input class="input" id="curpass" type="password" autocomplete="current-password" placeholder="Current password"><input class="input" id="newpass" type="password" autocomplete="new-password" placeholder="New password (8+ characters)"><button class="btn alt small" data-action="change-pass">Change password</button></div></details>`}
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn alt small" data-action="export">Download CSV</button>${S.status.open ? '<button class="btn alt small" data-action="switch-me">Switch person</button>' : '<button class="btn alt small" data-action="logout">Log out</button>'}</div>
  </div>`);
}
function settingsKeepScroll() { const y = $(".sheet")?.scrollTop || 0; settingsSheet(); const s = $(".sheet"); if (s) s.scrollTop = y; }

/* ============ auth screens ============ */
function authScreen(html) { app.innerHTML = `<div class="auth">${html}</div>`; sheetRoot.innerHTML = ""; S.sheet = false; }

function authView(view, msg = "") {
  const st = S.status;
  if (view === "register") {
    const first = st.users === 0;
    authScreen(`<div><h1>Our budget</h1><p style="margin-top:8px">${first ? "Create your account. Your partner makes theirs next, with the email you enter below." : "Create your account with the email your partner invited."}</p></div>
    <form data-form="register" class="stack" novalidate>
      <div class="field"><label class="lbl" for="r-n">Your name</label><input class="input" id="r-n" name="name" maxlength="20" autocomplete="given-name"></div>
      <div class="field"><label class="lbl" for="r-e">Your email</label><input class="input" id="r-e" name="email" type="email" autocomplete="email" inputmode="email"></div>
      <div class="field"><label class="lbl" for="r-p">Password</label><input class="input" id="r-p" name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
      ${first ? '<div class="field"><label class="lbl" for="r-pe">Your partner\'s email</label><input class="input" id="r-pe" name="partnerEmail" type="email" inputmode="email" autocomplete="off"></div><p class="hint">Only that email address can join. Your starter budget (€2,280 a month) is added automatically.</p>' : ""}
      <p class="err" data-err>${esc(msg)}</p><button class="btn" type="submit">Create account</button></form>
    ${st.users > 0 ? '<button class="link" data-action="auth" data-view="login">I already have an account</button>' : ""}`);
  } else if (view === "forgot") {
    authScreen(`<div><h1>Reset password</h1><p style="margin-top:8px">${st.emailEnabled ? "Enter your email and we'll send you a link to choose a new password." : "Email sending isn't set up for this app yet, so reset links can't be sent."}</p></div>
    <form data-form="forgot" class="stack" novalidate><div class="field"><label class="lbl" for="f-e">Email</label><input class="input" id="f-e" name="email" type="email" autocomplete="email" inputmode="email"></div>
    <p class="err" data-err>${esc(msg)}</p><button class="btn" type="submit" ${st.emailEnabled ? "" : "disabled"}>Send reset link</button></form>
    <div class="auth-links"><button class="link" data-action="auth" data-view="login">Back to log in</button>${st.recoveryEnabled ? '<button class="link" data-action="auth" data-view="recover">I have a recovery key</button>' : ""}</div>`);
  } else if (view === "recover") {
    authScreen(`<div><h1>Recovery key</h1><p style="margin-top:8px">Enter your email, the RECOVERY_KEY you set in Netlify, and a new password.</p></div>
    <form data-form="recover" class="stack" novalidate>
      <div class="field"><label class="lbl" for="k-e">Email</label><input class="input" id="k-e" name="email" type="email" autocomplete="email" inputmode="email"></div>
      <div class="field"><label class="lbl" for="k-k">Recovery key</label><input class="input" id="k-k" name="key" type="password" autocomplete="off"></div>
      <div class="field"><label class="lbl" for="k-p">New password</label><input class="input" id="k-p" name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
      <p class="err" data-err>${esc(msg)}</p><button class="btn" type="submit">Set new password</button></form>
    <button class="link" data-action="auth" data-view="login">Back to log in</button>`);
  } else if (view === "reset") {
    authScreen(`<div><h1>New password</h1><p style="margin-top:8px">Choose a new password for your account.</p></div>
    <form data-form="reset" class="stack" novalidate><div class="field"><label class="lbl" for="n-p">New password</label><input class="input" id="n-p" name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" data-autofocus></div>
    <p class="err" data-err>${esc(msg)}</p><button class="btn" type="submit">Save password</button></form>`);
  } else {
    authScreen(`<div><h1>Our budget</h1><p style="margin-top:8px">Log in to open your budget.</p></div>
    <form data-form="login" class="stack" novalidate>
      <div class="field"><label class="lbl" for="l-e">Email</label><input class="input" id="l-e" name="email" type="email" autocomplete="email" inputmode="email"></div>
      <div class="field"><label class="lbl" for="l-p">Password</label><input class="input" id="l-p" name="password" type="password" autocomplete="current-password"></div>
      <p class="err" data-err>${esc(msg)}</p><button class="btn" type="submit">Log in</button></form>
    <div class="auth-links"><button class="link" data-action="auth" data-view="forgot">Forgot password?</button>${st.users < 2 ? '<button class="link" data-action="auth" data-view="register">Create account</button>' : ""}</div>`);
  }
}

function whoView() {
  const n = S.status.names || { a: "Vihren", b: "Victoria" };
  authScreen(`<div><h1>Our budget</h1><p style="margin-top:8px">Who is using this phone?</p></div>
    <div class="stack"><button class="btn" data-action="pick-me" data-who="a">${esc(n.a)}</button><button class="btn alt" data-action="pick-me" data-who="b">${esc(n.b)}</button></div>
    <p class="hint">There is no password for now. Anyone with the link can open the budget.</p>`);
}

function signOutLocal() {
  S.token = ""; localStorage.removeItem("ob.token"); S.data = null; S.lastSig = ""; S.log = null;
  authView("login");
}

async function afterAuth(token) {
  S.token = token; localStorage.setItem("ob.token", token);
  S.lastSig = ""; S.tab = "today";
  history.replaceState(null, "", location.pathname);
  await refresh(true);
}

/* ============ push ============ */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const urlB64 = (b64) => { const p = "=".repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };

async function enablePush() {
  if (!pushSupported()) return toast("This browser can't show notifications.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Notifications are blocked. Allow them for this app in your phone's settings."); render(); return; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(S.data.vapidPublicKey) }));
    await api("POST", "/push/subscribe", { subscription: sub.toJSON() });
    await refresh(true);
    toast("Notifications are on.");
  } catch (e) { toast("Couldn't turn on notifications: " + (e.message || "unknown error")); }
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api("POST", "/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe(); }
    await refresh(true);
    toast("Notifications are off for this phone.");
  } catch (e) { toast(e.message); }
}

/* ============ toast ============ */
let toastTimer;
function toast(msg) {
  const root = $("#toast-root");
  root.innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ""; }, 4200);
}

/* ============ actions ============ */
async function guarded(fn) { try { await fn(); } catch (e) { toast(e.message || "Something went wrong."); await refresh(true).catch(() => {}); } }

const actions = {
  tab(el) {
    S.tab = el.dataset.tab;
    if (S.tab === "spending") { S.filterCat = "all"; S.filterWho = "all"; }
    if (S.tab === "history") { S.log = null; loadLog(); }
    window.scrollTo(0, 0); render();
  },
  auth(el) { authView(el.dataset.view); },
  async "pick-me"(el) { S.who = el.dataset.who; localStorage.setItem("ob.who", S.who); S.lastSig = ""; S.tab = "today"; try { await refresh(true); } catch (e) { toast(e.message); } },
  "switch-me"() { closeSheetQuiet(); S.who = ""; localStorage.removeItem("ob.who"); S.data = null; S.lastSig = ""; S.log = null; whoView(); },
  add() { expenseSheet(null); },
  settings() { S.draft = null; settingsSheet(); },
  "close-sheet"() { closeSheet(); },
  month(el) { const next = addMonths(S.month, Number(el.dataset.dir)); if (next > monthOf(todayStr())) return; S.month = next; render(); },
  "filter-cat"(el) { S.tab = "spending"; S.month = monthOf(todayStr()); S.filterCat = el.dataset.id; S.filterWho = "all"; window.scrollTo(0, 0); render(); },
  "set-filter"(el) { if (el.dataset.kind === "cat") S.filterCat = el.dataset.id; else S.filterWho = el.dataset.id; render(); },
  "log-who"(el) { S.logWho = el.dataset.id; render(); },
  "log-only"() { S.logOnly = !S.logOnly; render(); },
  "pick-cat"(el) {
    const form = el.closest("form");
    form.querySelectorAll(".cat-pick").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    form.elements.catId.value = el.dataset.id;
  },
  "pick-who"(el) { const w = el.closest(".seg"); w.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el))); w.querySelector("input").value = el.dataset.who; },
  "pick-dir"(el) { const w = el.closest(".seg"); w.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el))); w.querySelector("input").value = el.dataset.dir; },
  "edit-expense"(el) { const e = S.data.expenses.find((x) => x.id === el.dataset.id); if (e) expenseSheet(e); },

  "ask-delete"(el) {
    const who = otherName();
    if (!confirm(`Ask ${who} to approve deleting this expense? It stays in the budget until they approve.`)) return;
    closeSheetQuiet();
    guarded(async () => {
      await api("POST", "/expense/delete-request", { id: el.dataset.id, month: el.dataset.month });
      await refresh(true);
      toast(`Sent to ${who}. It's deleted once they approve.`);
    });
  },
  decide(el) {
    const { id, op } = el.dataset;
    if (el.dataset.close) closeSheetQuiet();
    guarded(async () => {
      await api("POST", `/request/${id}/${op}`);
      await refresh(true);
      toast(op === "approve" ? "Approved." : op === "decline" ? "Declined. Nothing was changed." : "Request cancelled.");
    });
  },
  "dismiss-notices"() { localStorage.setItem("ob.seen", String(Date.now())); render(); },

  "new-goal"() { goalSheet(null); },
  "edit-goal"(el) { goalSheet(S.data.goals.find((g) => g.id === el.dataset.id)); },
  "delete-goal"(el) {
    const id = el.closest("form").dataset.id;
    if (!confirm("Delete this goal and all the money logged to it? This is recorded in History.")) return;
    closeSheetQuiet();
    mutate(() => { S.data.goals = S.data.goals.filter((g) => g.id !== id); S.data.contribs = S.data.contribs.filter((c) => c.goalId !== id); }, () => api("DELETE", `/goal/${id}`));
  },
  "add-contrib"(el) { contribSheet(el.dataset.id, null); },
  "edit-contrib"(el) { const c = S.data.contribs.find((x) => x.id === el.dataset.id); if (c) contribSheet(el.dataset.goal, c); },
  "delete-contrib"(el) {
    const form = el.closest("form");
    const id = form.dataset.id, goalId = form.dataset.goal;
    closeSheetQuiet();
    mutate(() => { S.data.contribs = S.data.contribs.filter((c) => c.id !== id); }, () => api("DELETE", `/contrib/${goalId}/${id}`));
  },

  "save-name"() {
    const name = $("#myname").value.trim();
    if (!name) return;
    guarded(async () => { await api("PUT", "/me", { name }); await refresh(true); toast("Name saved."); settingsKeepScroll(); });
  },
  "add-cat"() {
    const order = Math.max(-1, ...S.draft.map((c) => c.order), ...S.data.cats.map((c) => c.order)) + 1;
    S.draft.push({ id: "c-" + uid().slice(0, 10), name: "New category", icon: "🛍️", monthly: 0, fixed: false, archived: false, order });
    settingsKeepScroll();
  },
  "archive-cat"(el) {
    const c = S.draft.find((x) => x.id === el.dataset.id);
    if (!c || !confirm(`Remove "${c.name}"? Past expenses in it stay in your history. ${otherName()} will need to approve this.`)) return;
    c.archived = true;
    // a brand-new category that was never sent can simply disappear
    if (!catById()[c.id]) S.draft = S.draft.filter((x) => x.id !== c.id);
    settingsKeepScroll();
  },
  "send-budget"() {
    const changes = draftChanges();
    if (!changes.length) return;
    guarded(async () => {
      await api("POST", "/budget/request", { changes });
      closeSheetQuiet();
      await refresh(true);
      toast(`Sent to ${otherName()}. It changes once they approve.`);
    });
  },
  "push-on"() { enablePush().then(() => { if (S.sheet) settingsKeepScroll(); }); },
  "push-off"() { disablePush().then(() => { if (S.sheet) settingsKeepScroll(); }); },
  "push-no"() { localStorage.setItem("ob.pushno", "1"); render(); },
  async "change-pass"() {
    const cur = $("#curpass").value, next = $("#newpass").value;
    if (next.length < 8) return toast("Use at least 8 characters.");
    try { await api("POST", "/password", { current: cur, password: next }); $("#curpass").value = ""; $("#newpass").value = ""; toast("Password changed. Your partner's other devices aren't affected."); }
    catch (e) { toast(e.message); }
  },
  export() {
    const byId = catById(); const nm = names();
    const rows = [["Date", "Category", "Amount (EUR)", "Paid by", "Added by", "Note"]].concat(
      S.data.expenses.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map((e) => [e.date, byId[e.catId]?.name || "", e.amount.toFixed(2), nm[e.who], nm[e.by], e.note]));
    const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `our-budget-${todayStr()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  },
  async logout() { closeSheetQuiet(); try { await api("POST", "/logout"); } catch {} signOutLocal(); },
};

/* ============ forms ============ */
const forms = {
  async register(f) {
    const v = Object.fromEntries(new FormData(f));
    try { const r = await api("POST", "/register", v); await afterAuth(r.token); }
    catch (e) { formErr(f, e.message); }
  },
  async login(f) {
    const v = Object.fromEntries(new FormData(f));
    try { const r = await api("POST", "/login", v); await afterAuth(r.token); }
    catch (e) { formErr(f, e.message); }
  },
  async forgot(f) {
    const v = Object.fromEntries(new FormData(f));
    try { await api("POST", "/forgot", v); f.innerHTML = '<p>If that email has an account, a reset link is on its way. It works for one hour.</p><button class="link" type="button" data-action="auth" data-view="login">Back to log in</button>'; }
    catch (e) { formErr(f, e.message); }
  },
  async recover(f) {
    const v = Object.fromEntries(new FormData(f));
    try { const r = await api("POST", "/recover", v); await afterAuth(r.token); toast("Password changed. You're logged in."); }
    catch (e) { formErr(f, e.message); }
  },
  async reset(f) {
    const v = Object.fromEntries(new FormData(f));
    try { const r = await api("POST", "/reset", { token: S.resetToken, password: v.password }); S.resetToken = ""; await afterAuth(r.token); toast("Password changed. You're logged in."); }
    catch (e) { formErr(f, e.message); }
  },
  expense(f) {
    const v = Object.fromEntries(new FormData(f));
    const amount = parseAmount(v.amount);
    if (!(amount > 0)) return formErr(f, "Enter an amount greater than 0.");
    if (!v.catId) return formErr(f, "Pick a category.");
    if (!v.date) return formErr(f, "Pick a date.");
    const editing = !!f.dataset.id;
    const old = editing ? S.data.expenses.find((x) => x.id === f.dataset.id) : null;
    const rec = { id: f.dataset.id || uid(), catId: v.catId, amount, note: (v.note || "").trim(), who: v.who, date: v.date, by: old?.by ?? mySlot(), ts: old?.ts ?? Date.now() };
    const oldMonth = f.dataset.month;
    closeSheetQuiet();
    S.lastCat = v.catId; localStorage.setItem("ob.lastcat", S.lastCat);
    mutate(() => { S.data.expenses = S.data.expenses.filter((x) => x.id !== rec.id).concat(rec); },
      () => api("PUT", "/expense", { ...rec, oldMonth }));
    toast(editing ? "Saved. The change is recorded in History." : `Added ${eur(amount)} · ${catName(rec.catId)}`);
  },
  goal(f) {
    const v = Object.fromEntries(new FormData(f));
    const target = parseAmount(v.target);
    if (!v.name.trim()) return formErr(f, "Give the goal a name.");
    if (!(target > 0)) return formErr(f, "Enter a target amount.");
    const old = S.data.goals.find((g) => g.id === f.dataset.id);
    const rec = { id: f.dataset.id || uid(), name: v.name.trim(), target, deadline: v.deadline || "", archived: false, created: old?.created || Date.now() };
    closeSheetQuiet();
    mutate(() => { S.data.goals = S.data.goals.filter((g) => g.id !== rec.id).concat(rec); }, () => api("PUT", "/goal", rec));
  },
  contrib(f) {
    const v = Object.fromEntries(new FormData(f));
    const amt = parseAmount(v.amount);
    if (!(amt > 0)) return formErr(f, "Enter an amount greater than 0.");
    const rec = { id: f.dataset.id || uid(), goalId: f.dataset.goal, amount: amt * Number(v.dir), who: v.who, date: v.date || todayStr(), note: (v.note || "").trim(), by: mySlot() };
    closeSheetQuiet();
    mutate(() => { S.data.contribs = S.data.contribs.filter((c) => c.id !== rec.id).concat(rec); }, () => api("PUT", "/contrib", rec));
    toast(rec.amount > 0 ? `Added ${eur(rec.amount)} to the goal` : `Took out ${eur(-rec.amount)}`);
  },
};
function formErr(f, msg) { const e = $("[data-err]", f); if (e) e.textContent = msg; }

/* ============ events ============ */
document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el); }
});
document.addEventListener("submit", (ev) => {
  const f = ev.target.closest("[data-form]");
  if (!f) return;
  ev.preventDefault();
  forms[f.dataset.form]?.(f);
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && S.sheet && $(".scrim[data-action]")) closeSheet(); });

// budget draft: typing changes the draft only; nothing is saved until the other person approves
document.addEventListener("input", (ev) => {
  const t = ev.target;
  const row = t.closest?.(".set-cat");
  if (!row || !t.dataset.field || !S.draft) return;
  const c = S.draft.find((x) => x.id === row.dataset.cat);
  if (!c) return;
  if (t.dataset.field === "monthly") { const n = parseAmount(t.value); if (!(n >= 0)) return; c.monthly = n; }
  else if (t.dataset.field === "fixed") c.fixed = t.checked;
  else c[t.dataset.field] = t.value.trim() || c[t.dataset.field];
  const total = S.draft.filter((x) => !x.archived).reduce((s, x) => s + x.monthly, 0);
  const tot = $("#set-total"); if (tot) tot.textContent = `${eur0(total)} total`;
  const n = draftChanges().length;
  const btn = $("#send-budget");
  if (btn) { btn.disabled = !n; btn.textContent = n ? `Ask ${otherName()} to approve ${n} ${n === 1 ? "change" : "changes"}` : "No changes yet"; }
});

// chart tooltip
function showTip(el) {
  const chart = el.closest(".chart"); const tip = $(".tip", chart); const sv = $("svg", chart);
  const r = sv.getBoundingClientRect(); const vb = sv.viewBox.baseVal;
  tip.textContent = el.dataset.tip; tip.hidden = false;
  const cx = (Number(el.dataset.tx) / vb.width) * r.width;
  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.max(half, Math.min(r.width - half, cx))}px`;
  tip.style.top = `${(Number(el.dataset.ty) / vb.height) * r.height - 6}px`;
}
document.addEventListener("pointerover", (ev) => { const h = ev.target.closest?.(".hit"); if (h) showTip(h); });
document.addEventListener("pointerdown", (ev) => { const h = ev.target.closest?.(".hit"); if (h) showTip(h); });
document.addEventListener("pointerout", (ev) => { if (ev.target.closest?.(".hit") && ev.pointerType === "mouse") $(".tip", ev.target.closest(".chart")).hidden = true; });

/* ============ boot ============ */
async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    navigator.serviceWorker.addEventListener("message", (ev) => { if (ev.data?.type === "refresh" && (S.token || S.who)) refresh(true).catch(() => {}); });
  }
  try {
    S.status = await fetch("/api/status").then((r) => r.json());
    const m = /^#reset=([a-f0-9]{48})$/.exec(location.hash);
    if (m) { S.resetToken = m[1]; return authView("reset"); }
    if (S.status.open && !m) {
      if (!S.who) return whoView();
      return await refresh(true);
    }
    if (!S.token) return authView(S.status.users === 0 ? "register" : "login");
    await refresh(true);
  } catch (e) {
    if (e.status === 401 || !S.data) { if (e.status === 401) { S.token = ""; localStorage.removeItem("ob.token"); return authView("login"); } }
    app.innerHTML = `<div class="auth"><h1>Can't connect</h1><p>${esc(e.message || "Check your connection and try again.")}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
  }
}

setInterval(() => {
  if (!S.data || document.hidden || !(S.token || S.who)) return;
  refresh().catch(() => {});
  if (S.tab === "history") loadLog(true);
}, 20000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.data && (S.token || S.who)) { refresh().catch(() => {}); if (S.tab === "history") loadLog(true); } });
boot();
