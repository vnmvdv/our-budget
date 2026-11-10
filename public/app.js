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
const dayLabel = (ds) => {
  const t = todayStr();
  if (ds === t) return "Today";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (ds === `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`) return "Yesterday";
  return dateObj(ds).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};

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
  key: localStorage.getItem("ob.key") || "",
  me: localStorage.getItem("ob.me") || "",
  data: null,
  tab: "today",
  month: monthOf(todayStr()),
  filterCat: "all",
  filterWho: "all",
  sheet: false,
  stale: false,
  lastSig: "",
  lastCat: localStorage.getItem("ob.lastcat") || "",
};
const names = () => S.data?.meta?.names ?? { a: "Me", b: "Partner" };
const catById = () => Object.fromEntries(S.data.cats.map((c) => [c.id, c]));
const activeCats = () => S.data.cats.filter((c) => !c.archived).sort((a, b) => a.order - b.order);

/* ============ api ============ */
async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", "x-household-key": S.key || "" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.data) { lock(); throw new Error("Passphrase changed. Enter it again."); }
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

/** Apply a change locally right away, then save it; if saving fails, reload the truth. */
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
    // week (Monday start), clipped to this month
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
const I = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13a8 8 0 0 1 16 0"/><path d="M12 13l4-4"/><path d="M4 18h16"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V11M12 20V5M19 20v-6"/></svg>',
  goal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
};

/* ============ rendering ============ */
const app = $("#app");

