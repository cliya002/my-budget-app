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
    hideAmounts: "mb_hide_amounts",
    aiProvider: "mb_ai_provider",
    aiKey: "mb_ai_key",
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
    netWorthHistory: [],   // each: { date: 'YYYY-MM-DD', value: number }
    creditInquiries: [],   // each: { id, date, reason, bureau, type ('hard'|'soft') }
    negativeItems: [],     // each: { id, type, creditor, amount, dateOpened, fallOffDate, note }
    limitIncreases: [],    // each: { id, cardId, oldLimit, newLimit, date, note }
    creditGoals: [],       // each: { id, targetScore, targetDate, note }
    creditFreezes: {},     // map: bureau -> { frozen: bool, date: 'YYYY-MM-DD' }
    annualReports: {},     // map: bureau -> { lastPulled: 'YYYY-MM-DD' }
    utilHistory: [],       // each: { date: 'YYYY-MM-DD', util: number }
    settings: {
      rollover: false,
      alertsShown: {},
      roundUpEnabled: false,
      roundUpGoalId: null,
    },
  };

  let currency = "USD";
  let theme = "light"; // 'light' | 'dark'
  let hideAmounts = false;

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
    if (hideAmounts) {
      return `${sym}••••`;
    }
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
    hideAmounts = localStorage.getItem(KEYS.hideAmounts) === "true";

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
    if (!Array.isArray(state.netWorthHistory)) state.netWorthHistory = [];
    if (!Array.isArray(state.creditInquiries)) state.creditInquiries = [];
    if (!Array.isArray(state.negativeItems)) state.negativeItems = [];
    if (!Array.isArray(state.limitIncreases)) state.limitIncreases = [];
    if (!Array.isArray(state.creditGoals)) state.creditGoals = [];
    if (!Array.isArray(state.utilHistory)) state.utilHistory = [];
    if (typeof state.creditFreezes !== "object" || !state.creditFreezes) state.creditFreezes = {};
    if (typeof state.annualReports !== "object" || !state.annualReports) state.annualReports = {};
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
    if (typeof state.settings.roundUpEnabled !== "boolean") state.settings.roundUpEnabled = false;
    if (typeof state.settings.roundUpGoalId === "undefined") state.settings.roundUpGoalId = null;

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
    // Always update today's net-worth snapshot so the chart stays current
    try { snapshotNetWorth(); } catch (e) { /* netWorth uses functions defined later; ignore in early-init save */ }
    try { snapshotUtilization(); } catch (e) { /* same */ }
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
    maybeStartTour();
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

  function snapshotNetWorth() {
    const today = todayStr();
    const value = netWorth();
    if (!Array.isArray(state.netWorthHistory)) state.netWorthHistory = [];
    // Replace today's entry if it exists, else add
    const idx = state.netWorthHistory.findIndex((s) => s.date === today);
    if (idx >= 0) {
      state.netWorthHistory[idx].value = value;
    } else {
      state.netWorthHistory.push({ date: today, value });
    }
    // Keep last 365 entries max
    if (state.netWorthHistory.length > 365) {
      state.netWorthHistory = state.netWorthHistory.slice(-365);
    }
  }

  function snapshotUtilization() {
    const today = todayStr();
    const util = utilizationPct();
    if (!Array.isArray(state.utilHistory)) state.utilHistory = [];
    const idx = state.utilHistory.findIndex((s) => s.date === today);
    if (idx >= 0) {
      state.utilHistory[idx].util = util;
    } else {
      state.utilHistory.push({ date: today, util });
    }
    if (state.utilHistory.length > 365) {
      state.utilHistory = state.utilHistory.slice(-365);
    }
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

  /* ---------- YTD income, Expected income, Tax estimator ---------- */
  function ytdIncomeTotal() {
    const year = currentMonth().slice(0, 4);
    return state.expenses
      .filter((e) => e.type === "income" && (e.date || "").startsWith(year))
      .reduce((s, e) => s + Number(e.amount), 0);
  }

  function ytdIncomeBySource() {
    const year = currentMonth().slice(0, 4);
    const out = {};
    state.expenses
      .filter((e) => e.type === "income" && (e.date || "").startsWith(year))
      .forEach((e) => {
        const key = e.source || "(unspecified)";
        out[key] = (out[key] || 0) + Number(e.amount);
      });
    return out;
  }

  function ytdIncomeByType() {
    const year = currentMonth().slice(0, 4);
    const out = {};
    state.expenses
      .filter((e) => e.type === "income" && (e.date || "").startsWith(year))
      .forEach((e) => {
        const key = e.incomeType || "other";
        out[key] = (out[key] || 0) + Number(e.amount);
      });
    return out;
  }

  function renderYtdIncome() {
    const el = $("#ytdIncomeBreakdown");
    if (!el) return;
    const total = ytdIncomeTotal();
    if (total === 0) {
      el.innerHTML = '<p class="empty">No income transactions yet this year.</p>';
      return;
    }
    const bySource = ytdIncomeBySource();
    const byType = ytdIncomeByType();

    const typeNames = {
      salary: "💼 Salary", freelance: "💻 Freelance", bonus: "🎉 Bonus",
      investment: "📈 Investment", refund: "↩️ Refund", gift: "🎁 Gift", other: "Other",
    };

    let html = `
      <div class="ytd-total">
        <div class="ytd-label">Total ${currentMonth().slice(0, 4)}</div>
        <div class="ytd-value">${fmt(total)}</div>
      </div>
      <div class="ytd-section-label">By type</div>
      <div class="ytd-rows">
    `;
    Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .forEach(([key, amount]) => {
        const name = typeNames[key] || key;
        const pct = (amount / total) * 100;
        html += `
          <div class="ytd-row">
            <span>${name}</span>
            <span><strong>${fmt(amount)}</strong> · ${pct.toFixed(0)}%</span>
          </div>`;
      });
    html += `</div>`;

    if (Object.keys(bySource).length > 0 && !(Object.keys(bySource).length === 1 && bySource["(unspecified)"])) {
      html += `<div class="ytd-section-label">By source</div><div class="ytd-rows">`;
      Object.entries(bySource)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .forEach(([key, amount]) => {
          const pct = (amount / total) * 100;
          html += `
            <div class="ytd-row">
              <span>${escapeHtml(key)}</span>
              <span><strong>${fmt(amount)}</strong> · ${pct.toFixed(0)}%</span>
            </div>`;
        });
      html += `</div>`;
    }

    el.innerHTML = html;
  }

  function renderExpectedIncome() {
    const list = $("#expectedIncomeList");
    if (!list) return;
    const incomes = state.recurring.filter((r) => r.type === "income" && r.active);
    if (!incomes.length) {
      list.innerHTML = '<li class="empty">No recurring incomes set up yet. Add a paycheck in Recurring Transactions to track expected income.</li>';
      return;
    }
    const today = new Date();
    const month = currentMonth();
    let totalExpected = 0;
    let totalReceived = 0;

    const items = incomes.map((r) => {
      const day = Math.min(28, r.dayOfMonth || 1);
      const dateStr = `${month}-${String(day).padStart(2, "0")}`;
      const expectedDate = new Date(dateStr);
      const isPast = expectedDate <= today;
      const received = state.expenses.some(
        (e) =>
          e.type === "income" &&
          monthKey(e.date) === month &&
          e.recurringId === r.id
      );
      totalExpected += Number(r.amount);
      if (received) totalReceived += Number(r.amount);
      return { r, dateStr, isPast, received };
    });

    let html = `
      <div class="expected-summary">
        <div><strong>${fmt(totalReceived)}</strong> received of <strong>${fmt(totalExpected)}</strong> expected</div>
        <div class="card-sub">${fmt(totalExpected - totalReceived)} still incoming</div>
      </div>
    `;
    items.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    items.forEach(({ r, dateStr, isPast, received }) => {
      let status = "";
      if (received) status = '<span class="expected-status received">✓ Received</span>';
      else if (isPast) status = '<span class="expected-status overdue">⚠ Overdue</span>';
      else status = '<span class="expected-status pending">⏳ Pending</span>';
      html += `
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">💰 ${escapeHtml(r.desc)}</div>
            <div class="list-item-sub">Day ${r.dayOfMonth} · ${dateStr}</div>
          </div>
          <div class="list-item-amount">${fmt(r.amount)}</div>
          <div>${status}</div>
        </li>`;
    });
    list.innerHTML = html;
  }

  /* ---------- Bills Calendar ---------- */
  function renderBillsCalendar() {
    const el = $("#billsCalendar");
    if (!el) return;

    // Collect all bills for this month: recurring expenses + credit card due dates
    const m = currentMonth();
    const today = todayStr();
    const bills = [];

    state.recurring.forEach((r) => {
      if (!r.active || r.type !== "expense") return;
      const day = Math.min(28, r.dayOfMonth || 1);
      const dateStr = `${m}-${String(day).padStart(2, "0")}`;
      const paid = state.expenses.some(
        (e) => e.recurringId === r.id && monthKey(e.date) === m
      );
      bills.push({
        type: "recurring",
        date: dateStr,
        day,
        name: r.desc,
        amount: r.amount,
        paid,
        icon: "📋",
      });
    });

    state.cards.forEach((c) => {
      if (!c.dueDay) return;
      const day = Math.min(28, c.dueDay);
      const dateStr = `${m}-${String(day).padStart(2, "0")}`;
      bills.push({
        type: "card",
        date: dateStr,
        day,
        name: `${c.name} payment`,
        amount: c.statement || c.balance || 0,
        paid: false, // we don't have a separate "paid" field for card
        autopay: c.autopay,
        icon: "💳",
      });
    });

    if (!bills.length) {
      el.innerHTML = '<p class="empty">Set up recurring transactions or credit card due dates to see bills.</p>';
      return;
    }

    bills.sort((a, b) => a.day - b.day);

    // Summary at top
    const total = bills.reduce((s, b) => s + Number(b.amount), 0);
    const paidTotal = bills.filter((b) => b.paid || b.autopay).reduce((s, b) => s + Number(b.amount), 0);
    const upcoming = bills.filter((b) => b.date > today && !b.paid && !b.autopay).length;
    const overdue = bills.filter((b) => b.date <= today && !b.paid && !b.autopay).length;

    let html = `
      <div class="bills-summary">
        <div><strong>${fmt(total)}</strong> total · ${fmt(paidTotal)} done</div>
        <div class="card-sub">${overdue ? `⚠ ${overdue} overdue · ` : ""}${upcoming} upcoming</div>
      </div>
    `;

    bills.forEach((b) => {
      const isPast = b.date <= today;
      let status, statusClass;
      if (b.paid) {
        status = "✓ Paid"; statusClass = "paid";
      } else if (b.autopay) {
        status = "🔄 Autopay"; statusClass = "autopay";
      } else if (isPast) {
        status = "⚠ Overdue"; statusClass = "overdue";
      } else {
        status = "⏳ Upcoming"; statusClass = "upcoming";
      }

      const dt = new Date(b.date);
      const dayName = dt.toLocaleDateString(undefined, { weekday: "short" });

      html += `
        <div class="bill-row ${statusClass}">
          <div class="bill-date">
            <div class="bill-day">${b.day}</div>
            <div class="bill-dow">${dayName}</div>
          </div>
          <div class="bill-info">
            <div class="bill-name">${b.icon} ${escapeHtml(b.name)}</div>
            <div class="bill-status ${statusClass}">${status}</div>
          </div>
          <div class="bill-amount">${fmt(b.amount)}</div>
        </div>`;
    });

    el.innerHTML = html;
  }

  /* ---------- Smart Insights ---------- */
  function renderSmartInsights() {
    const el = $("#smartInsights");
    if (!el) return;
    const insights = generateInsights();
    if (!insights.length) {
      el.innerHTML = '<p class="empty">Add more transactions to see personalized insights.</p>';
      return;
    }
    el.innerHTML = insights
      .map((i) => `
        <div class="insight-item ${i.tone || ""}">
          <span class="insight-icon">${i.icon}</span>
          <span class="insight-text">${i.text}</span>
        </div>
      `)
      .join("");
  }

  function generateInsights() {
    const insights = [];
    const m = currentMonth();
    const prev = prevMonth(m);
    const monthExpenses = state.expenses.filter(
      (e) => monthKey(e.date) === m && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    const prevExpenses = state.expenses.filter(
      (e) => monthKey(e.date) === prev && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );

    if (monthExpenses.length === 0 && prevExpenses.length === 0) return insights;

    const totalThisMonth = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalLastMonth = prevExpenses.reduce((s, e) => s + Number(e.amount), 0);

    // 1) Month-over-month change
    if (totalLastMonth > 0 && totalThisMonth > 0) {
      const diffPct = ((totalThisMonth - totalLastMonth) / totalLastMonth) * 100;
      if (Math.abs(diffPct) >= 10) {
        const dir = diffPct > 0 ? "up" : "down";
        const tone = diffPct > 0 ? "warn" : "positive";
        insights.push({
          icon: diffPct > 0 ? "📈" : "📉",
          tone,
          text: `Your spending is <strong>${dir} ${Math.abs(diffPct).toFixed(0)}%</strong> vs last month (${fmt(totalThisMonth)} this month vs ${fmt(totalLastMonth)}).`,
        });
      }
    }

    // 2) Top category usage
    const catTotals = {};
    monthExpenses.forEach((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const name = cat ? cat.name : "Uncategorized";
      catTotals[name] = (catTotals[name] || 0) + Number(e.amount);
    });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (topCats.length === 3 && totalThisMonth > 0) {
      const top3sum = topCats.reduce((s, [, v]) => s + v, 0);
      const top3pct = (top3sum / totalThisMonth) * 100;
      insights.push({
        icon: "🎯",
        tone: top3pct > 75 ? "warn" : "",
        text: `<strong>${topCats[0][0]}, ${topCats[1][0]}, ${topCats[2][0]}</strong> account for ${top3pct.toFixed(0)}% of your spending.`,
      });
    }

    // 3) Budget over-pace warning
    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const dayOfMonth = today.getDate();
    if (dayOfMonth < daysInMonth) {
      state.categories.forEach((cat) => {
        const limit = effectiveLimitFor(cat, m);
        if (limit <= 0) return;
        const spent = monthExpenses.filter((e) => e.categoryId === cat.id).reduce((s, e) => s + Number(e.amount), 0);
        if (spent === 0) return;
        const projected = (spent / dayOfMonth) * daysInMonth;
        if (projected > limit * 1.10) {
          insights.push({
            icon: "⚠️",
            tone: "danger",
            text: `At this pace, <strong>${cat.name}</strong> will hit ${fmt(projected)} (${(projected / limit * 100).toFixed(0)}% of ${fmt(limit)} budget).`,
          });
        }
      });
    }

    // 4) Savings rate insight
    const incomeReal = state.expenses
      .filter((e) => e.type === "income" && monthKey(e.date) === m)
      .reduce((s, e) => s + Number(e.amount), 0);
    const incomeTarget = incomeForMonth(m);
    const incomeForRate = incomeReal > 0 ? incomeReal : incomeTarget;
    if (incomeForRate > 0) {
      const rate = ((incomeForRate - totalThisMonth) / incomeForRate) * 100;
      if (rate >= 50) {
        insights.push({
          icon: "🏆",
          tone: "positive",
          text: `Saving <strong>${rate.toFixed(0)}%</strong> of income — that's exceptional. You're on FIRE pace.`,
        });
      } else if (rate >= 20) {
        insights.push({
          icon: "✨",
          tone: "positive",
          text: `Saving <strong>${rate.toFixed(0)}%</strong> of income — solid budgeting.`,
        });
      } else if (rate < 0) {
        insights.push({
          icon: "🚨",
          tone: "danger",
          text: `Spending <strong>${Math.abs(rate).toFixed(0)}% more</strong> than income this month. Reduce spending or boost income.`,
        });
      }
    }

    // 5) Subscription bloat
    const subTotal = state.recurring
      .filter((r) => r.active && r.type === "expense")
      .reduce((s, r) => s + Number(r.amount), 0);
    if (subTotal > 0 && incomeForRate > 0) {
      const subPct = (subTotal / incomeForRate) * 100;
      if (subPct >= 30) {
        insights.push({
          icon: "📺",
          tone: "warn",
          text: `Recurring bills total <strong>${fmt(subTotal)}/mo</strong>, ${subPct.toFixed(0)}% of income. Consider auditing subscriptions.`,
        });
      }
    }

    // 6) Big-ticket detection (largest single transaction)
    const sortedExp = [...monthExpenses].sort((a, b) => Number(b.amount) - Number(a.amount));
    if (sortedExp[0] && totalThisMonth > 0) {
      const biggest = sortedExp[0];
      const pct = (Number(biggest.amount) / totalThisMonth) * 100;
      if (pct >= 25) {
        insights.push({
          icon: "💰",
          tone: "warn",
          text: `Largest expense: <strong>${escapeHtml(biggest.desc)}</strong> at ${fmt(biggest.amount)} (${pct.toFixed(0)}% of monthly spend).`,
        });
      }
    }

    // 7) Anomaly: transaction unusually large for its category
    monthExpenses.forEach((e) => {
      if (!e.categoryId) return;
      const sameCatPast = state.expenses.filter(
        (x) =>
          x.categoryId === e.categoryId &&
          x.type !== "income" && x.type !== "transfer-in" && x.type !== "transfer-out" &&
          x.id !== e.id
      );
      if (sameCatPast.length < 5) return;
      const avg = sameCatPast.reduce((s, x) => s + Number(x.amount), 0) / sameCatPast.length;
      if (Number(e.amount) >= avg * 3 && Number(e.amount) >= 50) {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        insights.push({
          icon: "🔎",
          tone: "warn",
          text: `<strong>${escapeHtml(e.desc)}</strong> (${fmt(e.amount)}) is ${(Number(e.amount) / avg).toFixed(1)}× your average ${cat ? cat.name : "category"} spend.`,
        });
      }
    });

    // 8) Goal progress
    state.goals.forEach((g) => {
      const target = Number(g.target) || 0;
      const saved = Number(g.saved) || 0;
      if (target <= 0 || saved <= 0) return;
      const pct = (saved / target) * 100;
      if (pct >= 100) {
        insights.push({
          icon: "🎉",
          tone: "positive",
          text: `Goal <strong>${escapeHtml(g.name)}</strong> reached! ${fmt(saved)} saved.`,
        });
      } else if (pct >= 75) {
        insights.push({
          icon: "🚀",
          tone: "positive",
          text: `<strong>${escapeHtml(g.name)}</strong> is ${pct.toFixed(0)}% funded. Keep going.`,
        });
      }
    });

    // Cap to 6 most relevant
    return insights.slice(0, 6);
  }

  function renderIncomeOverview() {
    const el = $("#incomeOverview");
    if (!el) return;
    const m = currentMonth();
    const monthIncomes = state.expenses.filter(
      (e) => e.type === "income" && monthKey(e.date) === m
    );
    if (!monthIncomes.length) {
      el.innerHTML = '<p class="empty">No income recorded yet this month.</p>';
      return;
    }
    const totalThisMonth = monthIncomes.reduce((s, e) => s + Number(e.amount), 0);
    const ytd = ytdIncomeTotal();
    const target = incomeForMonth(m);
    const pctOfTarget = target > 0 ? (totalThisMonth / target) * 100 : 0;

    // Latest 3 income entries
    const latest = [...monthIncomes]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);

    let html = `
      <div class="income-overview-stats">
        <div class="income-stat">
          <div class="card-sub">This month</div>
          <div class="ytd-value">${fmt(totalThisMonth)}</div>
          ${target > 0 ? `<div class="card-sub">${pctOfTarget.toFixed(0)}% of ${fmt(target)} target</div>` : ""}
        </div>
        <div class="income-stat">
          <div class="card-sub">Year to date</div>
          <div class="ytd-value">${fmt(ytd)}</div>
        </div>
      </div>
    `;
    html += `<div class="ytd-section-label">Recent income</div>`;
    latest.forEach((e) => {
      const source = e.source ? ` · ${escapeHtml(e.source)}` : "";
      const tax = e.preTax ? " · pre-tax" : "";
      html += `
        <div class="ytd-row">
          <span>${escapeHtml(e.desc)}${source}${tax}</span>
          <strong>${fmt(e.amount)}</strong>
        </div>`;
    });
    el.innerHTML = html;
  }

  function renderRoundUpStats() {
    const el = $("#roundUpStats");
    if (!el) return;
    if (!state.settings.roundUpEnabled) {
      el.textContent = "";
      return;
    }
    if (!state.settings.roundUpGoalId) {
      el.textContent = "Pick a destination goal above.";
      return;
    }
    // Estimate this month's round-up amount
    const m = currentMonth();
    let total = 0;
    state.expenses.forEach((e) => {
      if (e.type !== "expense") return;
      if (monthKey(e.date) !== m) return;
      const cents = Math.round(Number(e.amount) * 100) % 100;
      const ru = cents === 0 ? 0 : (100 - cents) / 100;
      total += ru;
    });
    const goal = state.goals.find((g) => g.id === state.settings.roundUpGoalId);
    const goalName = goal ? goal.name : "(deleted goal)";
    el.innerHTML = `Round-up potential this month: <strong>${fmt(total)}</strong> → ${escapeHtml(goalName)}`;
  }

  function renderTaxEstimate() {
    const el = $("#taxEstimate");
    if (!el) return;
    const status = $("#taxFilingStatus").value || "single";
    const stateRate = parseFloat($("#taxStateRate").value) || 0;
    const ytd = ytdIncomeTotal();

    if (ytd === 0) {
      el.innerHTML = `<p class="empty">Add income to see tax estimate.</p>`;
      return;
    }

    // 2024 federal brackets (simplified)
    const brackets = {
      single: [
        [0, 0.10], [11600, 0.12], [47150, 0.22], [100525, 0.24],
        [191950, 0.32], [243725, 0.35], [609350, 0.37],
      ],
      married_joint: [
        [0, 0.10], [23200, 0.12], [94300, 0.22], [201050, 0.24],
        [383900, 0.32], [487450, 0.35], [731200, 0.37],
      ],
      married_separate: [
        [0, 0.10], [11600, 0.12], [47150, 0.22], [100525, 0.24],
        [191950, 0.32], [243725, 0.35], [365600, 0.37],
      ],
      head: [
        [0, 0.10], [16550, 0.12], [63100, 0.22], [100500, 0.24],
        [191950, 0.32], [243700, 0.35], [609350, 0.37],
      ],
    };
    const standardDeduction = {
      single: 14600,
      married_joint: 29200,
      married_separate: 14600,
      head: 21900,
    };

    // Project annualized income
    const today = new Date();
    const startOfYear = new Date(today.getFullYear(), 0, 1);
    const daysElapsed = Math.max(1, Math.floor((today - startOfYear) / (24 * 60 * 60 * 1000)));
    const daysInYear = 365;
    const annualizedIncome = (ytd / daysElapsed) * daysInYear;

    const taxableIncome = Math.max(0, annualizedIncome - standardDeduction[status]);
    const ratesArr = brackets[status];
    let federalTax = 0;
    for (let i = 0; i < ratesArr.length; i++) {
      const [floor, rate] = ratesArr[i];
      const ceiling = i + 1 < ratesArr.length ? ratesArr[i + 1][0] : Infinity;
      if (taxableIncome > floor) {
        federalTax += (Math.min(taxableIncome, ceiling) - floor) * rate;
      }
    }

    // FICA (Social Security 6.2% up to $168,600 + Medicare 1.45%)
    const ssBase = Math.min(annualizedIncome, 168600);
    const fica = ssBase * 0.062 + annualizedIncome * 0.0145;

    // State tax
    const stateTax = annualizedIncome * (stateRate / 100);

    const totalTax = federalTax + fica + stateTax;
    const effectiveRate = annualizedIncome > 0 ? (totalTax / annualizedIncome) * 100 : 0;
    const quarterlyEstimate = totalTax / 4;
    const ytdTaxOwed = (totalTax / daysInYear) * daysElapsed;

    el.innerHTML = `
      <div class="tax-grid">
        <div class="tax-stat">
          <div class="tax-label">Projected annual income</div>
          <div class="tax-value">${fmt(annualizedIncome)}</div>
          <div class="card-sub">Based on YTD pace</div>
        </div>
        <div class="tax-stat">
          <div class="tax-label">Federal tax</div>
          <div class="tax-value">${fmt(federalTax)}</div>
        </div>
        <div class="tax-stat">
          <div class="tax-label">FICA</div>
          <div class="tax-value">${fmt(fica)}</div>
        </div>
        <div class="tax-stat">
          <div class="tax-label">State tax</div>
          <div class="tax-value">${fmt(stateTax)}</div>
        </div>
        <div class="tax-stat tax-stat-total">
          <div class="tax-label">Total estimated tax</div>
          <div class="tax-value">${fmt(totalTax)}</div>
          <div class="card-sub">${effectiveRate.toFixed(1)}% effective rate</div>
        </div>
        <div class="tax-stat">
          <div class="tax-label">Quarterly estimated</div>
          <div class="tax-value">${fmt(quarterlyEstimate)}</div>
          <div class="card-sub">For self-employed planning</div>
        </div>
      </div>
      <p class="tax-disclaimer">⚠️ Estimates only. Real taxes depend on deductions, credits, and other factors. Consult a tax professional.</p>
    `;
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

    // Savings rate = (income - spending) / income
    // Use real income transactions if logged, otherwise target
    const incomeForRate = totalIncomeReal > 0 ? totalIncomeReal : totalIncome;
    const savingsRate = incomeForRate > 0
      ? ((incomeForRate - totalSpent) / incomeForRate) * 100
      : 0;
    $("#statSavingsRate").textContent = `${savingsRate.toFixed(0)}%`;
    const rateHint = $("#statSavingsRateHint");
    if (incomeForRate === 0) {
      rateHint.textContent = "Add income";
    } else if (savingsRate >= 50) {
      rateHint.innerHTML = '<span class="positive">Excellent</span>';
    } else if (savingsRate >= 20) {
      rateHint.innerHTML = '<span class="positive">Good</span>';
    } else if (savingsRate >= 10) {
      rateHint.innerHTML = '<span style="color:var(--warning)">Fair</span>';
    } else if (savingsRate > 0) {
      rateHint.innerHTML = '<span class="negative">Low</span>';
    } else {
      rateHint.innerHTML = '<span class="negative">Spending more than earning</span>';
    }

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

          // Forecast: pace * days in month
          const today = new Date();
          const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
          const dayOfMonth = today.getDate();
          const projected = dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : spent;
          let forecastTag = "";
          if (effectiveLimit > 0 && spent > 0 && dayOfMonth < daysInMonth) {
            if (projected > effectiveLimit * 1.05) {
              forecastTag = `<span class="forecast-tag forecast-over">📈 ${fmt(projected)} projected (over by ${fmt(projected - effectiveLimit)})</span>`;
            } else if (projected > effectiveLimit * 0.85) {
              forecastTag = `<span class="forecast-tag forecast-warn">📈 ${fmt(projected)} projected</span>`;
            } else {
              forecastTag = `<span class="forecast-tag forecast-ok">📈 ${fmt(projected)} projected · on track</span>`;
            }
          }

          return `
            <div class="progress-item">
              <div class="progress-header">
                <span class="progress-name">${escapeHtml(cat.name)} ${rolloverNote}</span>
                <span class="progress-amount">${fmt(spent)} / ${fmt(effectiveLimit)}</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill ${cls}" style="width: ${pct}%"></div>
              </div>
              ${forecastTag}
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

    // Income Overview card on dashboard
    renderIncomeOverview();
    renderBillsCalendar();
    renderSmartInsights();
  }

  function renderBalances() {
    $("#incomeAmount").value = state.income || "";
    renderMonthIncomeList();
    renderYtdIncome();
    renderExpectedIncome();
    renderTaxEstimate();
    renderRoundUpStats();

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
    renderCashFlowChart();
    renderIncomeSourcesChart();
    renderIncomeTypeChart();
    renderNetWorthChart();
    renderHeatmapCalendar();
    renderTopVendors();
    renderTagsChart();
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
    renderInquiriesList();
    renderNegativeList();
    renderLimitIncreaseList();
    renderCreditGoalList();
    renderFreezes();
    renderAnnualReports();
    renderPayByCalendar();
    renderAccountAgeTimeline();
    renderRewardsList();
    renderUtilTrendChart();
    renderScoreProjection();
    checkScoreMilestones();
  }

  function renderPayoffEmpty() {
    const eligible = state.cards.filter((c) => Number(c.balance) > 0);
    $("#payoffEmpty").hidden = eligible.length > 0;
  }

  /* ---------- Credit additions: inquiries, negatives, limits, goals, freezes, reports ---------- */

  function isInquiryActive(date) {
    const d = new Date(date);
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 24);
    return d >= cutoff;
  }

  function renderInquiriesList() {
    const list = $("#inquiriesList");
    if (!list) return;
    if (!state.creditInquiries.length) {
      list.innerHTML = '<li class="empty">No inquiries logged.</li>';
      return;
    }
    const sorted = [...state.creditInquiries].sort((a, b) => b.date.localeCompare(a.date));
    const active = sorted.filter((i) => isInquiryActive(i.date));
    const pointsCost = active.length * 5;

    let html = `<div class="card-sub" style="margin-bottom:0.5rem">
      <strong>${active.length}</strong> active inquiries (last 24 mo) · estimated ~${pointsCost} pts impact
    </div>`;
    sorted.forEach((i) => {
      const active = isInquiryActive(i.date);
      const fallOff = new Date(i.date);
      fallOff.setMonth(fallOff.getMonth() + 24);
      const fallOffStr = fallOff.toISOString().slice(0, 10);
      const monthsLeft = Math.max(0, Math.round((fallOff - new Date()) / (30.44 * 24 * 60 * 60 * 1000)));
      html += `
        <li class="list-item ${active ? "" : "faded"}">
          <div class="list-item-main">
            <div class="list-item-title">${escapeHtml(i.reason)}${i.bureau ? " · " + escapeHtml(i.bureau) : ""}</div>
            <div class="list-item-sub">${i.date} · ${active ? `Falls off ${fallOffStr} (${monthsLeft} mo)` : "Faded off"}</div>
          </div>
          <div class="list-item-actions">
            <button data-action="del-inquiry" data-id="${i.id}" title="Delete">🗑️</button>
          </div>
        </li>`;
    });
    list.innerHTML = html;
  }

  function renderNegativeList() {
    const list = $("#negativeList");
    if (!list) return;
    if (!state.negativeItems.length) {
      list.innerHTML = '<li class="empty">None logged.</li>';
      return;
    }
    const typeNames = {
      late30: "30-day late", late60: "60-day late", late90: "90+ day late",
      collection: "Collection", chargeoff: "Charge-off",
      bankruptcy: "Bankruptcy", foreclosure: "Foreclosure",
      repossession: "Repossession", judgement: "Judgement",
    };
    const fallOffYears = (type) => {
      if (type === "bankruptcy") return 10;
      return 7;
    };
    const sorted = [...state.negativeItems].sort((a, b) => b.date.localeCompare(a.date));
    list.innerHTML = sorted.map((n) => {
      const dt = new Date(n.date);
      const fallOff = new Date(dt);
      fallOff.setFullYear(fallOff.getFullYear() + fallOffYears(n.type));
      const fallOffStr = fallOff.toISOString().slice(0, 10);
      const today = new Date();
      const months = Math.max(0, Math.round((fallOff - today) / (30.44 * 24 * 60 * 60 * 1000)));
      const fadedOff = fallOff <= today;
      const amount = Number(n.amount) > 0 ? ` · ${fmt(n.amount)}` : "";
      const creditor = n.creditor ? ` · ${escapeHtml(n.creditor)}` : "";
      const note = n.note ? ` · ${escapeHtml(n.note)}` : "";
      return `
        <li class="list-item ${fadedOff ? "faded" : ""}">
          <div class="list-item-main">
            <div class="list-item-title">${typeNames[n.type] || n.type}${creditor}</div>
            <div class="list-item-sub">${n.date}${amount}${note} · ${fadedOff ? "Faded off" : `Falls off ${fallOffStr} (${months} mo)`}</div>
          </div>
          <div class="list-item-actions">
            <button data-action="del-negative" data-id="${n.id}" title="Delete">🗑️</button>
          </div>
        </li>`;
    }).join("");
  }

  function renderLimitIncreaseList() {
    const list = $("#limitIncreaseList");
    const summary = $("#limitIncreaseSummary");
    if (!list) return;
    if (!state.limitIncreases.length) {
      list.innerHTML = '<li class="empty">No limit increases logged. Edit a card and raise its limit to log one automatically.</li>';
      if (summary) summary.textContent = "";
      return;
    }
    const totalIncrease = state.limitIncreases.reduce(
      (s, x) => s + (Number(x.newLimit) - Number(x.oldLimit)), 0
    );
    if (summary) summary.innerHTML = `Total credit limit increase: <strong>${fmt(totalIncrease)}</strong>`;

    const sorted = [...state.limitIncreases].sort((a, b) => b.date.localeCompare(a.date));
    list.innerHTML = sorted.map((x) => {
      const card = state.cards.find((c) => c.id === x.cardId);
      const cardName = card ? card.name : "(deleted card)";
      const diff = Number(x.newLimit) - Number(x.oldLimit);
      return `
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">${escapeHtml(cardName)}</div>
            <div class="list-item-sub">${x.date} · ${fmt(x.oldLimit)} → ${fmt(x.newLimit)} (+${fmt(diff)})</div>
          </div>
          <div class="list-item-actions">
            <button data-action="del-limit" data-id="${x.id}" title="Delete">🗑️</button>
          </div>
        </li>`;
    }).join("");
  }

  function renderCreditGoalList() {
    const list = $("#creditGoalList");
    if (!list) return;
    if (!state.creditGoals.length) {
      list.innerHTML = '<li class="empty">No goals yet. Set one to track progress.</li>';
      return;
    }
    const cur = latestScore();
    const curScore = cur ? Number(cur.score) : 0;
    list.innerHTML = state.creditGoals.map((g) => {
      const target = Number(g.targetScore);
      const pts = target - curScore;
      const today = new Date();
      const goalDt = new Date(g.targetDate);
      const monthsLeft = Math.max(1, Math.round((goalDt - today) / (30.44 * 24 * 60 * 60 * 1000)));
      const ptsPerMonth = pts > 0 ? (pts / monthsLeft).toFixed(1) : "0";
      let statusClass = "", statusText;
      if (curScore >= target) {
        statusClass = "positive"; statusText = "🎉 Goal reached!";
      } else if (monthsLeft < 1) {
        statusClass = "negative"; statusText = `Need ${pts} pts (deadline passed)`;
      } else {
        statusText = `Need ${pts} pts in ${monthsLeft} mo (${ptsPerMonth}/mo pace)`;
      }
      const note = g.note ? ` · ${escapeHtml(g.note)}` : "";
      const pct = curScore >= target ? 100
        : Math.max(0, Math.min(100, ((curScore - 300) / (target - 300)) * 100));
      return `
        <li class="progress-item">
          <div class="progress-header">
            <span class="progress-name">Reach ${target} by ${g.targetDate}${note}</span>
            <span class="progress-amount ${statusClass}">${statusText}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${curScore >= target ? "success" : ""}" style="width: ${pct}%"></div>
          </div>
          <div class="goal-actions">
            <button class="btn-secondary" data-action="del-credit-goal" data-id="${g.id}">Delete</button>
          </div>
        </li>`;
    }).join("");
  }

  function renderFreezes() {
    document.querySelectorAll('[data-freeze]').forEach((cb) => {
      const bureau = cb.dataset.freeze;
      const f = state.creditFreezes[bureau];
      cb.checked = !!(f && f.frozen);
      const status = cb.parentElement.querySelector(".freeze-status");
      if (status) {
        status.textContent = f && f.frozen
          ? `🔒 Frozen since ${f.date}`
          : "🔓 Not frozen";
      }
    });
  }

  function renderAnnualReports() {
    const el = $("#annualReportStatus");
    if (!el) return;
    const bureaus = ["Equifax", "Experian", "TransUnion"];
    el.innerHTML = bureaus.map((b) => {
      const r = state.annualReports[b];
      const lastPulled = r ? r.lastPulled : null;
      let status;
      if (!lastPulled) {
        status = '<span class="negative">Never pulled — get yours free</span>';
      } else {
        const months = Math.round((new Date() - new Date(lastPulled)) / (30.44 * 24 * 60 * 60 * 1000));
        if (months >= 12) {
          status = `<span class="negative">${months} mo ago — pull a fresh one</span>`;
        } else {
          status = `<span class="positive">${months} mo ago</span>`;
        }
      }
      return `
        <div class="annual-report-row">
          <div>
            <strong>${b}</strong>
            <div class="card-sub">${status}</div>
          </div>
          <button class="btn-secondary" data-action="mark-pulled" data-bureau="${b}">Mark Pulled Today</button>
        </div>`;
    }).join("");
  }

  function renderPayByCalendar() {
    const el = $("#payByCalendar");
    if (!el) return;
    const cards = state.cards.filter((c) => c.dueDay || c.closeDay);
    if (!cards.length) {
      el.innerHTML = '<p class="empty">Add cards with closing/due days to see the calendar.</p>';
      return;
    }
    const today = new Date();
    const events = [];
    cards.forEach((c) => {
      // Generate next-30-day events for each card's close + due
      [
        { day: c.closeDay, label: "Statement closes", icon: "📅", priority: 1 },
        { day: c.dueDay, label: "Payment due", icon: "💸", priority: 2 },
      ].forEach((spec) => {
        if (!spec.day) return;
        // Find next occurrence of this day
        const next = new Date(today.getFullYear(), today.getMonth(), spec.day);
        if (next < today) next.setMonth(next.getMonth() + 1);
        const days = Math.ceil((next - today) / (24 * 60 * 60 * 1000));
        if (days <= 30) {
          events.push({
            date: next.toISOString().slice(0, 10),
            days,
            cardName: c.name,
            label: spec.label,
            icon: spec.icon,
            priority: spec.priority,
          });
        }
      });
    });
    if (!events.length) {
      el.innerHTML = '<p class="empty">No statement or due dates in the next 30 days.</p>';
      return;
    }
    events.sort((a, b) => a.days - b.days);
    el.innerHTML = events.map((e) => {
      const cls = e.days <= 3 ? "urgent" : e.days <= 7 ? "soon" : "";
      return `
        <div class="payby-row ${cls}">
          <div class="payby-days">
            <div class="payby-num">${e.days}</div>
            <div class="payby-unit">day${e.days === 1 ? "" : "s"}</div>
          </div>
          <div class="payby-info">
            <div class="payby-event">${e.icon} ${e.label}</div>
            <div class="payby-card">${escapeHtml(e.cardName)}</div>
          </div>
          <div class="payby-date">${e.date}</div>
        </div>`;
    }).join("");
  }

  function renderAccountAgeTimeline() {
    const el = $("#accountAgeTimeline");
    if (!el) return;
    const cards = state.cards.filter((c) => c.opened);
    if (!cards.length) {
      el.innerHTML = '<p class="empty">Add open dates to your cards to see the timeline.</p>';
      return;
    }
    const sorted = [...cards].sort((a, b) => a.opened.localeCompare(b.opened));
    const oldest = new Date(sorted[0].opened);
    const today = new Date();
    const totalSpan = today - oldest;
    const ages = sorted.map((c) => (today - new Date(c.opened)) / (365.25 * 24 * 60 * 60 * 1000));
    const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length;
    const oldestYears = ages[0];

    let html = `<div class="age-summary">
      Oldest: <strong>${oldestYears.toFixed(1)} years</strong> · Average: <strong>${avgAge.toFixed(1)} years</strong>
    </div>`;
    sorted.forEach((c) => {
      const age = (today - new Date(c.opened)) / (365.25 * 24 * 60 * 60 * 1000);
      const offsetPct = totalSpan > 0
        ? ((new Date(c.opened) - oldest) / totalSpan) * 100
        : 0;
      html += `
        <div class="age-row">
          <div class="age-name">${escapeHtml(c.name)}</div>
          <div class="age-bar">
            <div class="age-marker" style="left: ${offsetPct.toFixed(1)}%" title="${c.opened}"></div>
          </div>
          <div class="age-years">${age.toFixed(1)}y</div>
        </div>`;
    });
    el.innerHTML = html;
  }

  function renderRewardsList() {
    const list = $("#rewardsList");
    if (!list) return;
    const cardsWithRewards = state.cards.filter((c) =>
      Number(c.cashbackRate) > 0 || Number(c.annualFee) > 0 || Number(c.signupBonus) > 0
    );
    if (!cardsWithRewards.length) {
      list.innerHTML = '<li class="empty">Add cashback rate, annual fee, or sign-up bonus to your cards.</li>';
      return;
    }
    list.innerHTML = cardsWithRewards.map((c) => {
      const cashback = Number(c.cashbackRate) || 0;
      const fee = Number(c.annualFee) || 0;
      const bonus = Number(c.signupBonus) || 0;
      // Estimated annual cashback: assume balance/2 = monthly spending heuristic, * 12 * cashback%
      // Better: just show the rate; user can interpret
      // Net annual value = signup bonus - annual fee + (estimated cashback if user spends average)
      // Estimate spending: use sum of all expense transactions / 12 if we have them
      const avgMonthly = state.expenses
        .filter((e) => e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out")
        .reduce((s, e) => s + Number(e.amount), 0) / 12;
      const estCashback = (avgMonthly * 12) * (cashback / 100);
      const netValue = bonus - fee + estCashback;

      return `
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">${escapeHtml(c.name)}</div>
            <div class="list-item-sub">
              ${cashback > 0 ? `${cashback}% cashback · ` : ""}
              ${fee > 0 ? `${fmt(fee)} annual fee · ` : ""}
              ${bonus > 0 ? `${fmt(bonus)} bonus earned` : ""}
            </div>
          </div>
          <div class="list-item-amount ${netValue >= 0 ? "positive" : "negative"}">
            ${netValue >= 0 ? "+" : ""}${fmt(netValue)}
            <div class="list-item-sub">est annual</div>
          </div>
        </li>`;
    }).join("");
  }

  function renderUtilTrendChart() {
    if (typeof Chart === "undefined") return;
    destroyChart("utilTrend");
    const ctx = $("#chartUtilTrend");
    if (!ctx) return;
    const history = state.utilHistory || [];
    if (history.length < 2) {
      $("#utilTrendEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#utilTrendEmpty").hidden = true;
    ctx.style.display = "block";
    const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
    const labels = sorted.map((s) => {
      const [y, m, d] = s.date.split("-");
      return new Date(Number(y), Number(m) - 1, Number(d))
        .toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });
    const data = sorted.map((s) => Number(s.util));
    charts.utilTrend = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Utilization %",
          data,
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245, 158, 11, 0.1)",
          tension: 0.3,
          fill: true,
          pointRadius: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(1)}%` } } },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => v + "%" }, grid: { color: "#eee" }, beginAtZero: true, max: 100 },
        },
      },
    });
  }

  function renderScoreProjection() {
    if (typeof Chart === "undefined") return;
    destroyChart("scoreProjection");
    const ctx = $("#chartScoreProjection");
    if (!ctx) return;
    const sorted = [...state.creditScores].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 2) {
      $("#scoreProjectionEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#scoreProjectionEmpty").hidden = true;
    ctx.style.display = "block";

    // Linear regression on the scores
    const n = sorted.length;
    const xs = sorted.map((_, i) => i);
    const ys = sorted.map((s) => Number(s.score));
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - meanX) * (ys[i] - meanY);
      den += (xs[i] - meanX) ** 2;
    }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanY - slope * meanX;

    // Avg interval between data points (in days)
    const totalDays = (new Date(sorted[n - 1].date) - new Date(sorted[0].date)) / (24 * 60 * 60 * 1000);
    const avgInterval = totalDays / (n - 1) || 30;

    const labels = sorted.map((s) => s.date.slice(5));
    const data = ys.slice();

    // Project 6 future points (one per avg interval)
    const future = [];
    for (let i = 1; i <= 6; i++) {
      const projected = Math.max(300, Math.min(850, slope * (n - 1 + i) + intercept));
      future.push(projected);
      const futureDate = new Date(sorted[n - 1].date);
      futureDate.setDate(futureDate.getDate() + Math.round(avgInterval * i));
      labels.push("→ " + futureDate.toISOString().slice(5, 10));
    }

    // Build datasets: actual values for 0..n-1, then null; projected null then values
    const actualData = ys.concat(new Array(future.length).fill(null));
    const projectedData = new Array(n - 1).fill(null).concat([ys[n - 1], ...future]);

    charts.scoreProjection = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Actual",
            data: actualData,
            borderColor: "#5b3fb8",
            backgroundColor: "rgba(91, 63, 184, 0.1)",
            tension: 0.3,
            pointRadius: 4,
          },
          {
            label: "Projected",
            data: projectedData,
            borderColor: "#5b3fb8",
            borderDash: [6, 4],
            backgroundColor: "rgba(91, 63, 184, 0.05)",
            tension: 0.3,
            pointRadius: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "top", labels: { boxWidth: 12 } } },
        scales: {
          x: { grid: { display: false } },
          y: { min: 300, max: 850, grid: { color: "#eee" } },
        },
      },
    });
  }

  /* ---------- Score milestone celebration ---------- */
  function checkScoreMilestones() {
    const cur = latestScore();
    const prev = previousScore();
    if (!cur || !prev) return;
    const milestones = [580, 670, 700, 740, 800];
    for (const m of milestones) {
      if (Number(prev.score) < m && Number(cur.score) >= m) {
        // Don't re-celebrate the same milestone in the same session
        if (cur._celebrated && cur._celebrated[m]) continue;
        if (!cur._celebrated) cur._celebrated = {};
        cur._celebrated[m] = true;
        celebrateMilestone(m);
      }
    }
  }

  function celebrateMilestone(score) {
    const labels = {
      580: "Fair", 670: "Good", 700: "🎉 Crossed 700!",
      740: "Very Good", 800: "🏆 Exceptional",
    };
    showAlertToast(`${labels[score] || ""} You hit ${score}!`, "success");
    // Confetti — simple emoji burst
    const confetti = ["🎉", "✨", "🎊", "⭐", "🌟"];
    const container = document.createElement("div");
    container.className = "confetti-container";
    for (let i = 0; i < 30; i++) {
      const e = document.createElement("span");
      e.textContent = confetti[Math.floor(Math.random() * confetti.length)];
      e.style.left = Math.random() * 100 + "%";
      e.style.animationDelay = (Math.random() * 0.5) + "s";
      e.style.animationDuration = (1.5 + Math.random()) + "s";
      container.appendChild(e);
    }
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 3500);
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
    $("#cardCloseDay").value = isEdit ? (card.closeDay || "") : "";
    $("#cardAnnualFee").value = isEdit ? (card.annualFee || "") : "";
    $("#cardCashback").value = isEdit ? (card.cashbackRate || "") : "";
    $("#cardBonus").value = isEdit ? (card.signupBonus || "") : "";
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

  function populateGoalSelect() {
    const sel = $("#expGoal");
    if (!sel) return;
    sel.innerHTML =
      '<option value="">— No goal —</option>' +
      state.goals
        .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`)
        .join("");

    // Also populate round-up destination
    const ruSel = $("#roundUpGoalSelect");
    if (ruSel) {
      ruSel.innerHTML =
        '<option value="">Select goal</option>' +
        state.goals
          .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`)
          .join("");
      if (state.settings.roundUpGoalId) {
        ruSel.value = state.settings.roundUpGoalId;
      }
    }
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

  /* ---------- Income charts ---------- */
  function renderCashFlowChart() {
    destroyChart("cashFlow");
    const ctx = $("#chartCashFlow");
    if (!ctx) return;

    const m = currentMonth();
    let monthsBack = 6;
    if (insightsPeriod === "12mo") monthsBack = 12;
    else if (insightsPeriod === "all") monthsBack = 12;

    const months = [];
    for (let i = monthsBack - 1; i >= 0; i--) months.push(monthOffset(m, -i));

    const incomes = months.map((mk) =>
      state.expenses
        .filter((e) => monthKey(e.date) === mk && e.type === "income")
        .reduce((s, e) => s + Number(e.amount), 0)
    );
    const spent = months.map((mk) =>
      state.expenses
        .filter((e) => monthKey(e.date) === mk && e.type !== "income"
          && e.type !== "transfer-in" && e.type !== "transfer-out")
        .reduce((s, e) => s + Number(e.amount), 0)
    );
    const net = incomes.map((inc, i) => inc - spent[i]);

    if (incomes.every((v) => v === 0) && spent.every((v) => v === 0)) {
      $("#cashFlowEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#cashFlowEmpty").hidden = true;
    ctx.style.display = "block";

    const labels = months.map((mk) => {
      const [y, mm] = mk.split("-");
      const d = new Date(Number(y), Number(mm) - 1, 1);
      return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    });

    charts.cashFlow = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Income",
            data: incomes,
            borderColor: "#22c55e",
            backgroundColor: "rgba(34, 197, 94, 0.1)",
            tension: 0.3,
            fill: false,
            pointRadius: 3,
          },
          {
            label: "Expenses",
            data: spent,
            borderColor: "#ec4899",
            backgroundColor: "rgba(236, 72, 153, 0.1)",
            tension: 0.3,
            fill: false,
            pointRadius: 3,
          },
          {
            label: "Net",
            data: net,
            borderColor: "#5b3fb8",
            backgroundColor: "rgba(91, 63, 184, 0.1)",
            tension: 0.3,
            fill: true,
            pointRadius: 4,
            borderWidth: 3,
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

  function renderIncomeSourcesChart() {
    destroyChart("incomeSources");
    const ctx = $("#chartIncomeSources");
    if (!ctx) return;

    let incomes = state.expenses.filter((e) => e.type === "income" && e.source);
    const m = currentMonth();
    if (insightsPeriod === "monthly") incomes = incomes.filter((e) => monthKey(e.date) === m);
    else if (insightsPeriod === "6mo") incomes = incomes.filter((e) => monthKey(e.date) >= monthOffset(m, -5));
    else if (insightsPeriod === "12mo") incomes = incomes.filter((e) => monthKey(e.date) >= monthOffset(m, -11));

    const totals = {};
    incomes.forEach((e) => {
      totals[e.source] = (totals[e.source] || 0) + Number(e.amount);
    });
    const labels = Object.keys(totals);
    const data = Object.values(totals);

    if (!labels.length) {
      $("#incomeSourcesEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#incomeSourcesEmpty").hidden = true;
    ctx.style.display = "block";

    charts.incomeSources = new Chart(ctx, {
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
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}` } },
        },
      },
    });
  }

  function renderIncomeTypeChart() {
    destroyChart("incomeType");
    const ctx = $("#chartIncomeType");
    if (!ctx) return;

    let incomes = state.expenses.filter((e) => e.type === "income");
    const m = currentMonth();
    if (insightsPeriod === "monthly") incomes = incomes.filter((e) => monthKey(e.date) === m);
    else if (insightsPeriod === "6mo") incomes = incomes.filter((e) => monthKey(e.date) >= monthOffset(m, -5));
    else if (insightsPeriod === "12mo") incomes = incomes.filter((e) => monthKey(e.date) >= monthOffset(m, -11));

    const labels = [];
    const totals = [];
    const typeNames = {
      salary: "💼 Salary", freelance: "💻 Freelance", bonus: "🎉 Bonus",
      investment: "📈 Investment", refund: "↩️ Refund", gift: "🎁 Gift", other: "Other",
    };
    Object.keys(typeNames).forEach((key) => {
      const sum = incomes
        .filter((e) => (e.incomeType || "other") === key)
        .reduce((s, e) => s + Number(e.amount), 0);
      if (sum > 0) {
        labels.push(typeNames[key]);
        totals.push(sum);
      }
    });

    if (!labels.length) {
      $("#incomeTypeEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#incomeTypeEmpty").hidden = true;
    ctx.style.display = "block";

    charts.incomeType = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: totals,
          backgroundColor: ["#22c55e", "#3b82f6", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#94a3b8"],
          borderRadius: 6,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => fmt(ctx.parsed.x) } },
        },
        scales: {
          x: { ticks: { callback: (v) => fmt(v) }, grid: { color: "#eee" } },
          y: { grid: { display: false } },
        },
      },
    });
  }

  function renderNetWorthChart() {
    destroyChart("netWorth");
    const ctx = $("#chartNetWorth");
    if (!ctx) return;

    const history = state.netWorthHistory || [];
    if (history.length < 2) {
      $("#netWorthEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#netWorthEmpty").hidden = true;
    ctx.style.display = "block";

    const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
    const labels = sorted.map((s) => {
      const [y, m, d] = s.date.split("-");
      return new Date(Number(y), Number(m) - 1, Number(d))
        .toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });
    const data = sorted.map((s) => s.value);

    charts.netWorth = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Net Worth",
          data,
          borderColor: "#5b3fb8",
          backgroundColor: "rgba(91, 63, 184, 0.1)",
          tension: 0.3,
          fill: true,
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `Net worth: ${fmt(ctx.parsed.y)}` } },
        },
        scales: {
          x: { grid: { display: false } },
          y: { ticks: { callback: (v) => fmt(v) }, grid: { color: "#eee" } },
        },
      },
    });
  }

  /* ---------- Heatmap calendar ---------- */
  function renderHeatmapCalendar() {
    const el = $("#heatmapCalendar");
    if (!el) return;
    const expenses = state.expenses.filter(
      (e) => e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    if (!expenses.length) {
      $("#heatmapEmpty").hidden = false;
      el.innerHTML = "";
      return;
    }
    $("#heatmapEmpty").hidden = true;

    // Aggregate by day for the past 365 days
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 364);

    const dayTotals = new Map();
    expenses.forEach((e) => {
      const d = new Date(e.date);
      d.setHours(0, 0, 0, 0);
      if (d < startDate || d > today) return;
      const key = e.date;
      dayTotals.set(key, (dayTotals.get(key) || 0) + Number(e.amount));
    });

    // Find max for intensity scaling
    const max = Math.max(1, ...Array.from(dayTotals.values()));

    // Build grid: 53 weeks × 7 days
    const cells = [];
    // Start on previous Sunday so columns align
    const start = new Date(startDate);
    while (start.getDay() !== 0) start.setDate(start.getDate() - 1);

    const monthLabels = [];
    let lastMonth = -1;
    for (let week = 0; week < 53; week++) {
      for (let day = 0; day < 7; day++) {
        const d = new Date(start);
        d.setDate(d.getDate() + week * 7 + day);
        if (d > today) {
          cells.push({ empty: true });
          continue;
        }
        const dateStr = d.toISOString().slice(0, 10);
        const amount = dayTotals.get(dateStr) || 0;
        const intensity = amount === 0 ? 0 : Math.min(4, Math.ceil((amount / max) * 4));
        cells.push({
          dateStr,
          amount,
          intensity,
          dow: day,
          week,
        });
        if (day === 0 && d.getMonth() !== lastMonth) {
          monthLabels.push({
            week,
            label: d.toLocaleDateString(undefined, { month: "short" }),
          });
          lastMonth = d.getMonth();
        }
      }
    }

    let html = '<div class="heatmap-month-labels">';
    monthLabels.forEach((m) => {
      html += `<span style="grid-column-start: ${m.week + 1}">${m.label}</span>`;
    });
    html += "</div>";

    html += '<div class="heatmap-grid">';
    cells.forEach((c) => {
      if (c.empty) {
        html += '<div class="heatmap-cell empty"></div>';
      } else {
        const tooltip = `${c.dateStr}: ${fmt(c.amount)}`;
        html += `<div class="heatmap-cell intensity-${c.intensity}" title="${tooltip}"></div>`;
      }
    });
    html += "</div>";

    html += `
      <div class="heatmap-legend">
        <span>Less</span>
        <div class="heatmap-cell intensity-0"></div>
        <div class="heatmap-cell intensity-1"></div>
        <div class="heatmap-cell intensity-2"></div>
        <div class="heatmap-cell intensity-3"></div>
        <div class="heatmap-cell intensity-4"></div>
        <span>More</span>
      </div>
    `;

    el.innerHTML = html;
  }

  /* ---------- Top vendors ---------- */
  function renderTopVendors() {
    const list = $("#topVendors");
    if (!list) return;
    const expenses = filterExpensesForInsights();
    if (!expenses.length) {
      list.innerHTML = '<li class="empty">No expenses yet.</li>';
      return;
    }
    const totals = {};
    const counts = {};
    expenses.forEach((e) => {
      const key = e.desc.trim();
      if (!key) return;
      totals[key] = (totals[key] || 0) + Number(e.amount);
      counts[key] = (counts[key] || 0) + 1;
    });
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) {
      list.innerHTML = '<li class="empty">No vendor data yet.</li>';
      return;
    }
    const max = sorted[0][1];
    list.innerHTML = sorted.map(([name, total], i) => {
      const pct = (total / max) * 100;
      return `
        <li class="vendor-row">
          <span class="vendor-rank">#${i + 1}</span>
          <div class="vendor-main">
            <div class="vendor-name">${escapeHtml(name)}</div>
            <div class="vendor-meta">${counts[name]} txn${counts[name] === 1 ? "" : "s"}</div>
          </div>
          <div class="vendor-bar"><div class="vendor-fill" style="width:${pct}%"></div></div>
          <span class="vendor-amt">${fmt(total)}</span>
        </li>`;
    }).join("");
  }

  /* ---------- Tags chart ---------- */
  function renderTagsChart() {
    if (typeof Chart === "undefined") return;
    destroyChart("tags");
    const ctx = $("#chartTags");
    if (!ctx) return;
    const expenses = filterExpensesForInsights();
    const totals = {};
    expenses.forEach((e) => {
      if (!Array.isArray(e.tags) || !e.tags.length) return;
      e.tags.forEach((t) => {
        totals[t] = (totals[t] || 0) + Number(e.amount);
      });
    });
    const labels = Object.keys(totals);
    if (!labels.length) {
      $("#tagsEmpty").hidden = false;
      ctx.style.display = "none";
      return;
    }
    $("#tagsEmpty").hidden = true;
    ctx.style.display = "block";
    const data = Object.values(totals);
    charts.tags = new Chart(ctx, {
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
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}` } },
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
    $("#expTags").value = (prefill && Array.isArray(prefill.tags)) ? prefill.tags.join(", ") : "";

    populateExpenseCategorySelect();
    populateAccountSelect("#expAccount", true);
    populatePersonSelect();
    populateGoalSelect();
    if (prefill && prefill.categoryId) {
      $("#expCategory").value = prefill.categoryId;
    }
    if (prefill && prefill.accountId) {
      $("#expAccount").value = prefill.accountId;
    }
    if (prefill && prefill.personId) {
      $("#expPerson").value = prefill.personId;
    }
    if (prefill && prefill.goalId) {
      $("#expGoal").value = prefill.goalId;
    }

    // Income-specific prefill
    if (prefill && prefill.type === "income") {
      $("#incomeType").value = prefill.incomeType || "salary";
      $("#incomeSource").value = prefill.source || "";
      $("#incomePreTax").checked = !!prefill.preTax;
    } else {
      $("#incomeType").value = "salary";
      $("#incomeSource").value = "";
      $("#incomePreTax").checked = false;
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

  function offerRecurringFromIncome(desc, amount, source, date) {
    const exists = state.recurring.some(
      (r) => r.type === "income" && r.desc.toLowerCase() === desc.toLowerCase()
    );
    if (exists) {
      showToast("Income added");
      return;
    }
    showToast("Income added");
    setTimeout(() => {
      const make = confirm(`Make "${desc}" a monthly recurring income?`);
      if (!make) return;
      const day = parseInt(date.slice(8, 10), 10) || 1;
      state.recurring.push({
        id: uid(),
        type: "income",
        desc,
        amount,
        categoryId: null,
        dayOfMonth: Math.min(28, day),
        active: true,
        lastRunMonth: monthKey(date),
      });
      saveData();
      renderRecurringList();
      showToast(`"${desc}" set to recur monthly`);
    }, 400);
  }

  /* ---------- Paycheck Logger ---------- */
  function openPaycheckModal() {
    $("#pcDate").value = todayStr();
    $("#pcEmployer").value = "";
    ["#pcGross", "#pcNet", "#pcFedTax", "#pcStateTax", "#pcFica", "#pcHealth", "#pc401k", "#pcHsa"].forEach((id) => {
      const el = $(id); if (el) el.value = "";
    });
    const status = $("#paystubStatus");
    if (status) {
      status.hidden = true;
      status.textContent = "";
      status.className = "paystub-status";
    }
    populateIncomeSourceList();
    initPaycheckSplits();
    $("#paycheckModal").classList.add("open");
    setTimeout(() => $("#pcEmployer")?.focus(), 50);
  }
  function closePaycheckModal() {
    $("#paycheckModal").classList.remove("open");
  }

  function initPaycheckSplits() {
    const container = $("#paycheckSplits");
    container.innerHTML = "";
    if (state.accounts.length === 0) {
      container.innerHTML = '<p class="empty">Add accounts in Balances first.</p>';
      return;
    }
    // Default: one row, full net pay to first account
    addSplitRow(state.accounts[0].id, "");
    updateSplitRemaining();
  }

  function addSplitRow(accountId, amount) {
    const container = $("#paycheckSplits");
    const idx = container.children.length;
    const div = document.createElement("div");
    div.className = "paycheck-split-row";
    div.dataset.idx = String(idx);
    div.innerHTML = `
      <select class="split-account">
        ${state.accounts.map((a) =>
          `<option value="${a.id}" ${a.id === accountId ? "selected" : ""}>${escapeHtml(a.name)}</option>`
        ).join("")}
      </select>
      <input type="number" class="split-amount" step="0.01" min="0" placeholder="0.00" value="${amount}" />
      <button type="button" class="icon-btn split-remove" aria-label="Remove">×</button>
    `;
    container.appendChild(div);
    div.querySelector(".split-amount").addEventListener("input", updateSplitRemaining);
    div.querySelector(".split-remove").addEventListener("click", () => {
      div.remove();
      updateSplitRemaining();
    });
  }

  function updateSplitRemaining() {
    const net = parseFloat($("#pcNet").value) || 0;
    const inputs = $$(".split-amount");
    let assigned = 0;
    inputs.forEach((i) => assigned += parseFloat(i.value) || 0);
    const remaining = net - assigned;
    const el = $("#splitRemaining");
    if (Math.abs(remaining) < 0.01) {
      el.innerHTML = `<span class="positive">✓ All ${fmt(net)} assigned</span>`;
    } else if (remaining > 0) {
      el.innerHTML = `<span style="color:var(--warning)">${fmt(remaining)} unassigned</span>`;
    } else {
      el.innerHTML = `<span class="negative">Over-assigned by ${fmt(Math.abs(remaining))}</span>`;
    }
  }

  /* ---------- Paystub upload & parsing ---------- */
  async function handlePaystubUpload(file) {
    const status = $("#paystubStatus");
    status.hidden = false;
    status.className = "paystub-status";
    status.textContent = "Reading paystub…";
    try {
      let text = "";
      if (file.type === "application/pdf") {
        if (!window.pdfjsLib) {
          status.textContent = "PDF library not loaded. Try image instead.";
          return;
        }
        const buf = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map((it) => it.str).join(" ") + "\n";
        }
      } else if (file.type.startsWith("image/")) {
        status.textContent = "Loading OCR engine (one-time, ~10MB)…";
        text = await ocrImage(file, (progress) => {
          status.textContent = `OCR scanning… ${Math.round(progress * 100)}%`;
        });
      } else {
        status.textContent = "Unsupported file type. Use PDF or image.";
        return;
      }

      status.textContent = "Parsing paystub data…";
      const parsed = parsePaystub(text);
      applyPaystubToForm(parsed);

      const found = [];
      if (parsed.employer) found.push("employer");
      if (parsed.date) found.push("date");
      if (parsed.gross) found.push("gross");
      if (parsed.net) found.push("net");
      if (parsed.fedTax || parsed.stateTax || parsed.fica) found.push("taxes");
      if (parsed.k401 || parsed.hsa) found.push("retirement");

      if (found.length === 0) {
        status.className = "paystub-status warn";
        status.textContent = "Couldn't auto-detect fields. Fill them in manually.";
      } else {
        status.className = "paystub-status success";
        status.textContent = `✓ Found: ${found.join(", ")}. Review and adjust before saving.`;
      }
    } catch (e) {
      console.error(e);
      status.className = "paystub-status warn";
      status.textContent = "Failed to read this file. Try a different one or fill manually.";
    }
  }

  // Lazy-load Tesseract.js for image OCR
  let tesseractLoaded = null;
  async function ocrImage(file, progressCb) {
    if (!window.Tesseract) {
      if (!tesseractLoaded) {
        tesseractLoaded = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js";
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      await tesseractLoaded;
    }
    const result = await window.Tesseract.recognize(file, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text" && progressCb) progressCb(m.progress);
      },
    });
    return result.data.text || "";
  }

  function parsePaystub(rawText) {
    const text = rawText.replace(/\s+/g, " ").trim();
    const lines = rawText.split(/\n|\r/).map((l) => l.trim()).filter(Boolean);
    const result = {
      employer: null, date: null,
      gross: null, net: null,
      fedTax: null, stateTax: null, fica: null,
      health: null, k401: null, hsa: null,
    };

    // --- Employer: look for Company Name pattern, often at top of document
    // Heuristic: first line that has "Inc", "LLC", "Corp", "Co.", "Company", "Group", "Ltd"
    // Otherwise, the first line that's all caps or title-case 2+ words and not "Pay Stub" etc.
    const companyKeywords = /(Inc\.?|LLC|L\.L\.C\.|Corp\.?|Corporation|Co\.|Company|Ltd\.?|Group|Holdings)/;
    for (const line of lines.slice(0, 10)) {
      if (companyKeywords.test(line) && line.length < 100) {
        result.employer = line.replace(/Pay\s*stub/i, "").trim();
        break;
      }
    }

    // Date: Pay date / Period end / Check date
    const dateRegexes = [
      /Pay\s*Date\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
      /Check\s*Date\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
      /Period\s*End(?:ing)?\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
      /(\d{1,2}\/\d{1,2}\/\d{2,4})/, // fallback
    ];
    for (const re of dateRegexes) {
      const m = text.match(re);
      if (m) {
        result.date = normalizeDate(m[1]);
        if (result.date) break;
      }
    }

    // Field amounts — match common labels then the next dollar amount
    const fieldPatterns = [
      ["gross", /(?:Gross\s*(?:Pay|Earnings|Wages))\s*\$?\s*([\d,]+\.\d{2})/i],
      ["net", /(?:Net\s*(?:Pay|Wages|Check)|Take[\s\-]?Home)\s*\$?\s*([\d,]+\.\d{2})/i],
      ["fedTax", /(?:Federal\s*(?:Income\s*)?Tax|Fed\.?\s*W\/H|FIT)\s*\$?\s*([\d,]+\.\d{2})/i],
      ["stateTax", /(?:State\s*(?:Income\s*)?Tax|State\s*W\/H|SIT)\s*\$?\s*([\d,]+\.\d{2})/i],
      ["fica", /(?:FICA|Social\s*Security|OASDI)\s*\$?\s*([\d,]+\.\d{2})/i],
      ["health", /(?:Health\s*(?:Insurance)?|Medical|Dental|Vision)\s*\$?\s*([\d,]+\.\d{2})/i],
      ["k401", /(?:401\s*\(?k\)?|Retirement|Pension)\s*\$?\s*([\d,]+\.\d{2})/i],
      ["hsa", /(?:HSA|FSA|Health\s*Savings)\s*\$?\s*([\d,]+\.\d{2})/i],
    ];

    fieldPatterns.forEach(([key, re]) => {
      const m = text.match(re);
      if (m) {
        result[key] = Number(m[1].replace(/,/g, ""));
      }
    });

    // If we found Medicare separately and FICA missed, add Medicare to FICA
    const med = text.match(/Medicare\s*\$?\s*([\d,]+\.\d{2})/i);
    if (med && result.fica !== null) {
      result.fica += Number(med[1].replace(/,/g, ""));
    } else if (med && result.fica === null) {
      result.fica = Number(med[1].replace(/,/g, ""));
    }

    return result;
  }

  function normalizeDate(d) {
    // d like "12/31/2024" or "12/31/24"
    const parts = d.split("/");
    if (parts.length !== 3) return null;
    let [mm, dd, yy] = parts;
    if (yy.length === 2) yy = "20" + yy;
    if (mm.length === 1) mm = "0" + mm;
    if (dd.length === 1) dd = "0" + dd;
    const result = `${yy}-${mm}-${dd}`;
    // Sanity: must be parseable
    if (isNaN(new Date(result).getTime())) return null;
    return result;
  }

  function applyPaystubToForm(p) {
    if (p.employer) $("#pcEmployer").value = p.employer;
    if (p.date) $("#pcDate").value = p.date;
    if (p.gross !== null) $("#pcGross").value = p.gross.toFixed(2);
    if (p.net !== null) $("#pcNet").value = p.net.toFixed(2);
    if (p.fedTax !== null) $("#pcFedTax").value = p.fedTax.toFixed(2);
    if (p.stateTax !== null) $("#pcStateTax").value = p.stateTax.toFixed(2);
    if (p.fica !== null) $("#pcFica").value = p.fica.toFixed(2);
    if (p.health !== null) $("#pcHealth").value = p.health.toFixed(2);
    if (p.k401 !== null) $("#pc401k").value = p.k401.toFixed(2);
    if (p.hsa !== null) $("#pcHsa").value = p.hsa.toFixed(2);

    // If gross + deductions known but not net, compute it
    if (p.gross !== null && p.net === null) {
      const totalDed = (p.fedTax || 0) + (p.stateTax || 0) + (p.fica || 0)
        + (p.health || 0) + (p.k401 || 0) + (p.hsa || 0);
      $("#pcNet").value = Math.max(0, p.gross - totalDed).toFixed(2);
    }

    updateSplitRemaining();
  }

  function savePaycheck() {
    const employer = $("#pcEmployer").value.trim();
    const date = $("#pcDate").value;
    const gross = parseFloat($("#pcGross").value);
    const net = parseFloat($("#pcNet").value);
    if (!employer || !date || isNaN(gross) || isNaN(net)) return false;

    const fedTax = parseFloat($("#pcFedTax").value) || 0;
    const stateTax = parseFloat($("#pcStateTax").value) || 0;
    const fica = parseFloat($("#pcFica").value) || 0;
    const health = parseFloat($("#pcHealth").value) || 0;
    const k401 = parseFloat($("#pc401k").value) || 0;
    const hsa = parseFloat($("#pcHsa").value) || 0;

    // Collect splits
    const splits = [];
    $$(".paycheck-split-row").forEach((row) => {
      const accountId = row.querySelector(".split-account").value;
      const amount = parseFloat(row.querySelector(".split-amount").value) || 0;
      if (amount > 0 && accountId) splits.push({ accountId, amount });
    });
    const splitTotal = splits.reduce((s, x) => s + x.amount, 0);
    if (Math.abs(splitTotal - net) > 0.01) {
      if (!confirm(`Split total (${fmt(splitTotal)}) doesn't match net pay (${fmt(net)}). Save anyway?`)) {
        return false;
      }
    }

    const paycheckId = uid();

    // Create the income transaction (gross amount, pre-tax flag true)
    state.expenses.push({
      id: uid(),
      type: "income",
      desc: `Paycheck — ${employer}`,
      amount: gross,
      date,
      categoryId: null,
      accountId: null, // gross goes nowhere directly; net is split below
      personId: null,
      tags: ["paycheck"],
      receipt: null,
      incomeType: "salary",
      source: employer,
      preTax: true,
      paycheckId,
      paycheckMeta: {
        gross, net, fedTax, stateTax, fica, health, k401, hsa,
      },
    });

    // Create deduction expenses (categorized as Tax / Benefits where possible)
    const taxCat = state.categories.find((c) => /tax/i.test(c.name))?.id || null;
    const otherCat = state.categories.find((c) => c.name === "Other")?.id || null;
    const deductions = [
      ["Federal tax", fedTax, taxCat],
      ["State tax", stateTax, taxCat],
      ["FICA", fica, taxCat],
      ["Health insurance", health, otherCat],
      ["401(k)", k401, otherCat],
      ["HSA/FSA", hsa, otherCat],
    ];
    deductions.forEach(([name, amount, catId]) => {
      if (amount <= 0) return;
      state.expenses.push({
        id: uid(),
        type: "expense",
        desc: `${name} (${employer})`,
        amount,
        date,
        categoryId: catId,
        accountId: null,
        personId: null,
        tags: ["paycheck-deduction"],
        receipt: null,
        paycheckId,
      });
    });

    // Create transfer-in transactions for each account split
    splits.forEach((split) => {
      state.expenses.push({
        id: uid(),
        type: "transfer-in",
        desc: `Paycheck split — ${employer}`,
        amount: split.amount,
        date,
        categoryId: null,
        accountId: split.accountId,
        personId: null,
        tags: ["paycheck"],
        receipt: null,
        paycheckId,
      });
    });

    saveData();
    closePaycheckModal();
    renderAll();
    showToast(`Paycheck logged: ${fmt(gross)} gross, ${fmt(net)} net`);
    return true;
  }

  function setModalType(type) {
    currentModalType = type;
    $$(".type-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === type));
    const catSel = $("#expCategory");
    const catRow = $("#categoryRow");
    const incomeFields = $("#incomeOnlyFields");
    if (type === "income") {
      catSel.required = false;
      catRow.querySelector("label").textContent = "Category (optional)";
      if (incomeFields) {
        incomeFields.style.display = "block";
        populateIncomeSourceList();
      }
    } else {
      catSel.required = true;
      catRow.querySelector("label").textContent = "Category";
      if (incomeFields) incomeFields.style.display = "none";
    }
  }

  function populateIncomeSourceList() {
    const list = $("#incomeSourceList");
    if (!list) return;
    const sources = new Set();
    state.expenses
      .filter((e) => e.type === "income" && e.source)
      .forEach((e) => sources.add(e.source));
    list.innerHTML = [...sources]
      .map((s) => `<option value="${escapeHtml(s)}"></option>`)
      .join("");
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

    // Tax estimator inputs
    if ($("#taxFilingStatus")) {
      $("#taxFilingStatus").addEventListener("change", renderTaxEstimate);
      $("#taxStateRate").addEventListener("input", renderTaxEstimate);
    }

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
      const goalId = $("#expGoal").value;
      const tagsRaw = $("#expTags").value.trim();
      const tags = tagsRaw
        ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
      const receipt = $("#receiptPreview").dataset.dataUrl || null;
      const editId = $("#expEditId").value;
      const type = currentModalType;

      // Income-specific fields
      const incomeType = type === "income" ? $("#incomeType").value : null;
      const source = type === "income" ? $("#incomeSource").value.trim() || null : null;
      const preTax = type === "income" ? $("#incomePreTax").checked : false;

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
            goalId: goalId || null,
            tags,
            receipt,
            incomeType,
            source,
            preTax,
          };
        }
      } else {
        state.expenses.push({
          id: uid(), type, desc, amount, date,
          categoryId: categoryId || null,
          accountId: accountId || null,
          personId: personId || null,
          goalId: goalId || null,
          tags,
          receipt,
          incomeType,
          source,
          preTax,
        });

        // Apply manual goal contribution: amount goes toward saved
        if (goalId && type === "expense") {
          const g = state.goals.find((x) => x.id === goalId);
          if (g) g.saved = (Number(g.saved) || 0) + Number(amount);
        }

        // Round-up savings
        if (
          state.settings.roundUpEnabled &&
          state.settings.roundUpGoalId &&
          type === "expense"
        ) {
          const cents = Math.round(Number(amount) * 100) % 100;
          const roundUp = cents === 0 ? 0 : (100 - cents) / 100;
          if (roundUp > 0) {
            const g = state.goals.find((x) => x.id === state.settings.roundUpGoalId);
            if (g) {
              g.saved = (Number(g.saved) || 0) + roundUp;
              showToast(`+${fmt(roundUp)} rounded up to ${g.name}`);
            }
          }
        }
      }
      saveData();
      closeExpenseModal();
      renderAll();
      checkBudgetAlerts();

      // Suggest making this recurring if it's a paycheck-style income
      if (!editId && type === "income" && amount >= 100 && incomeType === "salary") {
        offerRecurringFromIncome(desc, amount, source, date);
      } else {
        showToast(editId ? "Transaction updated" : (type === "income" ? "Income added" : "Transaction added"));
      }
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
    $("#helpBtn")?.addEventListener("click", showShortcutsHelp);
    $("#replayTourBtn")?.addEventListener("click", () => {
      localStorage.removeItem(TOUR_KEY);
      startTour();
    });
    $("#showShortcutsBtn")?.addEventListener("click", showShortcutsHelp);

    // Print monthly report
    $("#printReportBtn")?.addEventListener("click", openPrintReport);

    // AI insights settings
    const aiProvSel = $("#aiProvider");
    const aiKeyInput = $("#aiKey");
    if (aiProvSel) {
      aiProvSel.value = localStorage.getItem(KEYS.aiProvider) || "";
      const stored = localStorage.getItem(KEYS.aiKey) || "";
      // Show only first/last 4 chars masked
      aiKeyInput.value = stored ? stored.slice(0, 4) + "•••••••••••" + stored.slice(-4) : "";
      aiKeyInput.addEventListener("focus", () => {
        if (aiKeyInput.dataset.unlocked !== "true") {
          aiKeyInput.value = stored;
          aiKeyInput.dataset.unlocked = "true";
        }
      });
    }
    $("#saveAiKey")?.addEventListener("click", () => {
      const provider = $("#aiProvider").value;
      const key = $("#aiKey").value.trim();
      if (provider && !key) {
        showToast("Enter an API key");
        return;
      }
      localStorage.setItem(KEYS.aiProvider, provider);
      if (key && !key.includes("•")) {
        localStorage.setItem(KEYS.aiKey, key);
      }
      if (!provider) {
        localStorage.removeItem(KEYS.aiKey);
      }
      showToast(provider ? "AI settings saved" : "AI disabled");
    });

    // Ask AI button
    $("#askAiBtn")?.addEventListener("click", askAiInsights);
    $("#addTxnBtn").addEventListener("click", () => {
      openExpenseModal();
    });
    $("#addIncomeBtn").addEventListener("click", () => {
      openExpenseModal({ type: "income" });
    });

    // Paycheck logger
    $("#paycheckBtn").addEventListener("click", openPaycheckModal);
    $("#paycheckClose").addEventListener("click", closePaycheckModal);
    $("#paycheckModal").addEventListener("click", (e) => {
      if (e.target.id === "paycheckModal") closePaycheckModal();
    });
    $("#addSplitBtn").addEventListener("click", () => {
      if (state.accounts.length === 0) {
        showToast("Add accounts in Balances first");
        return;
      }
      addSplitRow(state.accounts[0].id, "");
      updateSplitRemaining();
    });
    $("#pcNet").addEventListener("input", updateSplitRemaining);
    $("#pcGross").addEventListener("input", () => {
      // Auto-fill net = gross minus deductions if user hasn't set it
      const gross = parseFloat($("#pcGross").value) || 0;
      const totalDed = ["#pcFedTax", "#pcStateTax", "#pcFica", "#pcHealth", "#pc401k", "#pcHsa"]
        .reduce((s, id) => s + (parseFloat($(id).value) || 0), 0);
      if (gross > 0 && !$("#pcNet").value) {
        $("#pcNet").value = (gross - totalDed).toFixed(2);
        updateSplitRemaining();
      }
    });
    ["#pcFedTax", "#pcStateTax", "#pcFica", "#pcHealth", "#pc401k", "#pcHsa"].forEach((id) => {
      $(id).addEventListener("input", () => {
        const gross = parseFloat($("#pcGross").value) || 0;
        const totalDed = ["#pcFedTax", "#pcStateTax", "#pcFica", "#pcHealth", "#pc401k", "#pcHsa"]
          .reduce((s, sid) => s + (parseFloat($(sid).value) || 0), 0);
        if (gross > 0) {
          $("#pcNet").value = Math.max(0, gross - totalDed).toFixed(2);
          updateSplitRemaining();
        }
      });
    });
    $("#paycheckForm").addEventListener("submit", (e) => {
      e.preventDefault();
      savePaycheck();
    });

    // Paystub upload
    $("#paystubUploadBtn").addEventListener("click", () => $("#paystubFile").click());
    $("#paystubFile").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handlePaystubUpload(file);
      e.target.value = ""; // allow re-uploading same file
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

    // Round-up settings
    const roundToggle = $("#roundUpToggle");
    if (roundToggle) {
      roundToggle.checked = !!state.settings.roundUpEnabled;
      $("#roundUpGoalRow").style.display = roundToggle.checked ? "block" : "none";
      roundToggle.addEventListener("change", (e) => {
        state.settings.roundUpEnabled = e.target.checked;
        $("#roundUpGoalRow").style.display = e.target.checked ? "block" : "none";
        saveData();
        renderRoundUpStats();
        showToast(e.target.checked ? "Round-up enabled" : "Round-up disabled");
      });
    }
    const ruGoalSel = $("#roundUpGoalSelect");
    if (ruGoalSel) {
      ruGoalSel.addEventListener("change", (e) => {
        state.settings.roundUpGoalId = e.target.value || null;
        saveData();
        renderRoundUpStats();
      });
    }

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
      const oldCard = editId ? state.cards.find((c) => c.id === editId) : null;
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
        closeDay: parseInt($("#cardCloseDay").value, 10) || null,
        opened: $("#cardOpened").value || null,
        cardType: $("#cardType").value || "credit",
        autopay: $("#cardAutopay").checked,
        annualFee: parseFloat($("#cardAnnualFee").value) || 0,
        cashbackRate: parseFloat($("#cardCashback").value) || 0,
        signupBonus: parseFloat($("#cardBonus").value) || 0,
      };
      if (!card.name) return;

      // Auto-log a limit-increase entry if user raised the limit
      if (oldCard && Number(card.limit) > Number(oldCard.limit) && oldCard.limit > 0) {
        state.limitIncreases.push({
          id: uid(),
          cardId: card.id,
          oldLimit: Number(oldCard.limit),
          newLimit: Number(card.limit),
          date: todayStr(),
          note: "Auto-logged from card edit",
        });
      }

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
      checkScoreMilestones();
      showToast("Score logged");
    });

    // Inquiry modal
    $("#addInquiryBtn").addEventListener("click", () => {
      $("#inquiryDate").value = todayStr();
      $("#inquiryReason").value = "";
      $("#inquiryBureau").value = "";
      $("#inquiryModal").classList.add("open");
    });
    $("#inquiryClose").addEventListener("click", () => $("#inquiryModal").classList.remove("open"));
    $("#inquiryModal").addEventListener("click", (e) => {
      if (e.target.id === "inquiryModal") $("#inquiryModal").classList.remove("open");
    });
    $("#inquiryForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const date = $("#inquiryDate").value;
      const reason = $("#inquiryReason").value.trim();
      const bureau = $("#inquiryBureau").value || null;
      if (!date || !reason) return;
      state.creditInquiries.push({
        id: uid(), date, reason, bureau, type: "hard",
      });
      saveData();
      $("#inquiryModal").classList.remove("open");
      renderCredit();
      showToast("Inquiry logged");
    });

    // Negative item modal
    $("#addNegativeBtn").addEventListener("click", () => {
      $("#negDate").value = todayStr();
      $("#negCreditor").value = "";
      $("#negAmount").value = "";
      $("#negNote").value = "";
      $("#negativeModal").classList.add("open");
    });
    $("#negativeClose").addEventListener("click", () => $("#negativeModal").classList.remove("open"));
    $("#negativeModal").addEventListener("click", (e) => {
      if (e.target.id === "negativeModal") $("#negativeModal").classList.remove("open");
    });
    $("#negativeForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const type = $("#negType").value;
      const date = $("#negDate").value;
      if (!type || !date) return;
      state.negativeItems.push({
        id: uid(),
        type, date,
        creditor: $("#negCreditor").value.trim(),
        amount: parseFloat($("#negAmount").value) || 0,
        note: $("#negNote").value.trim(),
      });
      saveData();
      $("#negativeModal").classList.remove("open");
      renderCredit();
      showToast("Negative item logged");
    });

    // Credit goal modal
    $("#addGoalBtn").addEventListener("click", () => {
      $("#goalScore").value = "";
      $("#goalDate2").value = "";
      $("#goalNote").value = "";
      $("#creditGoalModal").classList.add("open");
    });
    $("#creditGoalClose").addEventListener("click", () => $("#creditGoalModal").classList.remove("open"));
    $("#creditGoalModal").addEventListener("click", (e) => {
      if (e.target.id === "creditGoalModal") $("#creditGoalModal").classList.remove("open");
    });
    $("#creditGoalForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const targetScore = parseInt($("#goalScore").value, 10);
      const targetDate = $("#goalDate2").value;
      const note = $("#goalNote").value.trim();
      if (!targetScore || !targetDate) return;
      state.creditGoals.push({
        id: uid(), targetScore, targetDate, note,
      });
      saveData();
      $("#creditGoalModal").classList.remove("open");
      renderCredit();
      showToast("Goal set");
    });

    // Freezes
    document.querySelectorAll('[data-freeze]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const bureau = e.target.dataset.freeze;
        if (e.target.checked) {
          state.creditFreezes[bureau] = { frozen: true, date: todayStr() };
        } else {
          state.creditFreezes[bureau] = { frozen: false, date: null };
        }
        saveData();
        renderFreezes();
        showToast(`${bureau} ${e.target.checked ? "frozen" : "unfrozen"}`);
      });
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
      } else if (action === "del-inquiry") {
        if (confirm("Delete this inquiry?")) {
          state.creditInquiries = state.creditInquiries.filter((x) => x.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "del-negative") {
        if (confirm("Delete this negative item?")) {
          state.negativeItems = state.negativeItems.filter((x) => x.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "del-limit") {
        if (confirm("Delete this limit increase entry?")) {
          state.limitIncreases = state.limitIncreases.filter((x) => x.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "del-credit-goal") {
        if (confirm("Delete this credit goal?")) {
          state.creditGoals = state.creditGoals.filter((x) => x.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "mark-pulled") {
        const bureau = btn.dataset.bureau;
        state.annualReports[bureau] = { lastPulled: todayStr() };
        saveData();
        renderAnnualReports();
        showToast(`${bureau} report marked pulled today`);
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

    // Auto-lock timeout
    const autoLockSel = $("#autoLockSelect");
    if (autoLockSel) {
      autoLockSel.value = localStorage.getItem(KEYS.autoLock) || "10";
      autoLockSel.addEventListener("change", (e) => {
        localStorage.setItem(KEYS.autoLock, e.target.value);
        autoLockMinutes = parseInt(e.target.value, 10);
        resetAutoLockTimer();
        showToast(autoLockMinutes === 0 ? "Auto-lock disabled" : `Auto-lock set to ${autoLockMinutes} min`);
      });
    }

    // Hide amounts (stealth mode)
    const hideToggle = $("#hideAmountsToggle");
    if (hideToggle) {
      hideToggle.checked = hideAmounts;
      hideToggle.addEventListener("change", (e) => {
        hideAmounts = e.target.checked;
        localStorage.setItem(KEYS.hideAmounts, hideAmounts ? "true" : "false");
        renderAll();
        showToast(hideAmounts ? "Stealth mode on" : "Stealth mode off");
      });
    }

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
            netWorthHistory: data.netWorthHistory || [],
            creditInquiries: data.creditInquiries || [],
            negativeItems: data.negativeItems || [],
            limitIncreases: data.limitIncreases || [],
            creditGoals: data.creditGoals || [],
            utilHistory: data.utilHistory || [],
            creditFreezes: data.creditFreezes || {},
            annualReports: data.annualReports || {},
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
          netWorthHistory: [],
          creditInquiries: [],
          negativeItems: [],
          limitIncreases: [],
          creditGoals: [],
          utilHistory: [],
          creditFreezes: {},
          annualReports: {},
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

  /* ---------- Keyboard shortcuts ---------- */
  function initKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      // Don't fire if typing in input/textarea/contenteditable
      const t = e.target;
      if (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable
      ) return;
      // Don't fire if a modal is open
      if (document.querySelector(".modal.open")) {
        if (e.key === "Escape") {
          document.querySelectorAll(".modal.open").forEach((m) => m.classList.remove("open"));
        }
        return;
      }
      // Don't fire if app is locked
      if ($("#app").hidden) return;

      const key = e.key.toLowerCase();
      switch (key) {
        case "n":
          e.preventDefault();
          openExpenseModal();
          break;
        case "i":
          e.preventDefault();
          openExpenseModal({ type: "income" });
          break;
        case "p":
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            openPaycheckModal();
          }
          break;
        case "/":
          e.preventDefault();
          // Switch to transactions tab and focus search
          $('[data-tab="transactions"]')?.click();
          setTimeout(() => $("#txnSearch")?.focus(), 100);
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          e.preventDefault();
          const tabs = $$(".nav-item");
          const idx = parseInt(key, 10) - 1;
          if (tabs[idx]) tabs[idx].click();
          break;
        }
        case "?":
          e.preventDefault();
          showShortcutsHelp();
          break;
        case "l":
          if (e.shiftKey) {
            e.preventDefault();
            lockNow();
          }
          break;
      }
    });
  }

  function showShortcutsHelp() {
    const existing = document.getElementById("shortcutsModal");
    if (existing) {
      existing.classList.add("open");
      return;
    }
    const div = document.createElement("div");
    div.id = "shortcutsModal";
    div.className = "modal open";
    div.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <h2>⌨️ Keyboard Shortcuts</h2>
          <button class="modal-close" id="shortcutsClose">×</button>
        </div>
        <div class="shortcuts-list">
          <div class="shortcut-row"><kbd>N</kbd> <span>New transaction</span></div>
          <div class="shortcut-row"><kbd>I</kbd> <span>New income</span></div>
          <div class="shortcut-row"><kbd>P</kbd> <span>Log paycheck</span></div>
          <div class="shortcut-row"><kbd>/</kbd> <span>Search transactions</span></div>
          <div class="shortcut-row"><kbd>1</kbd>–<kbd>7</kbd> <span>Switch tabs</span></div>
          <div class="shortcut-row"><kbd>Shift</kbd>+<kbd>L</kbd> <span>Lock app</span></div>
          <div class="shortcut-row"><kbd>Esc</kbd> <span>Close modal</span></div>
          <div class="shortcut-row"><kbd>?</kbd> <span>This help</span></div>
        </div>
      </div>
    `;
    document.body.appendChild(div);
    div.querySelector("#shortcutsClose").addEventListener("click", () => div.classList.remove("open"));
    div.addEventListener("click", (e) => {
      if (e.target === div) div.classList.remove("open");
    });
  }
  /* ---------- AI Insights (BYOK) ---------- */
  async function askAiInsights() {
    const provider = localStorage.getItem(KEYS.aiProvider);
    const key = localStorage.getItem(KEYS.aiKey);
    const responseEl = $("#aiResponse");
    if (!provider || !key) {
      responseEl.hidden = false;
      responseEl.className = "ai-response warn";
      responseEl.innerHTML = `Add an API key in <strong>Settings → AI Insights</strong> to enable.`;
      return;
    }

    responseEl.hidden = false;
    responseEl.className = "ai-response loading";
    responseEl.textContent = "🤖 Thinking…";

    const m = currentMonth();
    const monthExpenses = state.expenses.filter(
      (e) => monthKey(e.date) === m && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    const monthIncomes = state.expenses.filter((e) => e.type === "income" && monthKey(e.date) === m);
    const totalSpent = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalIncome = monthIncomes.reduce((s, e) => s + Number(e.amount), 0);

    const catTotals = {};
    monthExpenses.forEach((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const name = cat ? cat.name : "Uncategorized";
      catTotals[name] = (catTotals[name] || 0) + Number(e.amount);
    });

    const top10 = [...monthExpenses]
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 10)
      .map((e) => `${e.desc}: ${currencySymbols[currency] || "$"}${Number(e.amount).toFixed(2)}`);

    const cardSummary = state.cards.map((c) =>
      `${c.name}: balance ${currencySymbols[currency] || "$"}${(c.balance || 0).toFixed(0)} of ${(c.limit || 0).toFixed(0)} limit`
    );

    const latestSc = state.creditScores.length
      ? [...state.creditScores].sort((a, b) => b.date.localeCompare(a.date))[0].score
      : null;

    const context = `
You are a helpful personal finance coach. Give 3-5 concise, actionable insights based on this user's data:

MONTH: ${monthLabel(m)}
INCOME: ${currencySymbols[currency] || "$"}${totalIncome.toFixed(0)}
TOTAL SPENT: ${currencySymbols[currency] || "$"}${totalSpent.toFixed(0)}
SAVINGS RATE: ${totalIncome > 0 ? (((totalIncome - totalSpent) / totalIncome) * 100).toFixed(0) : "0"}%
${latestSc ? `CREDIT SCORE: ${latestSc}` : ""}

CATEGORIES (this month):
${Object.entries(catTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${currencySymbols[currency] || "$"}${v.toFixed(0)}`).join("\n")}

TOP TRANSACTIONS:
${top10.join("\n")}

${cardSummary.length ? `CREDIT CARDS:\n${cardSummary.join("\n")}` : ""}

Format your response as a numbered list of short, specific recommendations. No fluff. Use plain text, no markdown headers.
`.trim();

    try {
      let response;
      if (provider === "openai") {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: context }],
            max_tokens: 500,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "OpenAI error");
        response = data.choices[0].message.content;
      } else if (provider === "anthropic") {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 500,
            messages: [{ role: "user", content: context }],
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || "Anthropic error");
        response = data.content[0].text;
      } else {
        throw new Error("Unknown provider");
      }

      responseEl.className = "ai-response";
      responseEl.innerHTML = `<div class="ai-response-header">🤖 AI Insights</div><pre>${escapeHtml(response)}</pre>`;
    } catch (err) {
      responseEl.className = "ai-response warn";
      responseEl.textContent = `❌ ${err.message || "Request failed"}`;
    }
  }

  /* ---------- Monthly print report ---------- */
  function openPrintReport() {
    const m = currentMonth();
    const monthExpenses = state.expenses.filter(
      (e) => monthKey(e.date) === m && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    const monthIncomes = state.expenses.filter((e) => e.type === "income" && monthKey(e.date) === m);
    const totalSpent = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalIncome = monthIncomes.reduce((s, e) => s + Number(e.amount), 0);
    const target = incomeForMonth(m);
    const incomeForRate = totalIncome > 0 ? totalIncome : target;
    const savingsRate = incomeForRate > 0 ? ((incomeForRate - totalSpent) / incomeForRate) * 100 : 0;

    // Top categories
    const catTotals = {};
    monthExpenses.forEach((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const name = cat ? cat.name : "Uncategorized";
      catTotals[name] = (catTotals[name] || 0) + Number(e.amount);
    });
    const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);

    // Top vendors
    const vendorTotals = {};
    monthExpenses.forEach((e) => {
      const v = e.desc.trim();
      if (!v) return;
      vendorTotals[v] = (vendorTotals[v] || 0) + Number(e.amount);
    });
    const topVendors = Object.entries(vendorTotals).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Biggest single expense
    const biggest = [...monthExpenses].sort((a, b) => Number(b.amount) - Number(a.amount))[0];

    // Account net worth
    const nw = netWorth();

    const w = window.open("", "_blank");
    if (!w) {
      showToast("Please allow popups to print report");
      return;
    }
    w.document.write(`
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Pocket Budget — ${monthLabel(m)} Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #2a2a3a; padding: 40px; max-width: 800px; margin: auto; line-height: 1.5; }
  h1 { color: #5b3fb8; margin: 0 0 0.5rem 0; font-size: 1.85rem; }
  .meta { color: #7a7a8a; font-size: 0.9rem; margin-bottom: 1.5rem; }
  h2 { color: #5b3fb8; font-size: 1.2rem; border-bottom: 2px solid #ede9fb; padding-bottom: 0.3rem; margin-top: 1.5rem; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin: 1rem 0; }
  .stat { background: #faf7f1; padding: 0.85rem; border-radius: 8px; border-left: 4px solid #5b3fb8; }
  .stat-label { font-size: 0.7rem; color: #7a7a8a; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
  .stat-value { font-size: 1.3rem; font-weight: 700; margin-top: 0.2rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #e6e1d5; font-size: 0.9rem; }
  th { background: #f5f1ea; font-weight: 600; color: #5b3fb8; }
  td.right { text-align: right; }
  .footer { margin-top: 2rem; font-size: 0.8rem; color: #7a7a8a; text-align: center; border-top: 1px solid #e6e1d5; padding-top: 1rem; }
  @media print {
    body { padding: 20px; }
    .no-print { display: none; }
  }
  .no-print {
    text-align: center;
    margin-bottom: 1rem;
    padding: 0.85rem;
    background: #ede9fb;
    border-radius: 8px;
  }
  .no-print button {
    background: #5b3fb8;
    color: #fff;
    border: 0;
    padding: 0.7rem 1.4rem;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
  }
</style>
</head><body>
<div class="no-print">
  <button onclick="window.print()">📄 Print / Save as PDF</button>
</div>
<h1>💼 Pocket Budget — Monthly Report</h1>
<div class="meta">${monthLabel(m)} · Generated ${new Date().toLocaleDateString()}</div>

<h2>Summary</h2>
<div class="stats-grid">
  <div class="stat"><div class="stat-label">Income</div><div class="stat-value">${fmt(totalIncome || target)}</div></div>
  <div class="stat"><div class="stat-label">Spent</div><div class="stat-value">${fmt(totalSpent)}</div></div>
  <div class="stat"><div class="stat-label">Saved</div><div class="stat-value">${fmt(incomeForRate - totalSpent)}</div></div>
  <div class="stat"><div class="stat-label">Savings Rate</div><div class="stat-value">${savingsRate.toFixed(0)}%</div></div>
</div>
<p><strong>Net worth (today):</strong> ${fmt(nw)}</p>
${biggest ? `<p><strong>Biggest single expense:</strong> ${escapeHtml(biggest.desc)} — ${fmt(biggest.amount)} on ${biggest.date}</p>` : ""}

<h2>Top Categories</h2>
<table>
  <thead><tr><th>Category</th><th class="right">Spent</th><th class="right">% of total</th></tr></thead>
  <tbody>
    ${topCats.map(([name, total]) => `<tr><td>${escapeHtml(name)}</td><td class="right">${fmt(total)}</td><td class="right">${totalSpent > 0 ? ((total / totalSpent) * 100).toFixed(0) : 0}%</td></tr>`).join("")}
  </tbody>
</table>

<h2>Top Vendors</h2>
<table>
  <thead><tr><th>Vendor</th><th class="right">Total</th></tr></thead>
  <tbody>
    ${topVendors.map(([name, total]) => `<tr><td>${escapeHtml(name)}</td><td class="right">${fmt(total)}</td></tr>`).join("")}
  </tbody>
</table>

<h2>Budget Performance</h2>
<table>
  <thead><tr><th>Category</th><th class="right">Spent</th><th class="right">Budget</th><th class="right">Status</th></tr></thead>
  <tbody>
    ${state.categories.map((cat) => {
      const spent = monthExpenses.filter((e) => e.categoryId === cat.id).reduce((s, e) => s + Number(e.amount), 0);
      const limit = effectiveLimitFor(cat, m);
      const pct = limit > 0 ? (spent / limit) * 100 : 0;
      const status = pct >= 100 ? "Over" : pct >= 80 ? "Watch" : "OK";
      return `<tr><td>${escapeHtml(cat.name)}</td><td class="right">${fmt(spent)}</td><td class="right">${fmt(limit)}</td><td class="right">${status} (${pct.toFixed(0)}%)</td></tr>`;
    }).join("")}
  </tbody>
</table>

<div class="footer">
  Generated by Pocket Budget — Made by Chaturanga Liyanage<br/>
  Data stays in your browser. Print to save as PDF.
</div>

<script>
  setTimeout(() => window.print(), 600);
</script>
</body></html>
    `);
    w.document.close();
  }

  /* ---------- Onboarding tour ---------- */
  const TOUR_KEY = "mb_tour_seen";

  function maybeStartTour() {
    if (localStorage.getItem(TOUR_KEY)) return;
    setTimeout(() => startTour(), 800);
  }

  function startTour() {
    const steps = [
      {
        title: "👋 Welcome to Pocket Budget",
        body: "Quick 60-second tour. You can skip anytime.",
      },
      {
        title: "📥 Add transactions",
        body: "Tap the floating <strong>+</strong> button (bottom right) anytime to add an expense or income. Or press <kbd>N</kbd>.",
      },
      {
        title: "💰 Log your paycheck",
        body: "Use <strong>💼 Log Paycheck</strong> on the Dashboard for full pre-tax/post-tax tracking. You can even upload a paystub PDF.",
      },
      {
        title: "📊 Insights tab",
        body: "Charts of spending split, daily totals, net worth over time, top vendors, and a heatmap of your year.",
      },
      {
        title: "📈 Credit tab",
        body: "Track scores, cards, hard inquiries, negative items, debt payoff calculator, and more. Import Credit Karma reports.",
      },
      {
        title: "👨‍👩‍👧 Family tab",
        body: "Track money sent to family members. Tag any expense with a person to see breakdown.",
      },
      {
        title: "⚙️ Settings",
        body: "Dark mode, currency, presets library, auto-lock, encrypted backup, stealth mode for screenshots.",
      },
      {
        title: "⌨️ Pro tip",
        body: "Press <kbd>?</kbd> anytime to see all keyboard shortcuts.",
      },
    ];

    let idx = 0;
    const overlay = document.createElement("div");
    overlay.className = "tour-overlay";
    overlay.innerHTML = `
      <div class="tour-card">
        <div class="tour-progress" id="tourProgress"></div>
        <h2 id="tourTitle"></h2>
        <p id="tourBody"></p>
        <div class="tour-actions">
          <button class="btn-secondary" id="tourSkip">Skip tour</button>
          <button class="btn-primary" id="tourNext">Next →</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const render = () => {
      const s = steps[idx];
      $("#tourTitle").textContent = s.title;
      $("#tourBody").innerHTML = s.body;
      $("#tourNext").textContent = idx === steps.length - 1 ? "Got it 🎉" : "Next →";
      $("#tourProgress").innerHTML = steps.map((_, i) => `<span class="${i <= idx ? "active" : ""}"></span>`).join("");
    };
    const finish = () => {
      localStorage.setItem(TOUR_KEY, "1");
      overlay.remove();
    };
    $("#tourSkip").addEventListener("click", finish);
    $("#tourNext").addEventListener("click", () => {
      idx += 1;
      if (idx >= steps.length) { finish(); return; }
      render();
    });
    render();
  }

  /* ---------- Init ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    initLock();
    initNav();
    initForms();
    initKeyboardShortcuts();
  });
})();
