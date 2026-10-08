// Unit tests for parseCardPaste(text), the pure parser that lives inside the
// app.js IIFE between the `// @@parseCardPaste:start` / `// @@parseCardPaste:end`
// markers. Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSrc = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const START = "// @@parseCardPaste:start";
const END = "// @@parseCardPaste:end";
const start = appSrc.indexOf(START);
const end = appSrc.indexOf(END);
assert.ok(start !== -1 && end > start, "parseCardPaste markers not found in app.js");
const block = appSrc.slice(start + START.length, end);
const parseCardPaste = new Function(block + "; return parseCardPaste;")();

const EMPTY = { _derived: [], _unrecognized: [] };

const CHASE_FIXTURE = [
  "Prime Visa (...3410)",
  "",
  "Account Information",
  "Current balance",
  "$707.78",
  "Pending charges",
  "$130.47",
  "Available credit",
  "$2.38",
  "Total credit limit",
  "$1,000.00",
  "Next closing date",
  "Oct 16, 2026",
  "Balance on last statement",
  "$995.67 on Sep 16, 2026",
  "Remaining statement balance",
  "$530.67",
].join("\n");

test("marker block is self-contained (no closure references)", () => {
  for (const needle of ["localDateStr", "todayStr", "$(", "state.", "fmt("]) {
    assert.ok(!block.includes(needle), `block references ${needle}`);
  }
});

test("parses the exact Chase fixture", () => {
  const r = parseCardPaste(CHASE_FIXTURE);
  assert.deepEqual(r, {
    name: "Prime Visa",
    last4: "3410",
    balance: 707.78,
    pendingCharges: 130.47,
    availableCredit: 2.38,
    limit: 1000,
    nextClosingDate: "2026-10-16",
    lastStatementBalance: 995.67,
    lastStatementDate: "2026-09-16",
    remainingStatementBalance: 530.67,
    _derived: [],
    _unrecognized: ["Account Information"],
  });
  const recognized = Object.keys(r).filter((k) => !k.startsWith("_"));
  assert.equal(recognized.length, 10);
});

test("same-line label: value format", () => {
  const r = parseCardPaste(
    [
      "Current balance: $707.78",
      "Credit limit $1,000.00",
      "Minimum payment due $25.00",
      "Payment due date 11/05/2026",
      "Purchase APR 24.99%",
    ].join("\n")
  );
  assert.equal(r.balance, 707.78);
  assert.equal(r.limit, 1000);
  assert.equal(r.minimumPayment, 25);
  assert.equal(r.paymentDueDate, "2026-11-05");
  assert.equal(r.apr, 24.99);
  assert.deepEqual(r._derived, []);
  assert.deepEqual(r._unrecognized, []);
});

test("header variants", () => {
  const ending = parseCardPaste("Card ending in 3410\nCurrent balance\n$1.00");
  assert.equal(ending.last4, "3410");
  assert.equal(ending.name, undefined);

  const ellipsis = parseCardPaste("Chase Freedom (…1234)");
  assert.equal(ellipsis.name, "Chase Freedom");
  assert.equal(ellipsis.last4, "1234");

  const dots = parseCardPaste("Chase Freedom (...1234)");
  assert.equal(dots.name, "Chase Freedom");
  assert.equal(dots.last4, "1234");

  const dash = parseCardPaste("Sapphire - ****9876");
  assert.equal(dash.name, "Sapphire");
  assert.equal(dash.last4, "9876");
});

test("date formats: 'Sep. 16, 2026' and ISO", () => {
  assert.equal(
    parseCardPaste("Statement closing date\nSep. 16, 2026").nextClosingDate,
    "2026-09-16"
  );
  assert.equal(parseCardPaste("Due date 2026-11-05").paymentDueDate, "2026-11-05");
  assert.equal(parseCardPaste("Due date 11/05/26").paymentDueDate, "2026-11-05");
  assert.equal(parseCardPaste("Due date 13/05/2026").paymentDueDate, undefined);
});

test("derives limit from balance + available credit", () => {
  const r = parseCardPaste("Current balance\n$100.00\nAvailable credit\n$900.00");
  assert.equal(r.limit, 1000);
  assert.deepEqual(r._derived, ["limit"]);
});

test("label followed immediately by another label does not steal its value", () => {
  const r = parseCardPaste("Current balance\nPending charges\n$5.00");
  assert.equal(r.balance, undefined);
  assert.equal(r.pendingCharges, 5);
  assert.deepEqual(r._unrecognized, []);
});

test("empty and garbage input", () => {
  assert.deepEqual(parseCardPaste(""), EMPTY);
  const r = parseCardPaste("hello world");
  assert.deepEqual(Object.keys(r).filter((k) => !k.startsWith("_")), []);
  assert.deepEqual(r._unrecognized, ["hello world"]);
});

test("non-string input returns the empty meta object", () => {
  assert.deepEqual(parseCardPaste(null), EMPTY);
  assert.deepEqual(parseCardPaste(undefined), EMPTY);
  assert.deepEqual(parseCardPaste(42), EMPTY);
  assert.deepEqual(parseCardPaste({}), EMPTY);
});

test("blank lines and CRLF between label and value still pair", () => {
  const r = parseCardPaste("Current balance\r\n\r\n$707.78\r\n\r\nTotal credit limit\r\n\r\n$1,000.00\r\n");
  assert.equal(r.balance, 707.78);
  assert.equal(r.limit, 1000);
  assert.deepEqual(r._derived, []);
  assert.deepEqual(r._unrecognized, []);
});

test("first occurrence of a key wins", () => {
  const r = parseCardPaste("Current balance\n$10.00\nCurrent balance\n$20.00");
  assert.equal(r.balance, 10);
  assert.deepEqual(r._unrecognized, []);
});
