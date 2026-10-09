// Unit tests for buildCreditPlan(input), the pure Credit Coach engine that
// lives inside the app.js IIFE between the `// @@buildCreditPlan:start` /
// `// @@buildCreditPlan:end` markers. Run with: node --test "tests/*.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const START = "// @@buildCreditPlan:start";
const END = "// @@buildCreditPlan:end";
const start = appSrc.indexOf(START);
const end = appSrc.indexOf(END);
assert.ok(start !== -1 && end > start, "buildCreditPlan markers not found in app.js");
assert.equal(appSrc.indexOf(START, start + 1), -1, "duplicate start marker");
assert.equal(appSrc.indexOf(END, end + 1), -1, "duplicate end marker");
const block = appSrc.slice(start + START.length, end);
const buildCreditPlan = new Function(block + "; return buildCreditPlan;")();

/* ---- fixtures (verbatim from .agents/tasks/credit-coach-plan.md) ---- */
const TODAY = "2026-10-10";
const A = {
  id: "a", name: "Prime Visa", last4: "3410", limit: 1000, balance: 900, apr: 29.99,
  dueDay: 15, minPayment: 25, remainingStatementBalance: 530.67, autopay: false,
};
const B_SMALL = {
  id: "b", name: "Amex Blue", limit: 5000, balance: 400, apr: 15.99,
  dueDay: 25, opened: "2020-01-15", autopay: true,
};
const B_BIG = { ...B_SMALL, balance: 2500 };
const SCORES = [{ date: "2026-08-01", score: 612 }, { date: "2026-09-15", score: 628 }];
const base = {
  scores: SCORES,
  monthlyIncome: 4000,
  monthlyExpenses: 2500,
  today: TODAY,
  settings: { strategy: "avalanche", targetScore: null, monthlyBudget: null },
};

const run = (cards, overrides = {}, settings = {}) =>
  buildCreditPlan({ ...base, ...overrides, cards, settings: { ...base.settings, ...settings } });
const pay = (plan, month, id) => plan.payoff.months[month - 1].payments.find((p) => p.id === id);

test("marker block is self-contained (no closure references)", () => {
  for (const needle of ["state.", "$(", "fmt(", "cbT(", "localDateStr", "todayStr", "Date.now"]) {
    assert.ok(!block.includes(needle), `block references ${needle}`);
  }
});

test("output shape", () => {
  const plan = run([A, B_SMALL]);
  assert.deepEqual(
    Object.keys(plan).sort(),
    ["actions", "diagnosis", "fingerprint", "flags", "payoff", "planMonth", "projection", "snapshot", "status"],
  );
  assert.equal(plan.status, "ok");
  assert.equal(plan.planMonth, "2026-10");
  assert.equal(plan.payoff.months[0].label, "2026-11");
  assert.equal(plan.snapshot.perCard[0].name, "Prime Visa (…3410)");
  assert.equal(plan.snapshot.perCard[1].name, "Amex Blue");
  assert.equal(plan.snapshot.perCard[0].nextDue, "2026-10-15");
  assert.equal(plan.snapshot.perCard[0].daysToDue, 5);
  assert.equal(plan.snapshot.score, 628);
  assert.equal(plan.snapshot.bandKey, "cb.band.fair");
  assert.equal(plan.snapshot.targetScore, 670);
  assert.equal(plan.snapshot.cashAvailable, 1500);
  assert.ok(plan.flags.minEstimated.includes("b"));
  assert.ok(!plan.flags.minEstimated.includes("a"));
});

test("1. avalanche vs snowball month-1 payments", () => {
  const ava = run([A, B_SMALL], {}, { strategy: "avalanche", monthlyBudget: 300 });
  assert.equal(pay(ava, 1, "a").payment, 275);
  assert.equal(pay(ava, 1, "b").payment, 25);
  assert.ok(pay(ava, 1, "a").payment > pay(ava, 1, "b").payment);

  const snow = run([A, B_SMALL], {}, { strategy: "snowball", monthlyBudget: 300 });
  assert.equal(pay(snow, 1, "b").payment, 275);
  assert.equal(pay(snow, 1, "a").payment, 25);
  assert.ok(pay(snow, 1, "b").payment > pay(snow, 1, "a").payment);
});

test("2. utilization strategy brings the hottest card just under 30% first", () => {
  const util = run([A, B_BIG], {}, { strategy: "utilization", monthlyBudget: 1000 });
  const a = pay(util, 1, "a");
  const b = pay(util, 1, "b");
  assert.ok(a.endBalance / 1000 < 0.3, `a util ${a.endBalance / 10}% not < 30%`);
  assert.ok(a.endBalance > 0, "a should not be fully paid");
  assert.ok(Math.abs(a.endBalance - 299.99) < 0.02);
  assert.ok(b.endBalance > 2000, `b endBalance ${b.endBalance}`);

  const ava = run([A, B_BIG], {}, { strategy: "avalanche", monthlyBudget: 1000 });
  assert.equal(pay(ava, 1, "a").endBalance, 0);
});