function render() {
  if (!S.data) return;
  const y = window.scrollY;
  const views = { today: viewToday, spending: viewSpending, insights: viewInsights, goals: viewGoals };
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

function topbar(title, sub) {
  return `<header class="topbar"><div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ""}</div>
    <button class="icon-btn" data-action="settings" aria-label="Settings">${I.gear}</button></header>`;
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
  const d = new Date();
  const title = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return `${topbar(title, `Hi ${names()[S.me] || ""}`.trim())}
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
  const canNext = S.month < monthOf(todayStr());
  const body = groups.length
    ? groups.map((g) => `<div class="day"><div class="day-head"><span>${esc(dayLabel(g.date))}</span><span class="num">${eur(g.items.reduce((s, e) => s + e.amount, 0))}</span></div>
        <div class="rows">${g.items.map((e) => {
          const c = byId[e.catId];
          return `<button class="row" data-action="edit-expense" data-id="${esc(e.id)}"><span class="glyph" aria-hidden="true">${esc(c?.icon || "•")}</span>
            <div class="row-main"><div class="row-title">${esc(e.note || c?.name || "Expense")}</div>
            <div class="row-sub"><span class="dot ${e.who === "b" ? "b" : ""}"></span>${esc(nm[e.who])}${e.note ? ` · ${esc(c?.name || "")}` : ""}</div></div>
            <span class="row-amt num">${eur(e.amount)}</span></button>`;
        }).join("")}</div></div>`).join("")
    : `<div class="empty"><b>Nothing here yet</b>${S.filterCat !== "all" || S.filterWho !== "all" ? "No expenses match these filters." : `No expenses logged for ${esc(monthName(S.month))}. Tap + to add the first one.`}</div>`;
  return `${topbar("Spending", `${eur(sum)} in ${monthName(S.month)}`)}
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
  // last 6 months ending at S.month
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

  // categories ranked
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

  // who
  const byWho = { a: 0, b: 0 };
  for (const e of k.exps) byWho[e.who] += e.amount;
  const whoTotal = byWho.a + byWho.b;
  const who = whoTotal
    ? `<div class="split" role="img" aria-label="${esc(nm.a)} ${eur(byWho.a)}, ${esc(nm.b)} ${eur(byWho.b)}"><i style="width:${(byWho.a / whoTotal) * 100}%"></i><i class="b" style="width:${(byWho.b / whoTotal) * 100}%"></i></div>
       <div class="split-keys"><div><span class="dot"></span><span>${esc(nm.a)} <b class="num">${eur(byWho.a)}</b></span></div><div><span class="dot b"></span><span>${esc(nm.b)} <b class="num">${eur(byWho.b)}</b></span></div></div>`
    : '<p class="hint">Nothing logged this month yet.</p>';

  // stats
  const elapsed = k.isCur ? k.dom : k.dim;
  const noSpend = k.days.slice(0, elapsed).filter((d) => d.spent <= 0.004 && !k.exps.some((e) => e.date === d.ds)).length;
  const biggest = k.exps.reduce((m, e) => (e.amount > (m?.amount || 0) ? e : m), null);
  return `${topbar("Insights", monthName(S.month))}
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
  return `${topbar("Goals", "Saving together")}${body}
  <button class="btn alt" style="margin-top:4px" data-action="new-goal">New goal</button>`;
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
function closeSheet() {
  S.sheet = false;
  sheetRoot.innerHTML = "";
  if (S.stale) { S.stale = false; }
  render();
}

function whoSeg(sel, name = "who") {
  const nm = names();
  return `<div class="seg" role="group" aria-label="Who">${["a", "b"].map((w) => `<button type="button" data-action="pick-who" data-who="${w}" aria-pressed="${sel === w}">${esc(nm[w])}</button>`).join("")}<input type="hidden" name="${name}" value="${sel}"></div>`;
}

function expenseSheet(exp) {
  const editing = !!exp;
  const cats = activeCats();
  const byId = catById();
  const catList = cats.slice();
  if (editing && byId[exp.catId]?.archived) catList.push(byId[exp.catId]);
  const selCat = exp?.catId || (cats.some((c) => c.id === S.lastCat) ? S.lastCat : "");
  const who = exp?.who || S.me || "a";
  openSheet(editing ? "Edit expense" : "Add expense", `<form data-form="expense" class="stack" ${editing ? `data-id="${esc(exp.id)}" data-month="${esc(monthOf(exp.date))}"` : ""} novalidate>
    <div class="field"><label for="f-amount" class="lbl">Amount</label><div class="amount-wrap"><span>€</span><input id="f-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${editing ? exp.amount : ""}" ${editing ? "" : "data-autofocus"}></div></div>
    <div class="field"><span class="lbl">Category</span><div class="cats" role="group" aria-label="Category">${catList.map((c) => `<button type="button" class="cat-pick" data-action="pick-cat" data-id="${esc(c.id)}" aria-pressed="${selCat === c.id}"><span class="e">${esc(c.icon)}</span>${esc(c.name)}</button>`).join("")}</div><input type="hidden" name="catId" value="${esc(selCat)}"></div>
    <div class="field"><span class="lbl">Paid by</span>${whoSeg(who)}</div>
    <div class="field"><label for="f-note" class="lbl">Note (optional)</label><input class="input" id="f-note" name="note" maxlength="80" autocomplete="off" placeholder="Billa, taxi to work…" value="${esc(exp?.note || "")}"></div>
    <div class="field"><label for="f-date" class="lbl">Date</label><input class="input" id="f-date" name="date" type="date" value="${esc(exp?.date || todayStr())}"></div>
    <p class="err" data-err></p>
    <button class="btn" type="submit">${editing ? "Save changes" : "Add expense"}</button>
    ${editing ? '<button class="btn danger" type="button" data-action="delete-expense">Delete expense</button>' : ""}
  </form>`);
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
    ${g ? '<button class="btn danger" type="button" data-action="delete-goal">Delete goal</button>' : ""}
  </form>`);
}

