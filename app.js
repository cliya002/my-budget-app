/* ============================================================
 * Pocket Budget App — local-only budget app
 * Data persists in localStorage. Receipts as data URLs.
 * Password stored as SHA-256 hash (see README — not encryption).
 * ============================================================ */

(() => {
  "use strict";

  const KEYS = {
    pwd: "mb_password_hash",
    data: "mb_data",
    currency: "mb_currency",
    theme: "mb_theme",
  };

  const DEFAULT_PWD_HASH =
    "32ea448e581deafe4684d8bffce21c999be2b68f67440c165496b47ca0eb8f1f";

  let state = {
    income: 0,             // legacy "monthly income" target
    categories: [],
    expenses: [],          // each: { id, type, desc, amount, date, categoryId, receipt }
    goals: [],
    presets: [],           // each: { id, type, desc, amount, categoryId }
    recurring: [],         // each: { id, type, desc, amount, categoryId, dayOfMonth, lastRunMonth, active }
    settings: {
      rollover: false,     // when true, unused budget rolls over to next month
      alertsShown: {},     // map "YYYY-MM:catId:level" -> true (already alerted)
    },
  };

  let currency = "USD";
  let theme = "light"; // 'light' | 'dark'

  // Track which transaction we are currently editing (null = adding new)
  let editingTxnId = null;
  const currencySymbols = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", AUD: "$", CAD: "$",
  };

  // Filter state for transactions
  const filters = {
    start: "",
    end: "",
    categories: new Set(),  // empty = all
    search: "",
  };

  // Period for insights
  let insightsPeriod = "monthly";

  // Chart instances (so we can destroy them before re-render)
  const charts = {};

  /* ---------- Helpers ---------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const fmt = (n) => {
    const sym = currencySymbols[currency] || "$";
    const value = Number(n) || 0;
    const formatted = value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sym}${formatted}`;
  };

  const todayStr = () => {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  };

  const monthKey = (dateStr) => (dateStr || "").slice(0, 7);
  const currentMonth = () => todayStr().slice(0, 7);

  const monthLabel = (key) => {
    if (!key) return "";
    const [y, m] = key.split("-");
    const date = new Date(Number(y), Number(m) - 1, 1);
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  };

  const formatDateShort = (dateStr) => {
    if (!dateStr) return { day: "?", mo: "" };
    const [y, m, d] = dateStr.split("-");
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    return {
      day: String(Number(d)),
      mo: dt.toLocaleDateString(undefined, { month: "short" }),
      year: y,
    };
  };

  async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function showToast(msg) {
    const toast = $("#toast");
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (toast.hidden = true), 2200);
  }

  function loadData() {
    try {
      const raw = localStorage.getItem(KEYS.data);
      if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch (e) {
      console.error("Failed to load data", e);
    }
    currency = localStorage.getItem(KEYS.currency) || "USD";

    // Apply saved theme (or auto-detect on first launch)
    theme = localStorage.getItem(KEYS.theme);
    if (!theme) {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    applyTheme(theme);

    // Migrate old transactions (no type field) — assume expense
    let migrated = false;
    state.expenses = state.expenses.map((e) => {
      if (!e.type) { migrated = true; return { ...e, type: "expense" }; }
      return e;
    });

    // Ensure presets array exists
    if (!Array.isArray(state.presets)) state.presets = [];
    if (!Array.isArray(state.recurring)) state.recurring = [];
    if (!state.settings) state.settings = { rollover: false, alertsShown: {} };
    if (!state.settings.alertsShown) state.settings.alertsShown = {};
    if (typeof state.settings.rollover !== "boolean") state.settings.rollover = false;

    // Seed default categories on first launch
    if (!state.categories.length) {
      state.categories = [
        { id: uid(), name: "Groceries", limit: 400 },
        { id: uid(), name: "Rent", limit: 1500 },
        { id: uid(), name: "Utilities", limit: 200 },
        { id: uid(), name: "Transport", limit: 150 },
        { id: uid(), name: "Eating Out", limit: 200 },
        { id: uid(), name: "Other", limit: 200 },
      ];
      migrated = true;
    }

    // Seed a few default quick-add presets on first launch
    if (!state.presets.length) {
      const findCat = (name) => state.categories.find((c) => c.name === name)?.id;
      state.presets = [
        { id: uid(), type: "expense", desc: "Coffee", amount: 5, categoryId: findCat("Eating Out") },
        { id: uid(), type: "expense", desc: "Lunch", amount: 15, categoryId: findCat("Eating Out") },
        { id: uid(), type: "expense", desc: "Gas", amount: 50, categoryId: findCat("Transport") },
        { id: uid(), type: "income", desc: "Paycheck", amount: 0, categoryId: null },
      ];
      migrated = true;
    }

    if (migrated) saveData();
  }

  /* ---------- Recurring transactions ---------- */
  function processRecurring() {
    const today = new Date();
    const thisMonth = currentMonth();
    let added = 0;

    state.recurring.forEach((r) => {
      if (!r.active) return;

      // Determine months from lastRunMonth (or month of creation) up to current month
      // We add one transaction per missed month (capped to last 12 months for safety)
      const startMonth = r.lastRunMonth || thisMonth;
      const months = monthsBetween(startMonth, thisMonth, 12);

      months.forEach((m) => {
        // Don't double-add if already run for this month
        if (r.lastRunMonth === m) return;

        // Skip future months
        if (m > thisMonth) return;

        const day = Math.min(Math.max(1, r.dayOfMonth || 1), 28);
        const dateStr = `${m}-${String(day).padStart(2, "0")}`;

        // Skip dates that are still in the future
        if (dateStr > todayStr()) return;

        state.expenses.push({
          id: uid(),
          type: r.type || "expense",
          desc: r.desc + " (recurring)",
          amount: r.amount,
          date: dateStr,
          categoryId: r.categoryId || null,
          receipt: null,
          recurringId: r.id,
        });
        r.lastRunMonth = m;
        added += 1;
      });
    });

    if (added > 0) {
      saveData();
      // Toast handled after renderAll
      setTimeout(() => showToast(`Added ${added} recurring transaction${added === 1 ? "" : "s"}`), 500);
    }
  }

  // Returns YYYY-MM list from start (exclusive) to end (inclusive).
  // If start === end, returns [start].
  function monthsBetween(start, end, max = 24) {
    const out = [];
    if (!start || !end) return [end];
    const [sy, sm] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    let y = sy, mo = sm;
    if (start === end) return [start];
    let count = 0;
    while ((y < ey || (y === ey && mo <= em)) && count < max) {
      out.push(`${y}-${String(mo).padStart(2, "0")}`);
      mo += 1;
      if (mo > 12) { mo = 1; y += 1; }
      count += 1;
    }
    // Don't include the start month itself (already processed)
    return out.filter((m) => m !== start);
  }

  function applyTheme(t) {
    theme = t;
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem(KEYS.theme, t);
  }

  function saveData() {
    localStorage.setItem(KEYS.data, JSON.stringify(state));
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ---------- Lock screen ---------- */
  async function initLock() {
    if (!localStorage.getItem(KEYS.pwd)) {
      localStorage.setItem(KEYS.pwd, DEFAULT_PWD_HASH);
    }
    const stored = localStorage.getItem(KEYS.pwd);
    const lockTitle = $("#lockTitle");
    const lockSubtitle = $("#lockSubtitle");
    const confirmInput = $("#passwordConfirm");
    const unlockBtn = $("#unlockBtn");
    const resetBtn = $("#resetBtn");

    if (!stored) {
      lockTitle.textContent = "Set Your Password";
      lockSubtitle.textContent = "Create a password to protect your data";
      confirmInput.style.display = "block";
      unlockBtn.textContent = "Set Password";
    } else {
      resetBtn.hidden = false;
    }

    $("#lockForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pwd = $("#passwordInput").value;
      const errEl = $("#lockError");
      errEl.hidden = true;

      if (!stored) {
        const confirmVal = confirmInput.value;
        if (pwd.length < 4) {
          errEl.textContent = "Password must be at least 4 characters";
          errEl.hidden = false;
          return;
        }
        if (pwd !== confirmVal) {
          errEl.textContent = "Passwords do not match";
          errEl.hidden = false;
          return;
        }
        const hash = await sha256(pwd);
        localStorage.setItem(KEYS.pwd, hash);
        unlock();
      } else {
        const hash = await sha256(pwd);
        if (hash === stored) {
          unlock();
        } else {
          errEl.textContent = "Incorrect password";
          errEl.hidden = false;
          $("#passwordInput").value = "";
        }
      }
    });

    resetBtn.addEventListener("click", () => {
      if (confirm("This will erase your data and reset the password to the preset. Continue?")) {
        localStorage.removeItem(KEYS.data);
        localStorage.setItem(KEYS.pwd, DEFAULT_PWD_HASH);
        location.reload();
      }
    });

    setTimeout(() => $("#passwordInput")?.focus(), 100);
  }

  function unlock() {
    $("#lockScreen").classList.remove("open");
    $("#app").hidden = false;
    loadData();
    processRecurring();
    renderAll();
    checkBudgetAlerts();
  }

  function lockNow() {
    $("#app").hidden = true;
    $("#lockScreen").classList.add("open");
    $("#passwordInput").value = "";
    $("#passwordConfirm").value = "";
    $("#lockError").hidden = true;
  }

  /* ---------- Navigation ---------- */
  function initNav() {
    $$(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".nav-item").forEach((b) => b.classList.remove("active"));
        $$(".page").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        $(`#${btn.dataset.tab}`).classList.add("active");
        // Close mobile sidebar
        $("#sidebar").classList.remove("open");
        $("#sidebarBackdrop").classList.remove("open");
        // Re-render charts when entering insights so canvases size correctly
        if (btn.dataset.tab === "insights") {
          setTimeout(renderInsights, 50);
        }
      });
    });

    $("#menuToggle").addEventListener("click", () => {
      $("#sidebar").classList.add("open");
      $("#sidebarBackdrop").classList.add("open");
    });
    $("#sidebarBackdrop").addEventListener("click", () => {
      $("#sidebar").classList.remove("open");
      $("#sidebarBackdrop").classList.remove("open");
    });
  }

  /* ---------- Renderers ---------- */
  function renderAll() {
    $("#monthLabel").textContent = monthLabel(currentMonth());
    renderDashboard();
    renderBalances();
    renderTransactions();
    renderInsights();
    renderPresetsManage();
    renderRecurringList();
    renderThemeButtons();
    populateExpenseCategorySelect();
    populateRecurringCategorySelect();
    renderFilterChips();
    $("#currencySelect").value = currency;
    $("#rolloverToggle").checked = !!state.settings.rollover;
  }

  function renderRecurringList() {
    const list = $("#recurringList");
    if (!list) return;
    if (!state.recurring.length) {
      list.innerHTML = '<li class="empty">No recurring transactions yet.</li>';
      return;
    }
    list.innerHTML = state.recurring
      .map((r) => {
        const cat = state.categories.find((c) => c.id === r.categoryId);
        const catName = cat ? cat.name : (r.type === "income" ? "Income" : "—");
        const typeLabel = r.type === "income" ? "💰" : "💸";
        const status = r.active ? "Active" : "Paused";
        return `
          <li class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${typeLabel} ${escapeHtml(r.desc)}</div>
              <div class="list-item-sub">${fmt(r.amount)} on day ${r.dayOfMonth} · ${escapeHtml(catName)} · ${status}</div>
            </div>
            <div class="list-item-actions">
              <button data-action="toggle-rec" data-id="${r.id}" title="${r.active ? "Pause" : "Resume"}">${r.active ? "⏸️" : "▶️"}</button>
              <button data-action="del-rec" data-id="${r.id}" title="Delete">🗑️</button>
            </div>
          </li>`;
      })
      .join("");
  }

  function populateRecurringCategorySelect() {
    const sel = $("#recCategory");
    if (!sel) return;
    sel.innerHTML =
      '<option value="">—</option>' +
      state.categories
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
  }

  function renderPresetsManage() {
    const list = $("#presetsManageList");
    if (!list) return;
    if (!state.presets.length) {
      list.innerHTML = '<li class="empty">No presets yet.</li>';
      return;
    }
    list.innerHTML = state.presets
      .map((p) => {
        const cat = state.categories.find((c) => c.id === p.categoryId);
        const catName = cat ? cat.name : (p.type === "income" ? "Income" : "—");
        const amt = Number(p.amount) > 0 ? fmt(p.amount) : "any amount";
        const typeLabel = p.type === "income" ? "💰 Income" : "💸 Expense";
        return `
          <li class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(p.desc)}</div>
              <div class="list-item-sub">${typeLabel} · ${escapeHtml(catName)} · ${amt}</div>
            </div>
            <div class="list-item-actions">
              <button data-action="del-preset" data-id="${p.id}" title="Delete">🗑️</button>
            </div>
          </li>`;
      })
      .join("");
  }

  function renderThemeButtons() {
    const stored = localStorage.getItem(KEYS.theme);
    const active = stored ? theme : "auto";
    $$(".theme-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === active);
    });
  }

  function exportCsv() {
    if (!state.expenses.length) {
      showToast("No transactions to export");
      return;
    }
    const headers = ["Date", "Type", "Description", "Category", "Amount", "Currency"];
    const rows = [...state.expenses]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        return [
          e.date,
          e.type === "income" ? "Income" : "Expense",
          e.desc,
          cat ? cat.name : "",
          (e.type === "income" ? "" : "-") + Number(e.amount).toFixed(2),
          currency,
        ];
      });
    const csv = [headers, ...rows]
      .map((row) => row.map(csvEscape).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pocket-budget-${todayStr()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const s = String(value ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  /* ---------- Rollover & alerts ---------- */
  function effectiveLimitFor(cat, month) {
    const base = Number(cat.limit) || 0;
    if (!state.settings.rollover) return base;

    // Walk back month-by-month, accumulating leftover until we hit a month
    // where this category had no transactions (treat as no rollover) or
    // until 11 months back as a safety cap.
    let extra = 0;
    let m = prevMonth(month);
    for (let i = 0; i < 11; i++) {
      const monthExp = state.expenses.filter(
        (e) => monthKey(e.date) === m && e.categoryId === cat.id && e.type !== "income"
      );
      if (!monthExp.length) break;
      const spent = monthExp.reduce((s, e) => s + Number(e.amount), 0);
      const leftover = base - spent;
      if (leftover <= 0) break;
      extra += leftover;
      m = prevMonth(m);
    }
    return base + extra;
  }

  function prevMonth(monthStr) {
    const [y, m] = monthStr.split("-").map(Number);
    if (m === 1) return `${y - 1}-12`;
    return `${y}-${String(m - 1).padStart(2, "0")}`;
  }

  function checkBudgetAlerts() {
    const month = currentMonth();
    const monthExpenses = state.expenses.filter(
      (e) => monthKey(e.date) === month && e.type !== "income"
    );
    const alertsShown = state.settings.alertsShown;
    let changed = false;

    state.categories.forEach((cat) => {
      const limit = effectiveLimitFor(cat, month);
      if (limit <= 0) return;
      const spent = monthExpenses
        .filter((e) => e.categoryId === cat.id)
        .reduce((s, e) => s + Number(e.amount), 0);
      const pct = (spent / limit) * 100;

      const key100 = `${month}:${cat.id}:100`;
      const key80 = `${month}:${cat.id}:80`;

      if (pct >= 100 && !alertsShown[key100]) {
        showAlertToast(`🚨 ${cat.name} is over budget!`, "danger");
        alertsShown[key100] = true;
        changed = true;
      } else if (pct >= 80 && pct < 100 && !alertsShown[key80]) {
        showAlertToast(`⚠️ ${cat.name} at ${Math.round(pct)}% of budget`, "warning");
        alertsShown[key80] = true;
        changed = true;
      }
    });

    if (changed) saveData();
  }

  function showAlertToast(msg, type) {
    const toast = $("#toast");
    toast.textContent = msg;
    toast.className = `toast toast-${type}`;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.hidden = true;
      toast.className = "toast";
    }, 3500);
  }

  function renderDashboard() {
    const month = currentMonth();
    const monthTxns = state.expenses.filter((e) => monthKey(e.date) === month);
    const monthExpenses = monthTxns.filter((e) => e.type !== "income");
    const monthIncomes = monthTxns.filter((e) => e.type === "income");
    const totalSpent = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalIncomeReal = monthIncomes.reduce((s, e) => s + Number(e.amount), 0);
    const totalIncome = Math.max(Number(state.income) || 0, totalIncomeReal);
    const totalSaved = state.goals.reduce((s, g) => s + Number(g.saved || 0), 0);
    const remaining = totalIncome - totalSpent;

    $("#statIncome").textContent = fmt(totalIncome);
    $("#statSpent").textContent = fmt(totalSpent);
    $("#statRemaining").textContent = fmt(remaining);
    $("#statSaved").textContent = fmt(totalSaved);

    // Hide first-use hint once any transactions exist
    const hint = $("#firstUseHint");
    if (hint) hint.hidden = state.expenses.length > 0;

    // Budget progress
    const progressEl = $("#budgetProgress");
    if (!state.categories.length) {
      progressEl.innerHTML = '<p class="empty">No budget categories yet. Add some in Balances.</p>';
    } else {
      progressEl.innerHTML = state.categories
        .map((cat) => {
          const spent = monthExpenses
            .filter((e) => e.categoryId === cat.id)
            .reduce((s, e) => s + Number(e.amount), 0);
          const effectiveLimit = effectiveLimitFor(cat, month);
          const pct = effectiveLimit > 0 ? Math.min(100, (spent / effectiveLimit) * 100) : 0;
          let cls = "";
          if (pct >= 100) cls = "danger";
          else if (pct >= 80) cls = "warning";
          const rolloverNote = state.settings.rollover && effectiveLimit !== Number(cat.limit)
            ? `<span class="rollover-tag">+${fmt(effectiveLimit - cat.limit)} rolled over</span>`
            : "";
          return `
            <div class="progress-item">
              <div class="progress-header">
                <span class="progress-name">${escapeHtml(cat.name)} ${rolloverNote}</span>
                <span class="progress-amount">${fmt(spent)} / ${fmt(effectiveLimit)}</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill ${cls}" style="width: ${pct}%"></div>
              </div>
            </div>`;
        })
        .join("");
    }

    // Recent
    const recentEl = $("#recentExpenses");
    const recent = [...state.expenses]
      .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id))
      .slice(0, 5);
    if (!recent.length) {
      recentEl.innerHTML = '<li class="empty">No expenses recorded yet.</li>';
    } else {
      recentEl.innerHTML = recent.map(renderTxnItem).join("");
      attachReceiptClicks(recentEl);
      attachTxnDelete(recentEl);
    }

    // Goals on dashboard
    const dashGoals = $("#dashGoals");
    if (!state.goals.length) {
      dashGoals.innerHTML = '<p class="empty">No savings goals yet. Add some in Balances.</p>';
    } else {
      dashGoals.innerHTML = state.goals
        .map((g) => {
          const saved = Number(g.saved) || 0;
          const target = Number(g.target) || 0;
          const pct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
          return `
          <div class="progress-item">
            <div class="progress-header">
              <span class="progress-name">${escapeHtml(g.name)}</span>
              <span class="progress-amount">${fmt(saved)} / ${fmt(target)}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill success" style="width: ${pct}%"></div>
            </div>
          </div>`;
        })
        .join("");
    }
  }

  function renderBalances() {
    $("#incomeAmount").value = state.income || "";

    const list = $("#categoryList");
    if (!state.categories.length) {
      list.innerHTML = '<li class="empty">No categories yet.</li>';
    } else {
      list.innerHTML = state.categories
        .map(
          (cat) => `
          <li class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(cat.name)}</div>
              <div class="list-item-sub">Limit: ${fmt(cat.limit)}</div>
            </div>
            <div class="list-item-actions">
              <button data-action="edit-cat" data-id="${cat.id}" title="Edit">✏️</button>
              <button data-action="del-cat" data-id="${cat.id}" title="Delete">🗑️</button>
            </div>
          </li>`
        )
        .join("");
    }

    const goalList = $("#goalList");
    if (!state.goals.length) {
      goalList.innerHTML = '<li class="empty">No savings goals yet.</li>';
    } else {
      goalList.innerHTML = state.goals
        .map((g) => {
          const saved = Number(g.saved) || 0;
          const target = Number(g.target) || 0;
          const pct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
          const dateStr = g.date ? ` · by ${g.date}` : "";
          return `
          <li class="progress-item">
            <div class="progress-header">
              <span class="progress-name">${escapeHtml(g.name)}${dateStr}</span>
              <span class="progress-amount">${fmt(saved)} / ${fmt(target)}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill success" style="width: ${pct}%"></div>
            </div>
            <div class="goal-actions">
              <input type="number" placeholder="Add to savings" step="0.01" min="0" data-goal-input="${g.id}" />
              <button class="btn-primary" data-action="add-saving" data-id="${g.id}">Add</button>
              <button class="btn-secondary" data-action="del-goal" data-id="${g.id}">Delete</button>
            </div>
          </li>`;
        })
        .join("");
    }
  }

  function renderTxnItem(exp) {
    const cat = state.categories.find((c) => c.id === exp.categoryId);
    const catName = cat ? cat.name : (exp.type === "income" ? "Income" : "Uncategorized");
    const d = formatDateShort(exp.date);
    let receiptHtml;
    if (exp.receipt && exp.receipt.startsWith("data:application/pdf")) {
      receiptHtml = `<div class="txn-receipt-placeholder" data-receipt-pdf="${exp.id}" title="Open PDF">📄</div>`;
    } else if (exp.receipt) {
      receiptHtml = `<img src="${exp.receipt}" class="txn-receipt" data-receipt="${exp.id}" alt="Receipt" />`;
    } else {
      receiptHtml = `<div class="txn-receipt-placeholder ${exp.type === "income" ? "income" : ""}">${exp.type === "income" ? "💵" : "🧾"}</div>`;
    }
    const isIncome = exp.type === "income";
    const sign = isIncome ? "+" : "-";
    const amountClass = isIncome ? "positive" : "negative";
    const tag = isIncome ? "Received" : "Spent";
    return `
      <li class="txn-item" data-txn-row="${exp.id}">
        ${receiptHtml}
        <div class="txn-date">
          <span class="day">${d.day}</span>
          <span class="mo">${d.mo}</span>
        </div>
        <div class="txn-info">
          <div class="txn-id">#${exp.id.slice(-4).toUpperCase()}</div>
          <div class="txn-name">${escapeHtml(exp.desc)}</div>
          <div class="txn-cat">${escapeHtml(catName)}</div>
        </div>
        <div class="txn-right">
          <div class="txn-tag">${tag}</div>
          <div class="txn-amount ${amountClass}">${sign} ${fmt(exp.amount)}</div>
          <div class="txn-actions">
            <button data-action="edit-exp" data-id="${exp.id}" title="Edit">✏️</button>
            <button data-action="del-exp" data-id="${exp.id}" title="Delete">🗑️</button>
          </div>
        </div>
      </li>`;
  }

  function renderTransactions() {
    let items = [...state.expenses];

    if (filters.start) items = items.filter((e) => e.date >= filters.start);
    if (filters.end) items = items.filter((e) => e.date <= filters.end);
    if (filters.categories.size > 0) {
      items = items.filter((e) => filters.categories.has(e.categoryId));
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter((e) => {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        const catName = cat ? cat.name.toLowerCase() : "";
        return (
          e.desc.toLowerCase().includes(q) ||
          catName.includes(q) ||
          String(e.amount).includes(q)
        );
      });
    }

    items.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));

    const list = $("#expenseList");
    if (!items.length) {
      list.innerHTML = '<li class="empty">No transactions match your filters.</li>';
    } else {
      list.innerHTML = items.map(renderTxnItem).join("");
      attachReceiptClicks(list);
      attachTxnDelete(list);
    }

    const range = $("#txnRange");
    if (filters.start || filters.end) {
      const from = filters.start || "earliest";
      const to = filters.end || "today";
      range.textContent = `From ${from} to ${to}`;
    } else {
      range.textContent = `${items.length} transaction${items.length === 1 ? "" : "s"}`;
    }
  }

  function renderFilterChips() {
    const chips = $("#filterChips");
    if (!state.categories.length) {
      chips.innerHTML = '<span class="empty-chip">Add categories first</span>';
      return;
    }
    chips.innerHTML = state.categories
      .map((cat) => {
        const on = filters.categories.has(cat.id);
        return `<button class="chip ${on ? "" : "off"}" data-chip="${cat.id}">${
          on ? "✓ " : ""
        }${escapeHtml(cat.name)}</button>`;
      })
      .join("");
  }

  /* ---------- Insights / Charts ---------- */
  function renderInsights() {
    if (typeof Chart === "undefined") return;

    const expenses = filterExpensesForInsights();
    renderSplitChart(expenses);
    renderDailyChart(expenses);
    renderBalanceChart(expenses);
    renderWeekdayChart(expenses);
    renderTrendChart();
  }

  function filterExpensesForInsights() {
    let exps = state.expenses.filter((e) => e.type !== "income");
    const m = currentMonth();
    if (insightsPeriod === "monthly") {
      exps = exps.filter((e) => monthKey(e.date) === m);
    } else if (insightsPeriod === "6mo") {
      const cutoff = monthOffset(m, -5);
      exps = exps.filter((e) => monthKey(e.date) >= cutoff);
    } else if (insightsPeriod === "12mo") {
      const cutoff = monthOffset(m, -11);
      exps = exps.filter((e) => monthKey(e.date) >= cutoff);
    }
    return exps;
  }

  function monthOffset(monthStr, offset) {
    const [y, m] = monthStr.split("-").map(Number);
    let nm = m + offset;
    let ny = y;
    while (nm < 1) { nm += 12; ny -= 1; }
    while (nm > 12) { nm -= 12; ny += 1; }
    return `${ny}-${String(nm).padStart(2, "0")}`;
  }

  const palette = [
    "#5b3fb8", "#ec4899", "#f59e0b", "#3b82f6",
    "#14b8a6", "#22c55e", "#ef4444", "#8b5cf6",
    "#06b6d4", "#f97316", "#84cc16", "#d946ef",
  ];

  function destroyChart(name) {
    if (charts[name]) { charts[name].destroy(); charts[name] = null; }
  }

  function showEmpty(id, show) {
    const el = $(`#${id}`);
    if (el) el.hidden = !show;
  }

  function renderSplitChart(expenses) {
    destroyChart("split");
    const ctx = $("#chartSplit");
    if (!ctx) return;

    const totals = {};
    expenses.forEach((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const name = cat ? cat.name : "Uncategorized";
      totals[name] = (totals[name] || 0) + Number(e.amount);
    });
    const labels = Object.keys(totals);
    const data = Object.values(totals);

    if (!labels.length) {
      showEmpty("splitEmpty", true);
      ctx.style.display = "none";
      return;
    }
    showEmpty("splitEmpty", false);
    ctx.style.display = "block";

    charts.split = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: labels.map((_, i) => palette[i % palette.length]),
          borderWidth: 2,
          borderColor: "#fff",
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}` },
          },
        },
      },
    });
  }

  function renderDailyChart(expenses) {
    destroyChart("daily");
    const ctx = $("#chartDaily");
    if (!ctx) return;

    if (!expenses.length) {
      showEmpty("dailyEmpty", true);
      ctx.style.display = "none";
      return;
    }
    showEmpty("dailyEmpty", false);
    ctx.style.display = "block";

    // Aggregate by day-of-month for the period
    const dayTotals = {};
    expenses.forEach((e) => {
      const day = Number((e.date || "").slice(8, 10));
      if (!day) return;
      dayTotals[day] = (dayTotals[day] || 0) + Number(e.amount);
    });

    const days = Object.keys(dayTotals).map(Number).sort((a, b) => a - b);
    const data = days.map((d) => dayTotals[d]);

    charts.daily = new Chart(ctx, {
      type: "bar",
      data: {
        labels: days,
        datasets: [{
          data,
          backgroundColor: data.map(() => "#ec4899"),
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => fmt(ctx.parsed.y) } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => fmt(v) }, grid: { color: "#eee" } },
        },
      },
    });
  }

  function renderBalanceChart(expenses) {
    destroyChart("balance");
    const ctx = $("#chartBalance");
    if (!ctx) return;

    if (!expenses.length) {
      showEmpty("balanceEmpty", true);
      ctx.style.display = "none";
      return;
    }
    showEmpty("balanceEmpty", false);
    ctx.style.display = "block";

    // Cumulative remaining balance throughout the period
    const sorted = [...expenses].sort((a, b) => a.date.localeCompare(b.date));
    let running = Number(state.income) || 0;
    const labels = [];
    const data = [];
    // Start point
    if (sorted.length) {
      labels.push(sorted[0].date.slice(8, 10) || "1");
      data.push(running);
    }
    sorted.forEach((e) => {
      running -= Number(e.amount);
      labels.push(e.date.slice(8, 10));
      data.push(running);
    });

    charts.balance = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data,
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.1)",
          tension: 0.3,
          fill: true,
          pointRadius: 2,
          pointHoverRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => fmt(ctx.parsed.y) } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => fmt(v) }, grid: { color: "#eee" } },
        },
      },
    });
  }

  function renderWeekdayChart(expenses) {
    destroyChart("weekday");
    const ctx = $("#chartWeekday");
    if (!ctx) return;

    if (!expenses.length) {
      showEmpty("weekdayEmpty", true);
      ctx.style.display = "none";
      return;
    }
    showEmpty("weekdayEmpty", false);
    ctx.style.display = "block";

    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const totals = [0, 0, 0, 0, 0, 0, 0];
    const counts = [0, 0, 0, 0, 0, 0, 0];

    expenses.forEach((e) => {
      const [y, m, d] = e.date.split("-").map(Number);
      if (!y) return;
      const dt = new Date(y, m - 1, d);
      // JS: Sunday=0 .. Saturday=6 → remap so Mon=0 .. Sun=6
      const idx = (dt.getDay() + 6) % 7;
      totals[idx] += Number(e.amount);
      counts[idx] += 1;
    });

    const avgs = totals.map((t, i) => (counts[i] ? t / counts[i] : 0));

    charts.weekday = new Chart(ctx, {
      type: "bar",
      data: {
        labels: days,
        datasets: [{
          data: avgs,
          backgroundColor: "#06b6d4",
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => fmt(ctx.parsed.y) } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => fmt(v) }, grid: { color: "#eee" } },
        },
      },
    });
  }

  /* ---------- Misc helpers ---------- */
  function renderTrendChart() {
    destroyChart("trend");
    const ctx = $("#chartTrend");
    if (!ctx) return;

    // Build last N months (based on period) of total spent
    const m = currentMonth();
    let monthsBack;
    if (insightsPeriod === "monthly") monthsBack = 6;
    else if (insightsPeriod === "6mo") monthsBack = 6;
    else if (insightsPeriod === "12mo") monthsBack = 12;
    else monthsBack = 12;

    const months = [];
    for (let i = monthsBack - 1; i >= 0; i--) months.push(monthOffset(m, -i));

    const totals = months.map((mk) =>
      state.expenses
        .filter((e) => monthKey(e.date) === mk && e.type !== "income")
        .reduce((s, e) => s + Number(e.amount), 0)
    );

    const incomes = months.map((mk) =>
      state.expenses
        .filter((e) => monthKey(e.date) === mk && e.type === "income")
        .reduce((s, e) => s + Number(e.amount), 0)
    );

    if (totals.every((t) => t === 0) && incomes.every((t) => t === 0)) {
      showEmpty("trendEmpty", true);
      ctx.style.display = "none";
      return;
    }
    showEmpty("trendEmpty", false);
    ctx.style.display = "block";

    const labels = months.map((mk) => {
      const [y, mm] = mk.split("-");
      const d = new Date(Number(y), Number(mm) - 1, 1);
      return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    });

    charts.trend = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Spent",
            data: totals,
            backgroundColor: "#ec4899",
            borderRadius: 4,
          },
          {
            label: "Income",
            data: incomes,
            backgroundColor: "#22c55e",
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", labels: { boxWidth: 12 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => fmt(v) }, grid: { color: "#eee" } },
        },
      },
    });
  }

  function populateExpenseCategorySelect() {
    const sel = $("#expCategory");
    sel.innerHTML =
      '<option value="">Select category</option>' +
      state.categories
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
  }

  function attachReceiptClicks(container) {
    container.querySelectorAll("[data-receipt]").forEach((img) => {
      img.addEventListener("click", () => {
        $("#modalImage").src = img.src;
        $("#modal").classList.add("open");
      });
    });
    container.querySelectorAll("[data-receipt-pdf]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.receiptPdf;
        const exp = state.expenses.find((x) => x.id === id);
        if (!exp || !exp.receipt) return;
        // Open the PDF data URL in a new tab
        const w = window.open();
        if (w) {
          w.document.write(
            `<iframe src="${exp.receipt}" style="width:100%;height:100vh;border:0"></iframe>`
          );
        }
      });
    });
  }
  function attachTxnDelete() { /* handled by global delegated click */ }

  let currentModalType = "expense"; // 'expense' | 'income'

  function openExpenseModal(prefill) {
    editingTxnId = prefill && prefill.id ? prefill.id : null;
    currentModalType = (prefill && prefill.type) || "expense";

    $("#expDate").value = (prefill && prefill.date) || todayStr();
    $("#expDesc").value = (prefill && prefill.desc) || "";
    $("#expAmount").value = prefill && prefill.amount ? prefill.amount : "";
    $("#expEditId").value = editingTxnId || "";

    populateExpenseCategorySelect();
    if (prefill && prefill.categoryId) {
      $("#expCategory").value = prefill.categoryId;
    }

    // Receipt prefill (only when editing)
    const preview = $("#receiptPreview");
    preview.innerHTML = "";
    preview.hidden = true;
    delete preview.dataset.dataUrl;
    if (prefill && prefill.receipt) {
      preview.dataset.dataUrl = prefill.receipt;
      if (prefill.receipt.startsWith("data:application/pdf")) {
        preview.innerHTML = `<div class="receipt-pdf">📄 Existing PDF receipt</div>`;
      } else {
        preview.innerHTML = `<img src="${prefill.receipt}" alt="Receipt" />`;
      }
      preview.hidden = false;
    }

    setModalType(currentModalType);

    $("#modalTitle").textContent = editingTxnId ? "Edit Transaction" : "Add Transaction";
    $("#submitBtn").textContent = editingTxnId ? "Save Changes" : "Add";

    // Hide presets when editing
    $("#presetsSection").hidden = !!editingTxnId;
    if (!editingTxnId) renderPresets();

    $("#expenseModal").classList.add("open");
    setTimeout(() => $("#expDesc")?.focus(), 50);
  }

  function closeExpenseModal() {
    $("#expenseModal").classList.remove("open");
    $("#expenseForm").reset();
    $("#expEditId").value = "";
    editingTxnId = null;
    const preview = $("#receiptPreview");
    preview.hidden = true;
    preview.innerHTML = "";
    delete preview.dataset.dataUrl;
  }

  function setModalType(type) {
    currentModalType = type;
    $$(".type-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
    const catSel = $("#expCategory");
    const catRow = $("#categoryRow");
    if (type === "income") {
      // Category optional for income — keep visible but not required
      catSel.required = false;
      catRow.querySelector("label").textContent = "Category (optional)";
    } else {
      catSel.required = true;
      catRow.querySelector("label").textContent = "Category";
    }
  }

  function renderPresets() {
    const list = $("#presetsList");
    const items = state.presets.filter((p) => p.type === currentModalType);
    if (!items.length) {
      list.innerHTML = '<span class="empty-chip">No presets for this type. Add one with "Save as preset" below.</span>';
      return;
    }
    list.innerHTML = items
      .map((p) => {
        const amt = Number(p.amount) > 0 ? ` ${fmt(p.amount)}` : "";
        return `<button type="button" class="preset-chip" data-preset="${p.id}">
          ${escapeHtml(p.desc)}${amt}
        </button>`;
      })
      .join("");
  }

  function applyPreset(id) {
    const p = state.presets.find((x) => x.id === id);
    if (!p) return;
    $("#expDesc").value = p.desc || "";
    if (Number(p.amount) > 0) $("#expAmount").value = p.amount;
    if (p.categoryId) $("#expCategory").value = p.categoryId;
  }

  /* ---------- Forms & actions ---------- */
  function initForms() {
    // Income
    $("#incomeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      state.income = parseFloat($("#incomeAmount").value) || 0;
      saveData();
      renderAll();
      showToast("Income updated");
    });

    // Categories
    $("#categoryForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#catName").value.trim();
      const limit = parseFloat($("#catLimit").value);
      if (!name || isNaN(limit)) return;
      state.categories.push({ id: uid(), name, limit });
      saveData();
      $("#catName").value = "";
      $("#catLimit").value = "";
      renderAll();
      showToast("Category added");
    });

    // Receipt preview — three input sources
    function handleReceiptInput(e) {
      const file = e.target.files[0];
      const preview = $("#receiptPreview");
      if (!file) {
        preview.hidden = true;
        preview.innerHTML = "";
        return;
      }
      // PDFs: store the data URL but show a placeholder
      if (file.type === "application/pdf") {
        const reader = new FileReader();
        reader.onload = (ev) => {
          preview.innerHTML = `<div class="receipt-pdf">📄 ${escapeHtml(file.name)}</div>`;
          preview.hidden = false;
          preview.dataset.dataUrl = ev.target.result;
        };
        reader.readAsDataURL(file);
        return;
      }
      compressImage(file)
        .then((dataUrl) => {
          preview.innerHTML = `<img src="${dataUrl}" alt="Receipt preview" />`;
          preview.hidden = false;
          preview.dataset.dataUrl = dataUrl;
        })
        .catch((err) => {
          console.error(err);
          showToast("Could not read this file");
        });
      // Reset input value so selecting the same file again still triggers change
      e.target.value = "";
    }

    $("#expReceiptCamera").addEventListener("change", handleReceiptInput);
    $("#expReceiptGallery").addEventListener("change", handleReceiptInput);
    $("#expReceiptFile").addEventListener("change", handleReceiptInput);

    $("#btnTakePhoto").addEventListener("click", () => $("#expReceiptCamera").click());
    $("#btnChooseImage").addEventListener("click", () => $("#expReceiptGallery").click());
    $("#btnUploadFile").addEventListener("click", () => $("#expReceiptFile").click());

    // Expense form
    $("#expenseForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const desc = $("#expDesc").value.trim();
      const amount = parseFloat($("#expAmount").value);
      const date = $("#expDate").value;
      const categoryId = $("#expCategory").value;
      const receipt = $("#receiptPreview").dataset.dataUrl || null;
      const editId = $("#expEditId").value;
      const type = currentModalType;

      if (!desc || isNaN(amount) || !date) return;
      if (type === "expense" && !categoryId) return;

      if (editId) {
        const idx = state.expenses.findIndex((x) => x.id === editId);
        if (idx >= 0) {
          state.expenses[idx] = {
            ...state.expenses[idx],
            type, desc, amount, date,
            categoryId: categoryId || null,
            receipt,
          };
        }
      } else {
        state.expenses.push({
          id: uid(), type, desc, amount, date,
          categoryId: categoryId || null,
          receipt,
        });
      }
      saveData();
      closeExpenseModal();
      renderAll();
      checkBudgetAlerts();
      showToast(editId ? "Transaction updated" : (type === "income" ? "Income added" : "Transaction added"));
    });

    // Type toggle (expense/income)
    $$(".type-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setModalType(btn.dataset.type);
        renderPresets();
      });
    });

    // Preset chips inside modal
    $("#presetsList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preset]");
      if (!btn) return;
      applyPreset(btn.dataset.preset);
    });

    // Save current form as preset
    $("#savePresetBtn").addEventListener("click", () => {
      const desc = $("#expDesc").value.trim();
      const amount = parseFloat($("#expAmount").value);
      const categoryId = $("#expCategory").value || null;
      if (!desc) {
        showToast("Add a description first");
        return;
      }
      state.presets.push({
        id: uid(),
        type: currentModalType,
        desc,
        amount: isNaN(amount) ? 0 : amount,
        categoryId,
      });
      saveData();
      renderPresets();
      renderPresetsManage();
      showToast("Preset saved");
    });

    // Theme toggle in settings
    $$(".theme-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = btn.dataset.theme;
        if (t === "auto") {
          const sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
          applyTheme(sysDark ? "dark" : "light");
          localStorage.removeItem(KEYS.theme);
        } else {
          applyTheme(t);
        }
        renderThemeButtons();
      });
    });

    // CSV export
    $("#exportCsvBtn").addEventListener("click", exportCsv);

    // FAB and modal close
    $("#fab").addEventListener("click", () => {
      openExpenseModal();
    });
    $("#addTxnBtn").addEventListener("click", () => {
      openExpenseModal();
    });
    $("#expenseModalClose").addEventListener("click", closeExpenseModal);
    $("#expenseModal").addEventListener("click", (e) => {
      if (e.target.id === "expenseModal") closeExpenseModal();
    });

    // Goals
    $("#goalForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#goalName").value.trim();
      const target = parseFloat($("#goalTarget").value);
      const date = $("#goalDate").value;
      if (!name || isNaN(target)) return;
      state.goals.push({ id: uid(), name, target, saved: 0, date });
      saveData();
      e.target.reset();
      renderAll();
      showToast("Goal added");
    });

    // Recurring transactions form
    $("#recurringForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const desc = $("#recDesc").value.trim();
      const amount = parseFloat($("#recAmount").value);
      const dayOfMonth = parseInt($("#recDay").value, 10);
      const type = $("#recType").value;
      const categoryId = $("#recCategory").value || null;
      if (!desc || isNaN(amount) || isNaN(dayOfMonth)) return;
      if (dayOfMonth < 1 || dayOfMonth > 28) {
        showToast("Day must be between 1 and 28");
        return;
      }
      state.recurring.push({
        id: uid(),
        type,
        desc,
        amount,
        categoryId,
        dayOfMonth,
        active: true,
        lastRunMonth: null,
      });
      saveData();
      processRecurring(); // Catch up immediately for any prior months
      e.target.reset();
      renderAll();
      showToast("Recurring transaction added");
    });

    // Rollover toggle
    $("#rolloverToggle").addEventListener("change", (e) => {
      state.settings.rollover = !!e.target.checked;
      saveData();
      renderDashboard();
      showToast(state.settings.rollover ? "Rollover enabled" : "Rollover disabled");
    });

    // Filters
    $("#filterStart").addEventListener("change", (e) => {
      filters.start = e.target.value;
      renderTransactions();
    });
    $("#filterEnd").addEventListener("change", (e) => {
      filters.end = e.target.value;
      renderTransactions();
    });
    $("#txnSearch").addEventListener("input", (e) => {
      filters.search = e.target.value.trim();
      renderTransactions();
    });
    $("#clearFilters").addEventListener("click", () => {
      filters.start = "";
      filters.end = "";
      filters.categories.clear();
      filters.search = "";
      $("#filterStart").value = "";
      $("#filterEnd").value = "";
      $("#txnSearch").value = "";
      renderFilterChips();
      renderTransactions();
    });

    // Insights period selector
    $$(".period-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".period-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        insightsPeriod = btn.dataset.period;
        renderInsights();
      });
    });

    // Delegated clicks
    document.addEventListener("click", (e) => {
      // Filter chips
      const chip = e.target.closest("[data-chip]");
      if (chip) {
        const id = chip.dataset.chip;
        if (filters.categories.has(id)) filters.categories.delete(id);
        else filters.categories.add(id);
        renderFilterChips();
        renderTransactions();
        return;
      }

      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === "del-cat") {
        if (confirm("Delete this category? Transactions will show 'Uncategorized'.")) {
          state.categories = state.categories.filter((c) => c.id !== id);
          filters.categories.delete(id);
          saveData();
          renderAll();
        }
      } else if (action === "edit-cat") {
        const cat = state.categories.find((c) => c.id === id);
        if (!cat) return;
        const newName = prompt("Category name:", cat.name);
        if (newName === null) return;
        const newLimit = prompt("Monthly limit:", cat.limit);
        if (newLimit === null) return;
        cat.name = newName.trim() || cat.name;
        const lim = parseFloat(newLimit);
        if (!isNaN(lim)) cat.limit = lim;
        saveData();
        renderAll();
      } else if (action === "del-exp") {
        if (confirm("Delete this transaction?")) {
          state.expenses = state.expenses.filter((x) => x.id !== id);
          saveData();
          renderAll();
        }
      } else if (action === "edit-exp") {
        const exp = state.expenses.find((x) => x.id === id);
        if (exp) openExpenseModal(exp);
      } else if (action === "del-preset") {
        if (confirm("Delete this preset?")) {
          state.presets = state.presets.filter((p) => p.id !== id);
          saveData();
          renderPresetsManage();
        }
      } else if (action === "toggle-rec") {
        const r = state.recurring.find((x) => x.id === id);
        if (r) {
          r.active = !r.active;
          saveData();
          renderRecurringList();
          showToast(r.active ? "Recurring resumed" : "Recurring paused");
        }
      } else if (action === "del-rec") {
        if (confirm("Delete this recurring transaction? Existing transactions stay.")) {
          state.recurring = state.recurring.filter((x) => x.id !== id);
          saveData();
          renderRecurringList();
        }
      } else if (action === "del-goal") {
        if (confirm("Delete this goal?")) {
          state.goals = state.goals.filter((g) => g.id !== id);
          saveData();
          renderAll();
        }
      } else if (action === "add-saving") {
        const input = document.querySelector(`[data-goal-input="${id}"]`);
        const amt = parseFloat(input.value);
        if (isNaN(amt) || amt <= 0) return;
        const goal = state.goals.find((g) => g.id === id);
        if (!goal) return;
        goal.saved = (Number(goal.saved) || 0) + amt;
        saveData();
        renderAll();
        showToast("Savings updated");
      }
    });

    // Lock buttons
    $("#lockNowBtn").addEventListener("click", lockNow);
    $("#lockNowBtnDesktop").addEventListener("click", lockNow);

    // Currency
    $("#currencySelect").addEventListener("change", (e) => {
      currency = e.target.value;
      localStorage.setItem(KEYS.currency, currency);
      renderAll();
    });

    // Change password
    $("#changePasswordBtn").addEventListener("click", async () => {
      const oldPwd = prompt("Enter current password:");
      if (oldPwd === null) return;
      const oldHash = await sha256(oldPwd);
      if (oldHash !== localStorage.getItem(KEYS.pwd)) {
        alert("Incorrect current password.");
        return;
      }
      const newPwd = prompt("New password (min 4 characters):");
      if (newPwd === null) return;
      if (newPwd.length < 4) { alert("Password too short."); return; }
      const confirmPwd = prompt("Confirm new password:");
      if (newPwd !== confirmPwd) { alert("Passwords do not match."); return; }
      localStorage.setItem(KEYS.pwd, await sha256(newPwd));
      showToast("Password changed");
    });

    // Export
    $("#exportBtn").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pocket-budget-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Import
    $("#importBtn").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!confirm("This will replace all current data. Continue?")) return;
          state = {
            income: data.income || 0,
            categories: data.categories || [],
            expenses: (data.expenses || []).map((e) => ({ ...e, type: e.type || "expense" })),
            goals: data.goals || [],
            presets: data.presets || [],
            recurring: data.recurring || [],
            settings: data.settings || { rollover: false, alertsShown: {} },
          };
          saveData();
          renderAll();
          showToast("Data imported");
        } catch (err) {
          alert("Invalid JSON file.");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });

    // Clear all
    $("#clearAllBtn").addEventListener("click", () => {
      if (confirm("Delete ALL budget data? This cannot be undone.")) {
        state = {
          income: 0,
          categories: [],
          expenses: [],
          goals: [],
          presets: [],
          recurring: [],
          settings: { rollover: false, alertsShown: {} },
        };
        saveData();
        renderAll();
        showToast("All data cleared");
      }
    });

    // Receipt modal close
    $("#modalClose").addEventListener("click", () => $("#modal").classList.remove("open"));
    $("#modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") $("#modal").classList.remove("open");
    });
  }

  /* ---------- Image compression ---------- */
  function compressImage(file, maxDim = 1200, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const ratio = Math.min(maxDim / width, maxDim / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /* ---------- Init ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    initLock();
    initNav();
    initForms();
  });
})();