test("3. interest accrues first at apr/12", () => {
  const plan = run([{ id: "x", limit: 5000, balance: 1200, apr: 12, minPayment: 25 }], {}, { monthlyBudget: 100 });
  const row = plan.payoff.months[0];
  assert.equal(row.interest, 12);
  assert.equal(row.payments[0].payment, 100);
  assert.equal(row.endBalance, 1112);
});

test("4. budget shortfall falls back to minimums and flags it", () => {
  const plan = run([A, B_SMALL], { monthlyIncome: 100, monthlyExpenses: 90 });
  assert.equal(plan.flags.budgetShortfall, true);
  assert.equal(plan.payoff.budgetSource, "auto");
  assert.equal(plan.payoff.monthlyBudget, 50);
  assert.equal(pay(plan, 1, "a").payment, 25);
  assert.equal(pay(plan, 1, "b").payment, 25);
  assert.ok(plan.actions.some((a) => a.id === "budget-shortfall" && a.priority === 1));
});

test("5. debt-free month and zero interest at 0% APR", () => {
  const plan = run(
    [
      { id: "p", balance: 100, apr: 0, minPayment: 25, limit: 1000 },
      { id: "q", balance: 50, apr: 0, minPayment: 25, limit: 1000 },
    ],
    {},
    { monthlyBudget: 50 },
  );
  assert.equal(plan.payoff.debtFreeMonth, 3);
  assert.equal(plan.payoff.totalInterest, 0);
  assert.equal(plan.payoff.months.length, 3);
  assert.equal(plan.flags.truncated, false);
  assert.equal(plan.payoff.months[2].endBalance, 0);
});

test("6. score projection is clamped and reaches the target deterministically", () => {
  const plan = run([A, B_SMALL], { scores: [{ date: "2026-09-15", score: 612 }] }, { monthlyBudget: 1500 });
  assert.equal(plan.payoff.debtFreeMonth, 1);
  assert.equal(plan.projection.available, true);
  assert.equal(plan.projection.startScore, 612);
  assert.equal(plan.projection.points.length, 37);
  for (const p of plan.projection.points) {
    assert.ok(p.score <= 850 && p.score >= 300, `point ${p.month} score ${p.score} out of range`);
  }
  // u0 = 1300/6000 = 21.67% (table 60), u1+ = 0 (table 75), scale 1 → 627 + 2m
  assert.equal(plan.projection.points[0].score, 612);
  assert.equal(plan.projection.points[1].score, 629);
  assert.equal(plan.projection.points[22].score, 671);
  assert.equal(plan.projection.reachesTargetMonth, 22);
  assert.equal(plan.projection.points[0].label, "2026-10");
  assert.equal(plan.projection.points[1].label, "2026-11");

  const high = run([A, B_SMALL], { scores: [{ date: "2026-09-15", score: 845 }] }, { monthlyBudget: 1500 });
  assert.equal(Math.max(...high.projection.points.map((p) => p.score)), 850);
  assert.equal(high.snapshot.targetScore, 850);
});

test("7. no cards → status no-cards with empty plan", () => {
  const plan = run([]);
  assert.equal(plan.status, "no-cards");
  assert.equal(plan.payoff.months.length, 0);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.projection.available, false);
  assert.equal(plan.projection.points.length, 0);
  assert.equal(plan.diagnosis.hurting.length, 0);
  assert.equal(plan.fingerprint, "2026-10|");
  assert.equal(plan.snapshot.score, 628);
});

test("8. diagnosis flags the maxed card, the due-soon payment and the upward trend", () => {
  const plan = run([A, B_SMALL]);
  const h = plan.diagnosis.hurting;
  assert.ok(h.some((d) => d.id === "card-maxed-a" && d.severity === "high"));
  assert.ok(h.some((d) => d.id === "due-a" && d.severity === "high"));
  assert.ok(!h.some((d) => d.id === "due-b"));
  assert.ok(h.some((d) => d.id === "util-med" && d.severity === "medium"));
  const due = h.find((d) => d.id === "due-a");
  assert.deepEqual(due.vars, { name: "Prime Visa (…3410)", amount: 25, date: "2026-10-15" });
  // high → medium → low, stable
  const rank = { high: 0, medium: 1, low: 2 };
  for (let i = 1; i < h.length; i++) assert.ok(rank[h[i - 1].severity] <= rank[h[i].severity]);
  assert.ok(plan.diagnosis.helping.some((x) => x.key === "cc.help.trendUp" && x.vars.delta === 16));
  assert.ok(plan.diagnosis.helping.some((x) => x.key === "cc.help.mix"));
});

