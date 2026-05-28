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
    dataEnc: "mb_data_enc",      // AES-GCM encrypted blob (preferred)
    salt: "mb_salt",              // PBKDF2 salt
    currency: "mb_currency",
    theme: "mb_theme",
    autoLock: "mb_auto_lock",     // minutes; 0 = disabled
  };

  const DEFAULT_PWD_HASH =
    "32ea448e581deafe4684d8bffce21c999be2b68f67440c165496b47ca0eb8f1f";

  let state = {
    income: 0,             // legacy default if no per-month value set
    monthlyIncome: {},     // map: "YYYY-MM" -> amount (per-month target)
    categories: [],
    expenses: [],          // each: { id, type, desc, amount, date, categoryId, accountId, personId, tags, receipt }
    goals: [],
    presets: [],
    recurring: [],
    cards: [],
    creditScores: [],
    accounts: [],
    people: [],            // each: { id, name, relation, color, notes }
    settings: {
      rollover: false,
      alertsShown: {},
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
    people: new Set(),       // empty = all (only people-marked txns when non-empty)
    search: "",
    sort: "date-desc",      // 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc'
    groupByDay: true,
  };

  // Bulk-select & undo state
  const selectedTxns = new Set();
  let lastDeleted = null;     // { items: [...txns], at: timestamp }
  let lastDeletedTimer = null;

  // Subscription detector — dismissed during this session
  const dismissedSubs = new Set();

  // Period for insights
  let insightsPeriod = "monthly";

  // Period for family tab
  let familyPeriod = "monthly"; // 'monthly' | 'ytd' | 'all'

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

  /* ---------- AES-GCM encryption ---------- */
  let cryptoKey = null; // CryptoKey derived from password (held in memory only)

  function getOrCreateSalt() {
    let salt = localStorage.getItem(KEYS.salt);
    if (!salt) {
      const arr = crypto.getRandomValues(new Uint8Array(16));
      salt = btoa(String.fromCharCode(...arr));
      localStorage.setItem(KEYS.salt, salt);
    }
    const bin = atob(salt);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(password) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: getOrCreateSalt(),
        iterations: 200000,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptState(stateObj) {
    if (!cryptoKey) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(stateObj));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, data);
    const ctArr = new Uint8Array(ct);
    // Pack iv + ciphertext into base64
    const combined = new Uint8Array(iv.length + ctArr.length);
    combined.set(iv, 0);
    combined.set(ctArr, iv.length);
    let bin = "";
    combined.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  async function decryptState(b64) {
    if (!cryptoKey) return null;
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const iv = arr.slice(0, 12);
    const ct = arr.slice(12);
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) {
      console.error("Decryption failed", e);
      return null;
    }
  }

  function showToast(msg) {
    const toast = $("#toast");
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (toast.hidden = true), 2200);
  }

  async function loadData() {
    let loaded = null;

    // Prefer encrypted blob if available and we have the key
    const encBlob = localStorage.getItem(KEYS.dataEnc);
    if (encBlob && cryptoKey) {
      loaded = await decryptState(encBlob);
    }

    // Fallback: legacy plaintext (will be migrated to encrypted on next save)
    if (!loaded) {
      try {
        const raw = localStorage.getItem(KEYS.data);
        if (raw) loaded = JSON.parse(raw);
      } catch (e) {
        console.error("Failed to load data", e);
      }
    }

    if (loaded) state = { ...state, ...loaded };

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
    if (!Array.isArray(state.cards)) state.cards = [];
    if (!Array.isArray(state.creditScores)) state.creditScores = [];
    if (!Array.isArray(state.accounts)) state.accounts = [];
    if (!Array.isArray(state.people)) state.people = [];
    if (!state.monthlyIncome || typeof state.monthlyIncome !== "object") {
      state.monthlyIncome = {};
      // Migrate legacy income to current month
      if (Number(state.income) > 0) {
        state.monthlyIncome[currentMonth()] = Number(state.income);
        migrated = true;
      }
    }

    // Seed default accounts on first launch
    if (!state.accounts.length) {
      state.accounts = [
        { id: uid(), name: "Cash", type: "cash", balance: 0, color: "#22c55e" },
        { id: uid(), name: "Checking", type: "checking", balance: 0, color: "#3b82f6" },
        { id: uid(), name: "Credit Card", type: "credit", balance: 0, color: "#ec4899" },
        { id: uid(), name: "Savings", type: "savings", balance: 0, color: "#f59e0b" },
      ];
      migrated = true;
    }

    // Ensure each transaction has tags array (migrate old data)
    state.expenses = state.expenses.map((e) => {
      if (!Array.isArray(e.tags)) { migrated = true; return { ...e, tags: [] }; }
      return e;
    });
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

    // Seed quick-add presets on first launch with built-in library
    if (!state.presets.length) {
      state.presets = buildDefaultPresets();
      migrated = true;
    }

    // Migrate older presets to have group/icon/favorite fields
    state.presets = state.presets.map((p) => {
      let changed = false;
      const out = { ...p };
      if (!out.group) {
        out.group = out.type === "income" ? "income" : "daily";
        changed = true;
      }
      if (!out.icon) { out.icon = out.type === "income" ? "💵" : "💸"; changed = true; }
      if (typeof out.favorite !== "boolean") { out.favorite = false; changed = true; }
      if (changed) migrated = true;
      return out;
    });

    if (migrated) saveData();
  }

  /* ---------- Default preset library ---------- */
  function buildDefaultPresets() {
    const findCat = (name) => state.categories.find((c) => c.name === name)?.id;
    return [
      // Daily expenses
      { id: uid(), type: "expense", desc: "Coffee", amount: 5, categoryId: findCat("Eating Out"), icon: "☕", group: "daily", favorite: true },
      { id: uid(), type: "expense", desc: "Lunch", amount: 15, categoryId: findCat("Eating Out"), icon: "🥗", group: "daily", favorite: true },
      { id: uid(), type: "expense", desc: "Dinner Out", amount: 35, categoryId: findCat("Eating Out"), icon: "🍽️", group: "daily" },
      { id: uid(), type: "expense", desc: "Groceries", amount: 75, categoryId: findCat("Groceries"), icon: "🛒", group: "daily", favorite: true },
      { id: uid(), type: "expense", desc: "Gas", amount: 50, categoryId: findCat("Transport"), icon: "⛽", group: "daily", favorite: true },
      { id: uid(), type: "expense", desc: "Uber/Lyft", amount: 18, categoryId: findCat("Transport"), icon: "🚗", group: "daily" },
      { id: uid(), type: "expense", desc: "Public transit", amount: 5, categoryId: findCat("Transport"), icon: "🚇", group: "daily" },
      { id: uid(), type: "expense", desc: "Snacks", amount: 8, categoryId: findCat("Eating Out"), icon: "🍿", group: "daily" },

      // Subscriptions
      { id: uid(), type: "expense", desc: "Netflix", amount: 15.49, categoryId: findCat("Other"), icon: "🎬", group: "subscription" },
      { id: uid(), type: "expense", desc: "Spotify", amount: 11.99, categoryId: findCat("Other"), icon: "🎵", group: "subscription" },
      { id: uid(), type: "expense", desc: "Amazon Prime", amount: 14.99, categoryId: findCat("Other"), icon: "📦", group: "subscription" },
      { id: uid(), type: "expense", desc: "Disney+", amount: 13.99, categoryId: findCat("Other"), icon: "✨", group: "subscription" },
      { id: uid(), type: "expense", desc: "YouTube Premium", amount: 13.99, categoryId: findCat("Other"), icon: "▶️", group: "subscription" },
      { id: uid(), type: "expense", desc: "Apple iCloud", amount: 2.99, categoryId: findCat("Other"), icon: "☁️", group: "subscription" },
      { id: uid(), type: "expense", desc: "Gym", amount: 30, categoryId: findCat("Other"), icon: "💪", group: "subscription" },
      { id: uid(), type: "expense", desc: "Phone bill", amount: 75, categoryId: findCat("Utilities"), icon: "📱", group: "subscription" },
      { id: uid(), type: "expense", desc: "Internet", amount: 60, categoryId: findCat("Utilities"), icon: "📡", group: "subscription" },
      { id: uid(), type: "expense", desc: "Electric bill", amount: 120, categoryId: findCat("Utilities"), icon: "💡", group: "subscription" },
      { id: uid(), type: "expense", desc: "Water bill", amount: 40, categoryId: findCat("Utilities"), icon: "💧", group: "subscription" },
      { id: uid(), type: "expense", desc: "Rent", amount: 1500, categoryId: findCat("Rent"), icon: "🏠", group: "subscription" },

      // Income
      { id: uid(), type: "income", desc: "Paycheck", amount: 0, categoryId: null, icon: "💼", group: "income", favorite: true },
      { id: uid(), type: "income", desc: "Side gig", amount: 0, categoryId: null, icon: "💻", group: "income" },
      { id: uid(), type: "income", desc: "Refund", amount: 0, categoryId: null, icon: "↩️", group: "income" },
      { id: uid(), type: "income", desc: "Gift received", amount: 0, categoryId: null, icon: "🎁", group: "income" },
      { id: uid(), type: "income", desc: "Cashback", amount: 0, categoryId: null, icon: "💸", group: "income" },
    ];
  }

  /* ---------- Save (encrypted when available, plaintext as fallback) ---------- */
  function saveData() {
    if (cryptoKey) {
      // Encrypt asynchronously and write to localStorage; remove plaintext on success
      encryptState(state).then((b64) => {
        if (b64) {
          localStorage.setItem(KEYS.dataEnc, b64);
          // Once encrypted blob exists, drop plaintext
          localStorage.removeItem(KEYS.data);
        }
      }).catch((e) => {
        console.error("Encrypt save failed, writing plaintext", e);
        localStorage.setItem(KEYS.data, JSON.stringify(state));
      });
    } else {
      localStorage.setItem(KEYS.data, JSON.stringify(state));
    }
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
        await unlock(pwd);
      } else {
        const hash = await sha256(pwd);
        if (hash === stored) {
          await unlock(pwd);
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
        localStorage.removeItem(KEYS.dataEnc);
        localStorage.removeItem(KEYS.salt);
        localStorage.setItem(KEYS.pwd, DEFAULT_PWD_HASH);
        location.reload();
      }
    });

    setTimeout(() => $("#passwordInput")?.focus(), 100);
  }

  async function unlock(password) {
    $("#lockScreen").classList.remove("open");
    $("#app").hidden = false;
    if (password) {
      try {
        cryptoKey = await deriveKey(password);
      } catch (e) {
        console.error("Key derivation failed", e);
        cryptoKey = null;
      }
    }
    await loadData();
    processRecurring();
    renderAll();
    checkBudgetAlerts();
    startAutoLock();
  }

  function lockNow() {
    cryptoKey = null;
    stopAutoLock();
    $("#app").hidden = true;
    $("#lockScreen").classList.add("open");
    $("#passwordInput").value = "";
    $("#passwordConfirm").value = "";
    $("#lockError").hidden = true;
  }

  /* ---------- Auto-lock ---------- */
  let autoLockTimer = null;
  let autoLockMinutes = 10;

  function startAutoLock() {
    autoLockMinutes = parseInt(localStorage.getItem(KEYS.autoLock) || "10", 10);
    resetAutoLockTimer();
    ["click", "keydown", "mousemove", "touchstart"].forEach((ev) =>
      document.addEventListener(ev, resetAutoLockTimer, { passive: true })
    );
  }

  function stopAutoLock() {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }

  function resetAutoLockTimer() {
    if (!autoLockMinutes || autoLockMinutes <= 0) return;
    clearTimeout(autoLockTimer);
    autoLockTimer = setTimeout(() => {
      lockNow();
      showToast("Auto-locked");
    }, autoLockMinutes * 60 * 1000);
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
        if (btn.dataset.tab === "credit") {
          setTimeout(renderCreditTrend, 50);
        }
        if (btn.dataset.tab === "family") {
          setTimeout(renderFamilyTrend, 50);
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
    renderCredit();
    renderFamily();
    renderPresetsManage();
    renderRecurringList();
    renderAccountList();
    renderDashAccounts();
    renderThemeButtons();
    populateExpenseCategorySelect();
    populateAccountSelect("#expAccount", true);
    populatePersonSelect();
    populateRecurringCategorySelect();
    renderFilterChips();
    renderPersonFilterChips();
    $("#currencySelect").value = currency;
    $("#rolloverToggle").checked = !!state.settings.rollover;
  }

  function renderRecurringList() {
    const list = $("#recurringList");
    if (!list) return;
    if (!state.recurring.length) {
      list.innerHTML = '<li class="empty">No recurring transactions yet.</li>';
    } else {
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

    // Subscription suggestions
    renderSubscriptionSuggestions();
  }

  /* ---------- Accounts ---------- */
  function accountBalance(accId) {
    const acc = state.accounts.find((a) => a.id === accId);
    if (!acc) return 0;
    const starting = Number(acc.balance) || 0;
    const txns = state.expenses.filter((e) => e.accountId === accId);
    const delta = txns.reduce((s, t) => {
      if (t.type === "income") return s + Number(t.amount);
      if (t.type === "transfer-out") return s - Number(t.amount);
      if (t.type === "transfer-in") return s + Number(t.amount);
      return s - Number(t.amount); // expense
    }, 0);
    return starting + delta;
  }

  function netWorth() {
    return state.accounts.reduce((s, a) => s + accountBalance(a.id), 0);
  }

  /* ---------- Per-month income helpers ---------- */
  function incomeForMonth(monthKeyStr) {
    const explicit = state.monthlyIncome ? state.monthlyIncome[monthKeyStr] : undefined;
    if (typeof explicit === "number" && !isNaN(explicit)) return explicit;
    return Number(state.income) || 0; // fallback default
  }

  function setIncomeForMonth(monthKeyStr, amount) {
    if (!state.monthlyIncome) state.monthlyIncome = {};
    state.monthlyIncome[monthKeyStr] = Number(amount) || 0;
  }

  function renderMonthIncomeList() {
    const list = $("#monthIncomeList");
    if (!list) return;
    const entries = Object.entries(state.monthlyIncome || {})
      .filter(([_, v]) => Number(v) > 0)
      .sort(([a], [b]) => b.localeCompare(a)); // newest first
    if (!entries.length) {
      list.innerHTML = '<li class="empty">No monthly overrides yet. Default will be used.</li>';
      return;
    }
    list.innerHTML = entries
      .map(([m, amount]) => {
        return `
          <li class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${monthLabel(m)}</div>
              <div class="list-item-sub">Target: ${fmt(amount)}</div>
            </div>
            <div class="list-item-actions">
              <button data-action="edit-month-income" data-month="${m}" title="Edit">✏️</button>
              <button data-action="del-month-income" data-month="${m}" title="Delete">🗑️</button>
            </div>
          </li>`;
      })
      .join("");
  }

  function renderAccountList() {
    const list = $("#accountList");
    if (!list) return;
    if (!state.accounts.length) {
      list.innerHTML = '<li class="empty">No accounts yet.</li>';
      return;
    }
    list.innerHTML = state.accounts
      .map((a) => {
        const bal = accountBalance(a.id);
        const balClass = bal < 0 ? "negative" : "";
        return `
          <li class="list-item account-item" style="border-left: 4px solid ${a.color || "#5b3fb8"}">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(a.name)}</div>
              <div class="list-item-sub">${escapeHtml(a.type)}</div>
            </div>
            <div class="list-item-amount ${balClass}">${fmt(bal)}</div>
            <div class="list-item-actions">
              <button data-action="edit-acc" data-id="${a.id}" title="Edit">✏️</button>
              <button data-action="del-acc" data-id="${a.id}" title="Delete">🗑️</button>
            </div>
          </li>`;
      })
      .join("");
  }

  function renderDashAccounts() {
    const el = $("#dashAccounts");
    if (!el) return;
    if (!state.accounts.length) {
      el.innerHTML = '<p class="empty">No accounts yet.</p>';
      return;
    }
    const total = netWorth();
    let html = `
      <div class="account-net">
        <span class="account-net-label">Net Worth</span>
        <span class="account-net-value ${total < 0 ? "negative" : ""}">${fmt(total)}</span>
      </div>
      <div class="account-grid">
    `;
    state.accounts.forEach((a) => {
      const bal = accountBalance(a.id);
      html += `
        <div class="account-pill" style="border-left: 4px solid ${a.color || "#5b3fb8"}">
          <div class="account-pill-name">${escapeHtml(a.name)}</div>
          <div class="account-pill-bal ${bal < 0 ? "negative" : ""}">${fmt(bal)}</div>
        </div>`;
    });
    html += "</div>";
    el.innerHTML = html;
  }

  function populateAccountSelect(selectId, includeBlank) {
    const sel = $(selectId);
    if (!sel) return;
    const options = state.accounts.map(
      (a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`
    ).join("");
    sel.innerHTML = (includeBlank ? '<option value="">Select account</option>' : "") + options;
  }

  function openTransferModal() {
    if (state.accounts.length < 2) {
      showToast("Add at least 2 accounts to transfer");
      return;
    }
    populateAccountSelect("#transferFrom", false);
    populateAccountSelect("#transferTo", false);
    $("#transferDate").value = todayStr();
    $("#transferAmount").value = "";
    $("#transferNote").value = "";
    const fromSel = $("#transferFrom");
    const toSel = $("#transferTo");
    if (fromSel.options.length >= 2) {
      fromSel.value = state.accounts[0].id;
      toSel.value = state.accounts[1].id;
    }
    $("#transferModal").classList.add("open");
  }
  function closeTransferModal() {
    $("#transferModal").classList.remove("open");
  }

  /* ---------- Subscription detector ---------- */
  function detectSubscriptions() {
    // Group expenses by description (lowercased) and look for same amounts repeating monthly
    const byDesc = new Map();
    state.expenses.forEach((e) => {
      if (e.type === "income") return;
      if (e.recurringId) return; // already linked to a recurring
      const key = e.desc.toLowerCase().trim();
      if (!key) return;
      if (dismissedSubs.has(key)) return;
      if (!byDesc.has(key)) byDesc.set(key, []);
      byDesc.get(key).push(e);
    });

    const suggestions = [];
    byDesc.forEach((items, desc) => {
      if (items.length < 2) return;
      // Group by amount (rounded to cents) — find amounts that appear 2+ times across different months
      const byAmount = new Map();
      items.forEach((it) => {
        const amt = Number(it.amount).toFixed(2);
        if (!byAmount.has(amt)) byAmount.set(amt, new Set());
        byAmount.get(amt).add(monthKey(it.date));
      });
      byAmount.forEach((months, amt) => {
        if (months.size < 2) return;
        // Looks like a recurring charge
        const sample = items.find((i) => Number(i.amount).toFixed(2) === amt);
        suggestions.push({
          desc: sample.desc,
          amount: Number(amt),
          monthsSeen: months.size,
          categoryId: sample.categoryId,
          dayOfMonth: Number(sample.date.slice(8, 10)) || 1,
        });
      });
    });

    // Skip ones that already match an existing recurring
    return suggestions.filter((s) => {
      return !state.recurring.some(
        (r) =>
          r.desc.toLowerCase() === s.desc.toLowerCase() &&
          Math.abs(Number(r.amount) - Number(s.amount)) < 0.01
      );
    });
  }

  function renderSubscriptionSuggestions() {
    const el = $("#subscriptionSuggestions");
    if (!el) return;
    const suggestions = detectSubscriptions();
    if (!suggestions.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <div class="sub-title">💡 Possible subscriptions detected (${suggestions.length})</div>
      <div class="sub-sub">These charges appear monthly. Convert any to recurring?</div>
      ${suggestions.map((s, i) => {
        const cat = state.categories.find((c) => c.id === s.categoryId);
        const catName = cat ? cat.name : "Uncategorized";
        return `
          <div class="sub-item">
            <div class="sub-info">
              <div class="sub-name">${escapeHtml(s.desc)}</div>
              <div class="sub-detail">${fmt(s.amount)} · seen ${s.monthsSeen} months · ${escapeHtml(catName)}</div>
            </div>
            <div class="sub-actions">
              <button class="btn-primary" data-action="convert-sub" data-idx="${i}">Convert</button>
              <button class="btn-secondary" data-action="dismiss-sub" data-idx="${i}">Dismiss</button>
            </div>
          </div>`;
      }).join("")}
    `;
    // Stash for handlers
    el.dataset.suggestionsJson = JSON.stringify(suggestions);
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
        const groupLabel = p.group === "subscription" ? "📺 Subscription"
          : p.group === "daily" ? "☕ Daily"
          : p.group === "income" ? "💼 Income"
          : "Custom";
        const star = p.favorite ? "⭐" : "☆";
        const recurringBtn = p.type === "expense" && p.group === "subscription"
          ? `<button data-action="preset-recurring" data-id="${p.id}" title="Make recurring">🔁</button>`
          : "";
        return `
          <li class="list-item">
            <span class="preset-icon-mini">${p.icon || "💸"}</span>
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(p.desc)}</div>
              <div class="list-item-sub">${typeLabel} · ${groupLabel} · ${escapeHtml(catName)} · ${amt}</div>
            </div>
            <div class="list-item-actions">
              <button data-action="preset-fav" data-id="${p.id}" title="Toggle favorite">${star}</button>
              ${recurringBtn}
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
    const headers = ["Date", "Type", "Description", "Category", "Person", "Amount", "Currency"];
    const rows = [...state.expenses]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((e) => {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        const person = e.personId ? state.people.find((p) => p.id === e.personId) : null;
        return [
          e.date,
          e.type === "income" ? "Income" : "Expense",
          e.desc,
          cat ? cat.name : "",
          person ? person.name : "",
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

  /* ---------- Bulk select & undo ---------- */
  function updateBulkBar() {
    const bar = $("#bulkBar");
    if (!bar) return;
    if (selectedTxns.size === 0) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    $("#bulkCount").textContent = `${selectedTxns.size} selected`;
  }

  function showUndoToast(items) {
    if (!items || !items.length) return;
    lastDeleted = { items, at: Date.now() };
    const toast = $("#toast");
    const word = items.length === 1 ? "Transaction" : `${items.length} transactions`;
    toast.innerHTML = `${word} deleted <button id="undoBtn" class="toast-action">Undo</button>`;
    toast.className = "toast toast-undo";
    toast.hidden = false;
    clearTimeout(lastDeletedTimer);
    clearTimeout(showToast._t);

    const undoBtn = $("#undoBtn");
    if (undoBtn) {
      undoBtn.addEventListener("click", () => {
        if (!lastDeleted) return;
        state.expenses.push(...lastDeleted.items);
        lastDeleted = null;
        saveData();
        renderAll();
        toast.hidden = true;
        toast.className = "toast";
      });
    }

    lastDeletedTimer = setTimeout(() => {
      toast.hidden = true;
      toast.className = "toast";
      lastDeleted = null;
    }, 6000);
  }

  /* ---------- Auto-suggest category ---------- */
  function suggestCategory(desc) {
    const q = String(desc || "").toLowerCase().trim();
    if (q.length < 2) return null;
    // Find past transactions whose description starts with or contains the query
    const matches = state.expenses
      .filter((e) => e.categoryId && e.desc && e.desc.toLowerCase().includes(q));
    if (!matches.length) return null;
    // Pick the most-used category among matches
    const counts = {};
    matches.forEach((m) => { counts[m.categoryId] = (counts[m.categoryId] || 0) + 1; });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  }

  function suggestPerson(desc) {
    const q = String(desc || "").toLowerCase().trim();
    if (q.length < 2) return null;
    const matches = state.expenses
      .filter((e) => e.personId && e.desc && e.desc.toLowerCase().includes(q));
    if (!matches.length) return null;
    const counts = {};
    matches.forEach((m) => { counts[m.personId] = (counts[m.personId] || 0) + 1; });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  }

  function renderDashboard() {
    const month = currentMonth();
    const monthTxns = state.expenses.filter((e) => monthKey(e.date) === month);
    const monthExpenses = monthTxns.filter(
      (e) => e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    const monthIncomes = monthTxns.filter((e) => e.type === "income");
    const totalSpent = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalIncomeReal = monthIncomes.reduce((s, e) => s + Number(e.amount), 0);
    const targetIncome = incomeForMonth(month);
    const totalIncome = Math.max(targetIncome, totalIncomeReal);
    const totalSaved = state.goals.reduce((s, g) => s + Number(g.saved || 0), 0);
    const remaining = totalIncome - totalSpent;

    $("#statIncome").textContent = fmt(totalIncome);
    $("#statSpent").textContent = fmt(totalSpent);
    $("#statRemaining").textContent = fmt(remaining);
    $("#statSaved").textContent = fmt(totalSaved);

    // Family — money sent to people this month
    const totalFamily = monthExpenses
      .filter((e) => e.personId)
      .reduce((s, e) => s + Number(e.amount), 0);
    $("#statFamily").textContent = fmt(totalFamily);

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
    renderMonthIncomeList();

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
    const isTransferIn = exp.type === "transfer-in";
    const isTransferOut = exp.type === "transfer-out";
    let sign, amountClass, tag;
    if (isIncome) { sign = "+"; amountClass = "positive"; tag = "Received"; }
    else if (isTransferIn) { sign = "+"; amountClass = "positive"; tag = "Transfer in"; }
    else if (isTransferOut) { sign = "-"; amountClass = "negative"; tag = "Transfer out"; }
    else { sign = "-"; amountClass = "negative"; tag = "Spent"; }
    const isSelected = selectedTxns.has(exp.id);
    const tagsHtml = (exp.tags && exp.tags.length)
      ? `<div class="txn-tags">${exp.tags.map((t) => `<span class="txn-tag-chip">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
    const person = exp.personId ? state.people.find((p) => p.id === exp.personId) : null;
    const personHtml = person
      ? `<div class="txn-person" style="color: ${person.color || "var(--primary)"}">→ ${escapeHtml(person.name)}</div>`
      : "";
    return `
      <li class="txn-item ${isSelected ? "selected" : ""}" data-txn-row="${exp.id}">
        <input type="checkbox" class="txn-check" data-action="select-txn" data-id="${exp.id}" ${isSelected ? "checked" : ""} aria-label="Select transaction" />
        ${receiptHtml}
        <div class="txn-date">
          <span class="day">${d.day}</span>
          <span class="mo">${d.mo}</span>
        </div>
        <div class="txn-info">
          <div class="txn-id">#${exp.id.slice(-4).toUpperCase()}</div>
          <div class="txn-name">${escapeHtml(exp.desc)}</div>
          <div class="txn-cat">${escapeHtml(catName)}</div>
          ${personHtml}
          ${tagsHtml}
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
    if (filters.people.size > 0) {
      items = items.filter((e) => e.personId && filters.people.has(e.personId));
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter((e) => {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        const catName = cat ? cat.name.toLowerCase() : "";
        const tagsStr = (e.tags || []).join(" ").toLowerCase();
        const person = e.personId ? state.people.find((p) => p.id === e.personId) : null;
        const personName = person ? person.name.toLowerCase() : "";
        return (
          e.desc.toLowerCase().includes(q) ||
          catName.includes(q) ||
          tagsStr.includes(q) ||
          personName.includes(q) ||
          String(e.amount).includes(q)
        );
      });
    }

    // Sort
    items.sort((a, b) => {
      switch (filters.sort) {
        case "date-asc": return (a.date + a.id).localeCompare(b.date + b.id);
        case "amount-desc": return Number(b.amount) - Number(a.amount);
        case "amount-asc": return Number(a.amount) - Number(b.amount);
        case "date-desc":
        default: return (b.date + b.id).localeCompare(a.date + a.id);
      }
    });

    const list = $("#expenseList");
    if (!items.length) {
      list.innerHTML = '<li class="empty">No transactions match your filters.</li>';
    } else if (filters.groupByDay && (filters.sort === "date-desc" || filters.sort === "date-asc")) {
      list.innerHTML = renderGroupedTxns(items);
      attachReceiptClicks(list);
    } else {
      list.innerHTML = items.map(renderTxnItem).join("");
      attachReceiptClicks(list);
    }

    const range = $("#txnRange");
    if (filters.start || filters.end) {
      const from = filters.start || "earliest";
      const to = filters.end || "today";
      range.textContent = `From ${from} to ${to}`;
    } else {
      range.textContent = `${items.length} transaction${items.length === 1 ? "" : "s"}`;
    }

    updateBulkBar();
  }

  function renderGroupedTxns(items) {
    const groups = new Map();
    items.forEach((it) => {
      if (!groups.has(it.date)) groups.set(it.date, []);
      groups.get(it.date).push(it);
    });
    let html = "";
    for (const [date, list] of groups) {
      const total = list.reduce(
        (sum, t) => sum + (t.type === "income" ? Number(t.amount) : -Number(t.amount)),
        0
      );
      const totalStr = total >= 0 ? `+${fmt(total)}` : `-${fmt(Math.abs(total))}`;
      const totalCls = total >= 0 ? "positive" : "negative";
      html += `
        <li class="txn-day-header">
          <span>${formatLongDate(date)}</span>
          <span class="${totalCls}">${totalStr}</span>
        </li>`;
      html += list.map(renderTxnItem).join("");
    }
    return html;
  }

  function formatLongDate(dateStr) {
    if (!dateStr) return "";
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const today = todayStr();
    if (dateStr === today) return "Today";
    // Yesterday
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    const yestStr = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`;
    if (dateStr === yestStr) return "Yesterday";
    return dt.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: dt.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    });
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

  function renderPersonFilterChips() {
    const chips = $("#filterPeopleChips");
    if (!chips) return;
    if (!state.people.length) {
      chips.innerHTML = '<span class="empty-chip">Add people in Family tab</span>';
      return;
    }
    chips.innerHTML = state.people
      .map((p) => {
        const on = filters.people.has(p.id);
        const bgStyle = on
          ? `background:${p.color || "var(--primary)"}`
          : "";
        return `<button class="chip ${on ? "" : "off"}" style="${bgStyle}" data-person-chip="${p.id}">${
          on ? "✓ " : ""
        }${escapeHtml(p.name)}</button>`;
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
    let exps = state.expenses.filter(
      (e) => e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
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

  /* ---------- Credit tracker ---------- */
  function renderCredit() {
    renderCreditStats();
    renderCardList();
    renderScoreList();
    renderCreditTrend();
    renderCreditTips();
    renderPayoffEmpty();
  }

  function renderPayoffEmpty() {
    const eligible = state.cards.filter((c) => Number(c.balance) > 0);
    $("#payoffEmpty").hidden = eligible.length > 0;
  }

  function calculatePayoff() {
    const monthly = parseFloat($("#payoffMonthly").value);
    const strategy = $("#payoffStrategy").value;
    const cards = state.cards
      .filter((c) => Number(c.balance) > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        balance: Number(c.balance),
        apr: Number(c.apr) || 22.99, // assume 22.99% if missing
      }));

    if (!cards.length) {
      $("#payoffResults").hidden = true;
      showToast("Add cards with balances first");
      return;
    }
    if (!monthly || monthly <= 0) {
      showToast("Enter a monthly payment");
      return;
    }

    // Minimum payment estimate: 2% of balance, min $25 per card
    const minPerCard = (bal) => Math.min(bal, Math.max(25, bal * 0.02));
    const totalMin = cards.reduce((s, c) => s + minPerCard(c.balance), 0);

    if (monthly < totalMin) {
      $("#payoffResults").innerHTML = `
        <div class="payoff-warning">
          ⚠️ Your monthly payment (${fmt(monthly)}) is less than the estimated minimum across all cards (${fmt(totalMin)}).
          Increase the payment to start paying down principal.
        </div>`;
      $("#payoffResults").hidden = false;
      return;
    }

    // Sort by strategy
    if (strategy === "snowball") {
      cards.sort((a, b) => a.balance - b.balance);
    } else {
      cards.sort((a, b) => b.apr - a.apr);
    }

    // Simulate month by month, max 600 months (50 years) safety
    let month = 0;
    let totalInterest = 0;
    const payoffOrder = [];
    const working = cards.map((c) => ({ ...c, paidOff: false, monthPaid: null, interestPaid: 0 }));

    while (working.some((c) => c.balance > 0.01) && month < 600) {
      month += 1;

      // Apply interest first
      working.forEach((c) => {
        if (c.balance > 0) {
          const monthlyRate = c.apr / 100 / 12;
          const interest = c.balance * monthlyRate;
          c.interestPaid += interest;
          c.balance += interest;
          totalInterest += interest;
        }
      });

      // Pay minimums on all cards
      let leftover = monthly;
      working.forEach((c) => {
        if (c.balance <= 0) return;
        const min = Math.min(c.balance, minPerCard(c.balance));
        c.balance -= min;
        leftover -= min;
      });

      // Apply leftover to highest-priority unpaid card
      const target = working.find((c) => c.balance > 0);
      if (target && leftover > 0) {
        const pay = Math.min(leftover, target.balance);
        target.balance -= pay;
        leftover -= pay;
      }

      // Cascade any remaining leftover (target was paid off)
      while (leftover > 0.01) {
        const next = working.find((c) => c.balance > 0);
        if (!next) break;
        const pay = Math.min(leftover, next.balance);
        next.balance -= pay;
        leftover -= pay;
      }

      // Check newly paid-off cards
      working.forEach((c) => {
        if (c.balance <= 0.01 && !c.paidOff) {
          c.paidOff = true;
          c.monthPaid = month;
          payoffOrder.push(c);
        }
      });
    }

    // Render results
    const totalPaid = monthly * month;
    const totalStartBal = cards.reduce((s, c) => s + c.balance, 0);
    let html = `
      <div class="payoff-summary">
        <div class="payoff-stat">
          <div class="payoff-stat-label">Time to debt-free</div>
          <div class="payoff-stat-value">${formatMonths(month)}</div>
        </div>
        <div class="payoff-stat">
          <div class="payoff-stat-label">Total interest</div>
          <div class="payoff-stat-value negative">${fmt(totalInterest)}</div>
        </div>
        <div class="payoff-stat">
          <div class="payoff-stat-label">Total paid</div>
          <div class="payoff-stat-value">${fmt(totalPaid)}</div>
        </div>
      </div>
      <div class="payoff-order-title">Payoff order</div>
      <ol class="payoff-order">
    `;

    payoffOrder.forEach((c, i) => {
      const monthsToPayoff = c.monthPaid;
      html += `
        <li class="payoff-item">
          <span class="payoff-rank">#${i + 1}</span>
          <div class="payoff-info">
            <div class="payoff-name">${escapeHtml(c.name)}</div>
            <div class="payoff-detail">${fmt(c.interestPaid)} interest · ${formatMonths(monthsToPayoff)} to pay off</div>
          </div>
          <span class="payoff-when">Month ${monthsToPayoff}</span>
        </li>`;
    });
    html += "</ol>";

    // Compare with the other strategy briefly
    const compareStrategy = strategy === "avalanche" ? "snowball" : "avalanche";
    const compare = simulateQuick(monthly, compareStrategy);
    if (compare && compare.month > 0) {
      const interestDiff = compare.totalInterest - totalInterest;
      const monthDiff = compare.month - month;
      let comparison = "";
      if (Math.abs(interestDiff) > 1 || Math.abs(monthDiff) > 0) {
        const better = interestDiff > 0 || monthDiff > 0;
        const word = better ? "saves" : "costs more by";
        comparison = `
          <div class="payoff-compare">
            💡 vs <strong>${compareStrategy}</strong>: ${strategy} ${word}
            ${Math.abs(interestDiff).toFixed(0) > 0 ? `${fmt(Math.abs(interestDiff))} in interest` : ""}
            ${Math.abs(monthDiff) > 0 ? ` and ${Math.abs(monthDiff)} month${Math.abs(monthDiff) === 1 ? "" : "s"}` : ""}
          </div>`;
      }
      html += comparison;
    }

    $("#payoffResults").innerHTML = html;
    $("#payoffResults").hidden = false;
  }

  function simulateQuick(monthly, strategy) {
    const cards = state.cards
      .filter((c) => Number(c.balance) > 0)
      .map((c) => ({ balance: Number(c.balance), apr: Number(c.apr) || 22.99 }));
    if (!cards.length || monthly <= 0) return null;

    if (strategy === "snowball") cards.sort((a, b) => a.balance - b.balance);
    else cards.sort((a, b) => b.apr - a.apr);

    const minPerCard = (bal) => Math.min(bal, Math.max(25, bal * 0.02));
    let month = 0;
    let totalInterest = 0;
    while (cards.some((c) => c.balance > 0.01) && month < 600) {
      month += 1;
      cards.forEach((c) => {
        if (c.balance > 0) {
          const i = c.balance * (c.apr / 100 / 12);
          c.balance += i;
          totalInterest += i;
        }
      });
      let leftover = monthly;
      cards.forEach((c) => {
        if (c.balance <= 0) return;
        const min = Math.min(c.balance, minPerCard(c.balance));
        c.balance -= min;
        leftover -= min;
      });
      while (leftover > 0.01) {
        const next = cards.find((c) => c.balance > 0);
        if (!next) break;
        const pay = Math.min(leftover, next.balance);
        next.balance -= pay;
        leftover -= pay;
      }
    }
    return { month, totalInterest };
  }

  function formatMonths(m) {
    if (m <= 0) return "—";
    if (m < 12) return `${m} month${m === 1 ? "" : "s"}`;
    const years = Math.floor(m / 12);
    const remMonths = m % 12;
    if (remMonths === 0) return `${years} year${years === 1 ? "" : "s"}`;
    return `${years}y ${remMonths}m`;
  }

  function totalCardLimit() {
    return state.cards.reduce((s, c) => s + (Number(c.limit) || 0), 0);
  }
  function totalCardBalance() {
    return state.cards.reduce((s, c) => s + (Number(c.balance) || 0), 0);
  }
  function utilizationPct() {
    const lim = totalCardLimit();
    if (lim <= 0) return 0;
    return (totalCardBalance() / lim) * 100;
  }
  function latestScore() {
    if (!state.creditScores.length) return null;
    return [...state.creditScores].sort((a, b) =>
      b.date.localeCompare(a.date)
    )[0];
  }
  function previousScore() {
    if (state.creditScores.length < 2) return null;
    const sorted = [...state.creditScores].sort((a, b) => b.date.localeCompare(a.date));
    return sorted[1];
  }

  function renderCreditStats() {
    const cur = latestScore();
    const prev = previousScore();

    // Gauge
    const score = cur ? Number(cur.score) : 0;
    const arc = $("#gaugeArc");
    const num = $("#gaugeNumber");
    const band = $("#gaugeBand");
    if (arc && num && band) {
      const total = 251; // half circle path length
      const pct = score ? (score - 300) / (850 - 300) : 0;
      const filled = Math.max(0, Math.min(1, pct)) * total;
      arc.setAttribute("stroke-dasharray", `${filled} ${total - filled}`);
      num.textContent = score || "—";
      band.textContent = score ? scoreBand(score) : "No score yet";
    }

    // Next tier
    const tierEl = $("#nextTier");
    if (cur) {
      const tiers = [
        { min: 580, name: "Fair" },
        { min: 670, name: "Good" },
        { min: 740, name: "Very Good" },
        { min: 800, name: "Exceptional" },
      ];
      const next = tiers.find((t) => t.min > Number(cur.score));
      if (next) {
        const diff = next.min - Number(cur.score);
        tierEl.innerHTML = `<strong>${diff}</strong> points to <strong>${next.name}</strong> (${next.min}+)`;
      } else {
        tierEl.innerHTML = "🏆 You've reached the top tier";
      }
    } else {
      tierEl.textContent = "";
    }

    // Side stats
    const util = utilizationPct();
    $("#creditUtil").textContent = `${util.toFixed(0)}%`;
    const utilHint = $("#creditUtilHint");
    if (util === 0 && totalCardLimit() === 0) {
      utilHint.textContent = "Add a card to track";
    } else if (util < 10) {
      utilHint.innerHTML = '<span class="positive">Excellent</span>';
    } else if (util < 30) {
      utilHint.innerHTML = '<span class="positive">Good</span>';
    } else if (util < 50) {
      utilHint.innerHTML = '<span style="color:var(--warning)">Watch out</span>';
    } else {
      utilHint.innerHTML = '<span class="negative">Hurting your score</span>';
    }

    $("#creditLimit").textContent = fmt(totalCardLimit());
    $("#creditBalance").textContent = fmt(totalCardBalance());
    $("#creditCardCount").textContent = state.cards.length;

    // Average individual utilization
    if (state.cards.length) {
      const utils = state.cards
        .filter((c) => Number(c.limit) > 0)
        .map((c) => (Number(c.balance) / Number(c.limit)) * 100);
      const avg = utils.reduce((a, b) => a + b, 0) / (utils.length || 1);
      $("#creditAvgUtil").textContent = `Avg ${avg.toFixed(0)}% per card`;
    } else {
      $("#creditAvgUtil").textContent = "";
    }

    // Pill in header
    const pill = $("#creditScorePill");
    if (cur) {
      const change = prev ? cur.score - prev.score : 0;
      const arrow = change > 0 ? " ↑" : change < 0 ? " ↓" : "";
      pill.textContent = `${cur.score}${arrow} ${cur.type || ""}`.trim();
    } else {
      pill.textContent = "No score yet";
    }

    // Bureau breakdown
    renderBureauBreakdown();

    // FICO factors
    renderFactors();

    // Simulator (re-init with current state)
    initSimulator();
  }

  function renderBureauBreakdown() {
    const bureaus = ["Equifax", "Experian", "TransUnion"];
    bureaus.forEach((b) => {
      const latest = [...state.creditScores]
        .filter((s) => s.bureau === b)
        .sort((a, b2) => b2.date.localeCompare(a.date))[0];
      const valEl = document.querySelector(`[data-bureau="${b}"]`);
      const dateEl = document.querySelector(`[data-bureau-date="${b}"]`);
      if (!valEl) return;
      if (latest) {
        valEl.textContent = latest.score;
        valEl.className = "bureau-score";
        if (Number(latest.score) >= 740) valEl.classList.add("high");
        else if (Number(latest.score) >= 670) valEl.classList.add("good");
        else valEl.classList.add("low");
        if (dateEl) dateEl.textContent = latest.date;
      } else {
        valEl.textContent = "—";
        valEl.className = "bureau-score";
        if (dateEl) dateEl.textContent = "Not logged";
      }
    });
  }

  function renderFactors() {
    // Payment history — based on autopay rate + missed-payment heuristic (no data, so judge by autopay)
    const totalCards = state.cards.length;
    const autopayCards = state.cards.filter((c) => c.autopay).length;
    const paymentEl = $("#factorPayment");
    if (totalCards === 0) {
      paymentEl.textContent = "Add cards";
      paymentEl.className = "factor-status";
    } else if (autopayCards === totalCards) {
      paymentEl.textContent = "Excellent";
      paymentEl.className = "factor-status excellent";
    } else if (autopayCards > 0) {
      paymentEl.textContent = `${autopayCards}/${totalCards} on autopay`;
      paymentEl.className = "factor-status good";
    } else {
      paymentEl.textContent = "Risky";
      paymentEl.className = "factor-status fair";
    }

    // Utilization
    const util = utilizationPct();
    const utilEl = $("#factorUtil");
    if (totalCards === 0) {
      utilEl.textContent = "Add cards";
      utilEl.className = "factor-status";
    } else if (util < 10) {
      utilEl.textContent = "Excellent";
      utilEl.className = "factor-status excellent";
    } else if (util < 30) {
      utilEl.textContent = "Good";
      utilEl.className = "factor-status good";
    } else if (util < 50) {
      utilEl.textContent = "Fair";
      utilEl.className = "factor-status fair";
    } else {
      utilEl.textContent = "Poor";
      utilEl.className = "factor-status poor";
    }

    // Length of history (avg account age)
    const lenEl = $("#factorLength");
    const opened = state.cards.filter((c) => c.opened);
    if (!opened.length) {
      lenEl.textContent = "Add open dates";
      lenEl.className = "factor-status";
    } else {
      const now = Date.now();
      const ages = opened.map((c) => (now - new Date(c.opened).getTime()) / (365 * 24 * 60 * 60 * 1000));
      const avg = ages.reduce((a, b) => a + b, 0) / ages.length;
      lenEl.textContent = `${avg.toFixed(1)} yr avg`;
      lenEl.className = "factor-status";
      if (avg >= 7) lenEl.classList.add("excellent");
      else if (avg >= 3) lenEl.classList.add("good");
      else lenEl.classList.add("fair");
    }

    // Credit mix
    const mixEl = $("#factorMix");
    const types = new Set(state.cards.map((c) => c.cardType || "credit"));
    if (totalCards === 0) {
      mixEl.textContent = "Add cards";
      mixEl.className = "factor-status";
    } else if (types.size >= 3) {
      mixEl.textContent = "Diverse";
      mixEl.className = "factor-status excellent";
    } else if (types.size === 2) {
      mixEl.textContent = "Good";
      mixEl.className = "factor-status good";
    } else {
      mixEl.textContent = "Single type";
      mixEl.className = "factor-status fair";
    }

    // New credit — based on opened dates within 12 months
    const newEl = $("#factorNew");
    const recentOpens = state.cards.filter((c) => {
      if (!c.opened) return false;
      const months = (Date.now() - new Date(c.opened).getTime()) / (30.44 * 24 * 60 * 60 * 1000);
      return months <= 12;
    }).length;
    if (totalCards === 0) {
      newEl.textContent = "Add cards";
      newEl.className = "factor-status";
    } else if (recentOpens === 0) {
      newEl.textContent = "Stable";
      newEl.className = "factor-status excellent";
    } else if (recentOpens === 1) {
      newEl.textContent = "1 recent";
      newEl.className = "factor-status good";
    } else {
      newEl.textContent = `${recentOpens} recent`;
      newEl.className = "factor-status fair";
    }
  }

  function initSimulator() {
    const slider = $("#simSlider");
    const totalBal = totalCardBalance();
    if (!slider) return;
    slider.max = Math.max(1, Math.round(totalBal));
    slider.value = 0;
    runSimulator(0);
    slider.oninput = (e) => runSimulator(Number(e.target.value));
  }

  function runSimulator(payDown) {
    const lim = totalCardLimit();
    const bal = totalCardBalance();
    const newBal = Math.max(0, bal - payDown);
    const newUtil = lim > 0 ? (newBal / lim) * 100 : 0;
    const oldUtil = utilizationPct();

    $("#simAmountLabel").textContent = fmt(payDown);
    $("#simUtil").textContent = `${newUtil.toFixed(0)}%`;

    // Rough heuristic: utilization is ~30% of FICO. Going from >30% → <10% can yield ~30-50 pts.
    // Use a simple linear estimate based on utilization brackets.
    let estChange = 0;
    if (oldUtil >= 50 && newUtil < 30) estChange = 40;
    else if (oldUtil >= 30 && newUtil < 10) estChange = 30;
    else if (oldUtil >= 30 && newUtil < 30) estChange = 15;
    else if (oldUtil >= 10 && newUtil < 10) estChange = 10;
    else if (newUtil < oldUtil) estChange = Math.round((oldUtil - newUtil) / 3);

    const el = $("#simScoreChange");
    if (estChange > 0) {
      el.textContent = `+${estChange} pts`;
      el.className = "positive";
    } else {
      el.textContent = "+0";
      el.className = "";
    }
  }

  function renderCardList() {
    const list = $("#cardList");
    if (!state.cards.length) {
      list.innerHTML = '<li class="empty">No cards yet. Tap <strong>+ Add Card</strong>.</li>';
      return;
    }
    list.innerHTML = state.cards
      .map((c) => {
        const lim = Number(c.limit) || 0;
        const bal = Number(c.balance) || 0;
        const stmt = Number(c.statement) || 0;
        const util = lim > 0 ? (bal / lim) * 100 : 0;
        const stmtUtil = lim > 0 && stmt > 0 ? (stmt / lim) * 100 : 0;
        let cls = "success";
        if (util >= 50) cls = "danger";
        else if (util >= 30) cls = "warning";
        const last4 = c.last4 ? ` · ••${escapeHtml(c.last4)}` : "";
        const issuer = c.issuer ? `${escapeHtml(c.issuer)} · ` : "";
        const due = c.dueDay ? `Due day ${c.dueDay}` : "No due date";
        const apr = c.apr ? ` · ${c.apr}% APR` : "";
        const autopay = c.autopay ? '<span class="rollover-tag">Autopay</span>' : "";
        let stmtAlert = "";
        if (stmtUtil >= 30) {
          const cls2 = stmtUtil >= 50 ? "alert-danger" : "alert-warning";
          stmtAlert = `<div class="stmt-alert ${cls2}">⚠️ Statement balance is ${stmtUtil.toFixed(0)}% — this is what gets reported. Pay before statement closes.</div>`;
        }
        return `
          <li class="card-item">
            <div class="card-item-head">
              <div class="card-item-title">${escapeHtml(c.name)}${last4} ${autopay}</div>
              <div class="list-item-actions">
                <button data-action="edit-card" data-id="${c.id}" title="Edit">✏️</button>
                <button data-action="del-card" data-id="${c.id}" title="Delete">🗑️</button>
              </div>
            </div>
            <div class="card-item-sub">${issuer}${due}${apr}</div>
            <div class="card-item-bal">
              <span>${fmt(bal)} of ${fmt(lim)}${stmt > 0 ? ` · stmt ${fmt(stmt)}` : ""}</span>
              <span class="${util >= 30 ? (util >= 50 ? "negative" : "") : "positive"}">${util.toFixed(0)}% util</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill ${cls}" style="width: ${Math.min(util, 100)}%"></div>
            </div>
            ${stmtAlert}
          </li>`;
      })
      .join("");
  }

  function renderScoreList() {
    const list = $("#scoreList");
    if (!state.creditScores.length) {
      list.innerHTML = '<li class="empty">No score entries yet.</li>';
      return;
    }
    const sorted = [...state.creditScores].sort((a, b) => b.date.localeCompare(a.date));
    list.innerHTML = sorted
      .map((s) => {
        const note = s.note ? ` · ${escapeHtml(s.note)}` : "";
        return `
          <li class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${s.score} <span class="score-band">${scoreBand(s.score)}</span></div>
              <div class="list-item-sub">${s.date} · ${escapeHtml(s.source || "")} ${escapeHtml(s.type || "")}${note}</div>
            </div>
            <div class="list-item-actions">
              <button data-action="del-score" data-id="${s.id}" title="Delete">🗑️</button>
            </div>
          </li>`;
      })
      .join("");
  }

  function scoreBand(s) {
    const n = Number(s);
    if (n >= 800) return "Exceptional";
    if (n >= 740) return "Very Good";
    if (n >= 670) return "Good";
    if (n >= 580) return "Fair";
    return "Poor";
  }

  function renderCreditTrend() {
    if (typeof Chart === "undefined") return;
    destroyChart("creditTrend");
    const ctx = $("#chartCreditTrend");
    if (!ctx) return;

    if (state.creditScores.length < 1) {
      $("#creditTrendEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#creditTrendEmpty").hidden = true;
    ctx.style.display = "block";

    const sorted = [...state.creditScores].sort((a, b) => a.date.localeCompare(b.date));
    const labels = sorted.map((s) => s.date);
    const data = sorted.map((s) => s.score);

    charts.creditTrend = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Score",
          data,
          borderColor: "#5b3fb8",
          backgroundColor: "rgba(91, 63, 184, 0.1)",
          tension: 0.3,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: {
            min: 300,
            max: 850,
            grid: { color: "rgba(0,0,0,0.05)" },
            ticks: { stepSize: 50 },
          },
        },
      },
    });
  }

  function renderCreditTips() {
    const tips = [];
    const util = utilizationPct();
    const cur = latestScore();
    const totalCards = state.cards.length;

    if (totalCards === 0) {
      tips.push({ icon: "💳", text: "Add your credit cards to see personalized tips." });
    }
    if (util >= 30 && totalCards > 0) {
      tips.push({
        icon: "⚠️",
        text: `Total utilization is ${util.toFixed(0)}%. Aim for under 30% — ideally under 10% — to boost your score. Pay down balances or request a credit limit increase.`,
      });
    } else if (util > 0 && util < 10 && totalCards > 0) {
      tips.push({ icon: "✅", text: "Utilization is excellent (under 10%). Keep it there." });
    }
    state.cards.forEach((c) => {
      const lim = Number(c.limit) || 0;
      const bal = Number(c.balance) || 0;
      if (lim > 0 && bal / lim >= 0.5) {
        tips.push({
          icon: "🚨",
          text: `${c.name} is at ${((bal / lim) * 100).toFixed(0)}% utilization. Pay down before the statement closes for best impact.`,
        });
      }
      if (!c.autopay && c.dueDay) {
        tips.push({
          icon: "🔔",
          text: `Set up autopay for ${c.name} so you never miss a payment — payment history is 35% of your FICO score.`,
        });
      }
    });

    if (state.creditScores.length >= 2) {
      const sorted = [...state.creditScores].sort((a, b) => a.date.localeCompare(b.date));
      const oldest = sorted[0];
      const newest = sorted[sorted.length - 1];
      const diff = newest.score - oldest.score;
      if (diff > 0) {
        tips.push({ icon: "📈", text: `Your score is up ${diff} points since you started tracking. Nice work.` });
      } else if (diff < 0) {
        tips.push({ icon: "📉", text: `Your score is down ${Math.abs(diff)} points. Check for late payments, increased balances, or new hard inquiries.` });
      }
    }

    if (cur && cur.score >= 740) {
      tips.push({ icon: "🏆", text: "You're in the Very Good range. You'll qualify for the best rates on most loans." });
    }
    if (cur && cur.score < 670 && cur.score >= 580) {
      tips.push({ icon: "🎯", text: "Focus areas: pay every bill on time, keep balances low, and avoid opening new accounts unless necessary." });
    }

    if (!tips.length) {
      tips.push({ icon: "💡", text: "Log a credit score to start getting personalized tips." });
    }

    const list = $("#creditTips");
    list.innerHTML = tips
      .map((t) => `<li class="tip-item"><span class="tip-icon">${t.icon}</span><span>${escapeHtml(t.text)}</span></li>`)
      .join("");
  }

  function openCardModal(card) {
    const isEdit = !!card;
    $("#cardModalTitle").textContent = isEdit ? "Edit Card" : "Add Credit Card";
    $("#cardEditId").value = isEdit ? card.id : "";
    $("#cardName").value = isEdit ? card.name : "";
    $("#cardIssuer").value = isEdit ? (card.issuer || "") : "";
    $("#cardLast4").value = isEdit ? (card.last4 || "") : "";
    $("#cardLimit").value = isEdit ? card.limit : "";
    $("#cardBalance").value = isEdit ? card.balance : "";
    $("#cardStatement").value = isEdit ? (card.statement || "") : "";
    $("#cardApr").value = isEdit ? (card.apr || "") : "";
    $("#cardDueDay").value = isEdit ? (card.dueDay || "") : "";
    $("#cardOpened").value = isEdit ? (card.opened || "") : "";
    $("#cardType").value = isEdit ? (card.cardType || "credit") : "credit";
    $("#cardAutopay").checked = isEdit ? !!card.autopay : false;
    $("#cardModal").classList.add("open");
    setTimeout(() => $("#cardName")?.focus(), 50);
  }

  function closeCardModal() {
    $("#cardModal").classList.remove("open");
    $("#cardForm").reset();
    $("#cardEditId").value = "";
  }

  function openScoreModal() {
    $("#scoreDate").value = todayStr();
    $("#scoreModal").classList.add("open");
    setTimeout(() => $("#scoreValue")?.focus(), 50);
  }
  function closeScoreModal() {
    $("#scoreModal").classList.remove("open");
    $("#scoreForm").reset();
  }

  /* ---------- Credit report import ---------- */
  let parsedReport = null; // { score, bureau, source, cards: [...] }

  function openImportCreditModal() {
    parsedReport = null;
    $("#importText").value = "";
    $("#importStatus").hidden = true;
    $("#importPreview").hidden = true;
    $("#importDetected").innerHTML = "";
    $("#importCreditModal").classList.add("open");
  }
  function closeImportCreditModal() {
    $("#importCreditModal").classList.remove("open");
  }

  async function handlePdfImport(file) {
    const status = $("#importStatus");
    status.textContent = "Reading PDF…";
    status.hidden = false;
    if (!window.pdfjsLib) {
      status.textContent = "PDF library failed to load. Try pasting text instead.";
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((it) => it.str).join(" ");
        fullText += pageText + "\n";
      }
      status.textContent = `Read ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"} (${fullText.length} chars). Parsing…`;
      parseCreditReport(fullText);
    } catch (e) {
      console.error(e);
      status.textContent = "Could not read this PDF. Try pasting the text instead.";
    }
  }

  function parseCreditReport(text) {
    const status = $("#importStatus");
    const preview = $("#importPreview");
    const detected = $("#importDetected");

    const result = {
      score: null,
      bureau: null,
      source: null,
      type: null,
      reportDate: null,
      cards: [],
    };

    // Detect source
    const lower = text.toLowerCase();
    if (lower.includes("credit karma")) result.source = "Credit Karma";
    else if (lower.includes("experian")) result.source = "Experian";
    else if (lower.includes("equifax")) result.source = "Equifax";
    else if (lower.includes("transunion")) result.source = "TransUnion";
    else if (lower.includes("fico")) result.source = "FICO";
    else result.source = "Other";

    // Detect bureau (CK reports are usually TransUnion + Equifax via VantageScore 3.0)
    if (lower.includes("transunion")) result.bureau = "TransUnion";
    else if (lower.includes("equifax")) result.bureau = "Equifax";
    else if (lower.includes("experian")) result.bureau = "Experian";

    // Detect type
    if (lower.includes("vantagescore")) result.type = "VantageScore";
    else if (lower.includes("fico")) result.type = "FICO";
    else result.type = "VantageScore"; // CK default

    // Find score: 3-digit number 300-850 near "score" keyword
    const scoreMatches = [];
    const scoreRegex = /\b(\d{3})\b/g;
    let m;
    while ((m = scoreRegex.exec(text)) !== null) {
      const n = Number(m[1]);
      if (n >= 300 && n <= 850) {
        const context = text.slice(Math.max(0, m.index - 60), m.index + 60).toLowerCase();
        if (/score|rating|fico|vantage/.test(context)) {
          scoreMatches.push({ score: n, idx: m.index });
        }
      }
    }
    if (scoreMatches.length) {
      // Most likely score is the largest one near "credit score"
      result.score = scoreMatches[0].score;
    }

    // Find report date — look for a Month YYYY pattern
    const dateMatch = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}[,]?\s+(\d{4})\b/i);
    if (dateMatch) {
      const d = new Date(dateMatch[0]);
      if (!isNaN(d)) {
        result.reportDate = d.toISOString().slice(0, 10);
      }
    }

    // Parse cards / accounts. CK lists accounts with names + balance + credit limit
    // Heuristic: find lines with "$XXX" patterns near common issuer keywords
    const issuers = [
      "American Express", "AMEX", "Capital One", "Chase", "Citi", "Discover",
      "Bank of America", "Wells Fargo", "U.S. Bank", "USAA", "Barclays",
      "Synchrony", "Apple", "Goldman Sachs", "Navy Federal", "PNC", "TD Bank",
      "Fifth Third", "Truist", "HSBC", "Best Buy", "Target", "Macy's", "Nordstrom",
    ];

    // Split text into chunks and look for issuer + dollar amounts
    const lines = text.split(/\n|\r/).map((l) => l.trim()).filter(Boolean);
    const seenNames = new Set();

    issuers.forEach((issuer) => {
      const re = new RegExp(`\\b${issuer.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      lines.forEach((line, idx) => {
        if (!re.test(line)) return;
        // Look for dollar amounts in this and nearby lines
        const window = lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 5)).join(" ");
        const amounts = [...window.matchAll(/\$\s*([\d,]+(?:\.\d{2})?)/g)]
          .map((m) => Number(m[1].replace(/,/g, "")))
          .filter((n) => n >= 0 && n <= 1000000);

        if (amounts.length === 0) return;

        // Largest amount is likely credit limit, smaller is balance
        amounts.sort((a, b) => b - a);
        const limit = amounts[0];
        const balance = amounts.length > 1 ? amounts[1] : 0;

        // Don't dupe by issuer name (rough)
        const key = `${issuer}-${limit}-${balance}`;
        if (seenNames.has(key)) return;
        seenNames.add(key);

        result.cards.push({
          name: issuer,
          issuer,
          limit,
          balance,
          // Mark as detected — user can edit before saving
          detected: true,
        });
      });
    });

    parsedReport = result;

    // Render preview
    let html = "";
    if (result.score) {
      html += `<div class="detected-row">
        <span class="detected-label">Score</span>
        <span class="detected-val"><strong>${result.score}</strong> ${result.type || ""} ${result.bureau ? "· " + result.bureau : ""}</span>
      </div>`;
    } else {
      html += `<div class="detected-row warn"><span>⚠️ Couldn't detect a score</span></div>`;
    }
    if (result.reportDate) {
      html += `<div class="detected-row">
        <span class="detected-label">Report date</span>
        <span class="detected-val">${result.reportDate}</span>
      </div>`;
    }

    if (result.cards.length) {
      html += `<div class="detected-cards-title">${result.cards.length} card${result.cards.length === 1 ? "" : "s"} detected</div>`;
      html += '<div class="detected-cards">';
      result.cards.forEach((c, i) => {
        html += `
          <div class="detected-card">
            <div>
              <strong>${escapeHtml(c.name)}</strong>
              <div class="detected-mini">Balance: ${fmt(c.balance)} · Limit: ${fmt(c.limit)}</div>
            </div>
            <label class="detected-toggle">
              <input type="checkbox" data-card-idx="${i}" checked />
              Import
            </label>
          </div>`;
      });
      html += '</div>';
    } else {
      html += `<div class="detected-row warn"><span>No cards detected — you can still save the score, then add cards manually.</span></div>`;
    }

    detected.innerHTML = html;
    preview.hidden = false;
    status.textContent = "Review and confirm below.";
  }

  function applyImport() {
    if (!parsedReport) return;
    let saved = 0;

    // Save score
    if (parsedReport.score) {
      state.creditScores.push({
        id: uid(),
        score: parsedReport.score,
        date: parsedReport.reportDate || todayStr(),
        bureau: parsedReport.bureau || null,
        source: parsedReport.source || "Imported",
        type: parsedReport.type || "VantageScore",
        note: "Imported from credit report",
      });
      saved += 1;
    }

    // Save selected cards
    const checked = $$('#importDetected input[type="checkbox"]:checked');
    checked.forEach((cb) => {
      const idx = Number(cb.dataset.cardIdx);
      const c = parsedReport.cards[idx];
      if (!c) return;
      // Dedupe: skip if a card with same name and similar limit exists
      const exists = state.cards.find(
        (existing) =>
          existing.name.toLowerCase() === c.name.toLowerCase() &&
          Math.abs((Number(existing.limit) || 0) - (Number(c.limit) || 0)) < 1
      );
      if (exists) return;

      state.cards.push({
        id: uid(),
        name: c.name,
        issuer: c.issuer,
        last4: "",
        limit: c.limit,
        balance: c.balance,
        statement: null,
        apr: null,
        dueDay: null,
        opened: null,
        cardType: "credit",
        autopay: false,
      });
      saved += 1;
    });

    saveData();
    closeImportCreditModal();
    renderCredit();
    showToast(`Imported ${saved} item${saved === 1 ? "" : "s"}`);
  }

  /* ---------- Family ---------- */
  function familyTransactions() {
    // Only outgoing money sent to a person
    return state.expenses.filter(
      (e) => e.personId && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
  }

  function filterFamilyByPeriod(txns) {
    const m = currentMonth();
    if (familyPeriod === "monthly") {
      return txns.filter((e) => monthKey(e.date) === m);
    }
    if (familyPeriod === "ytd") {
      const year = m.slice(0, 4);
      return txns.filter((e) => (e.date || "").startsWith(year));
    }
    return txns;
  }

  function renderFamily() {
    renderPeopleList();
    renderFamilyBreakdown();
    renderFamilyTrend();
    renderFamilyTxnList();

    const total = filterFamilyByPeriod(familyTransactions())
      .reduce((s, e) => s + Number(e.amount), 0);
    $("#familyTotalPill").textContent = `Total sent: ${fmt(total)}`;
  }

  function renderPeopleList() {
    const list = $("#peopleList");
    if (!list) return;
    if (!state.people.length) {
      list.innerHTML = '<li class="empty">No people yet.</li>';
      return;
    }
    list.innerHTML = state.people
      .map((p) => {
        const totalAll = state.expenses
          .filter((e) => e.personId === p.id && e.type !== "income"
            && e.type !== "transfer-in" && e.type !== "transfer-out")
          .reduce((s, e) => s + Number(e.amount), 0);
        const notes = p.notes ? ` · ${escapeHtml(p.notes)}` : "";
        return `
          <li class="list-item person-item" style="border-left: 4px solid ${p.color || "#5b3fb8"}">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(p.name)}</div>
              <div class="list-item-sub">${escapeHtml(p.relation || "Other")}${notes}</div>
            </div>
            <div class="list-item-amount">${fmt(totalAll)}<div class="list-item-sub" style="margin-top:0.15rem">all-time</div></div>
            <div class="list-item-actions">
              <button data-action="edit-person" data-id="${p.id}" title="Edit">✏️</button>
              <button data-action="del-person" data-id="${p.id}" title="Delete">🗑️</button>
            </div>
          </li>`;
      })
      .join("");
  }

  function renderFamilyBreakdown() {
    const el = $("#familyBreakdown");
    if (!el) return;
    if (!state.people.length) {
      el.innerHTML = '<p class="empty">No people added yet. Tap <strong>+ Add Person</strong> to track money sent to family.</p>';
      return;
    }
    const txns = filterFamilyByPeriod(familyTransactions());
    const totalSent = txns.reduce((s, e) => s + Number(e.amount), 0);

    const rows = state.people.map((p) => {
      const personTxns = txns.filter((e) => e.personId === p.id);
      const total = personTxns.reduce((s, e) => s + Number(e.amount), 0);
      const pct = totalSent > 0 ? (total / totalSent) * 100 : 0;
      return { person: p, total, pct, count: personTxns.length };
    });

    rows.sort((a, b) => b.total - a.total);

    el.innerHTML = rows
      .map((r) => {
        return `
          <div class="progress-item person-progress" style="border-left: 4px solid ${r.person.color || "#5b3fb8"}">
            <div class="progress-header">
              <span class="progress-name">${escapeHtml(r.person.name)} <span class="progress-amount">${escapeHtml(r.person.relation || "")}</span></span>
              <span class="progress-amount">${fmt(r.total)} · ${r.count} txn${r.count === 1 ? "" : "s"}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${pct.toFixed(1)}%; background: ${r.person.color || "var(--primary)"}"></div>
            </div>
          </div>`;
      })
      .join("");

    if (totalSent === 0) {
      el.innerHTML += `<p class="empty" style="margin-top:0.75rem">No transactions for this period yet.</p>`;
    }
  }

  function renderFamilyTrend() {
    if (typeof Chart === "undefined") return;
    destroyChart("familyTrend");
    const ctx = $("#chartFamilyTrend");
    if (!ctx) return;

    const txns = familyTransactions();
    if (!txns.length || !state.people.length) {
      $("#familyTrendEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#familyTrendEmpty").hidden = true;
    ctx.style.display = "block";

    // Last 6 months totals per person, stacked
    const m = currentMonth();
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(monthOffset(m, -i));

    const datasets = state.people.map((p) => {
      const data = months.map((mk) =>
        txns
          .filter((e) => e.personId === p.id && monthKey(e.date) === mk)
          .reduce((s, e) => s + Number(e.amount), 0)
      );
      return {
        label: p.name,
        data,
        backgroundColor: p.color || "#5b3fb8",
        borderRadius: 4,
      };
    });

    const labels = months.map((mk) => {
      const [y, mm] = mk.split("-");
      const d = new Date(Number(y), Number(mm) - 1, 1);
      return d.toLocaleDateString(undefined, { month: "short" });
    });

    charts.familyTrend = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", labels: { boxWidth: 12 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, ticks: { callback: (v) => fmt(v) }, grid: { color: "#eee" } },
        },
      },
    });
  }

  function renderFamilyTxnList() {
    const list = $("#familyTxnList");
    if (!list) return;
    const txns = filterFamilyByPeriod(familyTransactions())
      .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
    if (!txns.length) {
      list.innerHTML = '<li class="empty">Mark a transaction as sent to someone using the "Sent to family member" field.</li>';
      return;
    }
    list.innerHTML = txns.map(renderTxnItem).join("");
    attachReceiptClicks(list);
  }

  function populatePersonSelect() {
    const sel = $("#expPerson");
    if (!sel) return;
    sel.innerHTML =
      '<option value="">— Not for a family member —</option>' +
      state.people
        .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.relation ? " (" + escapeHtml(p.relation) + ")" : ""}</option>`)
        .join("");
  }

  function openPersonModal(person) {
    const isEdit = !!person;
    $("#personModalTitle").textContent = isEdit ? "Edit Person" : "Add Person";
    $("#personEditId").value = isEdit ? person.id : "";
    $("#personName").value = isEdit ? person.name : "";
    $("#personRelation").value = isEdit ? (person.relation || "other") : "parent";
    $("#personColor").value = isEdit ? (person.color || "#5b3fb8") : randomPersonColor();
    $("#personNotes").value = isEdit ? (person.notes || "") : "";
    $("#personModal").classList.add("open");
    setTimeout(() => $("#personName")?.focus(), 50);
  }
  function closePersonModal() {
    $("#personModal").classList.remove("open");
    $("#personForm").reset();
  }
  function randomPersonColor() {
    const colors = ["#5b3fb8", "#22c55e", "#3b82f6", "#ec4899", "#f59e0b", "#14b8a6", "#06b6d4", "#8b5cf6"];
    return colors[state.people.length % colors.length];
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
    $("#expTags").value = (prefill && Array.isArray(prefill.tags)) ? prefill.tags.join(", ") : "";

    populateExpenseCategorySelect();
    populateAccountSelect("#expAccount", true);
    populatePersonSelect();
    if (prefill && prefill.categoryId) {
      $("#expCategory").value = prefill.categoryId;
    }
    if (prefill && prefill.accountId) {
      $("#expAccount").value = prefill.accountId;
    }
    if (prefill && prefill.personId) {
      $("#expPerson").value = prefill.personId;
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
      list.innerHTML = '<span class="empty-chip">No presets for this type. Use "Save as preset" below.</span>';
      return;
    }

    // Group: favorites first, then by group key
    const groupOrder = currentModalType === "income"
      ? [["income", "Income"]]
      : [["favorite", "⭐ Favorites"], ["daily", "Daily"], ["subscription", "Subscriptions"], ["custom", "Custom"]];

    const buckets = {};
    items.forEach((p) => {
      if (p.favorite && currentModalType !== "income") {
        if (!buckets["favorite"]) buckets["favorite"] = [];
        buckets["favorite"].push(p);
        return;
      }
      const k = p.group || (p.type === "income" ? "income" : "custom");
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(p);
    });

    let html = "";
    groupOrder.forEach(([key, label]) => {
      const arr = buckets[key];
      if (!arr || !arr.length) return;
      html += `<div class="preset-group-label">${label}</div><div class="preset-row">`;
      arr.forEach((p) => {
        const amt = Number(p.amount) > 0 ? `<span class="preset-amt">${fmt(p.amount)}</span>` : "";
        html += `
          <button type="button" class="preset-card" data-preset="${p.id}">
            <span class="preset-icon">${p.icon || "💸"}</span>
            <span class="preset-name">${escapeHtml(p.desc)}</span>
            ${amt}
          </button>`;
      });
      html += "</div>";
    });
    list.innerHTML = html;
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
    // Default income
    $("#saveDefaultIncome").addEventListener("click", () => {
      state.income = parseFloat($("#incomeAmount").value) || 0;
      saveData();
      renderAll();
      showToast("Default income saved");
    });

    // Per-month income override
    $("#monthIncomeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const m = $("#incomeMonth").value;
      const amount = parseFloat($("#incomeMonthAmount").value);
      if (!m || isNaN(amount)) return;
      setIncomeForMonth(m, amount);
      saveData();
      $("#incomeMonth").value = "";
      $("#incomeMonthAmount").value = "";
      renderAll();
      showToast("Monthly income set");
    });

    // Default the month picker to current month
    if ($("#incomeMonth")) $("#incomeMonth").value = currentMonth();

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
      const accountId = $("#expAccount").value;
      const personId = $("#expPerson").value;
      const tagsRaw = $("#expTags").value.trim();
      const tags = tagsRaw
        ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
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
            accountId: accountId || null,
            personId: personId || null,
            tags,
            receipt,
          };
        }
      } else {
        state.expenses.push({
          id: uid(), type, desc, amount, date,
          categoryId: categoryId || null,
          accountId: accountId || null,
          personId: personId || null,
          tags,
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
      // Ask for group (defaults based on type)
      let group;
      if (currentModalType === "income") {
        group = "income";
      } else {
        group = confirm("Is this a recurring subscription/bill? OK for Subscription, Cancel for Daily expense")
          ? "subscription" : "daily";
      }
      const icon = prompt("Pick an emoji icon (optional):", currentModalType === "income" ? "💵" : "💸") || "💸";
      state.presets.push({
        id: uid(),
        type: currentModalType,
        desc,
        amount: isNaN(amount) ? 0 : amount,
        categoryId,
        group,
        icon,
        favorite: false,
      });
      saveData();
      renderPresets();
      renderPresetsManage();
      showToast("Preset saved");
    });

    // Restore default preset library (merge, no duplicates)
    $("#restorePresetsBtn").addEventListener("click", () => {
      const defaults = buildDefaultPresets();
      let added = 0;
      const existingKeys = new Set(
        state.presets.map((p) => `${p.type}|${p.desc.toLowerCase()}`)
      );
      defaults.forEach((d) => {
        const key = `${d.type}|${d.desc.toLowerCase()}`;
        if (!existingKeys.has(key)) {
          state.presets.push(d);
          existingKeys.add(key);
          added += 1;
        }
      });
      saveData();
      renderPresetsManage();
      renderPresets();
      showToast(added > 0 ? `Added ${added} default preset${added === 1 ? "" : "s"}` : "All defaults already present");
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

    // Credit: open card/score modals
    $("#addCardBtn").addEventListener("click", () => openCardModal(null));
    $("#addScoreBtn").addEventListener("click", () => openScoreModal());
    $("#importCreditBtn").addEventListener("click", openImportCreditModal);
    $("#cardModalClose").addEventListener("click", closeCardModal);
    $("#cardModal").addEventListener("click", (e) => {
      if (e.target.id === "cardModal") closeCardModal();
    });
    $("#scoreModalClose").addEventListener("click", closeScoreModal);
    $("#scoreModal").addEventListener("click", (e) => {
      if (e.target.id === "scoreModal") closeScoreModal();
    });

    // Import credit modal
    $("#importCreditClose").addEventListener("click", closeImportCreditModal);
    $("#importCreditModal").addEventListener("click", (e) => {
      if (e.target.id === "importCreditModal") closeImportCreditModal();
    });
    $("#importPdfBtn").addEventListener("click", () => $("#importPdfFile").click());
    $("#importPdfFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handlePdfImport(file);
      e.target.value = "";
    });
    $("#importParseBtn").addEventListener("click", () => {
      const text = $("#importText").value.trim();
      if (!text) {
        showToast("Paste some report text first");
        return;
      }
      $("#importStatus").textContent = "Parsing…";
      $("#importStatus").hidden = false;
      parseCreditReport(text);
    });
    $("#importApplyBtn").addEventListener("click", applyImport);

    // Debt payoff
    $("#payoffCalcBtn").addEventListener("click", calculatePayoff);

    // Account form
    $("#accountForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#accName").value.trim();
      const type = $("#accType").value;
      const balance = parseFloat($("#accBalance").value) || 0;
      if (!name) return;
      const colors = ["#22c55e", "#3b82f6", "#ec4899", "#f59e0b", "#8b5cf6", "#14b8a6", "#06b6d4", "#ef4444"];
      const color = colors[state.accounts.length % colors.length];
      state.accounts.push({ id: uid(), name, type, balance, color });
      saveData();
      e.target.reset();
      renderAll();
      showToast("Account added");
    });

    // Transfer
    $("#transferBtn").addEventListener("click", openTransferModal);
    $("#transferModalClose").addEventListener("click", closeTransferModal);
    $("#transferModal").addEventListener("click", (e) => {
      if (e.target.id === "transferModal") closeTransferModal();
    });
    $("#transferForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const fromId = $("#transferFrom").value;
      const toId = $("#transferTo").value;
      const amount = parseFloat($("#transferAmount").value);
      const date = $("#transferDate").value;
      const note = $("#transferNote").value.trim();
      if (!fromId || !toId || fromId === toId) {
        showToast("Pick two different accounts");
        return;
      }
      if (isNaN(amount) || amount <= 0 || !date) return;
      const fromAcc = state.accounts.find((a) => a.id === fromId);
      const toAcc = state.accounts.find((a) => a.id === toId);
      const desc = note || `Transfer: ${fromAcc.name} → ${toAcc.name}`;
      // Two linked transactions
      const transferGroupId = uid();
      state.expenses.push({
        id: uid(),
        type: "transfer-out",
        desc,
        amount,
        date,
        accountId: fromId,
        categoryId: null,
        tags: ["transfer"],
        receipt: null,
        transferGroupId,
      });
      state.expenses.push({
        id: uid(),
        type: "transfer-in",
        desc,
        amount,
        date,
        accountId: toId,
        categoryId: null,
        tags: ["transfer"],
        receipt: null,
        transferGroupId,
      });
      saveData();
      closeTransferModal();
      renderAll();
      showToast("Transfer recorded");
    });

    // Family: person form
    $("#addPersonBtn").addEventListener("click", () => openPersonModal(null));
    $("#personModalClose").addEventListener("click", closePersonModal);
    $("#personModal").addEventListener("click", (e) => {
      if (e.target.id === "personModal") closePersonModal();
    });
    $("#personForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const editId = $("#personEditId").value;
      const person = {
        id: editId || uid(),
        name: $("#personName").value.trim(),
        relation: $("#personRelation").value,
        color: $("#personColor").value,
        notes: $("#personNotes").value.trim(),
      };
      if (!person.name) return;
      if (editId) {
        const idx = state.people.findIndex((p) => p.id === editId);
        if (idx >= 0) state.people[idx] = person;
      } else {
        state.people.push(person);
      }
      saveData();
      closePersonModal();
      renderAll();
      showToast(editId ? "Person updated" : "Person added");
    });

    // Family period selector
    $$(".family-period-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".family-period-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        familyPeriod = btn.dataset.period;
        renderFamily();
      });
    });

    // Card form
    $("#cardForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const editId = $("#cardEditId").value;
      const card = {
        id: editId || uid(),
        name: $("#cardName").value.trim(),
        issuer: $("#cardIssuer").value.trim(),
        last4: $("#cardLast4").value.trim(),
        limit: parseFloat($("#cardLimit").value) || 0,
        balance: parseFloat($("#cardBalance").value) || 0,
        statement: parseFloat($("#cardStatement").value) || null,
        apr: parseFloat($("#cardApr").value) || null,
        dueDay: parseInt($("#cardDueDay").value, 10) || null,
        opened: $("#cardOpened").value || null,
        cardType: $("#cardType").value || "credit",
        autopay: $("#cardAutopay").checked,
      };
      if (!card.name) return;
      if (editId) {
        const idx = state.cards.findIndex((c) => c.id === editId);
        if (idx >= 0) state.cards[idx] = card;
      } else {
        state.cards.push(card);
      }
      saveData();
      closeCardModal();
      renderCredit();
      showToast(editId ? "Card updated" : "Card added");
    });

    // Score form
    $("#scoreForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const score = parseInt($("#scoreValue").value, 10);
      const date = $("#scoreDate").value;
      if (!score || score < 300 || score > 850 || !date) return;
      state.creditScores.push({
        id: uid(),
        score,
        date,
        bureau: $("#scoreBureau").value || null,
        source: $("#scoreSource").value,
        type: $("#scoreType").value,
        note: $("#scoreNote").value.trim(),
      });
      saveData();
      closeScoreModal();
      renderCredit();
      showToast("Score logged");
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
      filters.people.clear();
      filters.search = "";
      $("#filterStart").value = "";
      $("#filterEnd").value = "";
      $("#txnSearch").value = "";
      renderFilterChips();
      renderPersonFilterChips();
      renderTransactions();
    });

    // Sort & group toolbar
    $("#txnSort").addEventListener("change", (e) => {
      filters.sort = e.target.value;
      renderTransactions();
    });
    $("#groupByDayToggle").addEventListener("change", (e) => {
      filters.groupByDay = e.target.checked;
      renderTransactions();
    });

    // Bulk actions
    $("#bulkClearBtn").addEventListener("click", () => {
      selectedTxns.clear();
      renderTransactions();
    });
    $("#bulkDeleteBtn").addEventListener("click", () => {
      if (!selectedTxns.size) return;
      const ids = [...selectedTxns];
      if (!confirm(`Delete ${ids.length} transaction${ids.length === 1 ? "" : "s"}?`)) return;
      const removed = state.expenses.filter((e) => ids.includes(e.id));
      state.expenses = state.expenses.filter((e) => !ids.includes(e.id));
      selectedTxns.clear();
      saveData();
      renderAll();
      showUndoToast(removed);
    });

    // Description input -> auto-suggest category from past transactions
    $("#expDesc").addEventListener("input", (e) => {
      const cat = suggestCategory(e.target.value);
      const sel = $("#expCategory");
      if (cat && sel.value === "") sel.value = cat;

      // Also suggest person
      const personId = suggestPerson(e.target.value);
      const personSel = $("#expPerson");
      if (personId && personSel.value === "") personSel.value = personId;
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
      const pchip = e.target.closest("[data-person-chip]");
      if (pchip) {
        const id = pchip.dataset.personChip;
        if (filters.people.has(id)) filters.people.delete(id);
        else filters.people.add(id);
        renderPersonFilterChips();
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
        const txn = state.expenses.find((x) => x.id === id);
        if (txn && confirm("Delete this transaction?")) {
          state.expenses = state.expenses.filter((x) => x.id !== id);
          saveData();
          renderAll();
          showUndoToast([txn]);
        }
      } else if (action === "select-txn") {
        if (selectedTxns.has(id)) selectedTxns.delete(id);
        else selectedTxns.add(id);
        const li = btn.closest(".txn-item");
        if (li) li.classList.toggle("selected", selectedTxns.has(id));
        updateBulkBar();
      } else if (action === "edit-exp") {
        const exp = state.expenses.find((x) => x.id === id);
        if (exp) openExpenseModal(exp);
      } else if (action === "del-preset") {
        if (confirm("Delete this preset?")) {
          state.presets = state.presets.filter((p) => p.id !== id);
          saveData();
          renderPresetsManage();
        }
      } else if (action === "preset-fav") {
        const p = state.presets.find((x) => x.id === id);
        if (!p) return;
        p.favorite = !p.favorite;
        saveData();
        renderPresetsManage();
        renderPresets();
      } else if (action === "preset-recurring") {
        const p = state.presets.find((x) => x.id === id);
        if (!p) return;
        const day = prompt(`Make "${p.desc}" recurring on which day of month? (1-28)`, "1");
        if (day === null) return;
        const dayOfMonth = Math.min(28, Math.max(1, parseInt(day, 10) || 1));
        state.recurring.push({
          id: uid(),
          type: p.type,
          desc: p.desc,
          amount: p.amount,
          categoryId: p.categoryId,
          dayOfMonth,
          active: true,
          lastRunMonth: null,
        });
        saveData();
        renderRecurringList();
        showToast(`"${p.desc}" is now recurring on day ${dayOfMonth}`);
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
      } else if (action === "edit-card") {
        const card = state.cards.find((c) => c.id === id);
        if (card) openCardModal(card);
      } else if (action === "edit-acc") {
        const acc = state.accounts.find((a) => a.id === id);
        if (!acc) return;
        const newName = prompt("Account name:", acc.name);
        if (newName === null) return;
        const newBal = prompt("Starting balance:", acc.balance);
        if (newBal === null) return;
        acc.name = newName.trim() || acc.name;
        const b = parseFloat(newBal);
        if (!isNaN(b)) acc.balance = b;
        saveData();
        renderAll();
      } else if (action === "edit-month-income") {
        const m = btn.dataset.month;
        const cur = state.monthlyIncome[m];
        const newVal = prompt(`Income for ${monthLabel(m)}:`, cur);
        if (newVal === null) return;
        const v = parseFloat(newVal);
        if (isNaN(v)) return;
        setIncomeForMonth(m, v);
        saveData();
        renderAll();
        showToast("Updated");
      } else if (action === "del-month-income") {
        const m = btn.dataset.month;
        if (confirm(`Remove income override for ${monthLabel(m)}? Default will be used instead.`)) {
          delete state.monthlyIncome[m];
          saveData();
          renderAll();
        }
      } else if (action === "del-acc") {
        if (confirm("Delete this account? Transactions assigned to it will keep their record.")) {
          state.accounts = state.accounts.filter((a) => a.id !== id);
          saveData();
          renderAll();
        }
      } else if (action === "edit-person") {
        const p = state.people.find((x) => x.id === id);
        if (p) openPersonModal(p);
      } else if (action === "del-person") {
        if (confirm("Delete this person? Transactions linked to them will keep their record but lose the link.")) {
          state.people = state.people.filter((p) => p.id !== id);
          // Unlink transactions
          state.expenses.forEach((e) => {
            if (e.personId === id) e.personId = null;
          });
          saveData();
          renderAll();
        }
      } else if (action === "del-card") {
        if (confirm("Delete this card?")) {
          state.cards = state.cards.filter((c) => c.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "del-score") {
        if (confirm("Delete this score entry?")) {
          state.creditScores = state.creditScores.filter((s) => s.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "convert-sub") {
        const idx = Number(btn.dataset.idx);
        const el = $("#subscriptionSuggestions");
        const suggestions = JSON.parse(el.dataset.suggestionsJson || "[]");
        const s = suggestions[idx];
        if (!s) return;
        state.recurring.push({
          id: uid(),
          type: "expense",
          desc: s.desc,
          amount: s.amount,
          categoryId: s.categoryId || null,
          dayOfMonth: s.dayOfMonth || 1,
          active: true,
          lastRunMonth: currentMonth(),
        });
        saveData();
        renderRecurringList();
        showToast("Converted to recurring");
      } else if (action === "dismiss-sub") {
        const idx = Number(btn.dataset.idx);
        const el = $("#subscriptionSuggestions");
        const suggestions = JSON.parse(el.dataset.suggestionsJson || "[]");
        const s = suggestions[idx];
        if (s) {
          dismissedSubs.add(s.desc.toLowerCase().trim());
          renderSubscriptionSuggestions();
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
            monthlyIncome: data.monthlyIncome || {},
            categories: data.categories || [],
            expenses: (data.expenses || []).map((e) => ({
              ...e,
              type: e.type || "expense",
              tags: Array.isArray(e.tags) ? e.tags : [],
            })),
            goals: data.goals || [],
            presets: data.presets || [],
            recurring: data.recurring || [],
            cards: data.cards || [],
            creditScores: data.creditScores || [],
            accounts: data.accounts || [],
            people: data.people || [],
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
          monthlyIncome: {},
          categories: [],
          expenses: [],
          goals: [],
          presets: [],
          recurring: [],
          cards: [],
          creditScores: [],
          accounts: [],
          people: [],
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