function contribSheet(goalId, c) {
  const g = S.data.goals.find((x) => x.id === goalId);
  const neg = c && c.amount < 0;
  openSheet(c ? "Edit entry" : `Add to ${g?.name || "goal"}`, `<form data-form="contrib" class="stack" data-goal="${esc(goalId)}" ${c ? `data-id="${esc(c.id)}"` : ""} novalidate>
    <div class="seg" role="group" aria-label="Type"><button type="button" data-action="pick-dir" data-dir="1" aria-pressed="${!neg}">Add money</button><button type="button" data-action="pick-dir" data-dir="-1" aria-pressed="${!!neg}">Take out</button><input type="hidden" name="dir" value="${neg ? -1 : 1}"></div>
    <div class="field"><label class="lbl" for="c-amount">Amount</label><div class="amount-wrap"><span>€</span><input id="c-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${c ? Math.abs(c.amount) : ""}" data-autofocus></div></div>
    <div class="field"><span class="lbl">Who</span>${whoSeg(c?.who || S.me || "a")}</div>
    <div class="field"><label class="lbl" for="c-note">Note (optional)</label><input class="input" id="c-note" name="note" maxlength="60" value="${esc(c?.note || "")}"></div>
    <div class="field"><label class="lbl" for="c-date">Date</label><input class="input" id="c-date" name="date" type="date" value="${esc(c?.date || todayStr())}"></div>
    <p class="err" data-err></p>
    <button class="btn" type="submit">${c ? "Save changes" : "Save"}</button>
    ${c ? '<button class="btn danger" type="button" data-action="delete-contrib">Delete entry</button>' : ""}
  </form>`);
}

function settingsSheet() {
  const nm = names();
  const catRows = S.data.cats.filter((c) => !c.archived).sort((a, b) => a.order - b.order).map((c) => `<div class="set-cat" data-cat="${esc(c.id)}">
      <input class="input icon-in" data-field="icon" value="${esc(c.icon)}" maxlength="4" aria-label="Icon for ${esc(c.name)}">
      <input class="input" data-field="name" value="${esc(c.name)}" maxlength="30" aria-label="Category name">
      <input class="input" data-field="monthly" inputmode="decimal" value="${c.monthly}" aria-label="Monthly budget for ${esc(c.name)}">
      <div class="set-cat-foot"><label class="check"><input type="checkbox" data-field="fixed" ${c.fixed ? "checked" : ""}> Fixed monthly cost</label><button class="link" data-action="archive-cat" data-id="${esc(c.id)}">Remove</button></div></div>`).join("");
  const total = activeCats().reduce((s, c) => s + c.monthly, 0);
  openSheet("Settings", `<div class="stack">
    <div class="field"><span class="lbl">Names</span><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><input class="input" id="nameA" value="${esc(nm.a)}" maxlength="20" aria-label="First name"><input class="input" id="nameB" value="${esc(nm.b)}" maxlength="20" aria-label="Second name"></div></div>
    <div class="field"><span class="lbl">This phone belongs to</span><div class="seg">${["a", "b"].map((w) => `<button type="button" data-action="set-me" data-who="${w}" aria-pressed="${S.me === w}">${esc(nm[w])}</button>`).join("")}</div></div>
    <div class="field"><span class="lbl">Monthly budget <span class="hint num" id="set-total">${eur0(total)} total</span></span>
      <div class="rows" style="padding:0 14px">${catRows}</div>
      <p class="hint">Fixed costs (rent, bills) are left out of the daily allowance. Everything else counts toward it.</p>
      <button class="btn alt small" data-action="add-cat" style="margin-top:4px">Add category</button></div>
    <details class="fold"><summary>Passphrase</summary><div class="stack"><input class="input" id="newpass" type="password" autocomplete="new-password" placeholder="New passphrase (8+ characters)"><button class="btn alt small" data-action="change-pass">Change passphrase</button><p class="hint">After changing it, enter the new one on the other phone.</p></div></details>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn alt small" data-action="export">Download CSV</button><button class="btn alt small" data-action="lock">Lock this phone</button></div>
  </div>`);
}