test("actions are prioritized with stable ids", () => {
  const plan = run([A, B_SMALL], {}, { strategy: "utilization" });
  const ids = plan.actions.map((a) => a.id);
  assert.ok(ids.includes("pay-min-a"));
  assert.ok(ids.includes("pay-plan-a"));
  assert.ok(ids.includes("autopay"));
  assert.ok(ids.includes("keep-oldest"));
  assert.ok(ids.includes("log-score"));
  assert.ok(ids.includes("spread-a-b"));
  for (let i = 1; i < plan.actions.length; i++) {
    assert.ok(plan.actions[i - 1].priority <= plan.actions[i].priority);
  }
  assert.equal(plan.actions[0].id, "pay-min-a");
  assert.equal(plan.actions[0].due, "2026-10-15");
  const planAct = plan.actions.find((a) => a.id === "pay-plan-a");
  assert.equal(planAct.key, "cc.act.payTo30");
  assert.equal(planAct.due, "2026-10-15");
  const auto = plan.actions.find((a) => a.id === "autopay");
  assert.equal(auto.vars.names, "Prime Visa (…3410)");
  const log = plan.actions.find((a) => a.id === "log-score");
  assert.equal(log.due, "2026-10-15"); // 2026-09-15 + 30 days
  const keep = plan.actions.find((a) => a.id === "keep-oldest");
  assert.equal(keep.vars.name, "Amex Blue");
  assert.equal(keep.vars.years, 6);
  assert.equal(keep.vars.months, 8);
});

test("minimums-only comparison is null when the min-only run never finishes", () => {
  // 29.99% APR with the 2% estimated minimum: interest outruns the minimum, so
  // the min-only balance diverges and no saving can be quoted.
  const plan = run([{ id: "d", limit: 5000, balance: 2500, apr: 29.99 }], {}, { monthlyBudget: 300 });
  assert.equal(plan.flags.minOnlyTruncated, true);
  assert.equal(plan.payoff.interestSaved, null);
  assert.equal(plan.payoff.minOnlyInterest, null);
  assert.equal(plan.flags.truncated, false);
  assert.ok(plan.payoff.totalInterest > 0);

  // Stored fixed minimum below one month's interest → same outcome.
  const fixed = run([{ id: "f", limit: 1500, balance: 1200, apr: 29.99, minPayment: 25 }], {}, { monthlyBudget: 200 });
  assert.equal(fixed.flags.minOnlyTruncated, true);
  assert.equal(fixed.payoff.interestSaved, null);

  // When both runs finish the comparison is a real, finite amount.
  const ok = run([{ id: "x", limit: 5000, balance: 1200, apr: 12, minPayment: 50 }], {}, { monthlyBudget: 300 });
  assert.equal(ok.flags.minOnlyTruncated, false);
  assert.ok(Number.isFinite(ok.payoff.interestSaved) && ok.payoff.interestSaved > 0);
  assert.ok(Number.isFinite(ok.payoff.minOnlyInterest) && ok.payoff.minOnlyInterest > ok.payoff.totalInterest);
});

test("36-month truncation nulls the comparison and keeps debtFreeMonth null", () => {
  const plan = run([{ id: "t", limit: 20000, balance: 15000, apr: 5, minPayment: 400 }], {}, { monthlyBudget: 400 });
  assert.equal(plan.flags.truncated, true);
  assert.equal(plan.payoff.months.length, 36);
  assert.equal(plan.payoff.debtFreeMonth, null);
  assert.equal(plan.payoff.interestSaved, null);
  assert.equal(plan.payoff.minOnlyInterest, null);
});

test("shortfall action quotes the amount that actually fell short", () => {
  // Override below minimums → cash is the override, not cashAvailable.
  const over = run([A, B_SMALL], {}, { monthlyBudget: 30 });
  assert.equal(over.flags.budgetShortfall, true);
  assert.equal(over.payoff.budgetSource, "override");
  const act = over.actions.find((a) => a.id === "budget-shortfall");
  assert.deepEqual(act.vars, { mins: 50, cash: 30 });

  // Auto path → cash is cashAvailable.
  const auto = run([A, B_SMALL], { monthlyIncome: 100, monthlyExpenses: 90 });
  const act2 = auto.actions.find((a) => a.id === "budget-shortfall");
  assert.deepEqual(act2.vars, { mins: 50, cash: 10 });
});

test("monthlyBudget 0 is read as no override (auto)", () => {
  const plan = run([A, B_SMALL], {}, { monthlyBudget: 0 });
  assert.equal(plan.payoff.budgetSource, "auto");
  assert.equal(plan.payoff.monthlyBudget, 1300);
  assert.equal(plan.flags.budgetShortfall, false);
});

test("fingerprint changes on a >= $1 balance change only", () => {
  const p0 = run([A, B_SMALL]);
  const p1 = run([{ ...A, balance: 901 }, B_SMALL]);
  const p2 = run([{ ...A, balance: 900.4 }, B_SMALL]);
  assert.notEqual(p0.fingerprint, p1.fingerprint);
  assert.equal(p0.fingerprint, p2.fingerprint);
  assert.equal(p0.fingerprint, "2026-10|a:900:1000,b:400:5000");
});
