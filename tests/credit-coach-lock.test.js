// Unit tests for the Credit Coach "Lock plan" engine: createLockedPlan() and
// compareToLockedPlan(), both pure blocks inside the app.js IIFE between their
// `// @@<name>:start` / `// @@<name>:end` markers. buildCreditPlan() is sliced
// the same way to produce real plans. Run with: node --test "tests/*.test.js"
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const slice = (name) => {
  const START = `// @@${name}:start`;
  const END = `// @@${name}:end`;
  const start = appSrc.indexOf(START);
  const end = appSrc.indexOf(END);
  assert.ok(start !== -1 && end > start, `${name} markers not found in app.js`);
  assert.equal(appSrc.indexOf(START, start + 1), -1, `duplicate ${name} start marker`);
  assert.equal(appSrc.indexOf(END, end + 1), -1, `duplicate ${name} end marker`);
  return appSrc.slice(start + START.length, end);
};
const planBlock = slice("buildCreditPlan");
const createBlock = slice("createLockedPlan");
const compareBlock = slice("compareToLockedPlan");
const buildCreditPlan = new Function(planBlock + "; return buildCreditPlan;")();
const createLockedPlan = new Function(createBlock + "; return createLockedPlan;")();
const compareToLockedPlan = new Function(compareBlock + "; return compareToLockedPlan;")();

/* ---- fixtures ---- */
const LOCKED_AT = "2026-10-10";
const A = { id: "a", name: "Prime Visa", last4: "3410", limit: 1000, balance: 900, apr: 29.99, dueDay: 15, minPayment: 25 };
const B = { id: "b", name: "Amex Blue", limit: 5000, balance: 400, apr: 15.99, dueDay: 25, opened: "2020-01-15", autopay: true };
const SCORES = [{ date: "2026-08-01", score: 612 }, { date: "2026-09-15", score: 628 }];
const SETTINGS = { strategy: "avalanche", targetScore: null, monthlyBudget: 300 };
const input = (cards, settings = SETTINGS, today = LOCKED_AT) => ({
  cards,
  scores: SCORES,
  monthlyIncome: 4000,
  monthlyExpenses: 2500,
  today,
  settings,
});
const lockFor = (cards = [A, B], settings = SETTINGS) => {
  const inp = input(cards, settings);
  return createLockedPlan(buildCreditPlan(inp), inp, LOCKED_AT);
};
// Current cards in the shape the adapter passes (live balance).
const cur = (overrides = {}) => [A, B].map((c) => ({
  id: c.id, name: c.name, last4: c.last4, limit: c.limit, balance: c.id in overrides ? overrides[c.id] : c.balance,
}));
const card = (prog, id) => prog.perCard.find((c) => c.id === id);

test("lock blocks are self-contained (no closure references)", () => {
  for (const block of [createBlock, compareBlock]) {
    for (const needle of ["state.", "$(", "fmt(", "cbT(", "localDateStr", "todayStr", "Date.now", "localStorage", "document", "window"]) {
      assert.ok(!block.includes(needle), `block references ${needle}`);
    }
  }
});