function whoAreYouSheet() {
  const nm = names();
  openSheet("Who is using this phone?", `<div class="stack"><p class="hint">So new expenses are marked as yours by default. You can change it any time in settings.</p>
    ${["a", "b"].map((w) => `<button class="btn ${w === "b" ? "alt" : ""}" data-action="set-me" data-who="${w}" data-close="1">${esc(nm[w])}</button>`).join("")}</div>`, { dismissible: false });
}

/* ============ auth screens ============ */
function authScreen(html) { app.innerHTML = `<div class="auth">${html}</div>`; sheetRoot.innerHTML = ""; S.sheet = false; }

function setupScreen() {
  authScreen(`<div><h1>Our budget</h1><p style="margin-top:8px">Set it up once. Both of you open the same link and use the same passphrase.</p></div>
  <form data-form="setup" class="stack" novalidate>
    <div class="field"><label class="lbl" for="s-a">Your name</label><input class="input" id="s-a" name="nameA" maxlength="20" autocomplete="given-name" placeholder="Vihren"></div>
    <div class="field"><label class="lbl" for="s-b">Their name</label><input class="input" id="s-b" name="nameB" maxlength="20" placeholder="Name"></div>
    <div class="field"><label class="lbl" for="s-p">Shared passphrase</label><input class="input" id="s-p" name="passphrase" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
    <p class="hint">Your starter budget (€2,280 a month) is added automatically. You can change every number later.</p>
    <p class="err" data-err></p><button class="btn" type="submit">Create our budget</button></form>`);
}

function loginScreen(msg = "") {
  authScreen(`<div><h1>Our budget</h1><p style="margin-top:8px">Enter your shared passphrase to open it.</p></div>
  <form data-form="login" class="stack" novalidate>
    <div class="field"><label class="lbl" for="l-p">Passphrase</label><input class="input" id="l-p" name="passphrase" type="password" autocomplete="current-password" data-autofocus></div>
    <p class="err" data-err>${esc(msg)}</p><button class="btn" type="submit">Open budget</button></form>`);
  setTimeout(() => $("#l-p")?.focus(), 50);
}

function lock() {
  S.key = ""; localStorage.removeItem("ob.key"); S.data = null; S.lastSig = "";
  loginScreen();
}

/* ============ toast ============ */
let toastTimer;
function toast(msg, undo) {
  const root = $("#toast-root");
  root.innerHTML = `<div class="toast" role="status"><span>${esc(msg)}</span>${undo ? '<button data-action="undo">Undo</button>' : ""}</div>`;
  S.undo = undo || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ""; S.undo = null; }, undo ? 6000 : 3500);
}

