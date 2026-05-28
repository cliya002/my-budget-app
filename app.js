/* ============================================================
 * Pursenal — local-only budget app
 * Data persists in localStorage. Receipts as data URLs.
 * Password stored as SHA-256 hash (see README — not encryption).
 * ============================================================ */

(() => {
  "use strict";

  const KEYS = {
    pwd: "mb_password_hash",
    data: "mb_data",
    currency: "mb_currency",
  };

  const DEFAULT_PWD_HASH =
    "32ea448e581deafe4684d8bffce21c999be2b68f67440c165496b47ca0eb8f1f";

  let state = {
    income: 0,
    categories: [],
    expenses: [],
    goals: [],
  };

  let currency = "USD";
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
    renderAll();
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
    populateExpenseCategorySelect();
    renderFilterChips();
    $("#currencySelect").value = currency;
  }

  function renderDashboard() {
    const month = currentMonth();
    const monthExpenses = state.expenses.filter((e) => monthKey(e.date) === month);
    const totalSpent = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalSaved = state.goals.reduce((s, g) => s + Number(g.saved || 0), 0);
    const remaining = Number(state.income) - totalSpent;

    $("#statIncome").textContent = fmt(state.income);
    $("#statSpent").textContent = fmt(totalSpent);
    $("#statRemaining").textContent = fmt(remaining);
    $("#statSaved").textContent = fmt(totalSaved);

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
          const pct = cat.limit > 0 ? Math.min(100, (spent / cat.limit) * 100) : 0;
          let cls = "";
          if (pct >= 100) cls = "danger";
          else if (pct >= 80) cls = "warning";
          return `
            <div class="progress-item">
              <div class="progress-header">
                <span class="progress-name">${escapeHtml(cat.name)}</span>
                <span class="progress-amount">${fmt(spent)} / ${fmt(cat.limit)}</span>
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
    const catName = cat ? cat.name : "Uncategorized";
    const d = formatDateShort(exp.date);
    const receiptHtml = exp.receipt
      ? `<img src="${exp.receipt}" class="txn-receipt" data-receipt="${exp.id}" alt="Receipt" />`
      : `<div class="txn-receipt-placeholder">🧾</div>`;
    return `
      <li class="txn-item">
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
          <div class="txn-tag">Spent</div>
          <div class="txn-amount negative">- ${fmt(exp.amount)}</div>
          <div class="txn-actions">
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
  }

  function filterExpensesForInsights() {
    if (insightsPeriod === "monthly") {
      const m = currentMonth();
      return state.expenses.filter((e) => monthKey(e.date) === m);
    }
    return [...state.expenses];
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
  }
  function attachTxnDelete() { /* handled by global delegated click */ }

  function openExpenseModal() {
    $("#expDate").value = todayStr();
    $("#expenseModal").classList.add("open");
    setTimeout(() => $("#expDesc")?.focus(), 50);
  }
  function closeExpenseModal() {
    $("#expenseModal").classList.remove("open");
    $("#expenseForm").reset();
    const preview = $("#receiptPreview");
    preview.hidden = true;
    preview.innerHTML = "";
    delete preview.dataset.dataUrl;
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

    // Receipt preview
    $("#expReceipt").addEventListener("change", (e) => {
      const file = e.target.files[0];
      const preview = $("#receiptPreview");
      if (!file) {
        preview.hidden = true;
        preview.innerHTML = "";
        return;
      }
      compressImage(file).then((dataUrl) => {
        preview.innerHTML = `<img src="${dataUrl}" alt="Receipt preview" />`;
        preview.hidden = false;
        preview.dataset.dataUrl = dataUrl;
      });
    });

    // Expense form
    $("#expenseForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const desc = $("#expDesc").value.trim();
      const amount = parseFloat($("#expAmount").value);
      const date = $("#expDate").value;
      const categoryId = $("#expCategory").value;
      const receipt = $("#receiptPreview").dataset.dataUrl || null;

      if (!desc || isNaN(amount) || !date || !categoryId) return;

      state.expenses.push({ id: uid(), desc, amount, date, categoryId, receipt });
      saveData();
      closeExpenseModal();
      renderAll();
      showToast("Transaction added");
    });

    // FAB and modal close
    $("#fab").addEventListener("click", () => {
      if (!state.categories.length) {
        showToast("Add a category first in Balances");
        $$(".nav-item").forEach((b) => b.classList.remove("active"));
        $$(".page").forEach((p) => p.classList.remove("active"));
        $('[data-tab="balances"]').classList.add("active");
        $("#balances").classList.add("active");
        return;
      }
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
      a.download = `pursenal-${todayStr()}.json`;
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
            expenses: data.expenses || [],
            goals: data.goals || [],
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
        state = { income: 0, categories: [], expenses: [], goals: [] };
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