test("createLockedPlan captures settings, starting snapshot, schedule, summary, projection and checklist", () => {
  const inp = input([A, B]);
  const plan = buildCreditPlan(inp);
  const lock = createLockedPlan(plan, inp, LOCKED_AT);

  assert.equal(lock.lockedAt, LOCKED_AT);
  assert.equal(lock.planMonth, "2026-10");
  assert.deepEqual(lock.settings, { strategy: "avalanche", targetScore: null, monthlyBudget: 300 });

  assert.equal(lock.start.score, 628);
  assert.equal(lock.start.totalBalance, 1300);
  assert.equal(lock.start.totalLimit, 6000);
  assert.ok(Math.abs(lock.start.utilization - (1300 / 6000) * 100) < 1e-9);
  assert.deepEqual(lock.start.cardOrder, ["a", "b"]);
  assert.equal(lock.start.cards.a.balance, 900);
  assert.equal(lock.start.cards.a.limit, 1000);
  assert.equal(lock.start.cards.a.apr, 29.99);
  assert.equal(lock.start.cards.a.name, "Prime Visa (…3410)");
  assert.equal(lock.start.cards.b.apr, 15.99);

  assert.equal(lock.schedule.length, plan.payoff.months.length);
  assert.ok(lock.schedule.length > 1);
  lock.schedule.forEach((row, i) => {
    const src = plan.payoff.months[i];
    assert.equal(row.label, src.label);
    assert.equal(row.endBalance, src.endBalance);
    assert.equal(row.utilization, src.utilization);
    assert.deepEqual(row.payments, src.payments);
  });

  assert.equal(lock.summary.debtFreeMonth, plan.payoff.debtFreeMonth);
  assert.equal(lock.summary.debtFreeLabel, plan.payoff.months[plan.payoff.debtFreeMonth - 1].label);
  assert.equal(lock.summary.totalInterest, plan.payoff.totalInterest);
  assert.equal(lock.summary.interestSaved, plan.payoff.interestSaved);
  assert.equal(lock.summary.utilUnder30Month, plan.payoff.utilUnder30Month);
  assert.equal(lock.summary.utilUnder10Month, plan.payoff.utilUnder10Month);
  assert.equal(lock.summary.targetMonth, plan.projection.reachesTargetMonth);
  assert.equal(lock.summary.targetScore, 670);
  assert.equal(lock.summary.monthlyBudget, 300);
  assert.equal(lock.projection.points.length, 37);
  assert.deepEqual(lock.projection.points.map((p) => p.score), plan.projection.points.map((p) => p.score));

  // Checklist: engine actions as month 0 plus one pay item per card per month, unique stable ids.
  const ids = lock.checklist.map((it) => it.id);
  assert.equal(new Set(ids).size, ids.length);
  plan.actions.forEach((a) => assert.ok(ids.includes(a.id), `missing action ${a.id}`));
  assert.ok(ids.includes("pay-plan-a"));
  assert.ok(!ids.includes("pay-m0-a"), "row-1 pay item is covered by pay-plan-a");
  assert.ok(ids.includes("pay-m0-b"));
  const m1a = lock.checklist.find((it) => it.id === "pay-m1-a");
  assert.equal(m1a.month, 1);
  assert.equal(m1a.label, "2026-11");
  assert.equal(m1a.key, "cc.lock.item.pay");
  assert.equal(m1a.vars.amount, plan.payoff.months[1].payments.find((p) => p.id === "a").payment);
  assert.deepEqual(lock.done, {});

  // Same input → same lock (deterministic), and the lock is a copy, not a view of the plan.
  assert.deepEqual(createLockedPlan(buildCreditPlan(inp), inp, LOCKED_AT), lock);
  plan.payoff.months[0].payments[0].payment = -1;
  assert.notEqual(lock.schedule[0].payments[0].payment, -1);
});

test("createLockedPlan returns null when there is nothing to lock", () => {
  const inp = input([]);
  assert.equal(createLockedPlan(buildCreditPlan(inp), inp, LOCKED_AT), null);
  const ok = input([A]);
  assert.equal(createLockedPlan(buildCreditPlan(ok), ok, "not-a-date"), null);
});

test("compareToLockedPlan month index counts calendar months since lockedAt", () => {
  const lock = lockFor();
  const idx = (today) => compareToLockedPlan(lock, cur(), [], today).monthIndex;
  assert.equal(idx("2026-10-10"), 0);
  assert.equal(idx("2026-10-31"), 0);
  assert.equal(idx("2026-11-01"), 1);
  assert.equal(idx("2027-01-05"), 3);
  assert.equal(idx("2026-09-01"), 0, "a clock before lockedAt never goes negative");

  // Month 1 compares against the end balance of schedule row 1.
  const prog = compareToLockedPlan(lock, cur(), [], "2026-11-05");
  assert.equal(card(prog, "a").planned, lock.schedule[0].payments.find((p) => p.id === "a").endBalance);
  assert.equal(prog.utilization.planned, lock.schedule[0].utilization);
});

test("ahead / on track / behind at the tolerance boundaries", () => {
  const lock = lockFor();
  const at = (a, b) => compareToLockedPlan(lock, cur({ a, b }), [], LOCKED_AT);
  // Month 0: planned = starting balance. a: 900 → tol max(10, 18) = 18; b: 400 → tol max(10, 8) = 10.
  assert.equal(card(at(882, 400), "a").status, "ahead");
  assert.equal(card(at(882.01, 400), "a").status, "onTrack");
  assert.equal(card(at(918, 400), "a").status, "onTrack");
  assert.equal(card(at(918.01, 400), "a").status, "behind");
  assert.equal(card(at(900, 390), "b").status, "ahead");
  assert.equal(card(at(900, 390.01), "b").status, "onTrack");
  assert.equal(card(at(900, 410), "b").status, "onTrack");
  assert.equal(card(at(900, 410.01), "b").status, "behind");

  // Totals: planned 1300 → tol 26.
  const ahead = at(700, 400);
  assert.equal(ahead.verdict.status, "ahead");
  assert.equal(ahead.verdict.amount, 200);
  assert.equal(ahead.verdict.catchUp, null);
  assert.equal(at(900, 400).verdict.status, "onTrack");

  const behind = at(950, 450);
  assert.equal(behind.totals.status, "behind");
  assert.equal(behind.verdict.amount, 100);
  assert.deepEqual(behind.verdict.catchUp, { id: "a", name: "Prime Visa (…3410)", amount: 50 });
  assert.equal(card(behind, "a").delta, 50);
});