/* ============ actions ============ */
const actions = {
  tab(el) { S.tab = el.dataset.tab; if (S.tab === "spending") { S.filterCat = "all"; S.filterWho = "all"; } window.scrollTo(0, 0); render(); },
  add() { expenseSheet(null); },
  settings() { settingsSheet(); },
  "close-sheet"() { closeSheet(); },
  month(el) {
    const next = addMonths(S.month, Number(el.dataset.dir));
    if (next > monthOf(todayStr())) return;
    S.month = next; render();
  },
  "filter-cat"(el) { S.tab = "spending"; S.month = monthOf(todayStr()); S.filterCat = el.dataset.id; S.filterWho = "all"; window.scrollTo(0, 0); render(); },
  "set-filter"(el) { if (el.dataset.kind === "cat") S.filterCat = el.dataset.id; else S.filterWho = el.dataset.id; render(); },
  "pick-cat"(el) {
    const form = el.closest("form");
    form.querySelectorAll(".cat-pick").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    form.elements.catId.value = el.dataset.id;
  },
  "pick-who"(el) {
    const wrap = el.closest(".seg");
    wrap.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    wrap.querySelector("input").value = el.dataset.who;
  },
  "pick-dir"(el) {
    const wrap = el.closest(".seg");
    wrap.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
    wrap.querySelector("input").value = el.dataset.dir;
  },
  "edit-expense"(el) { const e = S.data.expenses.find((x) => x.id === el.dataset.id); if (e) expenseSheet(e); },
  "delete-expense"(el) {
    const form = el.closest("form");
    const id = form.dataset.id, month = form.dataset.month;
    const old = S.data.expenses.find((x) => x.id === id);
    closeSheetQuiet();
    mutate(() => { S.data.expenses = S.data.expenses.filter((x) => x.id !== id); }, () => api("DELETE", `/expense/${month}/${id}`));
    toast("Expense deleted", () => saveExpense(old));
  },
  "new-goal"() { goalSheet(null); },
  "edit-goal"(el) { goalSheet(S.data.goals.find((g) => g.id === el.dataset.id)); },
  "delete-goal"(el) {
    const id = el.closest("form").dataset.id;
    if (!confirm("Delete this goal and all the money logged to it?")) return;
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
  "set-me"(el) {
    S.me = el.dataset.who; localStorage.setItem("ob.me", S.me);
    if (el.dataset.close) closeSheet(); else { settingsSheetKeepScroll(); }
  },
  "add-cat"() {
    const order = Math.max(-1, ...S.data.cats.map((c) => c.order)) + 1;
    const c = { id: "c-" + uid().slice(0, 10), name: "New category", icon: "🛍️", monthly: 0, fixed: false, archived: false, order };
    mutate(() => S.data.cats.push(c), () => api("PUT", "/cat", c));
    settingsSheetKeepScroll();
  },
  "archive-cat"(el) {
    const c = S.data.cats.find((x) => x.id === el.dataset.id);
    if (!c || !confirm(`Remove "${c.name}"? Past expenses in it stay in your history.`)) return;
    c.archived = true;
    mutate(() => {}, () => api("PUT", "/cat", c));
    settingsSheetKeepScroll();
  },
  async "change-pass"() {
    const v = $("#newpass").value;
    if (v.length < 8) { toast("Use at least 8 characters."); return; }
    try { await api("POST", "/passphrase", { passphrase: v }); S.key = v; localStorage.setItem("ob.key", v); toast("Passphrase changed. Use the new one on the other phone."); $("#newpass").value = ""; }
    catch (e) { toast(e.message); }
  },
  export() {
    const byId = catById(); const nm = names();
    const rows = [["Date", "Category", "Amount (EUR)", "Paid by", "Note"]].concat(
      S.data.expenses.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map((e) => [e.date, byId[e.catId]?.name || "", e.amount.toFixed(2), nm[e.who], e.note]));
    const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `our-budget-${todayStr()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  },
  lock() { closeSheetQuiet(); lock(); },
  undo() { const u = S.undo; $("#toast-root").innerHTML = ""; S.undo = null; if (u) u(); },
};

function closeSheetQuiet() { S.sheet = false; sheetRoot.innerHTML = ""; }
function settingsSheetKeepScroll() { const y = $(".sheet")?.scrollTop || 0; settingsSheet(); const s = $(".sheet"); if (s) s.scrollTop = y; }

function saveExpense(rec) {
  mutate(() => { S.data.expenses = S.data.expenses.filter((x) => x.id !== rec.id).concat(rec); }, () => api("PUT", "/expense", rec));
}

/* ============ forms ============ */
const forms = {
  async setup(f) {
    const v = Object.fromEntries(new FormData(f));
    if (!v.passphrase || v.passphrase.length < 8) return formErr(f, "Use at least 8 characters for the passphrase.");
    try {
      await api("POST", "/setup", v);
      S.key = v.passphrase; localStorage.setItem("ob.key", S.key);
      await boot();
    } catch (e) { formErr(f, e.message); }
  },
  async login(f) {
    const pass = new FormData(f).get("passphrase");
    S.key = pass;
    try { await refresh(true); localStorage.setItem("ob.key", pass); S.lastSig = ""; await boot(); }
    catch (e) { S.key = ""; formErr(f, e.status === 401 || /passphrase/i.test(e.message) ? "That passphrase didn't work." : e.message); }
  },
  expense(f) {
    const v = Object.fromEntries(new FormData(f));
    const amount = parseAmount(v.amount);
    if (!(amount > 0)) return formErr(f, "Enter an amount greater than 0.");
    if (!v.catId) return formErr(f, "Pick a category.");
    if (!v.date) return formErr(f, "Pick a date.");
    const editing = !!f.dataset.id;
    const rec = { id: f.dataset.id || uid(), catId: v.catId, amount, note: (v.note || "").trim(), who: v.who, date: v.date, ts: Date.now() };
    const oldMonth = f.dataset.month;
    closeSheetQuiet();
    S.lastCat = v.catId; localStorage.setItem("ob.lastcat", S.lastCat);
    mutate(() => { S.data.expenses = S.data.expenses.filter((x) => x.id !== rec.id).concat(rec); },
      async () => { await api("PUT", "/expense", rec); if (editing && oldMonth && oldMonth !== monthOf(rec.date)) await api("DELETE", `/expense/${oldMonth}/${rec.id}`); });
    const c = catById()[rec.catId];
    if (!editing) toast(`Added ${eur(amount)} · ${c?.name || ""}`, () => {
      mutate(() => { S.data.expenses = S.data.expenses.filter((x) => x.id !== rec.id); }, () => api("DELETE", `/expense/${monthOf(rec.date)}/${rec.id}`));
    });
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
    const rec = { id: f.dataset.id || uid(), goalId: f.dataset.goal, amount: amt * Number(v.dir), who: v.who, date: v.date || todayStr(), note: (v.note || "").trim() };
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

// settings: names + category edits save as you type/leave a field
document.addEventListener("change", (ev) => {
  const t = ev.target;
  if (t.id === "nameA" || t.id === "nameB") {
    const a = $("#nameA").value.trim(), b = $("#nameB").value.trim();
    if (!a || !b) return;
    mutate(() => { S.data.meta.names = { a, b }; }, () => api("PUT", "/meta", { nameA: a, nameB: b }));
    return;
  }
  const row = t.closest?.(".set-cat");
  if (row && t.dataset.field) {
    const c = S.data.cats.find((x) => x.id === row.dataset.cat);
    if (!c) return;
    if (t.dataset.field === "monthly") { const n = parseAmount(t.value); if (!(n >= 0)) { t.value = c.monthly; return; } c.monthly = n; t.value = n; }
    else if (t.dataset.field === "fixed") c.fixed = t.checked;
    else { const v = t.value.trim(); if (!v) { t.value = c[t.dataset.field]; return; } c[t.dataset.field] = v; }
    S.lastSig = "";
    api("PUT", "/cat", c).catch((e) => toast(e.message));
    const total = activeCats().reduce((s, x) => s + x.monthly, 0);
    const tot = $("#set-total"); if (tot) tot.textContent = `${eur0(total)} total`;
  }
});

// chart tooltip
function showTip(el) {
  const chart = el.closest(".chart"); const tip = $(".tip", chart); const svg = $("svg", chart);
  const r = svg.getBoundingClientRect(); const vb = svg.viewBox.baseVal;
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
  try {
    const status = await fetch("/api/status").then((r) => r.json());
    if (!status.configured) return setupScreen();
    if (!S.key) return loginScreen();
    await refresh(true);
    if (!S.me) whoAreYouSheet();
  } catch (e) {
    if (S.key && e.status === 401) return loginScreen("Enter your passphrase again.");
    app.innerHTML = `<div class="auth"><h1>Can't connect</h1><p>${esc(e.message || "Check your connection and try again.")}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
  }
}

setInterval(() => { if (S.data && !document.hidden && S.key) refresh().catch(() => {}); }, 20000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.data && S.key) refresh().catch(() => {}); });
boot();