test("progress totals, utilization, paid-off % and score vs projection", () => {
  const lock = lockFor();
  const prog = compareToLockedPlan(lock, cur({ a: 650, b: 0 }), [...SCORES, { date: "2026-11-02", score: 655 }], "2026-11-05");
  assert.equal(prog.totals.startTotal, 1300);
  assert.equal(prog.totals.actual, 650);
  assert.equal(prog.totals.paidOffPct, 50);
  assert.ok(Math.abs(prog.utilization.actual - (650 / 6000) * 100) < 1e-9);
  assert.equal(prog.score.latest, 655);
  assert.equal(prog.score.projected, lock.projection.points[1].score);
  assert.equal(prog.score.delta, 655 - lock.projection.points[1].score);
  // Only scores on/after lockedAt become chart dots, latest per month.
  assert.deepEqual(prog.scoreDots, [{ month: 1, score: 655, date: "2026-11-02" }]);
});

test("a card deleted after locking is flagged removed and excluded from totals", () => {
  const lock = lockFor();
  const onlyA = cur().filter((c) => c.id === "a");
  const prog = compareToLockedPlan(lock, onlyA, [], LOCKED_AT);
  const b = card(prog, "b");
  assert.equal(b.status, "removed");
  assert.equal(b.actual, null);
  assert.deepEqual(prog.removedCards, ["b"]);
  assert.equal(prog.totals.planned, 900);
  assert.equal(prog.totals.actual, 900);
  assert.equal(prog.totals.startTotal, 900);
  assert.equal(prog.verdict.status, "onTrack");
});

test("a card added after locking is counted in actuals and flagged new", () => {
  const lock = lockFor();
  const withC = [...cur(), { id: "c", name: "Discover", last4: "1111", limit: 3000, balance: 200 }];
  const prog = compareToLockedPlan(lock, withC, [], LOCKED_AT);
  assert.deepEqual(prog.newCards, [{ id: "c", name: "Discover (…1111)", actual: 200, status: "new" }]);
  assert.equal(prog.perCard.length, 2, "new card is not part of the locked per-card list");
  assert.equal(prog.totals.planned, 1300);
  assert.equal(prog.totals.actual, 1500);
  assert.equal(prog.totals.status, "behind");
  assert.equal(prog.verdict.catchUp, null, "no locked card is behind, so no catch-up card");
  assert.ok(Math.abs(prog.utilization.actual - (1500 / 9000) * 100) < 1e-9);
});

test("unchecked items from past months are missed; this month's items are current", () => {
  const lock = { ...lockFor(), done: { "pay-plan-a": true } };
  const prog = compareToLockedPlan(lock, cur(), [], "2026-11-05");
  const byId = Object.fromEntries(prog.items.map((it) => [it.id, it]));
  assert.equal(byId["pay-plan-a"].status, "past");
  assert.equal(byId["pay-plan-a"].done, true);
  assert.equal(byId["pay-m0-b"].status, "missed");
  assert.equal(byId["pay-m1-a"].status, "current");
  assert.ok(prog.items.filter((it) => it.month > 1).every((it) => it.status === "upcoming"));
  assert.deepEqual(
    prog.missed.map((it) => it.id).sort(),
    prog.items.filter((it) => it.month === 0 && !it.done).map((it) => it.id).sort(),
  );
  assert.ok(prog.missed.length >= 1);
  assert.equal(prog.currentAction.month, 1);
  assert.equal(prog.currentAction.done, false);

  // In the lock month nothing is missed yet.
  assert.equal(compareToLockedPlan(lock, cur(), [], LOCKED_AT).missed.length, 0);
});

test("locked checklist ticks survive balance changes (no fingerprint reset)", () => {
  const lock = { ...lockFor(), done: { "pay-plan-a": true, "pay-m0-b": true } };
  const before = compareToLockedPlan(lock, cur(), [], LOCKED_AT);
  const after = compareToLockedPlan(lock, cur({ a: 512.34, b: 77 }), [], LOCKED_AT);
  // The live plan's fingerprint changes with the balances (that is what resets the unlocked checklist)…
  assert.notEqual(
    buildCreditPlan(input([A, B])).fingerprint,
    buildCreditPlan(input([{ ...A, balance: 512.34 }, { ...B, balance: 77 }])).fingerprint,
  );
  // …but the locked checklist and its ticks do not.
  assert.deepEqual(after.items.map((it) => it.id), before.items.map((it) => it.id));
  assert.equal(after.items.find((it) => it.id === "pay-plan-a").done, true);
  assert.equal(after.items.find((it) => it.id === "pay-m0-b").done, true);
  assert.deepEqual(after.items.map((it) => it.vars), before.items.map((it) => it.vars), "item amounts stay frozen");
});

test("compareToLockedPlan rejects malformed locks", () => {
  assert.equal(compareToLockedPlan(null, cur(), [], LOCKED_AT), null);
  assert.equal(compareToLockedPlan({ lockedAt: "x", start: { cards: {} } }, cur(), [], LOCKED_AT), null);
  assert.equal(compareToLockedPlan({ lockedAt: LOCKED_AT }, cur(), [], LOCKED_AT), null);
});
