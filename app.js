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
    syncToken: "mb_sync_token",
    syncGistId: "mb_sync_gist_id",
    syncEnabled: "mb_sync_enabled",
    syncSkipReceiptsCellular: "mb_sync_skip_receipts_cellular",
    seeded: "mb_seeded_v1",       // one-time flag — defaults seeded for this install
    locale: "mb_locale",          // i18n locale, e.g. "en", "es", "fr", "de", "pt", "si"
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
    billNegotiations: [],  // each: { id, vendor, before, after, savedMonthly, date, note }
    incomeSources: [],     // each: { id, name, employer, type, defaultAmount } — saved payers/employers
    events: [],            // each: { id, name, icon, color, startDate, endDate, budget, lineItems, notes, status }
    fxRates: {},           // map: "FROM_TO" -> rate (e.g. "USD_EUR" -> 0.92)
    deletions: {},         // map: collectionName -> { id: deletedAt timestamp }
    mapTimestamps: {},     // map: collectionName -> { key: lastUpdatedAt } for map-style collections
    settings: {
      rollover: false,
      alertsShown: {},
      roundUpEnabled: false,
      roundUpGoalId: null,
    },
    settingsTimestamps: {}, // map: settingKey -> lastUpdatedAt
  };

  let currency = "USD";
  let theme = "light"; // 'light' | 'dark'
  let hideAmounts = false;

  // Track which transaction we are currently editing (null = adding new)
  let editingTxnId = null;
  const currencySymbols = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", AUD: "$", CAD: "$", LKR: "Rs ",
  };

  // Filter state for transactions
  const filters = {
    start: "",
    end: "",
    categories: new Set(),  // empty = all
    people: new Set(),       // empty = all (only people-marked txns when non-empty)
    tags: new Set(),         // empty = all (matches when txn has any selected tag)
    search: "",
    sort: "date-desc",      // 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc'
    groupByDay: true,
    hideTransfers: false,
    eventId: "",            // filter by event (empty = all)
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
    const isNeg = value < 0;
    const abs = Math.abs(value);
    const formatted = abs.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return isNeg ? `-${sym}${formatted}` : `${sym}${formatted}`;
  };

  // Multi-currency: convert an amount from one ISO code to another using state.fxRates.
  // Returns the converted number, or null if no rate is available.
  function convertFx(amount, fromCode, toCode) {
    const a = Number(amount) || 0;
    if (!fromCode || !toCode || fromCode === toCode) return a;
    const rates = (state && state.fxRates) || {};
    const direct = rates[`${fromCode}_${toCode}`];
    if (typeof direct === "number" && direct > 0) return a * direct;
    const inverse = rates[`${toCode}_${fromCode}`];
    if (typeof inverse === "number" && inverse > 0) return a / inverse;
    return null;
  }

  // Format an amount that's stored in `srcCode`, converting it to the active display currency
  // for display. Falls back to fmt() when no rate is configured.
  function fmtFx(amount, srcCode) {
    if (!srcCode || srcCode === currency) return fmt(amount);
    const converted = convertFx(amount, srcCode, currency);
    if (converted == null) {
      // No rate — display in original currency with code prefix to avoid confusing the user
      return `${srcCode} ${fmt(amount).replace(/^[^0-9-]+/, "")}`;
    }
    return fmt(converted);
  }

  // Render the list of saved FX rates in the Settings card
  function renderFxRatesList() {
    const el = document.getElementById("fxRatesList");
    if (!el) return;
    const rates = (state && state.fxRates) || {};
    const keys = Object.keys(rates);
    if (!keys.length) {
      el.innerHTML = '<p class="empty">No FX rates saved yet.</p>';
      return;
    }
    // Deduplicate inverse pairs (show only canonical direction once)
    const shown = new Set();
    const rows = [];
    keys.forEach((k) => {
      const [from, to] = k.split("_");
      if (!from || !to) return;
      const reverseKey = `${to}_${from}`;
      // Show the pair where the rate is >= 1 (cleaner to read)
      if (shown.has(k) || shown.has(reverseKey)) return;
      const direct = Number(rates[k]) || 0;
      let canonical = k, canonicalRate = direct;
      if (direct < 1 && rates[reverseKey]) {
        canonical = reverseKey;
        canonicalRate = Number(rates[reverseKey]);
      }
      shown.add(canonical);
      const [f, t] = canonical.split("_");
      rows.push(`
        <div class="fx-rate-row" style="display:flex;justify-content:space-between;align-items:center;padding:0.4rem 0;border-bottom:1px dashed var(--border)">
          <span><strong>${escapeHtml(f)}</strong> → <strong>${escapeHtml(t)}</strong>: 1 ${escapeHtml(f)} = ${canonicalRate.toFixed(4)} ${escapeHtml(t)}</span>
          <button class="icon-btn" data-action="del-fx" data-key="${escapeHtml(canonical)}" title="Delete">🗑️</button>
        </div>`);
    });
    el.innerHTML = rows.join("") || '<p class="empty">No FX rates saved yet.</p>';
    // Wire delete buttons (idempotent — re-binds on each render)
    el.querySelectorAll('[data-action="del-fx"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        if (!key) return;
        const [from, to] = key.split("_");
        if (!confirm(`Delete FX rate ${from} → ${to}?`)) return;
        if (state.fxRates) {
          // Tombstone both directions so the delete propagates via sync (otherwise other devices re-add it)
          if (typeof tombstoneMapKey === "function") {
            tombstoneMapKey("fxRates", key);
            tombstoneMapKey("fxRates", `${to}_${from}`);
          }
          delete state.fxRates[key];
          delete state.fxRates[`${to}_${from}`];
          saveData();
          renderFxRatesList();
          showToast("💱 FX rate removed");
        }
      });
    });
  }

  const todayStr = () => {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  };

  // Local timezone-safe YYYY-MM-DD from a Date object. Critical: do not use
  // d.toISOString().slice(0, 10) — that's UTC and will be off by a day for users
  // in negative-UTC timezones, breaking streak/forecast/heatmap matching.
  const localDateStr = (d) => {
    if (!(d instanceof Date) || isNaN(d.getTime())) return "";
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
  let cachedPassword = null; // Password held in memory during session, used to re-derive key on salt mismatch

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
    try {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const iv = arr.slice(0, 12);
      const ct = arr.slice(12);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) {
      console.error("Decryption failed", e);
      return null;
    }
  }

  function showToast(msg) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = msg;
    // Reset class so a previous showAlertToast() doesn't leak its colored style here
    toast.className = "toast";
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

    // Currency: prefer state.settings.currency (cross-device), fall back to per-device localStorage
    if (state.settings && state.settings.currency) {
      currency = state.settings.currency;
    } else {
      currency = localStorage.getItem(KEYS.currency) || "USD";
    }
    hideAmounts = localStorage.getItem(KEYS.hideAmounts) === "true";

    // Restore last sync time
    const ls = parseInt(localStorage.getItem("mb_last_synced") || "0", 10);
    if (ls > 0) lastSyncedAt = ls;
    lastSyncedHash = localStorage.getItem("mb_last_synced_hash") || null;

    // Apply saved theme (or auto-detect on first launch)
    theme = localStorage.getItem(KEYS.theme);
    if (!theme) {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    applyTheme(theme);

    // Defensive: ensure all collections are arrays before migrations run
    if (!Array.isArray(state.expenses)) state.expenses = [];
    if (!Array.isArray(state.categories)) state.categories = [];
    if (!Array.isArray(state.goals)) state.goals = [];

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
    if (!Array.isArray(state.billNegotiations)) state.billNegotiations = [];
    if (!Array.isArray(state.incomeSources)) state.incomeSources = [];
    if (!Array.isArray(state.events)) state.events = [];
    if (typeof state.fxRates !== "object" || !state.fxRates) state.fxRates = {};

    // Migration: each credit card gets a paired account in Balances so debt is visible
    // and pay-card transfers can post to it.
    const palette = ["#ec4899", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444", "#10b981", "#3b82f6"];
    state.cards.forEach((c) => {
      if (c.accountId) {
        // ensure the linked account still exists
        const exists = state.accounts.find((a) => a.id === c.accountId);
        if (exists) {
          // Keep names in sync
          if (exists.name !== c.name) { exists.name = c.name; touchRecord(exists); }
          if (exists.cardId !== c.id) { exists.cardId = c.id; touchRecord(exists); }
          return;
        }
        // Linked account was deleted — recreate
        c.accountId = null;
      }
      const acc = touchRecord({
        id: uid(),
        name: c.name || "Credit Card",
        type: "credit",
        balance: -Math.abs(Number(c.balance) || 0),
        color: palette[state.accounts.length % palette.length],
        cardId: c.id,
      });
      state.accounts.push(acc);
      c.accountId = acc.id;
      touchRecord(c);
    });

    if (typeof state.creditFreezes !== "object" || !state.creditFreezes) state.creditFreezes = {};
    if (typeof state.annualReports !== "object" || !state.annualReports) state.annualReports = {};
    if (typeof state.deletions !== "object" || !state.deletions) state.deletions = {};
    if (typeof state.mapTimestamps !== "object" || !state.mapTimestamps) state.mapTimestamps = {};
    if (typeof state.settingsTimestamps !== "object" || !state.settingsTimestamps) state.settingsTimestamps = {};

    // Backfill mapTimestamps for any existing keys that lack one. This way, after
    // upgrading, the next time the user touches a value, the merge correctly
    // identifies it as newer than other devices' un-stamped values.
    ["monthlyIncome", "creditFreezes", "annualReports", "fxRates"].forEach((coll) => {
      if (!state.mapTimestamps[coll]) state.mapTimestamps[coll] = {};
      Object.keys(state[coll] || {}).forEach((k) => {
        if (typeof state.mapTimestamps[coll][k] !== "number") {
          state.mapTimestamps[coll][k] = 0; // sentinel — any real update beats this
        }
      });
    });
    if (!state.monthlyIncome || typeof state.monthlyIncome !== "object") {
      state.monthlyIncome = {};
      // Migrate legacy income to current month
      if (Number(state.income) > 0) {
        state.monthlyIncome[currentMonth()] = Number(state.income);
        migrated = true;
      }
    }

    // Per-collection auto-seed: seed each collection independently when it's
    // empty AND has no tombstones (i.e. user never deleted from it). This handles
    // the partial-empty case where one collection got wiped but others survived.
    // Tombstones are the right gate (not sync setup) because:
    //   - If sync is set up but cloud also has nothing for this collection,
    //     seeding here is harmless (just puts defaults on both devices).
    //   - If user deleted entries, tombstones exist and seeding correctly skips.
    const collectionHasTombstones = (key) => {
      const ts = state.deletions && state.deletions[key];
      return !!(ts && Object.keys(ts).length > 0);
    };

    // Seed default accounts when accounts are empty and the user never deleted any
    if (!state.accounts.length && !collectionHasTombstones("accounts")) {
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

    // Apply persisted accent color early to avoid theme flicker
    if (state.settings.accentColor) {
      try { applyAccentColor(state.settings.accentColor); } catch (e) {}
    }
    // Apply compact mode early to avoid layout flash
    if (state.settings.compactMode) {
      document.documentElement.classList.add("compact-mode");
    } else {
      document.documentElement.classList.remove("compact-mode");
    }

    // Seed default categories when empty and never deleted from
    if (!state.categories.length && !collectionHasTombstones("categories")) {
      state.categories = [
        { id: uid(), name: "Groceries", limit: 400 },
        { id: uid(), name: "Rent", limit: 1500 },
        { id: uid(), name: "Utilities", limit: 200 },
        { id: uid(), name: "Transport", limit: 150 },
        { id: uid(), name: "Eating Out", limit: 200 },
        { id: uid(), name: "Subscriptions", limit: 100 },
        { id: uid(), name: "Healthcare", limit: 150 },
        { id: uid(), name: "Entertainment", limit: 100 },
        { id: uid(), name: "Shopping", limit: 200 },
        { id: uid(), name: "Personal Care", limit: 75 },
        { id: uid(), name: "Family", limit: 0 },
        { id: uid(), name: "Credit Payment", limit: 0 },
        { id: uid(), name: "Other", limit: 200 },
      ];
      migrated = true;
    }

    // Migration: ensure a "Family" category exists (added in a later release)
    // unless the user explicitly deleted one.
    if (state.categories.length
        && !state.categories.some((c) => /^family$/i.test(c.name))
        && !(state.deletions?.categories
             && Object.keys(state.deletions.categories).some((id) => true))) {
      // Be lenient — only add if no category with similar name exists
      const familyish = state.categories.find((c) => /family|relative|sent\s*to/i.test(c.name));
      if (!familyish) {
        state.categories.push(touchRecord({
          id: uid(),
          name: "Family",
          limit: 0,
        }));
        migrated = true;
      }
    }

    // Migration: ensure a "Credit Payment" category exists so credit card payment transfers
    // (from the Pay Cards modal) categorize as "Credit Payment" instead of "Uncategorized".
    if (state.categories.length
        && !state.categories.some((c) => /^credit\s*payment$/i.test(c.name))) {
      const cpExists = state.categories.find((c) => /credit\s*pay/i.test(c.name));
      if (!cpExists) {
        state.categories.push(touchRecord({
          id: uid(),
          name: "Credit Payment",
          limit: 0,
        }));
        migrated = true;
      }
    }

    // Backfill: any existing credit-payment txns that lack a categoryId get the new
    // Credit Payment category assigned.
    {
      const cpCat = state.categories.find((c) => /^credit\s*payment$/i.test(c.name));
      if (cpCat) {
        state.expenses.forEach((e) => {
          if (e.kind === "credit-payment" && !e.categoryId) {
            e.categoryId = cpCat.id;
            touchRecord(e);
            migrated = true;
          }
        });
      }
    }

    // Seed quick-add presets only on a brand-new install (presets are easy to
    // re-create via the Restore Defaults button, so we don't auto-replace).
    const presetsTotallyFresh = !state.presets.length &&
                                !collectionHasTombstones("presets") &&
                                !state.expenses.length;
    if (presetsTotallyFresh) {
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

    // Dedupe presets — sync merging across devices can create duplicates of the
    // default seed (each device generates its own uid()). Group by (type|desc|amount|group)
    // and keep the oldest entry; tombstone the rest so deletion propagates.
    {
      const groups = new Map();
      state.presets.forEach((p) => {
        const key = `${p.type || "expense"}|${(p.desc || "").trim().toLowerCase()}|${Number(p.amount) || 0}|${p.group || "custom"}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      });
      const losers = [];
      const winners = [];
      groups.forEach((arr) => {
        if (arr.length <= 1) { winners.push(arr[0]); return; }
        // Sort by uid creation time (oldest first); preserve favorite flag if any
        const sorted = arr.slice().sort((a, b) => {
          const at = recordTimestamp(a);
          const bt = recordTimestamp(b);
          return at - bt;
        });
        const keeper = sorted[0];
        // Inherit any favorite flag from the duplicates
        if (sorted.some((p) => p.favorite)) keeper.favorite = true;
        winners.push(keeper);
        sorted.slice(1).forEach((p) => losers.push(p));
      });
      if (losers.length > 0) {
        losers.forEach((p) => tombstoneRecord("presets", p.id));
        state.presets = winners;
        migrated = true;
        console.info(`Cleaned up ${losers.length} duplicate preset${losers.length === 1 ? "" : "s"}`);
      }
    }

    // Re-link subscription-style presets to the Subscriptions category if they
    // were created before the category existed (categoryId null/empty/missing).
    const relinkResult = relinkPresetsToCategories();
    if (relinkResult > 0) migrated = true;

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
      { id: uid(), type: "expense", desc: "Pharmacy", amount: 20, categoryId: findCat("Healthcare"), icon: "💊", group: "daily" },
      { id: uid(), type: "expense", desc: "Haircut", amount: 30, categoryId: findCat("Personal Care"), icon: "💇", group: "daily" },
      { id: uid(), type: "expense", desc: "Parking", amount: 10, categoryId: findCat("Transport"), icon: "🅿️", group: "daily" },
      { id: uid(), type: "expense", desc: "Movie", amount: 15, categoryId: findCat("Entertainment"), icon: "🎟️", group: "daily" },
      { id: uid(), type: "expense", desc: "Clothing", amount: 60, categoryId: findCat("Shopping"), icon: "👕", group: "daily" },

      // Subscriptions — streaming
      { id: uid(), type: "expense", desc: "Netflix", amount: 15.49, categoryId: findCat("Subscriptions"), icon: "🎬", group: "subscription" },
      { id: uid(), type: "expense", desc: "Spotify", amount: 11.99, categoryId: findCat("Subscriptions"), icon: "🎵", group: "subscription" },
      { id: uid(), type: "expense", desc: "Amazon Prime", amount: 14.99, categoryId: findCat("Subscriptions"), icon: "📦", group: "subscription" },
      { id: uid(), type: "expense", desc: "Disney+", amount: 13.99, categoryId: findCat("Subscriptions"), icon: "✨", group: "subscription" },
      { id: uid(), type: "expense", desc: "HBO Max", amount: 15.99, categoryId: findCat("Subscriptions"), icon: "🎭", group: "subscription" },
      { id: uid(), type: "expense", desc: "Apple TV+", amount: 9.99, categoryId: findCat("Subscriptions"), icon: "🍎", group: "subscription" },
      { id: uid(), type: "expense", desc: "Paramount+", amount: 11.99, categoryId: findCat("Subscriptions"), icon: "⛰️", group: "subscription" },
      { id: uid(), type: "expense", desc: "Peacock", amount: 7.99, categoryId: findCat("Subscriptions"), icon: "🦚", group: "subscription" },
      { id: uid(), type: "expense", desc: "YouTube Premium", amount: 13.99, categoryId: findCat("Subscriptions"), icon: "▶️", group: "subscription" },

      // Subscriptions — software / tools
      { id: uid(), type: "expense", desc: "Apple iCloud", amount: 2.99, categoryId: findCat("Subscriptions"), icon: "☁️", group: "subscription" },
      { id: uid(), type: "expense", desc: "Google One", amount: 1.99, categoryId: findCat("Subscriptions"), icon: "🌥️", group: "subscription" },
      { id: uid(), type: "expense", desc: "Dropbox", amount: 11.99, categoryId: findCat("Subscriptions"), icon: "📂", group: "subscription" },
      { id: uid(), type: "expense", desc: "ChatGPT Plus", amount: 20, categoryId: findCat("Subscriptions"), icon: "🤖", group: "subscription" },
      { id: uid(), type: "expense", desc: "Claude Pro", amount: 20, categoryId: findCat("Subscriptions"), icon: "🧠", group: "subscription" },
      { id: uid(), type: "expense", desc: "GitHub Copilot", amount: 10, categoryId: findCat("Subscriptions"), icon: "🐙", group: "subscription" },

      // Subscriptions — fitness / lifestyle
      { id: uid(), type: "expense", desc: "Gym", amount: 30, categoryId: findCat("Subscriptions"), icon: "💪", group: "subscription" },

      // Subscriptions — bills & insurance
      { id: uid(), type: "expense", desc: "Phone bill", amount: 75, categoryId: findCat("Utilities"), icon: "📱", group: "subscription" },
      { id: uid(), type: "expense", desc: "Internet", amount: 60, categoryId: findCat("Utilities"), icon: "📡", group: "subscription" },
      { id: uid(), type: "expense", desc: "Electric bill", amount: 120, categoryId: findCat("Utilities"), icon: "💡", group: "subscription" },
      { id: uid(), type: "expense", desc: "Water bill", amount: 40, categoryId: findCat("Utilities"), icon: "💧", group: "subscription" },
      { id: uid(), type: "expense", desc: "Car insurance", amount: 150, categoryId: findCat("Healthcare"), icon: "🚗", group: "subscription" },
      { id: uid(), type: "expense", desc: "Health insurance", amount: 250, categoryId: findCat("Healthcare"), icon: "🏥", group: "subscription" },
      { id: uid(), type: "expense", desc: "Rent", amount: 1500, categoryId: findCat("Rent"), icon: "🏠", group: "subscription" },

      // Income
      { id: uid(), type: "income", desc: "Paycheck", amount: 0, categoryId: null, icon: "💼", group: "income", favorite: true },
      { id: uid(), type: "income", desc: "Bonus", amount: 0, categoryId: null, icon: "🎉", group: "income" },
      { id: uid(), type: "income", desc: "Side gig", amount: 0, categoryId: null, icon: "💻", group: "income" },
      { id: uid(), type: "income", desc: "Refund", amount: 0, categoryId: null, icon: "↩️", group: "income" },
      { id: uid(), type: "income", desc: "Tax refund", amount: 0, categoryId: null, icon: "🧾", group: "income" },
      { id: uid(), type: "income", desc: "Reimbursement", amount: 0, categoryId: null, icon: "💵", group: "income" },
      { id: uid(), type: "income", desc: "Dividend", amount: 0, categoryId: null, icon: "📈", group: "income" },
      { id: uid(), type: "income", desc: "Interest", amount: 0, categoryId: null, icon: "🏦", group: "income" },
      { id: uid(), type: "income", desc: "Tips", amount: 0, categoryId: null, icon: "💰", group: "income" },
      { id: uid(), type: "income", desc: "Gift received", amount: 0, categoryId: null, icon: "🎁", group: "income" },
      { id: uid(), type: "income", desc: "Cashback", amount: 0, categoryId: null, icon: "💸", group: "income" },
    ];
  }

  /* ---------- Save (encrypted when available, plaintext as fallback) ---------- */
  function saveData() {
    // Always update today's net-worth snapshot so the chart stays current
    try { snapshotNetWorth(); } catch (e) { /* netWorth uses functions defined later; ignore in early-init save */ }
    try { snapshotUtilization(); } catch (e) { /* same */ }
    try { markDirty(); } catch (e) { /* before init */ }
    if (cryptoKey) {
      // Encrypt asynchronously and write to localStorage; remove plaintext on success
      encryptState(state).then((b64) => {
        if (b64) {
          try {
            localStorage.setItem(KEYS.dataEnc, b64);
            // Once encrypted blob exists, drop plaintext
            localStorage.removeItem(KEYS.data);
          } catch (e) {
            handleStorageQuotaError(e);
          }
        }
      }).catch((e) => {
        console.error("Encrypt save failed, writing plaintext", e);
        try {
          localStorage.setItem(KEYS.data, JSON.stringify(state));
        } catch (e2) {
          handleStorageQuotaError(e2);
        }
      });
    } else {
      try {
        localStorage.setItem(KEYS.data, JSON.stringify(state));
      } catch (e) {
        handleStorageQuotaError(e);
      }
    }
    // Proactive storage warning (cheap; runs once per save)
    try { checkStorageUsage(); } catch (e) {}
  }

  // Best-effort handler for localStorage quota errors. Warns the user once per
  // session that the device is full, usually because of receipt images.
  let _storageQuotaWarned = false;
  function handleStorageQuotaError(err) {
    console.error("Storage save failed", err);
    const msg = String((err && err.message) || err || "").toLowerCase();
    const isQuota = msg.includes("quota") || msg.includes("exceeded") ||
                    (err && err.name && /quota/i.test(err.name));
    if (isQuota && !_storageQuotaWarned) {
      _storageQuotaWarned = true;
      try {
        showAlertToast("⚠️ Device storage is full. Recent changes may not save. Delete old receipts to free space.", "danger");
      } catch (e) { /* ignore */ }
    }
  }

  // Proactively warn when localStorage is approaching the ~5MB limit.
  // Estimates total bytes used across all keys; warns once at 80%.
  let _storageLowWarned = false;
  function checkStorageUsage() {
    if (_storageLowWarned) return;
    try {
      let total = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        if (v) total += k.length + v.length;
      }
      // Browsers commonly cap localStorage at 5 MB (~5,242,880 chars). UTF-16 = 2 bytes/char so cap is roughly 2.5 MB of useful data.
      // We'll measure in chars and warn at ~80% of 5MB = 4 million chars.
      const CAP = 5 * 1024 * 1024;
      if (total > CAP * 0.8) {
        _storageLowWarned = true;
        const pct = Math.round((total / CAP) * 100);
        const receiptCount = (state.expenses || []).filter((e) => e.receipt).length;
        const tip = receiptCount > 0
          ? `Strip ${receiptCount} receipt photo${receiptCount === 1 ? "" : "s"} via Settings → Reset Specific Data.`
          : "Export a backup, then clear old transactions in Settings.";
        showAlertToast(`💾 Storage ${pct}% full. ${tip}`, "warning");
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- Recurring transactions ---------- */
  function processRecurring() {
    if (!Array.isArray(state.recurring)) state.recurring = [];
    if (!Array.isArray(state.expenses)) state.expenses = [];
    const today = new Date();
    const thisMonth = currentMonth();
    let added = 0;

    // First, dedupe any recurring transactions that ended up duplicated across devices
    // (sync merges can introduce two recurring entries for the same rule + month).
    dedupeRecurringTransactions();

    // Vacation mode: collect active vacation-mode events that overlap a given date.
    // If a recurring expense's run date falls within an active vacation event range,
    // skip it (don't auto-add the expense).
    function isInVacationRange(dateStr) {
      return (state.events || []).some((ev) => {
        if (!ev.vacationMode) return false;
        if (!ev.startDate || !ev.endDate) return false;
        return dateStr >= ev.startDate && dateStr <= ev.endDate;
      });
    }

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

        // Already exists for this month-year (could be from a synced device)
        const exists = state.expenses.some(
          (e) => e.recurringId === r.id && monthKey(e.date) === m
        );
        if (exists) {
          r.lastRunMonth = m;
          touchRecord(r);
          return;
        }

        const day = clampDayToMonth(r.dayOfMonth || 1, m);
        const dateStr = `${m}-${String(day).padStart(2, "0")}`;

        // Skip dates that are still in the future
        if (dateStr > todayStr()) return;

        // Vacation mode: skip expense recurring rules whose date is inside an active vacation event
        if (r.type === "expense" && isInVacationRange(dateStr)) {
          // Mark as run so we don't keep checking; bookkeeping only
          r.lastRunMonth = m;
          touchRecord(r);
          return;
        }

        state.expenses.push(touchRecord({
          id: uid(),
          type: r.type || "expense",
          desc: r.desc + " (recurring)",
          amount: r.amount,
          date: dateStr,
          categoryId: r.categoryId || null,
          goalId: r.goalId || null,
          receipt: null,
          recurringId: r.id,
        }));
        r.lastRunMonth = m;
        touchRecord(r);
        added += 1;
      });
    });

    if (added > 0) {
      saveData();
      setTimeout(() => showToast(`Added ${added} recurring transaction${added === 1 ? "" : "s"}`), 500);
    }
  }

  function dedupeRecurringTransactions() {
    const seen = new Map(); // key: recurringId+monthKey -> earliest record
    const toRemove = new Set();
    state.expenses.forEach((e) => {
      if (!e.recurringId) return;
      const key = `${e.recurringId}|${monthKey(e.date)}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, e);
      } else {
        // Keep the older record (smaller id timestamp); tombstone the newer one
        const tsExisting = recordTimestamp(existing);
        const tsCurrent = recordTimestamp(e);
        if (tsCurrent < tsExisting) {
          toRemove.add(existing.id);
          tombstoneRecord("expenses", existing.id);
          seen.set(key, e);
        } else {
          toRemove.add(e.id);
          tombstoneRecord("expenses", e.id);
        }
      }
    });
    if (toRemove.size > 0) {
      state.expenses = state.expenses.filter((e) => !toRemove.has(e.id));
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
    // Apply Chart.js defaults so axis labels/gridlines match the theme
    if (typeof Chart !== "undefined") {
      const isDark = t === "dark";
      Chart.defaults.color = isDark ? "rgba(226, 232, 240, 0.85)" : "rgba(30, 41, 59, 0.85)";
      Chart.defaults.borderColor = isDark ? "rgba(148, 163, 184, 0.18)" : "rgba(148, 163, 184, 0.25)";
      // Re-render charts that are already on screen
      try { renderInsights(); } catch (e) { /* charts not ready yet */ }
    }
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

    // Show/hide password toggle
    const pwdToggle = $("#passwordToggle");
    if (pwdToggle) {
      pwdToggle.addEventListener("click", () => {
        const inp = $("#passwordInput");
        if (!inp) return;
        const isPwd = inp.type === "password";
        inp.type = isPwd ? "text" : "password";
        pwdToggle.textContent = isPwd ? "🙈" : "👁";
        pwdToggle.title = isPwd ? "Hide password" : "Show password";
        inp.focus();
      });
    }

    // Caps Lock detector
    const capsHint = $("#capsLockHint");
    const capsHandler = (e) => {
      if (!capsHint) return;
      const on = e.getModifierState && e.getModifierState("CapsLock");
      capsHint.hidden = !on;
    };
    $("#passwordInput")?.addEventListener("keydown", capsHandler);
    $("#passwordInput")?.addEventListener("keyup", capsHandler);
    confirmInput?.addEventListener("keydown", capsHandler);
    confirmInput?.addEventListener("keyup", capsHandler);

    // Show app version pill on lock screen
    const versionPill = $("#lockVersionPill");
    if (versionPill) {
      const scriptTag = document.querySelector('script[src*="app.js"]');
      const m = scriptTag && scriptTag.src.match(/v=(\d+)/);
      if (m) {
        versionPill.textContent = `v${m[1]}`;
        versionPill.hidden = false;
      }
    }

    // Brute-force cooldown — 5 wrong attempts in 5 min triggers a 30s pause
    const COOLDOWN_KEY = "mb_lock_cooldown";
    const ATTEMPTS_KEY = "mb_lock_attempts";
    let _cooldownInterval = null;
    const checkCooldown = () => {
      // Stop any running countdown timer
      if (_cooldownInterval) {
        clearInterval(_cooldownInterval);
        _cooldownInterval = null;
      }
      const until = parseInt(localStorage.getItem(COOLDOWN_KEY) || "0", 10);
      const now = Date.now();
      // Sanity cap: if cooldown is more than 5 min in future, treat it as corrupt and clear
      if (until > now + 5 * 60 * 1000) {
        localStorage.removeItem(COOLDOWN_KEY);
        return false;
      }
      if (until > now) {
        const errEl = $("#lockError");
        const updateMsg = () => {
          const left = Math.max(0, until - Date.now());
          const sec = Math.ceil(left / 1000);
          if (errEl) {
            errEl.textContent = `Too many attempts — try again in ${sec}s`;
            errEl.hidden = false;
          }
          if (left <= 0) {
            clearInterval(_cooldownInterval);
            _cooldownInterval = null;
            if (unlockBtn) unlockBtn.disabled = false;
            if (errEl) errEl.hidden = true;
            // Same for PIN error
            const pinErr = $("#lockPinError");
            if (pinErr) pinErr.hidden = true;
            // Refocus the password input so user can immediately retry
            const pwdInp = $("#passwordInput");
            const pinPanel = $("#lockPinPanel");
            if (pwdInp && (!pinPanel || pinPanel.hidden)) {
              setTimeout(() => pwdInp.focus(), 50);
            }
          }
        };
        updateMsg();
        if (unlockBtn) unlockBtn.disabled = true;
        _cooldownInterval = setInterval(updateMsg, 1000);
        return true;
      }
      return false;
    };
    checkCooldown();

    $("#lockForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const pwdInp = $("#passwordInput");
      const pwd = pwdInp ? pwdInp.value : "";
      const errEl = $("#lockError");
      if (errEl) errEl.hidden = true;

      if (!stored) {
        const confirmVal = confirmInput ? confirmInput.value : "";
        if (pwd.length < 4) {
          if (errEl) {
            errEl.textContent = "Password must be at least 4 characters";
            errEl.hidden = false;
          }
          return;
        }
        if (pwd !== confirmVal) {
          if (errEl) {
            errEl.textContent = "Passwords do not match";
            errEl.hidden = false;
          }
          return;
        }
        const hash = await sha256(pwd);
        localStorage.setItem(KEYS.pwd, hash);
        await unlock(pwd);
      } else {
        if (checkCooldown()) return;
        const hash = await sha256(pwd);
        // Read fresh from storage — password may have changed since initLock ran
        const currentStored = localStorage.getItem(KEYS.pwd);
        if (hash === currentStored) {
          // Reset attempt counter on success
          localStorage.removeItem(ATTEMPTS_KEY);
          localStorage.removeItem(COOLDOWN_KEY);
          await unlock(pwd);
        } else {
          // Track failed attempts
          let attempts = parseInt(localStorage.getItem(ATTEMPTS_KEY) || "0", 10) + 1;
          localStorage.setItem(ATTEMPTS_KEY, String(attempts));
          // 5 wrong → 30s cooldown
          if (attempts >= 5) {
            localStorage.setItem(COOLDOWN_KEY, String(Date.now() + 30 * 1000));
            localStorage.setItem(ATTEMPTS_KEY, "0");
            checkCooldown();
            return;
          }
          const remaining = 5 - attempts;
          if (errEl) {
            errEl.textContent = `Incorrect password${remaining > 0 && remaining <= 2 ? ` · ${remaining} ${remaining === 1 ? "try" : "tries"} left` : ""}`;
            errEl.hidden = false;
          }
          if (pwdInp) pwdInp.value = "";
          // Shake animation
          const card = document.querySelector(".lock-card");
          if (card) {
            card.classList.remove("shake");
            void card.offsetWidth; // restart animation
            card.classList.add("shake");
          }
        }
      }
    });

    resetBtn.addEventListener("click", () => {
      if (confirm("This will erase your data and reset the password to the preset. Continue?")) {
        localStorage.removeItem(KEYS.data);
        localStorage.removeItem(KEYS.dataEnc);
        localStorage.removeItem(KEYS.salt);
        localStorage.setItem(KEYS.pwd, DEFAULT_PWD_HASH);
        // Clear biometric blob since the password has been reset
        localStorage.removeItem(BIO_CRED_KEY);
        localStorage.removeItem(BIO_PWD_KEY);
        // Clear lockout/attempt counters
        localStorage.removeItem("mb_lock_attempts");
        localStorage.removeItem("mb_lock_cooldown");
        location.reload();
      }
    });

    setTimeout(() => {
      // Skip auto-focus on password field if biometric is enrolled (button is more prominent)
      const hasBio = !!(localStorage.getItem(BIO_CRED_KEY) && localStorage.getItem(BIO_PWD_KEY));
      const lastMode = localStorage.getItem("mb_lock_mode") || "password";
      if (!hasBio && lastMode !== "pin") {
        $("#passwordInput")?.focus();
      }
    }, 100);

    // Render stats teaser (only when password is already set, not on first launch)
    if (stored) {
      try { renderLockStatsTeaser(); } catch (e) { /* ignore */ }
    }

    // Initial network status (shows offline pill on lock screen if applicable)
    try { updateNetStatus(); } catch (e) { /* ignore */ }

    // Show mode toggle (Password / PIN) only after a password is set
    if (stored) {
      const modeToggle = $("#lockModeToggle");
      if (modeToggle) {
        modeToggle.hidden = false;
        const lastMode = localStorage.getItem("mb_lock_mode") || "password";
        applyLockMode(lastMode);
        modeToggle.querySelectorAll("[data-lock-mode]").forEach((btn) => {
          btn.addEventListener("click", () => {
            applyLockMode(btn.dataset.lockMode);
          });
        });
      }
    }

    // Biometric (WebAuthn) — show button if a passkey was registered
    if (stored) {
      try { setupBiometricUnlock(); } catch (e) { console.warn("Biometric setup failed", e); }
    }
  }

  /* ---------- Lock screen helpers ---------- */
  function renderLockStatsTeaser() {
    const teaser = $("#lockStatsTeaser");
    if (!teaser) return;
    // Read non-encrypted metadata from localStorage to avoid needing the password
    const lastUnlock = parseInt(localStorage.getItem("mb_last_unlock") || "0", 10);
    const lastSync = parseInt(localStorage.getItem("mb_last_synced") || "0", 10);
    const items = [];
    const formatAgo = (ts) => {
      const ago = Date.now() - ts;
      if (ago < 60000) return "just now";
      if (ago < 3600000) return `${Math.floor(ago / 60000)}m ago`;
      if (ago < 86400000) return `${Math.floor(ago / 3600000)}h ago`;
      return `${Math.floor(ago / 86400000)}d ago`;
    };
    if (lastUnlock > 0) {
      items.push(`<span class="ls-item">⏱ Last open <strong>${formatAgo(lastUnlock)}</strong></span>`);
    } else if (lastSync > 0) {
      items.push(`<span class="ls-item">☁️ Last sync <strong>${formatAgo(lastSync)}</strong></span>`);
    }
    const dev = localStorage.getItem("mb_device_label");
    if (dev) items.push(`<span class="ls-item">📍 <strong>${escapeHtml(dev)}</strong></span>`);
    const hasSync = !!(localStorage.getItem(KEYS.syncToken) && localStorage.getItem(KEYS.syncGistId));
    if (hasSync && !lastSync) items.push(`<span class="ls-item">☁️ Sync ready</span>`);
    if (items.length) {
      teaser.innerHTML = items.join("");
      teaser.hidden = false;
    } else {
      teaser.hidden = true;
    }
  }

  function applyLockMode(mode) {
    localStorage.setItem("mb_lock_mode", mode);
    const toggle = $("#lockModeToggle");
    if (toggle) {
      toggle.querySelectorAll("[data-lock-mode]").forEach((b) => {
        b.classList.toggle("active", b.dataset.lockMode === mode);
      });
    }
    const form = $("#lockForm");
    const pinPanel = $("#lockPinPanel");
    // Clear errors and inputs when switching
    const errEl = $("#lockError");
    if (errEl) errEl.hidden = true;
    const pinErr = $("#lockPinError");
    if (pinErr) pinErr.hidden = true;
    if (mode === "pin") {
      if (form) form.hidden = true;
      if (pinPanel) pinPanel.hidden = false;
      // Clear password input when leaving password mode
      const pwdInp = $("#passwordInput");
      if (pwdInp) pwdInp.value = "";
      buildPinPad();
    } else {
      if (form) form.hidden = false;
      if (pinPanel) pinPanel.hidden = true;
      // Clear PIN buffer when leaving PIN mode
      _pinBuffer = "";
      renderPinDisplay();
      setTimeout(() => $("#passwordInput")?.focus(), 50);
    }
  }

  let _pinBuffer = "";
  let _pinKeydownHandler = null;
  function buildPinPad() {
    const pad = $("#lockPinPad");
    if (!pad) return;
    _pinBuffer = "";
    renderPinDisplay();
    const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
    pad.innerHTML = keys.map((k) => {
      if (k === "") return `<button type="button" class="pin-key empty" disabled></button>`;
      return `<button type="button" class="pin-key" data-pin-key="${k}">${k}</button>`;
    }).join("");
    pad.querySelectorAll("[data-pin-key]").forEach((btn) => {
      btn.addEventListener("click", () => onPinKey(btn.dataset.pinKey));
    });
    // Allow physical keyboard input for desktop users
    if (_pinKeydownHandler) document.removeEventListener("keydown", _pinKeydownHandler);
    _pinKeydownHandler = (e) => {
      // Only act when PIN panel is visible AND lock screen is open
      const lockScreen = $("#lockScreen");
      const pinPanel = $("#lockPinPanel");
      if (!lockScreen || !lockScreen.classList.contains("open")) return;
      if (!pinPanel || pinPanel.hidden) return;
      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        onPinKey(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        onPinKey("⌫");
      }
    };
    document.addEventListener("keydown", _pinKeydownHandler);
  }

  function renderPinDisplay() {
    const disp = $("#lockPinDisplay");
    if (!disp) return;
    const len = Math.max(4, _pinBuffer.length);
    disp.innerHTML = Array.from({ length: len }, (_, i) =>
      `<span class="pin-dot ${i < _pinBuffer.length ? "filled" : ""}"></span>`
    ).join("");
  }

  async function onPinKey(k) {
    const errEl = $("#lockPinError");
    if (errEl) errEl.hidden = true;
    // Honor cooldown
    const cooldownUntil = parseInt(localStorage.getItem("mb_lock_cooldown") || "0", 10);
    if (cooldownUntil > Date.now()) {
      if (errEl) {
        const sec = Math.ceil((cooldownUntil - Date.now()) / 1000);
        errEl.textContent = `Locked out for ${sec}s`;
        errEl.hidden = false;
      }
      return;
    }
    if (k === "⌫") {
      _pinBuffer = _pinBuffer.slice(0, -1);
      renderPinDisplay();
      return;
    }
    if (_pinBuffer.length >= 8) return;
    _pinBuffer += k;
    renderPinDisplay();
    // Auto-submit at 4+ digits if it matches
    if (_pinBuffer.length >= 4) {
      const snapshot = _pinBuffer; // freeze for async
      const stored = localStorage.getItem(KEYS.pwd);
      const hash = await sha256(snapshot);
      // Bail if user has kept typing past this snapshot (we'll match on a later call)
      if (snapshot !== _pinBuffer && hash !== stored) return;
      if (hash === stored) {
        localStorage.removeItem("mb_lock_attempts");
        localStorage.removeItem("mb_lock_cooldown");
        _pinBuffer = "";
        await unlock(snapshot);
      } else if (snapshot.length >= 8) {
        // 8 digits and still no match — show error and reset
        if (errEl) {
          errEl.textContent = "Incorrect PIN";
          errEl.hidden = false;
        }
        const card = document.querySelector(".lock-card");
        if (card) {
          card.classList.remove("shake");
          void card.offsetWidth;
          card.classList.add("shake");
        }
        // Track attempts for cooldown (shared with password attempts)
        let attempts = parseInt(localStorage.getItem("mb_lock_attempts") || "0", 10) + 1;
        localStorage.setItem("mb_lock_attempts", String(attempts));
        if (attempts >= 5) {
          localStorage.setItem("mb_lock_cooldown", String(Date.now() + 30 * 1000));
          localStorage.setItem("mb_lock_attempts", "0");
        }
        _pinBuffer = "";
        renderPinDisplay();
      }
    }
  }

  /* ---------- Biometric (WebAuthn / passkey) unlock ---------- */
  // Stores an encrypted-at-rest blob with the password, gated by a platform passkey.
  // The browser proves the user is present via Touch ID / Face ID / Windows Hello,
  // then we unwrap the password to decrypt local data.
  const BIO_CRED_KEY = "mb_bio_cred_id";
  const BIO_PWD_KEY = "mb_bio_pwd_blob";

  async function setupBiometricUnlock() {
    const btn = $("#lockBiometricBtn");
    if (!btn) return;
    if (!window.PublicKeyCredential) return; // not supported
    const credId = localStorage.getItem(BIO_CRED_KEY);
    const pwdBlob = localStorage.getItem(BIO_PWD_KEY);
    if (!credId || !pwdBlob) return;
    // Verify platform authenticator (Face ID / Touch ID / Windows Hello) is actually available.
    // On iOS Safari this returns false if Face ID isn't configured for the site.
    let available = true;
    try {
      if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function") {
        available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      }
    } catch (e) {
      available = true; // fail-open — let the user try
    }
    if (!available) {
      // Don't show button — fall back to password
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.onclick = () => attemptBiometricUnlock();
  }

  function _b64uToBytes(b64u) {
    const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/").padEnd(b64u.length + (4 - b64u.length % 4) % 4, "=");
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  function _bytesToB64u(buf) {
    const arr = new Uint8Array(buf);
    let bin = "";
    arr.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function attemptBiometricUnlock() {
    const credIdB64 = localStorage.getItem(BIO_CRED_KEY);
    const pwdBlob = localStorage.getItem(BIO_PWD_KEY);
    const errEl = $("#lockError");
    const btn = $("#lockBiometricBtn");
    const lbl = $("#lockBioLabel");
    const ico = $("#lockBioIcon");
    if (!credIdB64 || !pwdBlob) return;
    // Visual loading state
    if (btn) btn.disabled = true;
    if (lbl) lbl.textContent = "Verifying…";
    if (ico) ico.textContent = "⏳";
    try {
      // Use the credential to "verify" user presence. We don't actually use the assertion
      // for crypto — we just rely on the platform authenticator gate to release the password.
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: [{
            id: _b64uToBytes(credIdB64),
            type: "public-key",
          }],
          userVerification: "required",
          timeout: 60000,
        },
      });
      // User passed biometric — unwrap stored password
      const obj = JSON.parse(pwdBlob);
      let pwd;
      try {
        if (obj.v === 2) {
          // UTF-8 base64url-encoded
          const bytes = _b64uToBytes(obj.p || "");
          pwd = new TextDecoder().decode(bytes);
        } else {
          // Legacy: plain btoa (Latin-1 only)
          pwd = atob(obj.p || "");
        }
      } catch (decodeErr) {
        console.error("Failed to decode biometric blob", decodeErr);
        localStorage.removeItem(BIO_CRED_KEY);
        localStorage.removeItem(BIO_PWD_KEY);
        if (btn) btn.hidden = true;
        if (errEl) {
          errEl.textContent = "Biometric data corrupt — re-enable in Security.";
          errEl.hidden = false;
        }
        return;
      }
      const hash = await sha256(pwd);
      if (hash === localStorage.getItem(KEYS.pwd)) {
        await unlock(pwd);
      } else {
        // Password changed since registration — clear stale credential
        localStorage.removeItem(BIO_CRED_KEY);
        localStorage.removeItem(BIO_PWD_KEY);
        if (btn) btn.hidden = true;
        if (errEl) {
          errEl.textContent = "Biometric link expired — sign in with password to re-enable.";
          errEl.hidden = false;
        }
      }
    } catch (e) {
      console.warn("Biometric unlock failed", e);
      if (errEl) {
        // NotAllowedError is "user cancelled" — friendlier message
        const msg = (e && e.name === "NotAllowedError")
          ? "Biometric cancelled. Use password or try again."
          : "Biometric unlock failed. Use password instead.";
        errEl.textContent = msg;
        errEl.hidden = false;
      }
    } finally {
      // Restore button state
      if (btn) btn.disabled = false;
      if (lbl) lbl.textContent = "Unlock with biometrics";
      if (ico) ico.textContent = "🔐";
    }
  }

  async function registerBiometric(password) {
    if (!window.PublicKeyCredential) {
      showToast("Biometrics not supported on this device.");
      return false;
    }
    try {
      // Stable user ID per device — keep it across enrollments so iOS doesn't pile up credentials
      let userIdB64 = localStorage.getItem("mb_bio_user_id");
      let userId;
      if (userIdB64) {
        userId = _b64uToBytes(userIdB64);
      } else {
        userId = crypto.getRandomValues(new Uint8Array(16));
        localStorage.setItem("mb_bio_user_id", _bytesToB64u(userId));
      }
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: "Pocket Budget", id: location.hostname },
          user: {
            id: userId,
            name: "pocket-budget-user",
            displayName: "Pocket Budget",
          },
          pubKeyCredParams: [
            { alg: -7, type: "public-key" },   // ES256
            { alg: -257, type: "public-key" }, // RS256
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "required",
            residentKey: "preferred",
          },
          timeout: 60000,
          attestation: "none",
        },
      });
      if (!cred) return false;
      const credIdB64 = _bytesToB64u(cred.rawId);
      localStorage.setItem(BIO_CRED_KEY, credIdB64);
      // Store password Unicode-safe (btoa fails on chars > 0xFF — emoji, etc.)
      const utf8Bytes = new TextEncoder().encode(password);
      const wrapped = JSON.stringify({ p: _bytesToB64u(utf8Bytes), v: 2 });
      localStorage.setItem(BIO_PWD_KEY, wrapped);
      showToast("✓ Biometric unlock enabled");
      return true;
    } catch (e) {
      console.error("Register biometric failed", e);
      // Bubble up a more specific error so user knows what to do
      let msg = "Couldn't register biometric. Try again.";
      if (e && e.name === "NotAllowedError") {
        msg = "Biometric prompt cancelled or timed out.";
      } else if (e && e.name === "NotSupportedError") {
        msg = "Biometric type not supported on this device.";
      } else if (e && e.name === "InvalidStateError") {
        msg = "Already registered — tap unlock with biometrics.";
      } else if (e && e.name === "SecurityError") {
        msg = "Security error — make sure you're on https://";
      }
      showToast(msg);
      return false;
    }
  }

  function disableBiometric() {
    localStorage.removeItem(BIO_CRED_KEY);
    localStorage.removeItem(BIO_PWD_KEY);
    showToast("Biometric unlock disabled");
  }

  async function unlock(password) {
    $("#lockScreen").classList.remove("open");
    $("#app").hidden = false;
    // Stamp last-unlock time for the lock screen stats teaser
    try { localStorage.setItem("mb_last_unlock", String(Date.now())); } catch (e) {}
    if (password) {
      cachedPassword = password;
      try {
        cryptoKey = await deriveKey(password);
      } catch (e) {
        console.error("Key derivation failed", e);
        cryptoKey = null;
      }
    }
    await loadData();
    purgeOldTombstones();
    renderAll();
    checkBudgetAlerts();
    startAutoLock();
    startAutoSync();
    updateSyncIndicator("synced");
    updateNetStatus();
    // If sync is set up, automatically merge cloud data BEFORE running recurring
    // so we don't add duplicate recurring transactions across devices.
    if (localStorage.getItem(KEYS.syncToken) && localStorage.getItem(KEYS.syncGistId)) {
      // Run pull first; processRecurring runs after merge so it sees the freshest
      // r.lastRunMonth from any device. If the pull fails, we still run recurring
      // so the user isn't blocked.
      setTimeout(async () => {
        try {
          await syncPull({ skipConfirm: true, silent: true });
        } catch (e) {
          console.warn("Initial sync pull failed", e);
        }
        try {
          processRecurring();
          renderAll();
        } catch (e) { console.warn("Recurring run failed after pull", e); }
      }, 2000);
    } else {
      // No sync configured — run immediately
      processRecurring();
      renderAll();
    }
    maybeStartTour();
  }

  async function checkForRemoteUpdate() {
    const token = localStorage.getItem(KEYS.syncToken);
    const gistId = localStorage.getItem(KEYS.syncGistId);
    if (!token || !gistId) return;
    try {
      const res = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
      });
      if (!res.ok) return;
      const data = await res.json();
      const file = data.files[SYNC_FILENAME];
      if (!file) return;
      const payload = JSON.parse(file.content);
      const remoteTime = new Date(payload.updatedAt).getTime();
      const localTime = lastSyncedAt || 0;
      if (remoteTime > localTime + 60000) {
        // Remote is significantly newer — show a banner
        if (confirm(`Cloud has newer data (synced ${new Date(payload.updatedAt).toLocaleString()}). Pull now?`)) {
          syncPull();
        }
      }
    } catch (e) {
      console.warn("Remote check failed", e);
    }
  }

  function lockNow() {
    cryptoKey = null;
    cachedPassword = null;
    stopAutoLock();
    stopAutoSync();
    $("#app").hidden = true;
    $("#lockScreen").classList.add("open");
    const pwdInp = $("#passwordInput");
    if (pwdInp) {
      pwdInp.value = "";
      // Reset visibility back to password mode
      pwdInp.type = "password";
    }
    const pwdToggle = $("#passwordToggle");
    if (pwdToggle) {
      pwdToggle.textContent = "👁";
      pwdToggle.title = "Show password";
    }
    const confirmInp = $("#passwordConfirm");
    if (confirmInp) confirmInp.value = "";
    const errEl = $("#lockError");
    if (errEl) errEl.hidden = true;
    const capsHint = $("#capsLockHint");
    if (capsHint) capsHint.hidden = true;
    // Clear PIN buffer and refresh display
    _pinBuffer = "";
    renderPinDisplay();
    const pinErr = $("#lockPinError");
    if (pinErr) pinErr.hidden = true;
    // Refresh stats teaser (last-open time will update)
    try { renderLockStatsTeaser(); } catch (e) {}
    // Refresh network status (in case it changed while unlocked)
    try { updateNetStatus(); } catch (e) {}
    // Focus appropriate field
    setTimeout(() => {
      if ($("#lockPinPanel") && !$("#lockPinPanel").hidden) {
        // PIN mode — nothing to focus, pad takes input
      } else {
        $("#passwordInput")?.focus();
      }
    }, 50);
  }

  /* ---------- Auto-lock ---------- */
  let autoLockTimer = null;
  let autoLockMinutes = 10;
  const _AUTO_LOCK_EVENTS = ["click", "keydown", "mousemove", "touchstart"];

  function startAutoLock() {
    autoLockMinutes = parseInt(localStorage.getItem(KEYS.autoLock) || "10", 10);
    resetAutoLockTimer();
    // Remove first to avoid duplicate listeners on repeated start (lock/unlock cycles)
    _AUTO_LOCK_EVENTS.forEach((ev) => {
      document.removeEventListener(ev, resetAutoLockTimer);
      document.addEventListener(ev, resetAutoLockTimer, { passive: true });
    });
  }

  function stopAutoLock() {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
    _AUTO_LOCK_EVENTS.forEach((ev) => {
      document.removeEventListener(ev, resetAutoLockTimer);
    });
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

    // Tappable dashboard stat cards — jump to relevant tab
    document.addEventListener("click", (e) => {
      const card = e.target.closest("[data-stat-jump]");
      if (!card) return;
      // Don't intercept the inline link inside Credit Paid hint
      if (e.target.closest("[data-pay-cards]")) return;
      const tab = card.dataset.statJump;
      if (!tab) return;
      const navBtn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
      if (navBtn) navBtn.click();
    });
  }

  /* ---------- Renderers ---------- */
  function renderAll() {
    // Pick up synced currency setting if it changed via cross-device sync
    if (state.settings && state.settings.currency && state.settings.currency !== currency) {
      currency = state.settings.currency;
      localStorage.setItem(KEYS.currency, currency);
    }
    const monthLabelEl = $("#monthLabel");
    if (monthLabelEl) monthLabelEl.textContent = monthLabel(currentMonth());
    const safeCall = (fn, name) => {
      try { fn(); } catch (e) { console.error(`renderAll/${name} failed:`, e); }
    };
    safeCall(renderDashboard, "dashboard");
    safeCall(renderBalances, "balances");
    safeCall(renderTransactions, "transactions");
    safeCall(renderInsights, "insights");
    safeCall(renderCredit, "credit");
    safeCall(renderFamily, "family");
    safeCall(renderPresetsManage, "presetsManage");
    safeCall(renderRecurringList, "recurring");
    safeCall(renderAccountList, "accountList");
    safeCall(renderDashAccounts, "dashAccounts");
    safeCall(renderThemeButtons, "themeButtons");
    safeCall(renderGoalsTab, "goalsTab");
    safeCall(populateExpenseCategorySelect, "expenseCategorySelect");
    safeCall(() => populateAccountSelect("#expAccount", true), "expAccountSelect");
    safeCall(populatePersonSelect, "personSelect");
    safeCall(populateRecurringCategorySelect, "recurringCategorySelect");
    safeCall(renderFilterChips, "filterChips");
    safeCall(renderPersonFilterChips, "personFilterChips");
    safeCall(renderTagFilterChips, "tagFilterChips");
    safeCall(renderBillNegotiations, "billNegotiations");
    safeCall(renderIncomeSourcesManage, "incomeSourcesManage");
    safeCall(renderEventsTab, "eventsTab");
    safeCall(populateEventSelect, "eventSelect");
    safeCall(populateEventFilterSelect, "eventFilterSelect");
    safeCall(populateInsightsEventFilter, "insightsEventFilter");
    $("#currencySelect") && ($("#currencySelect").value = currency);
    const rolloverEl = $("#rolloverToggle");
    if (rolloverEl) rolloverEl.checked = !!state.settings.rollover;
    populateDefaultsSelects();
    renderBackupHealth();
    renderAccountCategoryMap();
    renderDataSummary();
    const skipDelTog = $("#skipDeleteConfirmToggle");
    if (skipDelTog) skipDelTog.checked = !!state.settings?.skipDeleteConfirm;
    // Reflect notification toggles
    [
      ["#notifyCat80Toggle", "cat80"],
      ["#notifyCat100Toggle", "cat100"],
      ["#notifyTotalOverToggle", "totalOver"],
      ["#notifyStatementToggle", "statementClose"],
      ["#notifyStaleRecurringToggle", "staleRecurring"],
    ].forEach(([sel, key]) => {
      const el = $(sel);
      if (el) el.checked = notifEnabled(key);
    });
    // Reflect accent color swatches
    loadAccentFromState();
    renderTopbarSpent();
    applyDashStatOrder();
  }

  // Topbar mini: spent today (visible on every tab)
  function renderTopbarSpent() {
    const el = document.getElementById("topSpentToday");
    if (!el) return;
    const today = todayStr();
    const total = state.expenses
      .filter((e) => e.date === today && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out")
      .reduce((s, e) => s + Number(e.amount), 0);
    el.textContent = `Today ${fmt(total)}`;
    el.classList.toggle("has-spend", total > 0);
  }

  // Read saved stat-card order from localStorage and re-arrange the grid
  function applyDashStatOrder() {
    const grid = document.getElementById("statGrid");
    if (!grid) return;
    let order = [];
    try { order = JSON.parse(localStorage.getItem("mb_stat_order") || "[]"); } catch (_) { /* ignore */ }
    if (!Array.isArray(order) || !order.length) return;
    const cards = Array.from(grid.querySelectorAll("[data-stat-id]"));
    const byId = new Map(cards.map((c) => [c.dataset.statId, c]));
    order.forEach((id) => {
      const c = byId.get(id);
      if (c) grid.appendChild(c);
    });
    // Append any new cards (not in saved order) at the end
    cards.forEach((c) => {
      if (!order.includes(c.dataset.statId)) grid.appendChild(c);
    });
  }

  function renderGoalsTab() {
    const overview = $("#goalOverview");
    const grid = $("#goalGrid");
    const totalPill = $("#goalsTotalSaved");
    if (!overview || !grid) return;

    const totalSaved = state.goals.reduce((s, g) => s + goalSavedTotal(g), 0);
    const totalTarget = state.goals.reduce((s, g) => s + (Number(g.target) || 0), 0);
    if (totalPill) totalPill.textContent = `${fmt(totalSaved)} saved`;

    if (!state.goals.length) {
      overview.innerHTML = '<p class="empty">No goals yet.</p>';
      grid.innerHTML = '<p class="empty">No savings goals yet. Tap + New Goal.</p>';
      return;
    }

    const overallPct = totalTarget > 0 ? (totalSaved / totalTarget) * 100 : 0;
    const completed = state.goals.filter((g) => goalSavedTotal(g) >= Number(g.target)).length;
    overview.innerHTML = `
      <div class="goal-overview-stats">
        <div class="goal-stat">
          <div class="card-sub">Total saved</div>
          <div class="ytd-value">${fmt(totalSaved)}</div>
          <div class="card-sub">of ${fmt(totalTarget)} target (${overallPct.toFixed(0)}%)</div>
        </div>
        <div class="goal-stat">
          <div class="card-sub">Goals completed</div>
          <div class="ytd-value">${completed} / ${state.goals.length}</div>
        </div>
      </div>
    `;

    grid.innerHTML = state.goals.map((g) => {
      const saved = goalSavedTotal(g);
      const target = Number(g.target) || 0;
      const pct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
      const remaining = Math.max(0, target - saved);

      // Calculate avg monthly contribution from txns
      const contribs = state.expenses.filter(
        (e) => e.goalId === g.id && e.type !== "income"
      );
      const monthsActive = contribs.length
        ? new Set(contribs.map((e) => monthKey(e.date))).size
        : 0;
      const avgPerMonth = monthsActive > 0
        ? contribs.reduce((s, e) => s + Number(e.amount), 0) / monthsActive
        : 0;

      // Projection
      let projection = "";
      if (remaining > 0 && avgPerMonth > 0) {
        const monthsToGoal = Math.ceil(remaining / avgPerMonth);
        const eta = new Date();
        eta.setMonth(eta.getMonth() + monthsToGoal);
        projection = `<div class="goal-projection">📅 At ${fmt(avgPerMonth)}/mo pace → ${eta.toLocaleDateString(undefined, { month: "short", year: "numeric" })} (${monthsToGoal} mo)</div>`;
      } else if (g.date && remaining > 0) {
        const target = new Date(g.date);
        const monthsLeft = Math.max(1, Math.round((target - new Date()) / (30.44 * 24 * 60 * 60 * 1000)));
        const needed = remaining / monthsLeft;
        projection = `<div class="goal-projection">📅 Need <strong>${fmt(needed)}</strong>/mo to hit ${g.date}</div>`;
      }

      // Suggested next contribution: if there's a date, use date-based; otherwise avg
      let suggestedAmt = 0;
      if (g.date && remaining > 0) {
        const targetDate = new Date(g.date);
        const monthsLeft = Math.max(1, Math.round((targetDate - new Date()) / (30.44 * 24 * 60 * 60 * 1000)));
        suggestedAmt = remaining / monthsLeft;
      } else if (avgPerMonth > 0) {
        suggestedAmt = avgPerMonth;
      } else if (remaining > 0) {
        // Default: round to nearest $25
        suggestedAmt = Math.max(25, Math.round(remaining / 24 / 25) * 25);
      }
      const suggestedHtml = suggestedAmt > 0
        ? `<button class="btn-secondary goal-suggest" data-action="suggest-goal-amount" data-id="${g.id}" data-amt="${suggestedAmt.toFixed(2)}" title="Use suggested amount">💡 ${fmt(suggestedAmt)}</button>`
        : "";

      const dateStr = g.date ? `Target: ${g.date}` : "No deadline";
      return `
        <div class="goal-card">
          <div class="goal-header">
            <h3>${escapeHtml(g.name)}</h3>
            <button class="icon-btn" data-action="del-goal" data-id="${g.id}" title="Delete">🗑️</button>
          </div>
          <div class="goal-amounts">
            <div><strong>${fmt(saved)}</strong> of ${fmt(target)}</div>
            <div class="card-sub">${dateStr}</div>
          </div>
          <div class="progress-bar"><div class="progress-fill ${saved >= target ? "success" : ""}" style="width:${pct}%"></div></div>
          <div class="card-sub" style="text-align:center;margin-top:0.4rem">${pct.toFixed(0)}% complete</div>
          ${projection}
          <div class="goal-actions" style="margin-top:0.6rem">
            <input type="number" placeholder="Add amount" step="0.01" min="0" data-goal-input="${g.id}" />
            <button class="btn-primary" data-action="add-saving" data-id="${g.id}">Add</button>
            ${suggestedHtml}
          </div>
          <div class="goal-quick-chips" style="margin-top:0.4rem">
            <button class="chip-mini" data-action="quick-goal-amt" data-id="${g.id}" data-amt="10">+10</button>
            <button class="chip-mini" data-action="quick-goal-amt" data-id="${g.id}" data-amt="25">+25</button>
            <button class="chip-mini" data-action="quick-goal-amt" data-id="${g.id}" data-amt="50">+50</button>
            <button class="chip-mini" data-action="quick-goal-amt" data-id="${g.id}" data-amt="100">+100</button>
          </div>
        </div>`;
    }).join("");

    // Sync round-up settings on this tab too
    const ru2 = $("#roundUpToggle2");
    if (ru2) ru2.checked = !!state.settings.roundUpEnabled;
    const ruRow2 = $("#roundUpGoalRow2");
    if (ruRow2) ruRow2.style.display = state.settings.roundUpEnabled ? "block" : "none";
    const ruSel2 = $("#roundUpGoalSelect2");
    if (ruSel2) {
      ruSel2.innerHTML = '<option value="">Select goal</option>' +
        state.goals.map((g) => `<option value="${g.id}" ${g.id === state.settings.roundUpGoalId ? "selected" : ""}>${escapeHtml(g.name)}</option>`).join("");
    }
    // Re-use the same stats calc
    if ($("#roundUpStats2") && state.settings.roundUpEnabled && state.settings.roundUpGoalId) {
      const m = currentMonth();
      let total = 0;
      state.expenses.forEach((e) => {
        if (e.type !== "expense") return;
        if (monthKey(e.date) !== m) return;
        const cents = Math.round(Number(e.amount) * 100) % 100;
        total += cents === 0 ? 0 : (100 - cents) / 100;
      });
      const goal = state.goals.find((g) => g.id === state.settings.roundUpGoalId);
      $("#roundUpStats2").innerHTML = `Round-up potential this month: <strong>${fmt(total)}</strong> → ${goal ? escapeHtml(goal.name) : ""}`;
    } else if ($("#roundUpStats2")) {
      $("#roundUpStats2").textContent = state.settings.roundUpEnabled ? "Pick a destination goal." : "";
    }

    renderGoalsTimelineChart();
  }

  function renderGoalsTimelineChart() {
    if (typeof Chart === "undefined") return;
    destroyChart("goalsTimeline");
    const ctx = $("#chartGoalsTimeline");
    if (!ctx) return;
    const goalsWithDates = state.goals.filter((g) => g.date && Number(g.target) > 0);
    const emptyEl = $("#goalsTimelineEmpty");
    if (!goalsWithDates.length) {
      if (emptyEl) emptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    ctx.style.display = "block";

    const sorted = [...goalsWithDates].sort((a, b) => a.date.localeCompare(b.date));
    const labels = sorted.map((g) => g.name);
    const targets = sorted.map((g) => Number(g.target));
    const saved = sorted.map((g) => goalSavedTotal(g));

    charts.goalsTimeline = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Saved", data: saved, backgroundColor: "#22c55e", borderRadius: 6 },
          { label: "Remaining", data: sorted.map((g, i) => Math.max(0, targets[i] - saved[i])), backgroundColor: "#e6e1d5", borderRadius: 6 },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "top" },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmt(ctx.parsed.x)}` } },
        },
        scales: {
          x: { stacked: true, ticks: { callback: (v) => fmt(v) }, grid: { color: "#eee" } },
          y: { stacked: true, grid: { display: false } },
        },
      },
    });
  }

  /* ---------- Events (vacations, life events) ---------- */

  // Compute spend on an event by summing expense txns tagged to it
  function eventSpentTotal(eventId, lineItemId) {
    return (state.expenses || []).reduce((s, e) => {
      if (e.eventId !== eventId) return s;
      if (e.type !== "expense") return s;
      if (lineItemId && e.eventLineItemId !== lineItemId) return s;
      return s + (Number(e.amount) || 0);
    }, 0);
  }

  // Auto-derive status if not explicitly set
  function eventStatus(ev) {
    if (ev.status === "completed") return "completed";
    const today = todayStr();
    if (ev.endDate && today > ev.endDate) return "completed";
    if (ev.startDate && today >= ev.startDate) return "active";
    return "planning";
  }

  let eventsSearchQuery = "";

  function renderEventsTab() {
    const activeList = $("#eventsActiveList");
    const completedList = $("#eventsCompletedList");
    const pill = $("#eventsTotalPill");
    if (!activeList || !completedList) return;

    if (!state.events.length) {
      activeList.innerHTML = `
        <p class="empty">No events yet — get started with a template or tap <strong>+ New Event</strong>.</p>
        <div class="event-templates">
          <button class="event-template" data-template="vacation">🌴<span>Vacation</span><span class="card-sub">Trip with line items</span></button>
          <button class="event-template" data-template="wedding">💍<span>Wedding</span><span class="card-sub">Big day budget</span></button>
          <button class="event-template" data-template="move">📦<span>Moving</span><span class="card-sub">Relocation costs</span></button>
          <button class="event-template" data-template="holidays">🎁<span>Holidays</span><span class="card-sub">Gifts + travel</span></button>
        </div>
      `;
      completedList.innerHTML = '<p class="empty">No completed events yet.</p>';
      if (pill) pill.textContent = "No events yet";
      return;
    }

    const q = (eventsSearchQuery || "").toLowerCase().trim();
    const matches = (ev) => {
      if (!q) return true;
      return (ev.name || "").toLowerCase().includes(q)
        || (ev.notes || "").toLowerCase().includes(q);
    };

    const active = [];
    const completed = [];
    state.events.forEach((ev) => {
      if (!matches(ev)) return;
      if (eventStatus(ev) === "completed") completed.push(ev);
      else active.push(ev);
    });
    // Active sorted by start date asc; completed by end date desc
    active.sort((a, b) => (a.startDate || "9999").localeCompare(b.startDate || "9999"));
    completed.sort((a, b) => (b.endDate || "").localeCompare(a.endDate || ""));

    if (pill) {
      const totalBudget = state.events.reduce((s, ev) => s + (Number(ev.budget) || 0), 0);
      const totalSpent = state.events.reduce((s, ev) => s + eventSpentTotal(ev.id), 0);
      pill.textContent = `${state.events.length} event${state.events.length === 1 ? "" : "s"} · ${fmt(totalSpent)} / ${fmt(totalBudget)}`;
    }

    activeList.innerHTML = active.length ? active.map(renderEventCard).join("") : `<p class="empty">${q ? "No matches." : "No upcoming events."}</p>`;
    completedList.innerHTML = completed.length ? completed.map(renderEventCard).join("") : `<p class="empty">${q ? "No matches." : "No completed events yet."}</p>`;
  }

  function renderEventCard(ev) {
    const status = eventStatus(ev);
    const today = new Date();
    const spent = eventSpentTotal(ev.id);
    const budget = Number(ev.budget) || 0;
    const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    const overBudget = budget > 0 && spent > budget;
    let cls = "success";
    if (pct >= 100) cls = "danger";
    else if (pct >= 80) cls = "warning";

    let timing = "";
    if (status === "planning" && ev.startDate) {
      const start = new Date(ev.startDate);
      const days = Math.ceil((start - today) / (24 * 60 * 60 * 1000));
      timing = days > 0 ? `Starts in ${days} day${days === 1 ? "" : "s"}` : "Starting soon";
    } else if (status === "active") {
      const end = ev.endDate ? new Date(ev.endDate) : null;
      if (end) {
        const days = Math.ceil((end - today) / (24 * 60 * 60 * 1000));
        timing = days > 0 ? `Active · ${days} day${days === 1 ? "" : "s"} left` : "Active · ends today";
      } else {
        timing = "Active";
      }
    } else {
      timing = "Completed";
    }

    // Daily pace for active events
    let paceHtml = "";
    if (status === "active" && ev.startDate && ev.endDate && spent > 0) {
      const start = new Date(ev.startDate);
      const end = new Date(ev.endDate);
      const totalDays = Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1000)) + 1);
      const daysElapsed = Math.max(1, Math.ceil((today - start) / (24 * 60 * 60 * 1000)) + 1);
      const daysRemaining = Math.max(0, totalDays - daysElapsed);
      const dailyPaceSoFar = spent / daysElapsed;
      const remainingBudget = Math.max(0, budget - spent);
      const dailyBudgetRemaining = daysRemaining > 0 ? remainingBudget / daysRemaining : 0;
      paceHtml = `<div class="event-pace">⏱️ ${fmt(dailyPaceSoFar)}/day so far${budget > 0 && daysRemaining > 0 ? ` · ${fmt(dailyBudgetRemaining)}/day budget left` : ""}</div>`;
    }

    const dateRange = ev.startDate && ev.endDate
      ? `${ev.startDate} → ${ev.endDate}`
      : (ev.startDate || ev.endDate || "No dates set");

    // Line item breakdown
    let lineItemsHtml = "";
    if (Array.isArray(ev.lineItems) && ev.lineItems.length) {
      lineItemsHtml = `<div class="event-lines">${ev.lineItems.map((li) => {
        const liSpent = eventSpentTotal(ev.id, li.id);
        const liBudget = Number(li.budget) || 0;
        const liPctRaw = liBudget > 0 ? (liSpent / liBudget) * 100 : 0;
        const liPct = Math.min(100, liPctRaw);
        const liCls = liPctRaw >= 100 ? "danger" : liPctRaw >= 80 ? "warning" : "success";
        const overTag = liBudget > 0 && liSpent > liBudget
          ? ` <span class="li-over-tag">+${fmt(liSpent - liBudget)} over</span>`
          : "";
        return `
          <div class="event-line-row">
            <div class="event-line-head">
              <span>${escapeHtml(li.label)}${overTag}</span>
              <span class="event-line-actions">
                <span class="card-sub">${fmt(liSpent)}${liBudget > 0 ? ` / ${fmt(liBudget)}` : ""}</span>
                <button class="event-line-add" data-action="quick-line-spend" data-event-id="${ev.id}" data-line-id="${li.id}" title="Add expense to ${escapeHtml(li.label)}">+</button>
              </span>
            </div>
            ${liBudget > 0 ? `<div class="progress-bar"><div class="progress-fill ${liCls}" style="width:${liPct}%"></div></div>` : ""}
          </div>`;
      }).join("")}</div>`;
    }

    // Linked savings goal progress (if any)
    let linkedGoalHtml = "";
    if (ev.linkedGoalId) {
      const goal = state.goals.find((g) => g.id === ev.linkedGoalId);
      if (goal) {
        const saved = goalSavedTotal(goal);
        const target = Number(goal.target) || 0;
        const gpct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
        const gcls = gpct >= 100 ? "success" : gpct >= 80 ? "" : "";
        linkedGoalHtml = `
          <div class="event-linked-goal">
            <div class="event-linked-goal-head">
              <span>🎯 ${escapeHtml(goal.name)}</span>
              <span class="card-sub">${fmt(saved)} / ${fmt(target)} (${gpct.toFixed(0)}%)</span>
            </div>
            <div class="progress-bar"><div class="progress-fill ${gcls}" style="width:${gpct}%; background:#22c55e"></div></div>
          </div>`;
      }
    }
    let cardSummaryHtml = "";
    const cardTxns = state.expenses.filter((e) => {
      if (e.eventId !== ev.id || e.type !== "expense") return false;
      const acc = e.accountId ? state.accounts.find((a) => a.id === e.accountId) : null;
      return acc && ((acc.type || "").toLowerCase() === "credit" || !!acc.cardId);
    });
    if (cardTxns.length) {
      const byCard = {};
      cardTxns.forEach((e) => {
        const acc = state.accounts.find((a) => a.id === e.accountId);
        if (!acc) return;
        byCard[acc.name] = (byCard[acc.name] || 0) + Number(e.amount);
      });
      const cardEntries = Object.entries(byCard).sort((a, b) => b[1] - a[1]);
      cardSummaryHtml = `<div class="event-card-spend">
        <span class="card-sub">💳 On cards: ${cardEntries.map(([n, a]) => `${escapeHtml(n)} ${fmt(a)}`).join(" · ")}</span>
      </div>`;
    }

    const statusBadge = status === "active" ? '<span class="event-badge active">🟢 Active</span>'
      : status === "completed" ? '<span class="event-badge completed">✓ Completed</span>'
      : '<span class="event-badge planning">📅 Planning</span>';

    const overTag = overBudget ? `<span class="event-badge over">⚠ Over by ${fmt(spent - budget)}</span>` : "";

    return `
      <div class="event-card" style="border-left: 4px solid ${ev.color || "#5b3fb8"}">
        <div class="event-card-head">
          <h3>${ev.icon || "🌴"} ${escapeHtml(ev.name)}</h3>
          <div class="list-item-actions">
            <button data-action="quick-event-spend" data-id="${ev.id}" title="Add expense to this event">+</button>
            <button data-action="event-txns" data-id="${ev.id}" title="Show transactions">📜</button>
            <button data-action="event-checklist" data-id="${ev.id}" title="Checklist">📋</button>
            <button data-action="event-report" data-id="${ev.id}" title="Generate report">📄</button>
            <button data-action="event-csv" data-id="${ev.id}" title="Export CSV">⤓</button>
            <button data-action="dup-event" data-id="${ev.id}" title="Duplicate">⎘</button>
            ${status !== "completed" ? `<button data-action="event-complete" data-id="${ev.id}" title="Mark as completed">✓</button>` : `<button data-action="event-reopen" data-id="${ev.id}" title="Reopen event">↻</button>`}
            <button data-action="edit-event" data-id="${ev.id}" title="Edit">✏️</button>
            <button data-action="del-event" data-id="${ev.id}" title="Delete">🗑️</button>
          </div>
        </div>
        <div class="event-meta">${statusBadge}${overTag}${ev.vacationMode ? '<span class="event-badge vacation">🏖️ Vacation mode</span>' : ""}<span class="card-sub">${timing} · ${dateRange}</span></div>
        ${budget > 0 ? `
          <div class="event-amounts">
            <div><strong>${fmt(spent)}</strong> of ${fmt(budget)}</div>
            <div class="card-sub">${pct.toFixed(0)}% used${budget > 0 ? ` · ${fmt(Math.max(0, budget - spent))} left` : ""}</div>
          </div>
          <div class="progress-bar"><div class="progress-fill ${cls}" style="width:${pct}%"></div></div>
        ` : `
          <div class="event-amounts">
            <div><strong>${fmt(spent)}</strong> spent</div>
            <div class="card-sub">No budget set</div>
          </div>
        `}
        ${lineItemsHtml}
        ${linkedGoalHtml}
        ${paceHtml}
        ${cardSummaryHtml}
        ${ev.notes ? `<div class="event-notes">${escapeHtml(ev.notes)}</div>` : ""}
        <div class="event-checklist-panel" data-event-checklist="${ev.id}" hidden>
          ${renderEventChecklistRows(ev)}
        </div>
        <div class="event-txns-panel" data-event-txns="${ev.id}" hidden>
          ${renderEventTxnRows(ev)}
        </div>
      </div>`;
  }

  // Render the checklist HTML for an event
  function renderEventChecklistRows(ev) {
    const items = Array.isArray(ev.checklist) ? ev.checklist : [];
    const completed = items.filter((it) => it.done).length;
    const checklistRows = items.map((it) => `
      <div class="event-check-row ${it.done ? "done" : ""}" data-check-id="${it.id}">
        <input type="checkbox" data-action="toggle-event-check" data-event-id="${ev.id}" data-check-id="${it.id}" ${it.done ? "checked" : ""} />
        <span class="event-check-label">${escapeHtml(it.label)}</span>
        <button class="link" data-action="del-event-check" data-event-id="${ev.id}" data-check-id="${it.id}" title="Remove">×</button>
      </div>
    `).join("");
    return `
      <div class="event-checklist-head">
        <strong>📋 Checklist</strong>
        ${items.length > 0 ? `<span class="card-sub">${completed} / ${items.length} done</span>` : ""}
      </div>
      <div class="event-check-list">
        ${checklistRows || '<div class="card-sub">No items yet — add tasks below.</div>'}
      </div>
      <div class="event-check-add">
        <input type="text" class="event-check-input" data-event-id="${ev.id}" placeholder="Add a task (e.g. Pack passport)" />
        <button class="btn-secondary" data-action="add-event-check" data-event-id="${ev.id}">Add</button>
      </div>
    `;
  }

  // Render the inline transactions list for an event
  function renderEventTxnRows(ev) {
    const txns = state.expenses
      .filter((e) => e.eventId === ev.id && e.type === "expense")
      .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id))
      .slice(0, 50); // cap for performance
    if (!txns.length) {
      return `<div class="card-sub">No transactions tagged to this event yet. Use the + button or tag a transaction with this event.</div>`;
    }
    const rows = txns.map((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const li = e.eventLineItemId ? (ev.lineItems || []).find((x) => x.id === e.eventLineItemId) : null;
      const liTag = li ? `<span class="event-txn-li">${escapeHtml(li.label)}</span>` : "";
      const acc = e.accountId ? state.accounts.find((a) => a.id === e.accountId) : null;
      const accTag = acc ? `<span class="card-sub">· ${escapeHtml(acc.name)}</span>` : "";
      return `
        <div class="event-txn-row">
          <div class="event-txn-info">
            <div class="event-txn-desc">${escapeHtml(e.desc)} ${liTag}</div>
            <div class="event-txn-meta">${e.date} · ${escapeHtml(cat ? cat.name : "Uncategorized")} ${accTag}</div>
          </div>
          <div class="event-txn-amount negative">−${fmt(e.amount)}</div>
        </div>`;
    }).join("");
    return `
      <div class="event-txn-head">
        <strong>📜 Transactions</strong>
        <span class="card-sub">${txns.length}${txns.length === 50 ? "+" : ""} shown</span>
      </div>
      <div class="event-txn-list">${rows}</div>
    `;
  }

  function populateEventSelect() {
    const sel = $("#expEvent");
    if (!sel) return;
    const today = todayStr();
    // Prefer active/upcoming events at top
    const sorted = [...(state.events || [])].sort((a, b) => {
      const ax = (a.endDate || "9999") < today ? 1 : 0;
      const bx = (b.endDate || "9999") < today ? 1 : 0;
      if (ax !== bx) return ax - bx;
      return (a.startDate || "").localeCompare(b.startDate || "");
    });
    sel.innerHTML = '<option value="">— No event —</option>' +
      sorted.map((ev) => {
        const status = eventStatus(ev);
        const tag = status === "active" ? "🟢" : status === "completed" ? "✓" : "📅";
        return `<option value="${ev.id}">${tag} ${escapeHtml(ev.icon || "")} ${escapeHtml(ev.name)}</option>`;
      }).join("");
  }

  // Populate the Transactions filter dropdown — same sort, plus the "All events" option
  function populateEventFilterSelect() {
    const sel = $("#filterEvent");
    if (!sel) return;
    const cur = filters.eventId || "";
    const today = todayStr();
    const sorted = [...(state.events || [])].sort((a, b) => {
      const ax = (a.endDate || "9999") < today ? 1 : 0;
      const bx = (b.endDate || "9999") < today ? 1 : 0;
      if (ax !== bx) return ax - bx;
      return (a.startDate || "").localeCompare(b.startDate || "");
    });
    sel.innerHTML = '<option value="">All events</option>' +
      sorted.map((ev) => {
        const status = eventStatus(ev);
        const tag = status === "active" ? "🟢" : status === "completed" ? "✓" : "📅";
        return `<option value="${ev.id}">${tag} ${escapeHtml(ev.name)}</option>`;
      }).join("");
    sel.value = cur;
  }

  // Same dropdown for the Insights tab
  function populateInsightsEventFilter() {
    const sel = $("#insightsEventFilter");
    if (!sel) return;
    const cur = insightsEventFilterId || "";
    const today = todayStr();
    const sorted = [...(state.events || [])].sort((a, b) => {
      const ax = (a.endDate || "9999") < today ? 1 : 0;
      const bx = (b.endDate || "9999") < today ? 1 : 0;
      if (ax !== bx) return ax - bx;
      return (a.startDate || "").localeCompare(b.startDate || "");
    });
    sel.innerHTML = '<option value="">All transactions</option>' +
      sorted.map((ev) => {
        const status = eventStatus(ev);
        const tag = status === "active" ? "🟢" : status === "completed" ? "✓" : "📅";
        return `<option value="${ev.id}">${tag} ${escapeHtml(ev.name)}</option>`;
      }).join("");
    sel.value = cur;
  }

  /* ---------- Event modal ---------- */
  function openEventModal(ev) {
    const isEdit = !!(ev && ev.id);
    $("#eventModalTitle").textContent = isEdit ? "Edit Event" : "New Event";
    $("#eventEditId").value = isEdit ? ev.id : "";
    $("#eventName").value = ev ? (ev.name || "") : "";
    $("#eventIcon").value = ev ? (ev.icon || "🌴") : "🌴";
    $("#eventStart").value = ev ? (ev.startDate || "") : "";
    $("#eventEnd").value = ev ? (ev.endDate || "") : "";
    $("#eventBudget").value = ev && ev.budget ? Number(ev.budget) : "";
    const colorEl = $("#eventColor");
    if (colorEl) colorEl.value = ev && ev.color ? ev.color : "#5b3fb8";
    $("#eventNotes").value = ev ? (ev.notes || "") : "";
    // Populate linked-goal dropdown
    const goalSel = $("#eventLinkedGoal");
    if (goalSel) {
      goalSel.innerHTML = '<option value="">— None —</option>' +
        state.goals.map((g) => `<option value="${g.id}">🎯 ${escapeHtml(g.name)}</option>`).join("");
      goalSel.value = ev ? (ev.linkedGoalId || "") : "";
    }
    const vmEl = $("#eventVacationMode");
    if (vmEl) vmEl.checked = ev ? !!ev.vacationMode : false;
    renderEventLineItemsForm(ev ? (ev.lineItems || []) : []);
    $("#eventModal").classList.add("open");
    setTimeout(() => $("#eventName")?.focus(), 50);
  }

  function closeEventModal() {
    $("#eventModal").classList.remove("open");
  }

  function renderEventLineItemsForm(items) {
    const container = $("#eventLineItems");
    if (!container) return;
    container.innerHTML = "";
    items.forEach((li) => addEventLineItemRow(li));
  }

  function addEventLineItemRow(li) {
    const container = $("#eventLineItems");
    if (!container) return;
    const row = document.createElement("div");
    row.className = "event-line-form-row";
    row.dataset.liId = li?.id || uid();
    row.innerHTML = `
      <input type="text" class="li-label" placeholder="Flights, Hotel, Food" value="${escapeHtml(li?.label || "")}" />
      <input type="number" class="li-budget" step="0.01" min="0" placeholder="Budget" value="${li?.budget || ""}" />
      <button type="button" class="btn-secondary li-remove" title="Remove">×</button>
    `;
    row.querySelector(".li-remove").addEventListener("click", () => row.remove());
    container.appendChild(row);
  }

  function readEventLineItemsFromForm() {
    return Array.from(document.querySelectorAll(".event-line-form-row")).map((row) => {
      const label = row.querySelector(".li-label").value.trim();
      const budget = parseFloat(row.querySelector(".li-budget").value) || 0;
      if (!label) return null;
      return { id: row.dataset.liId, label, budget };
    }).filter(Boolean);
  }

  function renderRecurringList() {
    const list = $("#recurringList");
    if (!list) return;
    if (!state.recurring.length) {
      list.innerHTML = '<li class="empty">No recurring transactions yet.</li>';
    } else {
      // Sort: active first, then paused; alphabetical inside each group
      const sorted = [...state.recurring].sort((a, b) => {
        if (!!a.active !== !!b.active) return a.active ? -1 : 1;
        return (a.desc || "").localeCompare(b.desc || "");
      });
      const m = currentMonth();
      const totalActive = sorted.filter((r) => r.active).length;
      const totalActiveAmount = sorted
        .filter((r) => r.active && r.type === "expense")
        .reduce((s, r) => s + (Number(r.amount) || 0), 0);
      const totalActiveIncome = sorted
        .filter((r) => r.active && r.type === "income")
        .reduce((s, r) => s + (Number(r.amount) || 0), 0);

      const summary = `
        <li class="cat-summary-row">
          <span><strong>${totalActive}</strong> active${totalActiveAmount > 0 ? ` · ${fmt(totalActiveAmount)}/mo expenses` : ""}${totalActiveIncome > 0 ? ` · ${fmt(totalActiveIncome)}/mo income` : ""}</span>
          ${state.recurring.length - totalActive > 0 ? `<span class="card-sub">${state.recurring.length - totalActive} paused</span>` : ""}
        </li>`;

      const rowsHtml = sorted
        .map((r) => {
          const cat = state.categories.find((c) => c.id === r.categoryId);
          const catName = cat ? cat.name : (r.type === "income" ? "Income" : "—");
          const typeLabel = r.type === "income" ? "💰" : "💸";
          const goal = r.goalId ? state.goals.find((g) => g.id === r.goalId) : null;
          const goalLabel = goal ? ` · 🎯 ${escapeHtml(goal.name)}` : "";
          const pausedCls = r.active ? "" : "rec-paused";
          const lastRun = r.lastRunMonth || "";
          let staleTag = "";
          if (r.active && lastRun) {
            const monthsAgo = monthDiff(lastRun, m);
            if (monthsAgo >= 3) {
              staleTag = `<span class="rec-stale-tag">⚠ Stale · ${monthsAgo}mo</span>`;
            }
          }
          const statusTag = r.active
            ? (lastRun ? `<span class="rec-status-tag">Last ran ${lastRun}</span>` : `<span class="rec-status-tag">Pending</span>`)
            : `<span class="rec-status-tag rec-status-paused">Paused</span>`;
          return `
            <li class="list-item ${pausedCls}">
              <div class="list-item-main">
                <div class="list-item-title">${typeLabel} ${escapeHtml(r.desc)} ${staleTag}</div>
                <div class="list-item-sub">${fmt(r.amount)} on day ${r.dayOfMonth} · ${escapeHtml(catName)}${goalLabel} · ${statusTag}</div>
              </div>
              <div class="list-item-actions">
                <button data-action="edit-rec" data-id="${r.id}" title="Edit">✏️</button>
                <button data-action="toggle-rec" data-id="${r.id}" title="${r.active ? "Pause" : "Resume"}">${r.active ? "⏸️" : "▶️"}</button>
                <button data-action="del-rec" data-id="${r.id}" title="Delete">🗑️</button>
              </div>
            </li>`;
        })
        .join("");

      const stalePaused = sorted.filter((r) => !r.active && r.lastRunMonth && monthDiff(r.lastRunMonth, m) >= 3);
      const cleanupHtml = stalePaused.length > 0
        ? `<li class="rec-cleanup-row"><button class="link" data-action="cleanup-stale-rec">🧹 Delete ${stalePaused.length} stale paused rule${stalePaused.length === 1 ? "" : "s"}</button></li>`
        : "";

      list.innerHTML = summary + rowsHtml + cleanupHtml;
    }

    // Subscription suggestions
    renderSubscriptionSuggestions();
  }

  // Months between two YYYY-MM strings (positive = later)
  function monthDiff(from, to) {
    if (!from || !to) return 0;
    const [fy, fm] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    return (ty - fy) * 12 + (tm - fm);
  }

  /* ---------- Accounts ---------- */
  function accountBalance(accId) {
    const acc = state.accounts.find((a) => a.id === accId);
    if (!acc) return 0;
    const starting = Number(acc.balance) || 0;
    const txns = state.expenses.filter((e) => e.accountId === accId);
    const delta = txns.reduce((s, t) => {
      const amt = Number(t.amount) || 0;
      if (t.type === "income") return s + amt;
      if (t.type === "transfer-out") return s - amt;
      if (t.type === "transfer-in") return s + amt;
      return s - amt; // expense
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

  // Returns the number of days in the given YYYY-MM month (28/29/30/31)
  function daysInMonth(monthKeyStr) {
    const [y, m] = monthKeyStr.split("-").map(Number);
    return new Date(y, m, 0).getDate(); // Day 0 of next month = last day of this
  }

  // Clamp a configured "day of month" (1-31) to the actual last day of the
  // given month. Used so a "31st" rule still fires on Feb 28/29 etc.
  function clampDayToMonth(day, monthKeyStr) {
    const last = daysInMonth(monthKeyStr);
    return Math.min(last, Math.max(1, day || 1));
  }

  function setIncomeForMonth(monthKeyStr, amount) {
    if (!state.monthlyIncome) state.monthlyIncome = {};
    state.monthlyIncome[monthKeyStr] = Number(amount) || 0;
    touchMapKey("monthlyIncome", monthKeyStr);
  }

  // Total saved toward a goal: manual baseline (goal.saved) + sum of expense
  // transactions tagged with this goalId. Used wherever progress is shown so the
  // UI cannot drift from the underlying transaction history.
  function goalSavedTotal(goal) {
    if (!goal) return 0;
    const baseline = Number(goal.saved) || 0;
    const fromTxns = state.expenses.reduce((s, e) => {
      if (e.goalId === goal.id && e.type === "expense") {
        return s + (Number(e.amount) || 0);
      }
      return s;
    }, 0);
    return baseline + fromTxns;
  }

  function renderMonthIncomeList() {
    const list = $("#monthIncomeList");
    if (!list) return;

    // Show actual income this month vs current target at the top
    const month = currentMonth();
    const monthIncomeTxns = state.expenses.filter(
      (e) => e.type === "income" && monthKey(e.date) === month
    );
    const actual = monthIncomeTxns.reduce((s, e) => s + Number(e.amount), 0);
    const target = incomeForMonth(month);
    let actualHtml = "";
    if (target > 0 || actual > 0) {
      const pct = target > 0 ? (actual / target) * 100 : 0;
      const cls = target > 0 ? (pct >= 95 ? "positive" : pct >= 50 ? "" : "negative") : "";
      actualHtml = `
        <li class="cat-summary-row">
          <span><strong>${fmt(actual)}</strong> earned${target > 0 ? ` of <strong>${fmt(target)}</strong> target` : ""}</span>
          <span class="${cls}">${target > 0 ? `${pct.toFixed(0)}%` : monthLabel(month).split(" ")[0]}</span>
        </li>`;
    }

    const entries = Object.entries(state.monthlyIncome || {})
      .filter(([_, v]) => Number(v) > 0)
      .sort(([a], [b]) => b.localeCompare(a)); // newest first
    if (!entries.length) {
      list.innerHTML = actualHtml + '<li class="empty">No monthly overrides yet. Default will be used.</li>';
      return;
    }
    list.innerHTML = actualHtml + entries
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

  // Returns the GROSS amount for income (used only by the tax estimator).
  // For paychecks, gross is stored in paycheckMeta; otherwise the recorded amount IS gross.
  function incomeGrossAmount(e) {
    if (!e) return 0;
    if (e.paycheckMeta && Number(e.paycheckMeta.gross) > 0) return Number(e.paycheckMeta.gross);
    return Number(e.amount) || 0;
  }

  function ytdGrossIncomeTotal() {
    const year = currentMonth().slice(0, 4);
    return state.expenses
      .filter((e) => e.type === "income" && (e.date || "").startsWith(year))
      .reduce((s, e) => s + incomeGrossAmount(e), 0);
  }

  // Helper kept for back-compat — now returns the recorded amount (net for paychecks).
  // Income totals on the dashboard/insights/etc use the on-record amount so the math
  // matches what hit your accounts. The tax estimator uses incomeGrossAmount instead.
  function incomeReportingAmount(e) {
    return Number(e?.amount) || 0;
  }

  function ytdIncomeBySource() {
    const year = currentMonth().slice(0, 4);
    const out = {};
    state.expenses
      .filter((e) => e.type === "income" && (e.date || "").startsWith(year))
      .forEach((e) => {
        const key = e.source || "(unspecified)";
        out[key] = (out[key] || 0) + incomeReportingAmount(e);
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
        out[key] = (out[key] || 0) + incomeReportingAmount(e);
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
      const day = clampDayToMonth(r.dayOfMonth || 1, month);
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
      const day = clampDayToMonth(r.dayOfMonth || 1, m);
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
      const day = clampDayToMonth(c.dueDay, m);
      const dateStr = `${m}-${String(day).padStart(2, "0")}`;
      // Card is "paid" if any credit-payment was logged this month for this card
      const paidThisMonth = state.expenses.some(
        (e) => e.kind === "credit-payment" && e.cardId === c.id &&
               e.type === "transfer-out" && monthKey(e.date) === m
      );
      bills.push({
        type: "card",
        date: dateStr,
        day,
        name: `${c.name} payment`,
        amount: Number(c.statement) > 0 ? Number(c.statement) : cardCurrentBalance(c),
        paid: paidThisMonth,
        autopay: c.autopay,
        icon: "💳",
        cardId: c.id,
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
          ${b.type === "card" && !b.paid && !b.autopay ? `<button class="bill-pay-btn" data-action="quick-pay-card" data-id="${b.cardId}" title="Pay this card">Pay</button>` : ""}
        </div>`;
    });

    el.innerHTML = html;
  }

  /* ---------- Smart Insights ---------- */
  function renderDashSyncCard() {
    const card = $("#dashSyncCard");
    const body = $("#dashSyncCardBody");
    if (!card || !body) return;
    const enabled = localStorage.getItem(KEYS.syncToken) && localStorage.getItem(KEYS.syncGistId);
    if (!enabled) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const devices = getDevicesFromHistory().slice(0, 4);
    const myName = getDeviceLabel();
    const syncedText = lastSyncedAt
      ? `Last synced ${formatSyncRelative(lastSyncedAt)} from ${escapeHtml(myName)}`
      : "Not yet synced";

    let devicesHtml = "";
    if (devices.length) {
      devicesHtml = '<div class="sync-card-devices">' +
        devices.map((d) => {
          const isThis = d.name === myName;
          return `<span class="sync-card-device ${isThis ? "this" : ""}">${isThis ? "📍" : "🖥️"} ${escapeHtml(d.name)} · ${formatSyncRelative(d.lastTs)}</span>`;
        }).join("") +
        "</div>";
    }

    const status = dirtyForSync
      ? '<span class="sync-card-status dirty">🟡 Pending</span>'
      : !navigator.onLine
        ? '<span class="sync-card-status offline">📵 Offline</span>'
        : '<span class="sync-card-status synced">🟢 Synced</span>';

    body.innerHTML = `
      <div class="sync-card-row">
        ${status}
        <span class="sync-card-time">${syncedText}</span>
      </div>
      ${devicesHtml}
      <button id="syncNowBtn" class="btn-primary block" style="margin-top:0.75rem">🔄 Sync Now</button>
    `;

    // Wire the button (re-attached on every render)
    const btn = $("#syncNowBtn");
    if (btn) {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "🔄 Syncing…";
        try {
          // Pull-merge first, then push so all devices converge
          await syncPull({ skipConfirm: true, silent: false });
          await syncPush({ silent: false });
        } finally {
          btn.disabled = false;
          btn.textContent = "🔄 Sync Now";
          renderDashSyncCard();
        }
      });
    }
  }

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
      .reduce((s, e) => s + incomeReportingAmount(e), 0);
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
      const saved = goalSavedTotal(g);
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

    // 9) Credit cards: high utilization or upcoming due dates
    if (state.cards.length) {
      const totalDebt = totalCardBalance();
      const totalLim = totalCardLimit();
      const utilTotal = totalLim > 0 ? (totalDebt / totalLim) * 100 : 0;

      const paidThisMonth = state.expenses
        .filter((e) => e.type === "transfer-out" && e.kind === "credit-payment" && monthKey(e.date) === m)
        .reduce((s, e) => s + Number(e.amount || 0), 0);

      if (utilTotal >= 50 && paidThisMonth === 0 && totalDebt > 0) {
        insights.push({
          icon: "💳",
          tone: "danger",
          text: `Credit utilization is <strong>${utilTotal.toFixed(0)}%</strong> with ${fmt(totalDebt)} owed. Pay before statement closes to lower reported util.`,
        });
      } else if (totalDebt > 0 && paidThisMonth === 0) {
        // Soft nudge if nothing paid yet this month
        const liquid = liquidTotal();
        if (liquid > totalDebt * 0.5) {
          insights.push({
            icon: "💸",
            tone: "",
            text: `You have ${fmt(liquid)} liquid and ${fmt(totalDebt)} card debt. Tap <strong>Pay Cards</strong> on the Credit tab to plan payments.`,
          });
        }
      } else if (paidThisMonth > 0) {
        insights.push({
          icon: "✅",
          tone: "positive",
          text: `Paid <strong>${fmt(paidThisMonth)}</strong> to credit cards this month. ${totalDebt > 0 ? `${fmt(totalDebt)} remaining.` : "All cards paid off!"}`,
        });
      }

      // Upcoming due dates within 7 days
      const today = new Date();
      const todayMonth = currentMonth();
      const inSoon = state.cards.filter((c) => {
        if (!c.dueDay || !(cardCurrentBalance(c) > 0)) return false;
        const day = clampDayToMonth(Number(c.dueDay), todayMonth);
        const due = new Date(today.getFullYear(), today.getMonth(), day);
        const diffDays = Math.round((due - today) / 86400000);
        return diffDays >= 0 && diffDays <= 7;
      });
      if (inSoon.length === 1) {
        const c = inSoon[0];
        const day = clampDayToMonth(Number(c.dueDay), todayMonth);
        const due = new Date(today.getFullYear(), today.getMonth(), day);
        const diffDays = Math.max(0, Math.round((due - today) / 86400000));
        const whenLabel = diffDays === 0 ? "today" : `in ${diffDays}d`;
        insights.push({
          icon: "⏰",
          tone: "warn",
          text: `<strong>${escapeHtml(c.name)}</strong> payment due ${whenLabel} (${fmt(cardCurrentBalance(c))} balance).`,
        });
      } else if (inSoon.length > 1) {
        insights.push({
          icon: "⏰",
          tone: "warn",
          text: `<strong>${inSoon.length} card payments</strong> due in the next 7 days. Plan now in the Credit tab.`,
        });
      }

      // Statement closing soon — pay BEFORE close to lower reported util
      const closingSoon = state.cards.filter((c) => {
        if (!c.closeDay || !(cardCurrentBalance(c) > 0)) return false;
        const day = clampDayToMonth(Number(c.closeDay), todayMonth);
        const close = new Date(today.getFullYear(), today.getMonth(), day);
        const diffDays = Math.round((close - today) / 86400000);
        return diffDays >= 0 && diffDays <= 5;
      });
      if (notifEnabled("statementClose")) {
        if (closingSoon.length === 1) {
          const c = closingSoon[0];
          const lim = Number(c.limit) || 0;
          const bal = cardCurrentBalance(c);
          const util = lim > 0 ? (bal / lim) * 100 : 0;
          if (util >= 10) {
            const day = clampDayToMonth(Number(c.closeDay), todayMonth);
            const close = new Date(today.getFullYear(), today.getMonth(), day);
            const diffDays = Math.max(0, Math.round((close - today) / 86400000));
            const whenLabel = diffDays === 0 ? "today" : `in ${diffDays}d`;
            insights.push({
              icon: "📅",
              tone: util >= 30 ? "warn" : "",
              text: `<strong>${escapeHtml(c.name)}</strong> statement closes ${whenLabel} at ${util.toFixed(0)}% util. Pay before close to report lower utilization.`,
            });
          }
        } else if (closingSoon.length > 1) {
          insights.push({
            icon: "📅",
            tone: "warn",
            text: `<strong>${closingSoon.length} statements</strong> closing in 5 days. Pay down before close to lower reported util.`,
          });
        }
      }
    }

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
    const totalThisMonth = monthIncomes.reduce((s, e) => s + incomeReportingAmount(e), 0);
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
    // Use GROSS income for tax math — bracket calculations are meaningless on net.
    const ytd = ytdGrossIncomeTotal();

    if (ytd === 0) {
      el.innerHTML = `<p class="empty">Add income to see tax estimate.</p>`;
      return;
    }

    // 2025 federal brackets (IRS Rev. Proc. 2024-40 inflation adjustments)
    const brackets = {
      single: [
        [0, 0.10], [11925, 0.12], [48475, 0.22], [103350, 0.24],
        [197300, 0.32], [250525, 0.35], [626350, 0.37],
      ],
      married_joint: [
        [0, 0.10], [23850, 0.12], [96950, 0.22], [206700, 0.24],
        [394600, 0.32], [501050, 0.35], [751600, 0.37],
      ],
      married_separate: [
        [0, 0.10], [11925, 0.12], [48475, 0.22], [103350, 0.24],
        [197300, 0.32], [250525, 0.35], [375800, 0.37],
      ],
      head: [
        [0, 0.10], [17000, 0.12], [64850, 0.22], [103350, 0.24],
        [197300, 0.32], [250500, 0.35], [626350, 0.37],
      ],
    };
    const standardDeduction = {
      single: 15000,
      married_joint: 30000,
      married_separate: 15000,
      head: 22500,
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
    const month = currentMonth();
    list.innerHTML = state.accounts
      .map((a) => {
        const bal = accountBalance(a.id);
        const balClass = bal < 0 ? "negative" : "";
        const isCredit = (a.type || "").toLowerCase() === "credit" || !!a.cardId;
        const icon = isCredit ? "💳 " : "";
        const linkedCard = a.cardId ? state.cards.find((c) => c.id === a.cardId) : null;
        const subText = isCredit
          ? `Credit card${linkedCard ? ` · linked to ${escapeHtml(linkedCard.name)}` : ""}`
          : escapeHtml(a.type);

        // Monthly activity: net change to this account this month
        let inflow = 0, outflow = 0;
        state.expenses.forEach((e) => {
          if (e.accountId !== a.id) return;
          if (monthKey(e.date) !== month) return;
          if (e.type === "income" || e.type === "transfer-in") inflow += Number(e.amount) || 0;
          else if (e.type === "expense" || e.type === "transfer-out") outflow += Number(e.amount) || 0;
        });
        const monthlyDelta = inflow - outflow;
        const monthlyClass = monthlyDelta > 0 ? "positive" : monthlyDelta < 0 ? "negative" : "";
        const monthlyText = (inflow > 0 || outflow > 0)
          ? `<span class="${monthlyClass}">${monthlyDelta >= 0 ? "+" : ""}${fmt(monthlyDelta)}</span> this month`
          : `<span class="card-sub">No activity this month</span>`;

        return `
          <li class="list-item account-item" style="border-left: 4px solid ${a.color || "#5b3fb8"}">
            <div class="list-item-main">
              <div class="list-item-title">${icon}${escapeHtml(a.name)}</div>
              <div class="list-item-sub">${subText}</div>
              <div class="acc-monthly">${monthlyText}</div>
            </div>
            <div class="list-item-amount ${balClass}">${fmt(bal)}</div>
            <div class="list-item-actions">
              ${isCredit && linkedCard && cardCurrentBalance(linkedCard) > 0 ? `<button data-action="quick-pay-card" data-id="${linkedCard.id}" title="Pay this card">Pay</button>` : ""}
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
    // Split: liquid (cash-like) vs credit cards (debt)
    const isCredit = (a) => (a.type || "").toLowerCase() === "credit" || !!a.cardId;
    const liquid = state.accounts.filter((a) => !isCredit(a));
    const credit = state.accounts.filter(isCredit);
    const liquidSum = liquid.reduce((s, a) => s + accountBalance(a.id), 0);
    const creditSum = credit.reduce((s, a) => s + accountBalance(a.id), 0); // negative = debt

    let html = `
      <div class="account-net">
        <span class="account-net-label">Net Worth</span>
        <span class="account-net-value ${total < 0 ? "negative" : ""}">${fmt(total)}</span>
      </div>
    `;

    if (liquid.length) {
      html += `<div class="account-section-label">💵 Cash & Bank · ${fmt(liquidSum)}</div><div class="account-grid">`;
      liquid.forEach((a) => {
        const bal = accountBalance(a.id);
        html += `
          <div class="account-pill" style="border-left: 4px solid ${a.color || "#5b3fb8"}">
            <div class="account-pill-name">${escapeHtml(a.name)}</div>
            <div class="account-pill-bal ${bal < 0 ? "negative" : ""}">${fmt(bal)}</div>
          </div>`;
      });
      html += "</div>";
    }

    if (credit.length) {
      html += `<div class="account-section-label">💳 Credit Cards · <span class="${creditSum < 0 ? "negative" : ""}">${fmt(creditSum)}</span></div><div class="account-grid">`;
      credit.forEach((a) => {
        const bal = accountBalance(a.id);
        const debt = bal < 0 ? Math.abs(bal) : 0;
        html += `
          <div class="account-pill credit-pill" style="border-left: 4px solid ${a.color || "#ec4899"}">
            <div class="account-pill-name">💳 ${escapeHtml(a.name)}</div>
            <div class="account-pill-bal ${bal < 0 ? "negative" : "positive"}">${bal < 0 ? `-${fmt(debt)}` : fmt(bal)}</div>
          </div>`;
      });
      html += "</div>";
    }

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
      const key = String(e.desc || "").toLowerCase().trim();
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
          String(r.desc || "").toLowerCase() === String(s.desc || "").toLowerCase() &&
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
    // Also populate the goal select for recurring goal contributions
    const goalSel = $("#recGoal");
    if (goalSel) {
      goalSel.innerHTML =
        '<option value="">— No goal —</option>' +
        state.goals
          .map((g) => `<option value="${g.id}">${escapeHtml(g.name)}</option>`)
          .join("");
    }
  }

  // Bill negotiations list + summary card on Settings
  function renderBillNegotiations() {
    const list = $("#billNegList");
    const summary = $("#billNegSummary");
    if (!list || !summary) return;
    const items = state.billNegotiations || [];
    if (!items.length) {
      list.innerHTML = '<li class="empty">No negotiations recorded yet.</li>';
      summary.innerHTML = "";
      return;
    }
    const totalMonthly = items.reduce((s, n) => s + (Number(n.savedMonthly) || 0), 0);
    const totalAnnual = totalMonthly * 12;
    summary.innerHTML = `
      <div class="bill-neg-pill">
        <strong>${fmt(totalMonthly)}/mo</strong> saved
        <span class="card-sub">(${fmt(totalAnnual)}/yr · ${items.length} negotiation${items.length === 1 ? "" : "s"})</span>
      </div>
    `;
    list.innerHTML = [...items]
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .map((n) => {
        const saved = Number(n.savedMonthly) || 0;
        const cls = saved > 0 ? "positive" : saved < 0 ? "negative" : "";
        const noteLine = n.note ? `<div class="list-item-sub">${escapeHtml(n.note)}</div>` : "";
        return `
          <li class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(n.vendor)}</div>
              <div class="list-item-sub">${n.date} · ${fmt(n.before)} → ${fmt(n.after)} <span class="${cls}">(${saved > 0 ? "−" : "+"}${fmt(Math.abs(saved))}/mo)</span></div>
              ${noteLine}
            </div>
            <div class="list-item-actions">
              <button data-action="del-billneg" data-id="${n.id}" title="Delete">🗑️</button>
            </div>
          </li>`;
      }).join("");
  }

  function renderIncomeSourcesManage() {
    const list = $("#incomeSourceManageList");
    if (!list) return;
    const items = state.incomeSources || [];
    if (!items.length) {
      list.innerHTML = '<li class="empty">No saved sources yet. Add your employer or recurring payer above.</li>';
      return;
    }
    const typeIcons = {
      salary: "💼", hourly: "⏱️", freelance: "🧾", bonus: "🎁",
      dividend: "📈", rental: "🏠", other: "💰",
    };
    list.innerHTML = items
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map((s) => {
        const icon = typeIcons[s.type] || "💰";
        const amt = Number(s.defaultAmount) > 0 ? ` · ${fmt(s.defaultAmount)}` : "";
        const note = s.note ? ` · ${escapeHtml(s.note)}` : "";
        return `
          <li class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${icon} ${escapeHtml(s.name)}</div>
              <div class="list-item-sub">${escapeHtml(s.type || "other")}${amt}${note}</div>
            </div>
            <div class="list-item-actions">
              <button data-action="use-incsrc" data-id="${s.id}" title="Use in paycheck">💼</button>
              <button data-action="del-incsrc" data-id="${s.id}" title="Delete">🗑️</button>
            </div>
          </li>`;
      }).join("");
  }

  function renderPresetsManage() {
    const list = $("#presetsManageList");
    if (!list) return;
    // Keep the toggle button label's count in sync with current preset total
    const toggleBtn = $("#presetsListToggle");
    if (toggleBtn) {
      const isVisible = !list.hidden;
      toggleBtn.textContent = isVisible
        ? `▾ Hide preset list (${state.presets.length})`
        : `▸ Show preset list (${state.presets.length})`;
    }
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
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
      .map((e) => {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        const person = e.personId ? state.people.find((p) => p.id === e.personId) : null;
        return [
          e.date || "",
          e.type === "income" ? "Income" : "Expense",
          e.desc || "",
          cat ? cat.name : "",
          person ? person.name : "",
          (e.type === "income" ? "" : "-") + (Number(e.amount) || 0).toFixed(2),
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

  // Tax-friendly export: current year transactions plus per-category totals
  // and totals by month, in a single CSV suitable for filing or accountant.
  function exportTaxCsv() {
    const year = currentMonth().slice(0, 4);
    const yearTxns = state.expenses.filter(
      (e) => (e.date || "").startsWith(year) &&
             e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    if (!yearTxns.length) {
      showToast(`No ${year} transactions to export`);
      return;
    }

    const headers = ["Date", "Type", "Description", "Category", "Person", "Tags", "Amount", "Currency", "Source", "Pre-Tax", "Receipt"];
    const txnRows = [...yearTxns]
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")))
      .map((e) => {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        const person = e.personId ? state.people.find((p) => p.id === e.personId) : null;
        return [
          e.date,
          e.type === "income" ? "Income" : "Expense",
          e.desc || "",
          cat ? cat.name : "",
          person ? person.name : "",
          (e.tags || []).join("; "),
          (e.type === "income" ? "" : "-") + Number(e.amount).toFixed(2),
          currency,
          e.source || "",
          e.preTax ? "Yes" : "",
          e.receipt ? "Yes" : "",
        ];
      });

    // Category totals
    const catTotals = {};
    let totalIncome = 0;
    let totalExpenses = 0;
    yearTxns.forEach((e) => {
      const amt = Number(e.amount) || 0;
      if (e.type === "income") {
        totalIncome += amt;
      } else {
        totalExpenses += amt;
        const cat = state.categories.find((c) => c.id === e.categoryId);
        const name = cat ? cat.name : "Uncategorized";
        catTotals[name] = (catTotals[name] || 0) + amt;
      }
    });

    // Monthly totals
    const monthTotals = {};
    yearTxns.forEach((e) => {
      const m = monthKey(e.date);
      if (!monthTotals[m]) monthTotals[m] = { income: 0, expense: 0 };
      const amt = Number(e.amount) || 0;
      if (e.type === "income") monthTotals[m].income += amt;
      else monthTotals[m].expense += amt;
    });

    const lines = [];
    lines.push(`Tax-Friendly Export · ${year}`);
    lines.push(`Generated ${new Date().toLocaleString()}`);
    lines.push("");
    lines.push("=== SUMMARY ===");
    lines.push(`Total Income,${totalIncome.toFixed(2)}`);
    lines.push(`Total Expenses,${totalExpenses.toFixed(2)}`);
    lines.push(`Net,${(totalIncome - totalExpenses).toFixed(2)}`);
    lines.push(`Currency,${currency}`);
    lines.push("");
    lines.push("=== CATEGORY TOTALS ===");
    lines.push("Category,Total");
    Object.entries(catTotals).sort((a, b) => b[1] - a[1]).forEach(([cat, total]) => {
      lines.push([csvEscape(cat), total.toFixed(2)].join(","));
    });
    lines.push("");
    lines.push("=== MONTHLY TOTALS ===");
    lines.push("Month,Income,Expense,Net");
    Object.keys(monthTotals).sort().forEach((m) => {
      const t = monthTotals[m];
      lines.push([m, t.income.toFixed(2), t.expense.toFixed(2), (t.income - t.expense).toFixed(2)].join(","));
    });
    lines.push("");
    lines.push("=== TRANSACTIONS ===");
    lines.push(headers.map(csvEscape).join(","));
    txnRows.forEach((row) => lines.push(row.map(csvEscape).join(",")));

    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pocket-budget-tax-${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${yearTxns.length} ${year} transactions`);
  }

  /* ---------- Rollover & alerts ---------- */
  // Returns the limit that was effective for `cat` during `month` (YYYY-MM).
  // Falls back to current cat.limit if no history is recorded.
  // History format: [{ until: "YYYY-MM", limit: number }, ...] — each entry
  // describes a past period whose limit applied through `until` (inclusive).
  function limitForMonth(cat, month) {
    const history = Array.isArray(cat.limitHistory) ? cat.limitHistory : [];
    if (!history.length) return Number(cat.limit) || 0;
    // Find the earliest history entry whose `until` >= month
    const sorted = [...history].sort((a, b) =>
      String(a.until || "").localeCompare(String(b.until || ""))
    );
    for (const h of sorted) {
      if (h.until && h.until >= month) return Number(h.limit) || 0;
    }
    // No history entry covers this month — use current limit
    return Number(cat.limit) || 0;
  }

  function effectiveLimitFor(cat, month) {
    const base = limitForMonth(cat, month);
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
      const spent = monthExp.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const leftover = limitForMonth(cat, m) - spent;
      if (leftover <= 0) break;
      extra += leftover;
      m = prevMonth(m);
    }
    return base + extra;
  }

  function prevMonth(monthStr) {
    if (!monthStr || typeof monthStr !== "string") return monthStr;
    const parts = monthStr.split("-").map(Number);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return monthStr;
    const [y, m] = parts;
    if (m === 1) return `${y - 1}-12`;
    return `${y}-${String(m - 1).padStart(2, "0")}`;
  }

  function checkBudgetAlerts() {
    const month = currentMonth();
    const monthExpenses = state.expenses.filter(
      (e) => monthKey(e.date) === month && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    const alertsShown = state.settings.alertsShown;
    let changed = false;

    // Bounded cleanup: remove alertsShown entries older than 6 months to prevent unbounded localStorage growth
    Object.keys(alertsShown).forEach((k) => {
      // Keys look like "YYYY-MM:catId:80" or "overbudget_YYYY-MM"
      const match = k.match(/(\d{4}-\d{2})/);
      if (!match) return;
      const keyMonth = match[1];
      // Compute months difference: keyYY*12+keyMM vs current
      const [ky, km] = keyMonth.split("-").map(Number);
      const [cy, cm] = month.split("-").map(Number);
      const diff = (cy - ky) * 12 + (cm - km);
      if (diff > 6) { delete alertsShown[k]; changed = true; }
    });

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
        if (notifEnabled("cat100")) {
          showAlertToast(`🚨 ${cat.name} is over budget!`, "danger");
          showSystemNotification(`🚨 ${cat.name} is over budget!`, `You've spent ${fmt(spent)} of ${fmt(limit)} this month.`);
        }
        alertsShown[key100] = true;
        changed = true;
      } else if (pct >= 80 && pct < 100 && !alertsShown[key80]) {
        if (notifEnabled("cat80")) {
          showAlertToast(`⚠️ ${cat.name} at ${Math.round(pct)}% of budget`, "warning");
          showSystemNotification(`⚠️ ${cat.name} at ${Math.round(pct)}%`, `${fmt(spent)} of ${fmt(limit)} spent this month.`);
        }
        alertsShown[key80] = true;
        changed = true;
      }
    });

    if (changed) saveData();
  }

  function showAlertToast(msg, type) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast toast-${type}`;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      toast.hidden = true;
      toast.className = "toast";
    }, 3500);
  }

  // Show OS-level notification (when permission granted and toggle on)
  function showSystemNotification(title, body) {
    try {
      if (typeof Notification === "undefined") return;
      if (!state.settings.notifyEnableSystem) return;
      if (Notification.permission !== "granted") return;
      // Skip if app is in foreground & visible — toast already shown
      if (typeof document !== "undefined" && document.visibilityState === "visible") return;
      const n = new Notification(title, {
        body,
        icon: "icon-192.svg",
        tag: `pocket-budget-${title}`,
        // Persist on Android/desktop until user dismisses (helps update notifications stick around)
        requireInteraction: /update/i.test(title),
      });
      // Tapping/clicking the notification focuses the app window (or opens it on iOS PWA)
      n.onclick = () => {
        try {
          window.focus();
          // If clicked from a closed tab, this brings the existing tab to front.
          // For PWA installs on iOS / Windows, this opens the app.
        } catch (_) {}
        n.close();
      };
    } catch (e) { /* ignore */ }
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
        // Restore — clear tombstones and bump updatedAt so the resurrection beats the deletion
        // on the next sync round.
        const restored = lastDeleted.items.map((it) => {
          if (state.deletions && state.deletions.expenses) {
            delete state.deletions.expenses[it.id];
          }
          return touchRecord({ ...it });
        });
        // If this was a credit-payment, undo the card balance restore that delete did
        const creditPay = lastDeleted.items.find((t) => t.kind === "credit-payment" && t.cardId);
        if (creditPay) {
          const card = state.cards.find((c) => c.id === creditPay.cardId);
          if (card) {
            card.balance = Math.max(0, (Number(card.balance) || 0) - Number(creditPay.amount || 0));
            touchRecord(card);
          }
        }
        state.expenses.push(...restored);
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
    // Pick the most-used category among matches that still exists
    const validIds = new Set(state.categories.map((c) => c.id));
    const counts = {};
    matches.forEach((m) => {
      if (!validIds.has(m.categoryId)) return;
      counts[m.categoryId] = (counts[m.categoryId] || 0) + 1;
    });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  }

  function suggestPerson(desc) {
    const q = String(desc || "").toLowerCase().trim();
    if (q.length < 2) return null;
    const matches = state.expenses
      .filter((e) => e.personId && e.desc && e.desc.toLowerCase().includes(q));
    if (!matches.length) return null;
    const validIds = new Set((state.people || []).map((p) => p.id));
    const counts = {};
    matches.forEach((m) => {
      if (!validIds.has(m.personId)) return;
      counts[m.personId] = (counts[m.personId] || 0) + 1;
    });
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
    const totalIncomeReal = monthIncomes.reduce((s, e) => s + incomeReportingAmount(e), 0);
    const targetIncome = incomeForMonth(month);
    // Show actual income when logged; fall back to target only when nothing's been logged.
    // This prevents the dashboard from inflating Income by showing the target after a real
    // smaller paycheck has already been recorded.
    const totalIncome = totalIncomeReal > 0 ? totalIncomeReal : targetIncome;

    // Last month for trend comparison
    const lastMonth = prevMonth(month);
    const lastMonthExp = state.expenses.filter(
      (e) => monthKey(e.date) === lastMonth && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    const lastMonthInc = state.expenses.filter(
      (e) => monthKey(e.date) === lastMonth && e.type === "income"
    );
    const lastSpent = lastMonthExp.reduce((s, e) => s + Number(e.amount), 0);
    const lastIncomeReal = lastMonthInc.reduce((s, e) => s + incomeReportingAmount(e), 0);

    // Saved this month: goal contributions where the txn date is this month
    const totalSaved = state.expenses
      .filter((e) => e.goalId && e.type === "expense" && monthKey(e.date) === month)
      .reduce((s, e) => s + Number(e.amount), 0);

    const remaining = totalIncome - totalSpent;

    $("#statIncome").textContent = fmt(totalIncome);
    $("#statSpent").textContent = fmt(totalSpent);
    const remainingEl = $("#statRemaining");
    if (remainingEl) {
      remainingEl.textContent = fmt(remaining);
      remainingEl.classList.toggle("negative", remaining < 0);
      remainingEl.classList.toggle("positive", remaining > 0);
    }
    $("#statSaved").textContent = fmt(totalSaved);

    // MoM trend arrows under Income / Spent
    function renderTrendMeta(elId, current, previous, lowerIsBetter) {
      const el = document.getElementById(elId);
      if (!el) return;
      if (previous <= 0) { el.innerHTML = ""; return; }
      const diff = current - previous;
      const pct = (diff / previous) * 100;
      const goingUp = diff > 0;
      const isGood = lowerIsBetter ? !goingUp : goingUp;
      const arrow = goingUp ? "▲" : (diff < 0 ? "▼" : "■");
      const cls = Math.abs(pct) < 1 ? "" : (isGood ? "positive" : "negative");
      el.innerHTML = Math.abs(pct) < 1
        ? `<span class="card-sub">vs last month</span>`
        : `<span class="${cls}">${arrow} ${Math.abs(pct).toFixed(0)}%</span> <span class="card-sub">vs last month</span>`;
    }
    renderTrendMeta("statIncomeMeta", totalIncome, lastIncomeReal, false);
    renderTrendMeta("statSpentMeta", totalSpent, lastSpent, true);

    // 7-day spending sparkline under the Spent stat
    renderSpentSparkline();

    // Spending pulse: forecast, velocity, streaks
    renderPulse(month, totalSpent, monthExpenses);

    // One-shot over-budget alert per month: if you cross 100% of total budget
    checkOverBudgetAlert(totalSpent, month);

    // Family — net money to people this month (sent minus received from same family)
    const sentToFamily = monthExpenses
      .filter((e) => e.personId)
      .reduce((s, e) => s + Number(e.amount), 0);
    const receivedFromFamily = monthIncomes
      .filter((e) => e.personId)
      .reduce((s, e) => s + Number(e.amount), 0);
    const netFamily = sentToFamily - receivedFromFamily;
    const familyEl = $("#statFamily");
    if (familyEl) {
      familyEl.textContent = receivedFromFamily > 0
        ? `${netFamily >= 0 ? "" : "+"}${fmt(Math.abs(netFamily))}`
        : fmt(sentToFamily);
    }

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

    // Credit payments this month
    const creditPaid = state.expenses
      .filter((e) => e.type === "transfer-out" && e.kind === "credit-payment" && monthKey(e.date) === month)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const creditPaidEl = $("#statCreditPaid");
    if (creditPaidEl) creditPaidEl.textContent = fmt(creditPaid);
    const creditPaidHint = $("#statCreditPaidHint");
    if (creditPaidHint) {
      const cardCount = state.cards.length;
      const debt = totalCardBalance();
      if (!cardCount) {
        creditPaidHint.textContent = "No cards tracked";
      } else if (creditPaid === 0 && debt > 0) {
        creditPaidHint.innerHTML = `<a href="#" data-pay-cards="1" style="color:var(--accent, #5b3fb8)">Plan payment →</a>`;
        const link = creditPaidHint.querySelector("[data-pay-cards]");
        if (link) link.addEventListener("click", (ev) => { ev.preventDefault(); openPayCardModal(); });
      } else if (creditPaid === 0 && debt === 0) {
        creditPaidHint.innerHTML = '<span class="positive">Cards paid off</span>';
      } else {
        creditPaidHint.textContent = debt > 0 ? `${fmt(debt)} remaining` : "Cards paid off";
      }
    }

    // Hide first-use hint once any transactions exist
    const hint = $("#firstUseHint");
    if (hint) hint.hidden = state.expenses.length > 0;

    // Budget progress
    const progressEl = $("#budgetProgress");
    if (progressEl && !state.categories.length) {
      progressEl.innerHTML = '<p class="empty">No budget categories yet. Add some in Balances.</p>';
    } else if (progressEl) {
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

          // 6-month sparkline of spending in this category
          const sparkPoints = [];
          let cursor = month;
          for (let i = 0; i < 6; i++) {
            const m2 = cursor;
            const total = state.expenses
              .filter((e) => e.categoryId === cat.id && monthKey(e.date) === m2 && e.type !== "income")
              .reduce((s, e) => s + Number(e.amount), 0);
            sparkPoints.push(total);
            cursor = prevMonth(cursor);
          }
          sparkPoints.reverse();
          const sparkSvg = renderSparkline(sparkPoints);

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
              <div class="sparkline-row">${sparkSvg}<span class="sparkline-label">last 6 mo</span></div>
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
          const saved = goalSavedTotal(g);
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
    renderDashSyncCard();
    renderToday();
    renderUpcomingEvent();
  }

  // Show the next upcoming/active event on the dashboard.
  function renderUpcomingEvent() {
    const card = document.getElementById("upcomingEventCard");
    const body = document.getElementById("upcomingEventBody");
    if (!card || !body) return;
    if (!state.events.length) { card.hidden = true; return; }

    const today = todayStr();
    // Pick first event that's currently active OR upcoming (not completed)
    const candidates = state.events
      .filter((ev) => eventStatus(ev) !== "completed")
      .sort((a, b) => (a.startDate || "9999").localeCompare(b.startDate || "9999"));
    if (!candidates.length) { card.hidden = true; return; }

    const ev = candidates[0];
    const status = eventStatus(ev);
    const spent = eventSpentTotal(ev.id);
    const budget = Number(ev.budget) || 0;
    const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
    let cls = "success";
    if (pct >= 100) cls = "danger";
    else if (pct >= 80) cls = "warning";

    let timing = "";
    if (status === "planning" && ev.startDate) {
      const days = Math.ceil((new Date(ev.startDate) - new Date(today)) / (24 * 60 * 60 * 1000));
      timing = days > 1 ? `Starts in ${days} days` : days === 1 ? "Starts tomorrow" : "Starts today";
    } else if (status === "active") {
      const end = ev.endDate ? new Date(ev.endDate) : null;
      if (end) {
        const days = Math.ceil((end - new Date(today)) / (24 * 60 * 60 * 1000));
        timing = days > 1 ? `${days} days left` : days === 1 ? "Ends tomorrow" : "Ends today";
      } else {
        timing = "Active";
      }
    }

    card.hidden = false;
    body.innerHTML = `
      <div class="upcoming-event-row">
        <div>
          <div class="upcoming-event-title">${ev.icon || "🌴"} ${escapeHtml(ev.name)}</div>
          <div class="card-sub">${timing}${ev.startDate ? ` · ${ev.startDate}${ev.endDate ? ` → ${ev.endDate}` : ""}` : ""}</div>
        </div>
        <button class="btn-secondary" data-stat-jump="events" style="white-space:nowrap">Open</button>
      </div>
      ${budget > 0 ? `
        <div class="upcoming-event-bar">
          <div><strong>${fmt(spent)}</strong> of ${fmt(budget)} <span class="card-sub">(${pct.toFixed(0)}%)</span></div>
          <div class="progress-bar"><div class="progress-fill ${cls}" style="width:${pct}%"></div></div>
        </div>
      ` : `<div class="card-sub" style="margin-top:0.4rem">${fmt(spent)} spent · no budget set</div>`}
    `;
  }

  // 7-day spending mini-sparkline rendered into the Spent stat card
  function renderSpentSparkline() {
    const svg = document.getElementById("statSpentSpark");
    if (!svg) return;
    const today = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const ds = localDateStr(d);
      const total = state.expenses
        .filter((e) => e.date === ds && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out")
        .reduce((s, e) => s + Number(e.amount), 0);
      days.push(total);
    }
    const max = Math.max(1, ...days);
    const W = 100, H = 24;
    const stepX = W / Math.max(1, days.length - 1);
    const points = days.map((v, i) => {
      const x = i * stepX;
      const y = H - (v / max) * (H - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const lastVal = days[days.length - 1];
    const fillPath = `M0,${H} L${points.split(" ").join(" L")} L${W},${H} Z`;
    svg.innerHTML = `
      <path d="${fillPath}" fill="rgba(236, 72, 153, 0.15)" />
      <polyline points="${points}" fill="none" stroke="#ec4899" stroke-width="1.5" stroke-linejoin="round" />
      ${lastVal > 0 ? `<circle cx="${W}" cy="${H - (lastVal / max) * (H - 2) - 1}" r="2" fill="#ec4899" />` : ""}
    `;
  }

  // Over-budget alert: fires once per month when total spend crosses 100% of total budget.
  function checkOverBudgetAlert(totalSpent, month) {
    const totalLimit = state.categories.reduce((s, c) => s + (Number(c.limit) || 0), 0);
    if (totalLimit <= 0) return;
    if (totalSpent < totalLimit) return;
    if (!state.settings.alertsShown) state.settings.alertsShown = {};
    const key = `overbudget_${month}`;
    if (state.settings.alertsShown[key]) return;
    state.settings.alertsShown[key] = true;
    setSetting("alertsShown", state.settings.alertsShown);
    saveData();
    if (notifEnabled("totalOver")) {
      showToast(`⚠️ Over budget — ${fmt(totalSpent)} spent vs ${fmt(totalLimit)} budgeted`);
    }
  }

  // Spending Pulse: forecast vs actual, daily velocity, under-budget streak
  function renderPulse(month, totalSpent, monthExpenses) {
    const el = document.getElementById("pulseContent");
    if (!el) return;
    // Empty-state guard: keep the friendly placeholder visible until there's at least
    // one expense or an income event recorded. Otherwise the card shows misleading zeros.
    if (!Array.isArray(state.expenses) || state.expenses.length === 0) {
      el.innerHTML = '<p class="empty">Add a few transactions to see your spending pulse.</p>';
      return;
    }
    const now = new Date();
    const [yy, mm] = month.split("-").map(Number);
    const isCurrentMonth = (yy === now.getFullYear() && mm === now.getMonth() + 1);
    const dayOfMonth = isCurrentMonth ? now.getDate() : new Date(yy, mm, 0).getDate();
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);

    // Forecast: current spent / day-of-month * days-in-month
    const dailyAvg = dayOfMonth > 0 ? totalSpent / dayOfMonth : 0;
    const forecast = dailyAvg * daysInMonth;
    const totalLimit = state.categories.reduce((s, c) => s + (effectiveLimitFor(c, month) || 0), 0);

    // Forecast tone vs total budget
    let forecastTone = "neutral";
    let forecastNote = "";
    if (totalLimit > 0) {
      if (forecast > totalLimit * 1.1) {
        forecastTone = "danger";
        forecastNote = `${fmt(forecast - totalLimit)} over budget at this pace`;
      } else if (forecast > totalLimit) {
        forecastTone = "warning";
        forecastNote = `Slightly over budget at this pace`;
      } else if (forecast < totalLimit * 0.85) {
        forecastTone = "success";
        forecastNote = `On track — ${fmt(totalLimit - forecast)} under at this pace`;
      } else {
        forecastTone = "success";
        forecastNote = `On track`;
      }
    }

    // Streak: count consecutive past days ending yesterday (or today if isCurrentMonth) where daily total < daily budget
    const dailyBudget = totalLimit > 0 ? totalLimit / daysInMonth : 0;
    let streak = 0;
    if (dailyBudget > 0 && state.expenses.length > 0) {
      // Only count back to the date of the first transaction — otherwise a fresh user with no data
      // would falsely show a 364-day "streak". This makes the streak meaningful.
      const earliestDateStr = state.expenses
        .map((e) => e.date)
        .filter(Boolean)
        .sort()[0];
      const earliestDate = earliestDateStr ? new Date(earliestDateStr + "T00:00:00") : null;

      const startDate = new Date(now);
      // Start from yesterday so today (in-progress) doesn't break the streak prematurely
      startDate.setDate(startDate.getDate() - 1);
      for (let i = 0; i < 365; i++) {
        const d = new Date(startDate);
        d.setDate(startDate.getDate() - i);
        if (earliestDate && d < earliestDate) break;
        const ds = localDateStr(d);
        const dayTotal = state.expenses
          .filter((e) => e.date === ds && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out")
          .reduce((s, e) => s + Number(e.amount), 0);
        if (dayTotal <= dailyBudget) {
          streak++;
        } else {
          break;
        }
      }
    }

    // Velocity: daily average vs daily budget
    let velocityHtml = "";
    if (dailyAvg > 0) {
      if (dailyBudget > 0) {
        const ratio = dailyAvg / dailyBudget;
        const tone = ratio > 1.05 ? "negative" : (ratio < 0.95 ? "positive" : "");
        velocityHtml = `<span class="${tone}">${fmt(dailyAvg)}/day</span> vs ${fmt(dailyBudget)}/day budget`;
      } else {
        velocityHtml = `${fmt(dailyAvg)}/day this month`;
      }
    } else {
      velocityHtml = `No spend yet this month`;
    }

    // Forecast block
    let forecastHtml = "";
    if (totalLimit > 0) {
      forecastHtml = `
        <div class="pulse-row">
          <span class="pulse-icon">📈</span>
          <div class="pulse-text">
            <strong>Forecast: ${fmt(forecast)}</strong> by month-end
            <div class="card-sub pulse-${forecastTone}">${escapeHtml(forecastNote)}</div>
          </div>
        </div>`;
    } else {
      forecastHtml = `
        <div class="pulse-row">
          <span class="pulse-icon">📈</span>
          <div class="pulse-text">
            <strong>Forecast: ${fmt(forecast)}</strong> by month-end
            <div class="card-sub">Set category budgets to see how you compare</div>
          </div>
        </div>`;
    }

    // Velocity block
    const velocityBlock = `
      <div class="pulse-row">
        <span class="pulse-icon">💸</span>
        <div class="pulse-text">
          <strong>Spending velocity</strong>
          <div class="card-sub">${velocityHtml}</div>
        </div>
      </div>`;

    // Streak block
    let streakBlock = "";
    if (dailyBudget > 0) {
      const streakLabel = streak === 0
        ? "No active streak — try a no-spend day to start"
        : `${streak} day${streak === 1 ? "" : "s"} under daily budget`;
      const flame = streak >= 7 ? "🔥" : (streak >= 3 ? "✨" : "🏆");
      streakBlock = `
        <div class="pulse-row">
          <span class="pulse-icon">${flame}</span>
          <div class="pulse-text">
            <strong>Streak</strong>
            <div class="card-sub">${escapeHtml(streakLabel)}</div>
          </div>
        </div>`;
    }

    // Days remaining context
    const daysHtml = isCurrentMonth && daysRemaining > 0
      ? `<div class="pulse-footer card-sub">${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left this month</div>`
      : "";

    el.innerHTML = forecastHtml + velocityBlock + streakBlock + daysHtml;
  }

  // Drag-to-reorder for dashboard stat cards
  function initStatCardDrag() {
    const grid = document.getElementById("statGrid");
    if (!grid) return;
    let dragId = null;
    grid.addEventListener("dragstart", (e) => {
      const card = e.target.closest("[data-stat-id]");
      if (!card) return;
      dragId = card.dataset.statId;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch (_) { /* Safari */ }
    });
    grid.addEventListener("dragend", (e) => {
      const card = e.target.closest("[data-stat-id]");
      if (card) card.classList.remove("dragging");
      dragId = null;
      // Save new order
      const order = Array.from(grid.querySelectorAll("[data-stat-id]")).map((c) => c.dataset.statId);
      localStorage.setItem("mb_stat_order", JSON.stringify(order));
    });
    grid.addEventListener("dragover", (e) => {
      e.preventDefault();
      const target = e.target.closest("[data-stat-id]");
      if (!target || target.dataset.statId === dragId) return;
      const dragging = grid.querySelector(".dragging");
      if (!dragging) return;
      const rect = target.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      grid.insertBefore(dragging, before ? target : target.nextSibling);
    });
  }

  // Today card: quick summary of just today's spending and recent activity
  function renderToday() {
    const el = $("#todaySummary");
    if (!el) return;
    const today = todayStr();
    const todayTxns = state.expenses.filter((e) => e.date === today);
    const todayExpenses = todayTxns.filter((e) => e.type === "expense");
    const todayIncome = todayTxns.filter((e) => e.type === "income");
    const totalSpent = todayExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalIncome = todayIncome.reduce((s, e) => s + Number(e.amount), 0);

    // Upcoming card payments due in the next 5 days
    const todayDate = new Date();
    const dueAlerts = [];
    state.cards.forEach((c) => {
      if (!c.dueDay || !(cardCurrentBalance(c) > 0)) return;
      const day = clampDayToMonth(Number(c.dueDay), currentMonth());
      const due = new Date(todayDate.getFullYear(), todayDate.getMonth(), day);
      const diffDays = Math.round((due - todayDate) / 86400000);
      if (diffDays >= 0 && diffDays <= 5) {
        dueAlerts.push({ card: c, diffDays });
      }
    });
    const dueHtml = dueAlerts.length
      ? `<div class="today-due-alerts">${dueAlerts.slice(0, 3).map((a) => {
          const when = a.diffDays === 0 ? "due today" : a.diffDays === 1 ? "due tomorrow" : `due in ${a.diffDays}d`;
          return `<div class="today-due-row"><span>💳 ${escapeHtml(a.card.name)}</span><span class="today-due-when">${when} · ${fmt(cardCurrentBalance(a.card))}</span></div>`;
        }).join("")}</div>`
      : "";

    if (!todayTxns.length) {
      el.innerHTML = `<p class="empty" style="margin:0">No transactions today. Tap <strong>+</strong> or <strong>🔁 Repeat last</strong> to add one.</p>${dueHtml}`;
      return;
    }

    const recent = [...todayTxns].sort((a, b) => b.id.localeCompare(a.id)).slice(0, 3);
    const recentList = recent.map((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const catName = cat ? cat.name : (e.type === "income" ? "Income" : "Uncategorized");
      const sign = e.type === "income" ? "+" : "−";
      const cls = e.type === "income" ? "positive" : "";
      return `<li class="today-row">
        <span class="today-row-desc">${escapeHtml(e.desc || "(no description)")}</span>
        <span class="today-row-cat">${escapeHtml(catName)}</span>
        <span class="today-row-amt ${cls}">${sign}${fmt(e.amount)}</span>
      </li>`;
    }).join("");

    el.innerHTML = `
      <div class="today-stats">
        ${totalIncome > 0 ? `<span class="today-stat positive">+${fmt(totalIncome)} income</span>` : ""}
        <span class="today-stat">${fmt(totalSpent)} spent</span>
        <span class="today-stat-sub">${todayTxns.length} txn${todayTxns.length === 1 ? "" : "s"}</span>
      </div>
      <ul class="today-list">${recentList}</ul>
      ${dueHtml}
    `;
  }

  function renderBalances() {
    const incEl = $("#incomeAmount");
    if (incEl) incEl.value = state.income || "";
    renderMonthIncomeList();
    renderYtdIncome();
    renderExpectedIncome();
    renderTaxEstimate();
    renderRoundUpStats();

    const list = $("#categoryList");
    if (list && !state.categories.length) {
      list.innerHTML = '<li class="empty">No categories yet.</li>';
    } else if (list) {
      const month = currentMonth();
      const monthExp = state.expenses.filter(
        (e) => monthKey(e.date) === month && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
      );

      // Build rows with spend so we can sort by % usage (most-used first)
      const rows = state.categories.map((cat) => {
        const spent = monthExp.filter((e) => e.categoryId === cat.id).reduce((s, e) => s + Number(e.amount), 0);
        const limit = effectiveLimitFor(cat, month);
        const pct = limit > 0 ? (spent / limit) * 100 : 0;
        return { cat, spent, limit, pct };
      }).sort((a, b) => {
        // Categories with limits sort by % descending, no-limit ones at bottom
        if (a.limit > 0 && b.limit <= 0) return -1;
        if (a.limit <= 0 && b.limit > 0) return 1;
        if (a.limit > 0 && b.limit > 0) return b.pct - a.pct;
        return b.spent - a.spent;
      });

      const totalLimit = state.categories.reduce((s, c) => s + (Number(c.limit) || 0), 0);
      const totalSpent = monthExp.reduce((s, e) => s + Number(e.amount), 0);
      const totalPct = totalLimit > 0 ? (totalSpent / totalLimit) * 100 : 0;

      const summaryRow = totalLimit > 0
        ? `<li class="cat-summary-row">
            <span><strong>${fmt(totalSpent)}</strong> spent of <strong>${fmt(totalLimit)}</strong> total</span>
            <span class="${totalPct > 100 ? "negative" : totalPct > 80 ? "" : "positive"}">${totalPct.toFixed(0)}%</span>
          </li>`
        : "";

      list.innerHTML = summaryRow + rows.map(({ cat, spent, limit, pct }) => {
        let cls = "success";
        if (pct >= 100) cls = "danger";
        else if (pct >= 80) cls = "warning";
        const limitText = limit > 0 ? `${fmt(spent)} / ${fmt(limit)}` : `${fmt(spent)} (no limit)`;
        const progressBar = limit > 0
          ? `<div class="progress-bar"><div class="progress-fill ${cls}" style="width: ${Math.min(100, pct)}%"></div></div>`
          : "";
        const pctTag = limit > 0
          ? `<span class="cat-pct ${pct >= 100 ? "negative" : pct >= 80 ? "" : ""}">${pct.toFixed(0)}%</span>`
          : "";
        return `
          <li class="list-item cat-list-item">
            <div class="list-item-main">
              <div class="list-item-title">${escapeHtml(cat.name)} ${pctTag}</div>
              <div class="list-item-sub">${limitText}</div>
              ${progressBar}
            </div>
            <div class="list-item-actions">
              <button data-action="edit-cat" data-id="${cat.id}" title="Edit">✏️</button>
              <button data-action="del-cat" data-id="${cat.id}" title="Delete">🗑️</button>
            </div>
          </li>`;
      }).join("");
    }

    const goalList = $("#goalList");
    if (goalList && !state.goals.length) {
      goalList.innerHTML = '<li class="empty">No savings goals yet.</li>';
    } else if (goalList) {
      goalList.innerHTML = state.goals
        .map((g) => {
          const saved = goalSavedTotal(g);
          const target = Number(g.target) || 0;
          const pct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
          const dateStr = g.date ? ` · by ${g.date}` : "";

          // Date-based pace hint: how much/month to hit the target by g.date
          let paceHtml = "";
          if (g.date && target > 0 && saved < target) {
            const today = new Date();
            const goalDate = new Date(g.date);
            const monthsLeft = Math.max(0, (goalDate.getFullYear() - today.getFullYear()) * 12
              + (goalDate.getMonth() - today.getMonth()));
            const remaining = target - saved;
            if (monthsLeft > 0) {
              const perMonth = remaining / monthsLeft;
              paceHtml = `<div class="goal-pace">📅 ${fmt(perMonth)}/mo for ${monthsLeft} more month${monthsLeft === 1 ? "" : "s"}</div>`;
            } else if (goalDate < today) {
              paceHtml = `<div class="goal-pace negative">⚠️ Past target date — ${fmt(remaining)} short</div>`;
            }
          } else if (saved >= target && target > 0) {
            paceHtml = `<div class="goal-pace positive">🎉 Goal reached!</div>`;
          }

          return `
          <li class="progress-item">
            <div class="progress-header">
              <span class="progress-name">${escapeHtml(g.name)}${dateStr}</span>
              <span class="progress-amount">${fmt(saved)} / ${fmt(target)}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill success" style="width: ${pct}%"></div>
            </div>
            ${paceHtml}
            <div class="goal-actions">
              <input type="number" placeholder="Add to savings" step="0.01" min="0" data-goal-input="${g.id}" />
              <button class="btn-primary" data-action="add-saving" data-id="${g.id}">Add</button>
              <button class="btn-secondary" data-action="del-goal" data-id="${g.id}">Delete</button>
            </div>
            <div class="goal-quick-chips" style="margin-top:0.4rem">
              <button class="chip-mini" data-action="quick-goal-amt" data-id="${g.id}" data-amt="10">+10</button>
              <button class="chip-mini" data-action="quick-goal-amt" data-id="${g.id}" data-amt="25">+25</button>
              <button class="chip-mini" data-action="quick-goal-amt" data-id="${g.id}" data-amt="50">+50</button>
              <button class="chip-mini" data-action="quick-goal-amt" data-id="${g.id}" data-amt="100">+100</button>
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
    const isCreditPay = exp.kind === "credit-payment";
    let sign, amountClass, tag;
    if (isIncome) { sign = "+"; amountClass = "positive"; tag = "Received"; }
    else if (isCreditPay && isTransferIn) { sign = "+"; amountClass = "positive"; tag = "💳 Card paid"; }
    else if (isCreditPay && isTransferOut) { sign = "-"; amountClass = "negative"; tag = "💳 Card payment"; }
    else if (isTransferIn) { sign = "+"; amountClass = "positive"; tag = "Transfer in"; }
    else if (isTransferOut) { sign = "-"; amountClass = "negative"; tag = "Transfer out"; }
    else { sign = "-"; amountClass = "negative"; tag = "Spent"; }
    const isSelected = selectedTxns.has(exp.id);
    const isNew = recentlyPulledIds.has(exp.id);
    const tagsHtml = (exp.tags && exp.tags.length)
      ? `<div class="txn-tags">${exp.tags.map((t) => `<span class="txn-tag-chip">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";
    const person = exp.personId ? state.people.find((p) => p.id === exp.personId) : null;
    const personHtml = person
      ? `<div class="txn-person" style="color: ${person.color || "var(--primary)"}">→ ${escapeHtml(person.name)}</div>`
      : "";
    const event = exp.eventId ? state.events.find((ev) => ev.id === exp.eventId) : null;
    const eventHtml = event
      ? `<div class="txn-event">${event.icon || "🌴"} ${escapeHtml(event.name)}</div>`
      : "";
    return `
      <li class="txn-item ${isSelected ? "selected" : ""} ${isNew ? "newly-synced" : ""}" data-txn-row="${exp.id}">
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
          ${eventHtml}
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

    if (filters.hideTransfers) {
      items = items.filter((e) => e.type !== "transfer-in" && e.type !== "transfer-out");
    }
    if (filters.eventId) {
      items = items.filter((e) => e.eventId === filters.eventId);
    }

    if (filters.start) items = items.filter((e) => e.date >= filters.start);
    if (filters.end) items = items.filter((e) => e.date <= filters.end);
    if (filters.categories.size > 0) {
      items = items.filter((e) => filters.categories.has(e.categoryId));
    }
    if (filters.people.size > 0) {
      items = items.filter((e) => e.personId && filters.people.has(e.personId));
    }
    if (filters.tags.size > 0) {
      items = items.filter((e) => {
        if (!Array.isArray(e.tags) || !e.tags.length) return false;
        // Match if txn has at least one of the selected tags (lowercase compare)
        return e.tags.some((t) => filters.tags.has(String(t).trim().toLowerCase()));
      });
    }
    if (filters.search) {
      const q = filters.search.toLowerCase();
      items = items.filter((e) => {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        const catName = cat ? cat.name.toLowerCase() : "";
        const tagsStr = (e.tags || []).join(" ").toLowerCase();
        const person = e.personId ? state.people.find((p) => p.id === e.personId) : null;
        const personName = person ? String(person.name || "").toLowerCase() : "";
        const desc = String(e.desc || "").toLowerCase();
        return (
          desc.includes(q) ||
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
      // Show summary: count + spent + earned (excluding internal transfers)
      let earned = 0, spent = 0;
      items.forEach((t) => {
        if (t.type === "transfer-in" || t.type === "transfer-out") return;
        if (t.type === "income") earned += Number(t.amount);
        else spent += Number(t.amount);
      });
      const parts = [`${items.length} txn${items.length === 1 ? "" : "s"}`];
      if (spent > 0) parts.push(`<span class="negative">−${fmt(spent)}</span>`);
      if (earned > 0) parts.push(`<span class="positive">+${fmt(earned)}</span>`);
      range.innerHTML = parts.join(" · ");
    }

    // Filter count pill — show how many filters are active
    const filterPill = $("#filterCountPill");
    if (filterPill) {
      let count = 0;
      if (filters.start) count++;
      if (filters.end) count++;
      if (filters.categories.size) count += filters.categories.size;
      if (filters.people.size) count += filters.people.size;
      if (filters.tags.size) count += filters.tags.size;
      if (filters.search) count++;
      if (filters.hideTransfers) count++;
      if (filters.eventId) count++;
      if (count > 0) {
        filterPill.hidden = false;
        filterPill.textContent = `${count} filter${count === 1 ? "" : "s"} active`;
      } else {
        filterPill.hidden = true;
      }
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
      // Day total: only count REAL income/spending, not internal transfers (credit
      // payments, account-to-account moves) which would double-count or inflate.
      let earned = 0, spent = 0;
      list.forEach((t) => {
        if (t.type === "transfer-in" || t.type === "transfer-out") return;
        if (t.type === "income") earned += Number(t.amount);
        else spent += Number(t.amount);
      });
      const net = earned - spent;
      const totalCls = net >= 0 ? "positive" : "negative";
      const totalStr = net === 0
        ? `${fmt(0)}`
        : (net > 0 ? `+${fmt(net)}` : `-${fmt(Math.abs(net))}`);
      const breakdown = (earned > 0 && spent > 0)
        ? ` <span class="card-sub">(+${fmt(earned)} / −${fmt(spent)})</span>`
        : "";
      html += `
        <li class="txn-day-header">
          <span>${formatLongDate(date)}</span>
          <span class="${totalCls}">${totalStr}${breakdown}</span>
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
    if (!chips) return;
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

  // Render tag filter chips. Aggregates all unique tags across transactions
  // and renders one chip per tag, sorted by frequency.
  function renderTagFilterChips() {
    const chips = $("#filterTagChips");
    if (!chips) return;
    const tagCounts = {};
    state.expenses.forEach((e) => {
      (e.tags || []).forEach((t) => {
        const key = String(t).trim().toLowerCase();
        if (!key) return;
        tagCounts[key] = (tagCounts[key] || 0) + 1;
      });
    });
    const tagList = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
    if (!tagList.length) {
      chips.innerHTML = '<span class="empty-chip">Tag transactions to filter</span>';
      return;
    }
    chips.innerHTML = tagList
      .map(([tag, count]) => {
        const on = filters.tags.has(tag);
        return `<button class="chip ${on ? "" : "off"}" data-tag-chip="${escapeHtml(tag)}">${
          on ? "✓ " : ""
        }${escapeHtml(tag)} <span class="chip-count">${count}</span></button>`;
      })
      .join("");
  }

  /* ---------- Insights / Charts ---------- */
  function renderInsights() {
    if (typeof Chart === "undefined") return;

    const safeCall = (fn, name) => {
      try { fn(); } catch (e) { console.error(`renderInsights/${name} failed:`, e); }
    };
    const expenses = filterExpensesForInsights();
    safeCall(() => renderSplitChart(expenses), "splitChart");
    safeCall(() => renderDailyChart(expenses), "dailyChart");
    safeCall(() => renderBalanceChart(expenses), "balanceChart");
    safeCall(() => renderWeekdayChart(expenses), "weekdayChart");
    safeCall(renderTrendChart, "trendChart");
    safeCall(renderCashFlowChart, "cashFlow");
    safeCall(renderIncomeSourcesChart, "incomeSources");
    safeCall(renderIncomeTypeChart, "incomeType");
    safeCall(renderNetWorthChart, "netWorth");
    safeCall(renderHeatmapCalendar, "heatmap");
    safeCall(renderTopVendors, "topVendors");
    safeCall(renderTagsChart, "tags");
    safeCall(renderYoYChart, "yoy");
    safeCall(renderMoneyFlow, "moneyFlow");
    safeCall(() => renderTagAnalytics(expenses), "tagAnalytics");
  }

  // Tag analytics: list per-tag totals for the filtered window, with a 6-month trend sparkline per tag
  function renderTagAnalytics(expenses) {
    const el = document.getElementById("tagAnalyticsList");
    if (!el) return;
    const tagTotals = {};
    (expenses || []).forEach((e) => {
      if (e.type !== "expense") return;
      const tags = (e.tags || []).filter(Boolean);
      tags.forEach((t) => {
        const k = String(t).trim().toLowerCase();
        if (!k) return;
        tagTotals[k] = (tagTotals[k] || 0) + (Number(e.amount) || 0);
      });
    });
    const sorted = Object.entries(tagTotals).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!sorted.length) {
      el.innerHTML = '<p class="empty">Tag transactions to see analytics.</p>';
      return;
    }
    // Build 6-month trend per tag (using ALL state.expenses, not just filtered)
    const months = [];
    let cursor = currentMonth();
    for (let i = 0; i < 6; i++) {
      months.unshift(cursor);
      cursor = prevMonth(cursor);
    }
    el.innerHTML = sorted.map(([tag, total]) => {
      const monthly = months.map((m) => {
        return state.expenses
          .filter((e) => e.type === "expense" && monthKey(e.date) === m && (e.tags || []).map((t) => String(t).toLowerCase()).includes(tag))
          .reduce((s, e) => s + (Number(e.amount) || 0), 0);
      });
      const spark = renderSparkline(monthly, { width: 100, height: 22 });
      return `
        <div class="tag-row">
          <span class="tag-name">#${escapeHtml(tag)}</span>
          <span class="tag-amount">${fmt(total)}</span>
          <span class="tag-spark">${spark}</span>
        </div>`;
    }).join("");
  }

  // Tiny inline SVG sparkline. Used in dashboard category list for 6-month trend.
  function renderSparkline(values, opts) {
    const width = (opts && opts.width) || 80;
    const height = (opts && opts.height) || 18;
    if (!values || !values.length) return "";
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const stepX = width / Math.max(1, values.length - 1);
    const points = values.map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const last = values[values.length - 1];
    const prev = values.length > 1 ? values[values.length - 2] : last;
    const trendUp = last > prev;
    const color = trendUp ? "var(--danger)" : "var(--success)";
    return `<svg class="sparkline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="6-month trend">
      <polyline fill="none" stroke="${color}" stroke-width="1.5" points="${points}" />
    </svg>`;
  }

  // Year-over-year comparison: this month vs same month last year, this month last 6mo vs prior 6mo, etc.
  function renderYoYChart() {
    if (typeof Chart === "undefined") return;
    destroyChart("yoy");
    const ctx = $("#chartYoY");
    if (!ctx) return;
    const headline = $("#yoyHeadline");
    const breakdown = $("#yoyBreakdown");
    const empty = $("#yoyEmpty");

    // Build last 12 months ending at current month, plus the same months last year
    const cur = currentMonth();
    const months = [];
    let cursor = cur;
    for (let i = 0; i < 12; i++) {
      months.unshift(cursor);
      cursor = prevMonth(cursor);
    }
    // For each month, total expenses in the year and the prior year's same month
    const labels = [];
    const thisYearVals = [];
    const lastYearVals = [];
    months.forEach((m) => {
      const [y, mm] = m.split("-").map(Number);
      const lastYearKey = `${y - 1}-${String(mm).padStart(2, "0")}`;
      const thisYearTotal = state.expenses
        .filter((e) => monthKey(e.date) === m && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out")
        .reduce((s, e) => s + Number(e.amount), 0);
      const lastYearTotal = state.expenses
        .filter((e) => monthKey(e.date) === lastYearKey && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out")
        .reduce((s, e) => s + Number(e.amount), 0);
      labels.push(monthLabel(m).split(" ")[0]); // Just month name
      thisYearVals.push(thisYearTotal);
      lastYearVals.push(lastYearTotal);
    });

    const hasLastYearData = lastYearVals.some((v) => v > 0);
    if (!hasLastYearData) {
      if (empty) empty.hidden = false;
      ctx.style.display = "none";
      if (headline) headline.textContent = "No last-year data yet — keep tracking and this'll fill in.";
      if (breakdown) breakdown.innerHTML = "";
      return;
    }
    if (empty) empty.hidden = true;
    ctx.style.display = "block";

    // Headline: this month vs same month last year
    const curIdx = labels.length - 1;
    const curVal = thisYearVals[curIdx];
    const priorVal = lastYearVals[curIdx];
    if (priorVal > 0) {
      const diff = curVal - priorVal;
      const pct = (diff / priorVal) * 100;
      const arrow = pct > 0 ? "↑" : (pct < 0 ? "↓" : "→");
      const word = pct > 0 ? "more" : "less";
      if (headline) {
        headline.innerHTML = `${monthLabel(cur)}: <strong>${fmt(curVal)}</strong> ${arrow} ${Math.abs(pct).toFixed(0)}% ${word} than ${monthLabel(`${cur.slice(0, 4) - 1}-${cur.slice(5)}`)} (${fmt(priorVal)})`;
      }
    } else if (headline) {
      headline.textContent = `${monthLabel(cur)}: ${fmt(curVal)} (no comparable data last year)`;
    }

    charts.yoy = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "This year",
            data: thisYearVals,
            backgroundColor: "rgba(91, 63, 184, 0.8)",
          },
          {
            label: "Last year",
            data: lastYearVals,
            backgroundColor: "rgba(148, 163, 184, 0.5)",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
      },
    });

    // Per-category breakdown: top 5 categories with biggest YoY difference
    if (breakdown) {
      const catDiffs = state.categories.map((cat) => {
        const thisYearTotal = state.expenses
          .filter((e) => e.categoryId === cat.id && (e.date || "").startsWith(cur.slice(0, 4)) && e.type !== "income")
          .reduce((s, e) => s + Number(e.amount), 0);
        const lastYearTotal = state.expenses
          .filter((e) => e.categoryId === cat.id && (e.date || "").startsWith(String(Number(cur.slice(0, 4)) - 1)) && e.type !== "income")
          .reduce((s, e) => s + Number(e.amount), 0);
        return { name: cat.name, thisYear: thisYearTotal, lastYear: lastYearTotal, diff: thisYearTotal - lastYearTotal };
      }).filter((c) => c.thisYear > 0 || c.lastYear > 0)
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
        .slice(0, 5);

      if (catDiffs.length) {
        breakdown.innerHTML = `<div class="yoy-title">Biggest changes (YTD):</div>` +
          catDiffs.map((c) => {
            const pct = c.lastYear > 0 ? ((c.diff / c.lastYear) * 100).toFixed(0) : "—";
            const cls = c.diff > 0 ? "negative" : "positive";
            const arrow = c.diff > 0 ? "↑" : "↓";
            return `<div class="yoy-row">
              <span>${escapeHtml(c.name)}</span>
              <span class="${cls}">${arrow} ${fmt(Math.abs(c.diff))} (${c.lastYear > 0 ? pct + "%" : "new"})</span>
            </div>`;
          }).join("");
      } else {
        breakdown.innerHTML = "";
      }
    }
  }

  // Money flow: visual breakdown of where current month's income went,
  // by category and top vendors per category.
  function renderMoneyFlow() {
    const el = $("#moneyFlow");
    const empty = $("#moneyFlowEmpty");
    if (!el) return;
    const m = currentMonth();
    let monthTxns = state.expenses.filter((e) => monthKey(e.date) === m);
    // Honor the Insights event filter
    if (insightsEventFilterId) {
      monthTxns = monthTxns.filter((e) => e.eventId === insightsEventFilterId);
    }
    const incomes = monthTxns.filter((e) => e.type === "income");
    const expenses = monthTxns.filter((e) => e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out");
    const totalIncome = incomes.reduce((s, e) => s + incomeReportingAmount(e), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    if (totalIncome === 0 && totalExpenses === 0) {
      if (empty) empty.hidden = false;
      el.innerHTML = "";
      return;
    }
    if (empty) empty.hidden = true;

    // Group expenses by category
    const byCat = {};
    expenses.forEach((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const name = cat ? cat.name : "Uncategorized";
      if (!byCat[name]) byCat[name] = { total: 0, vendors: {} };
      const amt = Number(e.amount) || 0;
      byCat[name].total += amt;
      const vendor = e.desc || "(no description)";
      byCat[name].vendors[vendor] = (byCat[name].vendors[vendor] || 0) + amt;
    });
    const sortedCats = Object.entries(byCat).sort((a, b) => b[1].total - a[1].total);

    const saved = Math.max(0, totalIncome - totalExpenses);
    const overspent = totalExpenses > totalIncome ? totalExpenses - totalIncome : 0;

    let html = `
      <div class="flow-summary">
        <div class="flow-pill flow-income">💰 Income · ${fmt(totalIncome)}</div>
        <div class="flow-arrow">→</div>
        <div class="flow-pill flow-expense">💸 Spent · ${fmt(totalExpenses)}</div>
        <div class="flow-arrow">→</div>
        <div class="flow-pill ${overspent > 0 ? "flow-overspent" : "flow-saved"}">${overspent > 0 ? `⚠️ Overspent · ${fmt(overspent)}` : `✓ Saved · ${fmt(saved)}`}</div>
      </div>
      <div class="flow-cats">
    `;

    sortedCats.forEach(([catName, info]) => {
      const pct = totalExpenses > 0 ? (info.total / totalExpenses) * 100 : 0;
      const topVendors = Object.entries(info.vendors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      html += `
        <div class="flow-cat">
          <div class="flow-cat-head">
            <span class="flow-cat-name">${escapeHtml(catName)}</span>
            <span class="flow-cat-amount">${fmt(info.total)} · ${pct.toFixed(0)}%</span>
          </div>
          <div class="flow-cat-bar">
            <div class="flow-cat-fill" style="width: ${pct.toFixed(1)}%"></div>
          </div>
          <div class="flow-vendors">
            ${topVendors.map(([v, amt]) => `<span class="flow-vendor">${escapeHtml(v)} · ${fmt(amt)}</span>`).join("")}
            ${Object.keys(info.vendors).length > 3 ? `<span class="flow-vendor-more">+${Object.keys(info.vendors).length - 3} more</span>` : ""}
          </div>
        </div>`;
    });
    html += "</div>";
    el.innerHTML = html;
  }

  let insightsEventFilterId = ""; // empty = all transactions

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
    if (insightsEventFilterId) {
      exps = exps.filter((e) => e.eventId === insightsEventFilterId);
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
      totals[name] = (totals[name] || 0) + (Number(e.amount) || 0);
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
      dayTotals[day] = (dayTotals[day] || 0) + (Number(e.amount) || 0);
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
    const sorted = [...expenses].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    let running = Number(state.income) || 0;
    const labels = [];
    const data = [];
    // Start point
    if (sorted.length) {
      labels.push(String(sorted[0].date || "").slice(8, 10) || "1");
      data.push(running);
    }
    sorted.forEach((e) => {
      running -= (Number(e.amount) || 0);
      labels.push(String(e.date || "").slice(8, 10));
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
      if (!e.date) return;
      const [y, m, d] = String(e.date).split("-").map(Number);
      if (!y) return;
      const dt = new Date(y, m - 1, d);
      // JS: Sunday=0 .. Saturday=6 → remap so Mon=0 .. Sun=6
      const idx = (dt.getDay() + 6) % 7;
      totals[idx] += (Number(e.amount) || 0);
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
        .filter((e) => monthKey(e.date) === mk && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out")
        .reduce((s, e) => s + (Number(e.amount) || 0), 0)
    );

    const incomes = months.map((mk) =>
      state.expenses
        .filter((e) => monthKey(e.date) === mk && e.type === "income")
        .reduce((s, e) => s + (Number(e.amount) || 0), 0)
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
    const safeCall = (fn, name) => {
      try { fn(); } catch (e) { console.error(`renderCredit/${name} failed:`, e); }
    };
    safeCall(renderCreditStats, "stats");
    safeCall(renderCardList, "cardList");
    safeCall(renderScoreList, "scoreList");
    safeCall(renderCreditTrend, "creditTrend");
    safeCall(renderCreditTips, "creditTips");
    safeCall(renderPayoffEmpty, "payoffEmpty");
    safeCall(renderInquiriesList, "inquiriesList");
    safeCall(renderNegativeList, "negativeList");
    safeCall(renderLimitIncreaseList, "limitIncreaseList");
    safeCall(renderCreditGoalList, "creditGoalList");
    safeCall(renderFreezes, "freezes");
    safeCall(renderAnnualReports, "annualReports");
    safeCall(renderPayByCalendar, "payByCalendar");
    safeCall(renderAccountAgeTimeline, "accountAgeTimeline");
    safeCall(renderRewardsList, "rewardsList");
    safeCall(renderUtilTrendChart, "utilTrend");
    safeCall(renderScoreProjection, "scoreProjection");
    safeCall(checkScoreMilestones, "scoreMilestones");
    safeCall(renderPayPlanSummary, "payPlanSummary");
  }

  function renderPayoffEmpty() {
    const eligible = state.cards.filter((c) => cardCurrentBalance(c) > 0);
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
      const fallOffStr = localDateStr(fallOff);
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
      const fallOffStr = localDateStr(fallOff);
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
    const freezes = state.creditFreezes || {};
    document.querySelectorAll('[data-freeze]').forEach((cb) => {
      const bureau = cb.dataset.freeze;
      const f = freezes[bureau];
      cb.checked = !!(f && f.frozen);
      const status = cb.parentElement && cb.parentElement.querySelector(".freeze-status");
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
    const reports = state.annualReports || {};
    el.innerHTML = bureaus.map((b) => {
      const r = reports[b];
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
            date: localDateStr(next),
            days,
            cardName: c.name,
            cardId: c.id,
            label: spec.label,
            icon: spec.icon,
            priority: spec.priority,
            isDue: spec.priority === 2,
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
          ${e.isDue ? `<button class="bill-pay-btn" data-action="quick-pay-card" data-id="${e.cardId}" title="Pay this card">Pay</button>` : ""}
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
    const utilEmptyEl = $("#utilTrendEmpty");
    if (history.length < 2) {
      if (utilEmptyEl) utilEmptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (utilEmptyEl) utilEmptyEl.hidden = true;
    ctx.style.display = "block";
    const sorted = [...history].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const labels = sorted.map((s) => {
      const parts = String(s.date || "").split("-");
      if (parts.length < 3) return s.date || "";
      const [y, m, d] = parts;
      return new Date(Number(y), Number(m) - 1, Number(d))
        .toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });
    const data = sorted.map((s) => Number(s.util) || 0);
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
    const sorted = [...state.creditScores]
      .filter((s) => s && s.date && Number(s.score))
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const projEmptyEl = $("#scoreProjectionEmpty");
    if (sorted.length < 2) {
      if (projEmptyEl) projEmptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (projEmptyEl) projEmptyEl.hidden = true;
    ctx.style.display = "block";

    // Linear regression on the scores
    const n = sorted.length;
    const xs = sorted.map((_, i) => i);
    const ys = sorted.map((s) => Number(s.score) || 0);
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
    const startMs = new Date(sorted[0].date).getTime();
    const endMs = new Date(sorted[n - 1].date).getTime();
    const totalDays = (isNaN(startMs) || isNaN(endMs)) ? 0 : (endMs - startMs) / (24 * 60 * 60 * 1000);
    const avgInterval = (totalDays > 0 && n > 1) ? totalDays / (n - 1) : 30;

    const labels = sorted.map((s) => String(s.date || "").slice(5));
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
      .filter((c) => cardCurrentBalance(c) > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        balance: cardCurrentBalance(c),
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
      .filter((c) => cardCurrentBalance(c) > 0)
      .map((c) => ({ balance: cardCurrentBalance(c), apr: Number(c.apr) || 22.99 }));
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
    return state.cards.reduce((s, c) => s + cardCurrentBalance(c), 0);
  }

  // Live card balance: card.balance is the recorded number that gets adjusted by:
  //   + expense txns on the paired credit account (purchases increase debt)
  //   − transfer-in txns (payments reduce debt)
  // This means whenever the user logs a transaction with the card's paired account
  // selected, the card balance reflects the new total automatically.
  function cardCurrentBalance(card) {
    if (!card) return 0;
    const base = Number(card.balance) || 0;
    if (!card.accountId) return base;
    let purchaseDelta = 0;
    state.expenses.forEach((e) => {
      if (e.accountId !== card.accountId) return;
      // Skip the credit-payment transfer-in (it's already accounted for in card.balance via executePayCard)
      if (e.kind === "credit-payment") return;
      if (e.type === "expense") purchaseDelta += Number(e.amount) || 0; // purchases add to debt
      else if (e.type === "transfer-in") purchaseDelta -= Number(e.amount) || 0; // manual payments reduce
      else if (e.type === "transfer-out") purchaseDelta += Number(e.amount) || 0; // refunds out of card add debt back
      else if (e.type === "income") purchaseDelta -= Number(e.amount) || 0; // refund credited to card reduces debt
    });
    return Math.max(0, base + purchaseDelta);
  }
  function utilizationPct() {
    const lim = totalCardLimit();
    if (lim <= 0) return 0;
    return (totalCardBalance() / lim) * 100;
  }
  function latestScore() {
    if (!state.creditScores.length) return null;
    return [...state.creditScores].sort((a, b) =>
      String(b.date || "").localeCompare(String(a.date || ""))
    )[0];
  }
  function previousScore() {
    if (state.creditScores.length < 2) return null;
    const sorted = [...state.creditScores].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
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
        .map((c) => (cardCurrentBalance(c) / Number(c.limit)) * 100);
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

    // Extra context: estimated monthly interest savings from paying down
    const simSavingsEl = $("#simInterestSavings");
    if (simSavingsEl) {
      const avgApr = state.cards.length
        ? state.cards.reduce((s, c) => s + (Number(c.apr) || 22.99), 0) / state.cards.length
        : 22.99;
      const monthlySavings = (payDown * (avgApr / 100)) / 12;
      simSavingsEl.textContent = monthlySavings > 0
        ? `≈ ${fmt(monthlySavings)}/mo less interest`
        : "";
    }
    // Show new debt total
    const simDebtEl = $("#simNewDebt");
    if (simDebtEl) {
      simDebtEl.textContent = `${fmt(newBal)} remaining`;
    }
  }

  // Card list filter state — persists across renders within a session
  const cardListFilters = { search: "", filter: "all" };

  // Render the expandable detail panel for a card row
  function renderCardDetailRows(c) {
    const today = new Date();
    const todayMonth = currentMonth();
    const rows = [];

    if (c.opened) {
      const opened = new Date(c.opened);
      const ageYears = (today - opened) / (365.25 * 24 * 60 * 60 * 1000);
      rows.push(`<div class="card-detail-row"><span>Opened</span><strong>${c.opened} · ${ageYears.toFixed(1)}y old</strong></div>`);
    }
    if (c.closeDay) {
      const day = clampDayToMonth(Number(c.closeDay), todayMonth);
      const close = new Date(today.getFullYear(), today.getMonth(), day);
      if (close < today) close.setMonth(close.getMonth() + 1);
      const days = Math.ceil((close - today) / (24 * 60 * 60 * 1000));
      rows.push(`<div class="card-detail-row"><span>Statement closes</span><strong>${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`} (day ${c.closeDay})</strong></div>`);
    }
    if (c.dueDay) {
      const day = clampDayToMonth(Number(c.dueDay), todayMonth);
      const due = new Date(today.getFullYear(), today.getMonth(), day);
      if (due < today) due.setMonth(due.getMonth() + 1);
      const days = Math.ceil((due - today) / (24 * 60 * 60 * 1000));
      rows.push(`<div class="card-detail-row"><span>Payment due</span><strong>${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`} (day ${c.dueDay})</strong></div>`);
    }
    if (Number(c.minPayment) > 0) {
      rows.push(`<div class="card-detail-row"><span>Min payment</span><strong>${fmt(c.minPayment)}</strong></div>`);
    }
    if (Number(c.cashbackRate) > 0) {
      rows.push(`<div class="card-detail-row"><span>Cashback</span><strong>${c.cashbackRate}%</strong></div>`);
    }
    if (Number(c.annualFee) > 0) {
      rows.push(`<div class="card-detail-row"><span>Annual fee</span><strong>${fmt(c.annualFee)}</strong></div>`);
    }
    if (Number(c.signupBonus) > 0) {
      rows.push(`<div class="card-detail-row"><span>Sign-up bonus</span><strong>${fmt(c.signupBonus)} earned</strong></div>`);
    }
    // Last payment
    const lastPay = state.expenses
      .filter((e) => e.kind === "credit-payment" && e.cardId === c.id && e.type === "transfer-out")
      .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id))[0];
    if (lastPay) {
      rows.push(`<div class="card-detail-row"><span>Last payment</span><strong>${fmt(lastPay.amount)} on ${lastPay.date}</strong></div>`);
    }
    // Total payments YTD
    const year = todayMonth.slice(0, 4);
    const ytdPaid = state.expenses
      .filter((e) => e.kind === "credit-payment" && e.cardId === c.id && e.type === "transfer-out" && (e.date || "").startsWith(year))
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    if (ytdPaid > 0) {
      rows.push(`<div class="card-detail-row"><span>Paid YTD</span><strong>${fmt(ytdPaid)}</strong></div>`);
    }
    return rows.length ? rows.join("") : '<div class="card-sub">No additional details. Edit the card to add cashback, fees, opened date, etc.</div>';
  }

  function renderCardList() {
    const list = $("#cardList");
    if (!list) return;
    if (!state.cards.length) {
      list.innerHTML = '<li class="empty">No cards yet. Tap <strong>+ Add Card</strong>.</li>';
      return;
    }

    // Apply filter + search
    const q = cardListFilters.search.toLowerCase().trim();
    const filtered = state.cards.filter((c) => {
      // Filter mode
      if (cardListFilters.filter === "open") {
        if (c.accountStatus && c.accountStatus.toLowerCase() !== "open") return false;
        if (c.closedDate) return false;
      } else if (cardListFilters.filter === "closed") {
        const isClosed = (c.accountStatus && c.accountStatus.toLowerCase() !== "open") || c.closedDate;
        if (!isClosed) return false;
      } else if (cardListFilters.filter === "high-util") {
        const lim = Number(c.limit) || 0;
        const bal = cardCurrentBalance(c);
        const util = lim > 0 ? (bal / lim) * 100 : 0;
        if (util < 80) return false;
      } else if (cardListFilters.filter === "autopay") {
        if (!c.autopay) return false;
      }
      // Search
      if (q) {
        const haystack = [c.name, c.issuer, c.last4].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      list.innerHTML = `<li class="empty">No cards match. <button class="link" id="cardClearFilters">Clear filters</button></li>`;
      $("#cardClearFilters")?.addEventListener("click", () => {
        cardListFilters.search = "";
        cardListFilters.filter = "all";
        const search = $("#cardSearch"); if (search) search.value = "";
        const filter = $("#cardFilter"); if (filter) filter.value = "all";
        renderCardList();
      });
      return;
    }

    list.innerHTML = filtered
      .map((c) => {
        const lim = Number(c.limit) || 0;
        const bal = cardCurrentBalance(c);
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
          <li class="card-item" data-card-row="${c.id}">
            <div class="card-item-head">
              <div class="card-item-title">${escapeHtml(c.name)}${last4} ${autopay}</div>
              <div class="list-item-actions">
                ${cardCurrentBalance(c) > 0 ? `<button data-action="quick-pay-card" data-id="${c.id}" title="Pay this card">💸 Pay</button>` : ""}
                <button data-action="expand-card" data-id="${c.id}" title="Show details">ℹ️</button>
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
            <div class="card-detail-panel" data-card-detail="${c.id}" hidden>
              ${renderCardDetailRows(c)}
            </div>
          </li>`;
      })
      .join("");

    // Show count if filter is active
    const filterIsActive = q || cardListFilters.filter !== "all";
    if (filterIsActive) {
      const summary = document.createElement("li");
      summary.className = "empty";
      summary.style.fontSize = "0.8rem";
      summary.textContent = `Showing ${filtered.length} of ${state.cards.length} cards`;
      list.appendChild(summary);
    }
  }

  /* ---------- Pay-card planning (credit cards <-> accounts) ---------- */

  // Working state for the pay modal & summary card
  const payCardPlanState = {
    sourceId: null,
    keep: 0,
    strategy: "statement",
    plan: {}, // { cardId: amount }
    date: null,
  };

  // Liquid (cash-like) source accounts: anything that isn't a credit card
  function liquidAccounts() {
    return state.accounts.filter((a) => (a.type || "").toLowerCase() !== "credit" && !a.cardId);
  }

  function liquidTotal() {
    return liquidAccounts().reduce((s, a) => s + accountBalance(a.id), 0);
  }

  // Sum of payments to credit cards this month (transfer-out + kind=credit-payment)
  function creditPaymentsThisMonth() {
    const m = currentMonth();
    return state.expenses
      .filter((e) => e.type === "transfer-out" && e.kind === "credit-payment" && monthKey(e.date) === m)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
  }

  // Render the summary card on the credit page
  function renderPayPlanSummary() {
    const debtEl = $("#ppDebt");
    const liquidEl = $("#ppLiquid");
    const paidEl = $("#ppPaidMonth");
    const rows = $("#payPlanRows");
    if (!debtEl || !liquidEl || !paidEl || !rows) return;

    const debt = totalCardBalance();
    const liquid = liquidTotal();
    const paid = creditPaymentsThisMonth();

    debtEl.textContent = fmt(debt);
    liquidEl.textContent = fmt(liquid);
    paidEl.textContent = fmt(paid);

    if (!state.cards.length) {
      rows.innerHTML = '<p class="empty">Add cards with balances to see suggestions.</p>';
      return;
    }

    // Per-card row showing balance, suggested payment, util %, and a quick "pay" action
    rows.innerHTML = state.cards
      .filter((c) => cardCurrentBalance(c) > 0)
      .sort((a, b) => cardCurrentBalance(b) - cardCurrentBalance(a))
      .map((c) => {
        const lim = Number(c.limit) || 0;
        const bal = cardCurrentBalance(c);
        const stmt = Number(c.statement) || 0;
        const util = lim > 0 ? (bal / lim) * 100 : 0;
        const minPay = Math.max(25, Math.round(bal * 0.02));
        const utilCls = util >= 50 ? "danger" : util >= 30 ? "warning" : "success";
        return `
          <div class="pay-plan-row">
            <div class="pp-row-main">
              <div class="pp-row-name">${escapeHtml(c.name)} ${stmt > 0 ? `<span class="pp-stmt">stmt ${fmt(stmt)}</span>` : ""}</div>
              <div class="pp-row-sub">${fmt(bal)} bal · ${util.toFixed(0)}% util · min ~${fmt(minPay)}</div>
              <div class="progress-bar"><div class="progress-fill ${utilCls}" style="width:${Math.min(util, 100)}%"></div></div>
            </div>
            <button class="btn-secondary" data-action="quick-pay-card" data-id="${c.id}">Pay</button>
          </div>`;
      })
      .join("") || '<p class="empty">No card balances to pay.</p>';
  }

  function openPayCardModal(prefillCardId) {
    if (!state.cards.length) {
      showToast("No credit cards to pay");
      return;
    }
    const liquids = liquidAccounts();
    if (!liquids.length) {
      showToast("Add a checking or savings account first");
      return;
    }

    // Default source: largest-balance liquid account
    const defaultSource = liquids
      .map((a) => ({ id: a.id, bal: accountBalance(a.id) }))
      .sort((a, b) => b.bal - a.bal)[0];
    payCardPlanState.sourceId = defaultSource.id;
    payCardPlanState.keep = 0;
    payCardPlanState.strategy = "statement";
    payCardPlanState.plan = {};
    payCardPlanState.date = todayStr();

    // Populate source dropdown
    const src = $("#pmSource");
    if (src) {
      src.innerHTML = liquids
        .map((a) => `<option value="${a.id}">${escapeHtml(a.name)} (${fmt(accountBalance(a.id))})</option>`)
        .join("");
      src.value = payCardPlanState.sourceId;
    }
    $("#pmKeep").value = "";
    $("#pmDate").value = payCardPlanState.date;

    // If user clicked "Pay" on a single card, pre-fill plan with that card's statement
    if (typeof prefillCardId === "string") {
      const c = state.cards.find((x) => x.id === prefillCardId);
      if (c) {
        const target = Number(c.statement) > 0 ? Number(c.statement) : cardCurrentBalance(c);
        payCardPlanState.plan[c.id] = target;
      }
    } else {
      // Default strategy: statement balances
      applyStrategyToPlan();
    }

    // Highlight default strategy button
    $$(".pay-strategy-row button[data-strategy]").forEach((b) => b.classList.remove("active"));
    const def = document.querySelector('.pay-strategy-row button[data-strategy="statement"]');
    if (def) def.classList.add("active");

    renderPayCardPlanRows();
    $("#payCardModal").classList.add("open");
  }

  function closePayCardModal() {
    $("#payCardModal").classList.remove("open");
  }

  function applyStrategyToPlan() {
    const cards = state.cards.filter((c) => cardCurrentBalance(c) > 0);
    payCardPlanState.plan = {};
    if (!cards.length) return;
    const strat = payCardPlanState.strategy;

    if (strat === "clear") return; // empty plan

    if (strat === "full") {
      cards.forEach((c) => { payCardPlanState.plan[c.id] = cardCurrentBalance(c); });
      return;
    }
    if (strat === "statement") {
      cards.forEach((c) => {
        const target = Number(c.statement) > 0 ? Number(c.statement) : cardCurrentBalance(c);
        payCardPlanState.plan[c.id] = target;
      });
      return;
    }

    // Avalanche / Snowball: distribute available funds in priority order, paying minimums on the rest
    const liquid = liquidTotal();
    const keep = payCardPlanState.keep || 0;
    const available = Math.max(0, liquid - keep);
    const minPay = (c) => Math.max(25, Math.round(cardCurrentBalance(c) * 0.02));

    let sorted = [...cards];
    if (strat === "avalanche") sorted.sort((a, b) => (Number(b.apr) || 0) - (Number(a.apr) || 0));
    else if (strat === "snowball") sorted.sort((a, b) => cardCurrentBalance(a) - cardCurrentBalance(b));

    // First pass: minimums for everyone
    let remaining = available;
    sorted.forEach((c) => {
      const m = Math.min(minPay(c), cardCurrentBalance(c));
      const pay = Math.min(m, remaining);
      payCardPlanState.plan[c.id] = pay;
      remaining -= pay;
    });
    // Second pass: top up priority cards toward statement/full balance
    for (const c of sorted) {
      if (remaining <= 0) break;
      const target = Number(c.statement) > 0 ? Number(c.statement) : cardCurrentBalance(c);
      const already = payCardPlanState.plan[c.id] || 0;
      const room = Math.max(0, target - already);
      const add = Math.min(room, remaining);
      payCardPlanState.plan[c.id] = already + add;
      remaining -= add;
    }
  }

  function renderPayCardPlanRows() {
    const list = $("#pmCardList");
    if (!list) return;

    const liquid = liquidTotal();
    const planTotal = Object.values(payCardPlanState.plan).reduce((s, v) => s + (Number(v) || 0), 0);

    $("#pmDebt").textContent = fmt(totalCardBalance());
    $("#pmLiquid").textContent = fmt(liquid);
    $("#pmPlanTotal").textContent = fmt(planTotal);

    const cards = state.cards.filter((c) => cardCurrentBalance(c) > 0);
    if (!cards.length) {
      list.innerHTML = '<li class="empty">No card balances to pay.</li>';
      return;
    }

    // Sort by current strategy
    let sorted = [...cards];
    if (payCardPlanState.strategy === "avalanche") sorted.sort((a, b) => (Number(b.apr) || 0) - (Number(a.apr) || 0));
    else if (payCardPlanState.strategy === "snowball") sorted.sort((a, b) => cardCurrentBalance(a) - cardCurrentBalance(b));
    else sorted.sort((a, b) => cardCurrentBalance(b) - cardCurrentBalance(a));

    list.innerHTML = sorted
      .map((c) => {
        const bal = cardCurrentBalance(c);
        const stmt = Number(c.statement) || 0;
        const apr = c.apr ? `${c.apr}% APR · ` : "";
        const planAmt = Number(payCardPlanState.plan[c.id] || 0);
        return `
          <li class="pay-card-row">
            <div class="pcr-info">
              <div class="pcr-name">${escapeHtml(c.name)}</div>
              <div class="pcr-sub">${apr}bal ${fmt(bal)}${stmt > 0 ? ` · stmt ${fmt(stmt)}` : ""}</div>
            </div>
            <input type="number" class="pcr-amount" data-card-id="${c.id}" min="0" step="0.01" max="${bal}" value="${planAmt.toFixed(2)}" />
          </li>`;
      })
      .join("");

    // Wire amount changes
    list.querySelectorAll(".pcr-amount").forEach((inp) => {
      inp.addEventListener("input", (e) => {
        const id = e.target.dataset.cardId;
        const v = Math.max(0, Number(e.target.value) || 0);
        payCardPlanState.plan[id] = v;
        const total = Object.values(payCardPlanState.plan).reduce((s, x) => s + (Number(x) || 0), 0);
        $("#pmPlanTotal").textContent = fmt(total);
      });
    });
  }

  // Make a single card payment: transfer from source liquid -> credit-card paired account
  function executePayCard(cardId, amount, fromAccountId, date, transferGroupId) {
    const card = state.cards.find((c) => c.id === cardId);
    if (!card) return false;
    const fromAcc = state.accounts.find((a) => a.id === fromAccountId);
    if (!fromAcc) return false;

    // Ensure card has a paired account
    if (!card.accountId || !state.accounts.find((a) => a.id === card.accountId)) {
      const palette = ["#ec4899", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444"];
      const acc = touchRecord({
        id: uid(),
        name: card.name,
        type: "credit",
        balance: -Math.abs(Number(card.balance) || 0),
        color: palette[state.accounts.length % palette.length],
        cardId: card.id,
      });
      state.accounts.push(acc);
      card.accountId = acc.id;
      touchRecord(card);
    }

    const groupId = transferGroupId || uid();
    const desc = `Payment: ${fromAcc.name} → ${card.name}`;
    const dt = date || todayStr();
    // Tag with Credit Payment category so it shows as "Credit Payment" in the txn list
    const cpCat = state.categories.find((c) => /^credit\s*payment$/i.test(c.name));
    const cpCatId = cpCat ? cpCat.id : null;

    state.expenses.push(touchRecord({
      id: uid(),
      type: "transfer-out",
      desc,
      amount,
      date: dt,
      accountId: fromAccountId,
      categoryId: cpCatId,
      tags: ["transfer", "credit-payment"],
      receipt: null,
      transferGroupId: groupId,
      kind: "credit-payment",
      cardId: card.id,
    }));
    state.expenses.push(touchRecord({
      id: uid(),
      type: "transfer-in",
      desc,
      amount,
      date: dt,
      accountId: card.accountId,
      categoryId: cpCatId,
      tags: ["transfer", "credit-payment"],
      receipt: null,
      transferGroupId: groupId,
      kind: "credit-payment",
      cardId: card.id,
    }));

    // Reduce card.balance by the payment amount (don't go below zero)
    const newBal = Math.max(0, (Number(card.balance) || 0) - amount);
    card.balance = newBal;
    touchRecord(card);
    return true;
  }

  // Quick-pay minimums on every card with a balance, all from the largest liquid account
  function payAllMinimums() {
    const cardsWithBalance = state.cards.filter((c) => cardCurrentBalance(c) > 0);
    if (!cardsWithBalance.length) {
      showToast("No cards with balances to pay");
      return;
    }
    const liquids = liquidAccounts();
    if (!liquids.length) {
      showToast("Add a checking or savings account first");
      return;
    }
    // Compute minimum per card: explicit minPayment, else 2% of balance, floored at $25
    const plan = cardsWithBalance.map((c) => {
      const bal = cardCurrentBalance(c);
      const explicit = Number(c.minPayment) || 0;
      const computed = Math.max(25, Math.round(bal * 0.02));
      const min = Math.min(bal, explicit > 0 ? explicit : computed);
      return { card: c, amount: min };
    });
    const total = plan.reduce((s, p) => s + p.amount, 0);

    // Pick largest-balance liquid account as default source
    const source = liquids
      .map((a) => ({ a, bal: accountBalance(a.id) }))
      .sort((x, y) => y.bal - x.bal)[0];
    if (!source || source.bal < total) {
      const proceed = confirm(
        `Plan: ${plan.length} card${plan.length === 1 ? "" : "s"}, ${fmt(total)} total\n\n` +
        `${source ? source.a.name : "Source"} has ${source ? fmt(source.bal) : "$0"} available — that's less than the minimums total.\n\nApply anyway?`
      );
      if (!proceed) return;
    } else {
      const lines = plan.map((p) => `  • ${p.card.name}: ${fmt(p.amount)}`).join("\n");
      const ok = confirm(
        `Pay minimums on ${plan.length} card${plan.length === 1 ? "" : "s"} from ${source.a.name}?\n\n${lines}\n\nTotal: ${fmt(total)}`
      );
      if (!ok) return;
    }

    let applied = 0;
    let appliedTotal = 0;
    plan.forEach(({ card, amount }) => {
      if (amount <= 0) return;
      if (executePayCard(card.id, amount, source.a.id)) {
        applied++;
        appliedTotal += amount;
      }
    });
    saveData();
    renderAll();
    showToast(`Paid ${fmt(appliedTotal)} across ${applied} card${applied === 1 ? "" : "s"}`);
  }

  function applyPayCardPlan() {
    const fromId = $("#pmSource")?.value;
    const date = $("#pmDate")?.value || todayStr();
    if (!fromId) {
      showToast("Pick a source account");
      return;
    }
    const entries = Object.entries(payCardPlanState.plan)
      .map(([cardId, amt]) => [cardId, Number(amt) || 0])
      .filter(([, amt]) => amt > 0);
    if (!entries.length) {
      showToast("No payments to apply");
      return;
    }

    // Sanity: warn if plan exceeds liquid
    const planTotal = entries.reduce((s, [, a]) => s + a, 0);
    const liquid = liquidTotal();
    const keep = Number($("#pmKeep")?.value) || 0;
    if (planTotal > liquid - keep) {
      const proceed = confirm(
        `Plan total ${fmt(planTotal)} exceeds available cash ${fmt(Math.max(0, liquid - keep))}. Apply anyway?`
      );
      if (!proceed) return;
    }

    let applied = 0;
    let total = 0;
    entries.forEach(([cardId, amt]) => {
      if (executePayCard(cardId, amt, fromId, date)) {
        applied++;
        total += amt;
      }
    });

    saveData();
    closePayCardModal();
    renderAll();
    showToast(`Applied ${applied} payment${applied === 1 ? "" : "s"} totaling ${fmt(total)}`);
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

    const trendEmptyEl = $("#creditTrendEmpty");
    if (state.creditScores.length < 1) {
      if (trendEmptyEl) trendEmptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (trendEmptyEl) trendEmptyEl.hidden = true;
    ctx.style.display = "block";

    const sorted = [...state.creditScores].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const labels = sorted.map((s) => s.date || "");
    const data = sorted.map((s) => Number(s.score) || 0);

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
      const bal = cardCurrentBalance(c);
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
    if (status) {
      status.textContent = "Reading PDF…";
      status.hidden = false;
    }
    if (!window.pdfjsLib) {
      if (status) status.textContent = "PDF library failed to load. Try pasting text instead.";
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
      if (status) status.textContent = `Read ${pdf.numPages} page${pdf.numPages === 1 ? "" : "s"} (${fullText.length} chars). Parsing…`;
      parseCreditReport(fullText);
    } catch (e) {
      console.error(e);
      if (status) status.textContent = "Could not read this PDF. Try pasting the text instead.";
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
      inquiries: [],
      negatives: [],
    };

    // Detect source
    const lower = text.toLowerCase();
    if (lower.includes("credit karma")) result.source = "Credit Karma";
    else if (lower.includes("experian")) result.source = "Experian";
    else if (lower.includes("equifax")) result.source = "Equifax";
    else if (lower.includes("transunion")) result.source = "TransUnion";
    else if (lower.includes("fico")) result.source = "FICO";
    else result.source = "Other";

    // Detect bureau
    if (lower.includes("transunion")) result.bureau = "TransUnion";
    else if (lower.includes("equifax")) result.bureau = "Equifax";
    else if (lower.includes("experian")) result.bureau = "Experian";

    // Detect score type
    if (lower.includes("vantagescore")) result.type = "VantageScore";
    else if (lower.includes("fico")) result.type = "FICO";
    else result.type = "VantageScore";

    // Find score: 3-digit number near "VantageScore" or "FICO" or "Calculated using"
    const scoreCalcMatch = text.match(/(\d{3})\s*(?:Calculated using|VantageScore|FICO)/i)
      || text.match(/(?:VantageScore|FICO)[\s\S]{0,40}?(\d{3})/i);
    if (scoreCalcMatch) {
      const n = Number(scoreCalcMatch[1]);
      if (n >= 300 && n <= 850) result.score = n;
    }
    // Fallback: any 3-digit between 300-850 that appears very early in the doc
    if (!result.score) {
      const earlyText = text.slice(0, 2000);
      const earlyMatch = earlyText.match(/\b([3-8]\d{2})\b/);
      if (earlyMatch) {
        const n = Number(earlyMatch[1]);
        if (n >= 300 && n <= 850) result.score = n;
      }
    }

    // Find report date — look for "View report from" or first Month DD, YYYY
    const reportFromMatch = text.match(/View report from\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i)
      || text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(\d{4})\b/i);
    if (reportFromMatch) {
      const d = new Date(reportFromMatch[0].replace(/^View report from\s+/i, ""));
      if (!isNaN(d)) result.reportDate = localDateStr(d);
    }

    // Friendly name lookup for known creditor codes
    const friendlyNames = {
      "CB INDIGO": "Indigo Mastercard",
      "CB/INDIGO": "Indigo Mastercard",
      "BBY/CBNA": "Best Buy / Citi",
      "JPMCB CARD": "Chase",
      "DISCOVERCARD": "Discover",
      "FB&T/MERCURY": "Mercury Mastercard",
      "WFBNA CARD": "Wells Fargo",
      "CREDITONEBNK": "Credit One Bank",
      "CAPITAL ONE": "Capital One",
      "CURRENT": "Current",
    };

    // Helper: parse a "Mon. DD, YYYY" or "Mon DD, YYYY" date string into ISO format
    const parseFlexDate = (str) => {
      if (!str) return null;
      const cleaned = str.replace(/\./g, "").trim();
      const d = new Date(cleaned);
      return isNaN(d) ? null : localDateStr(d);
    };

    // Strategy: find all "Reported: <date>" anchors. For each, the card name
    // is the ALL-CAPS issuer code immediately before it in the text. Since
    // pdfjs joins all text with spaces, we use a single-line regex.
    //
    // The card name pattern allows for:
    //   - Word characters, ampersands, slashes, dots, hyphens, spaces
    //   - 2-40 chars
    //   - Must start with uppercase letter
    //   - Mostly uppercase letters (allows digits and small connectors)
    //
    // Match looks like: "<NAME> Reported: <DATE>"
    // Use a tight window before "Reported:" to capture just the name.
    const nameAndReportedRegex = /\b([A-Z][A-Z0-9&./\s\-]{1,38}[A-Z0-9])\s+Reported:\s*([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4})/g;
    const matches = [];
    let nm;
    while ((nm = nameAndReportedRegex.exec(text)) !== null) {
      const rawName = nm[1].trim();
      // Filter out false positives — header text like "TODAY CREDIT CARDS LOANS"
      if (/CREDIT CARDS|CREDIT KARMA|TODAY CREDIT|VIEW REPORT|HARD INQUIRIES|CREDITOR INFORMATION/i.test(rawName)) continue;
      // Must have at least 3 letters
      if ((rawName.match(/[A-Z]/g) || []).length < 3) continue;
      // Skip if this is the same as the previous match (dedupe back-to-back)
      matches.push({
        rawName,
        reportedDate: nm[2],
        idx: nm.index,
        endIdx: nm.index + nm[0].length,
      });
    }

    // Fallback: some Credit Karma exports concatenate "<NAME>Reported:" with no
    // space. Try a no-space variant when the spaced version found nothing.
    if (matches.length === 0) {
      const noSpaceRegex = /([A-Z][A-Z0-9&/\s\-]{1,38}[A-Z0-9])Reported:\s*([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4})/g;
      let nsm;
      while ((nsm = noSpaceRegex.exec(text)) !== null) {
        let rawName = nsm[1].trim();
        // Strip leading "CREDIT CARDS" prefix if it got captured
        rawName = rawName.replace(/^CREDIT CARDS\s*/i, "").trim();
        if (/CREDIT CARDS|CREDIT KARMA|TODAY CREDIT|VIEW REPORT|HARD INQUIRIES|CREDITOR INFORMATION/i.test(rawName)) continue;
        if ((rawName.match(/[A-Z]/g) || []).length < 3) continue;
        matches.push({
          rawName,
          reportedDate: nsm[2],
          idx: nsm.index,
          endIdx: nsm.index + nsm[0].length,
        });
      }
    }

    const seenCards = new Set();

    matches.forEach((mt, i) => {
      // Block extends from this match's end to the next match's start
      const blockStart = mt.endIdx;
      const blockEnd = i + 1 < matches.length ? matches[i + 1].idx : Math.min(text.length, mt.endIdx + 5000);
      const block = text.slice(blockStart, blockEnd);

      const balanceMatch = block.match(/Balance\s*\$?([\d,]+(?:\.\d{2})?)/i);
      let balance = balanceMatch ? Number(balanceMatch[1].replace(/,/g, "")) : 0;

      const limitMatch = block.match(/Credit limit\s*\$?([\d,]+(?:\.\d{2})?)/i);
      const noLimit = /Credit limit\s*No Info/i.test(block);
      const limit = limitMatch ? Number(limitMatch[1].replace(/,/g, "")) : 0;

      // Summary-format fallback: when "Balance $X" section isn't present, try
      // to grab the balance from the line right after "Reported: <date>$X.XX<status>"
      if (balance === 0 && !balanceMatch) {
        const summaryBalanceMatch = block.match(/^\s*\$?([\d,]+(?:\.\d{2})?)\s*(In good standing|Needs Attention|Closed)/i);
        if (summaryBalanceMatch) {
          balance = Number(summaryBalanceMatch[1].replace(/,/g, ""));
        }
      }

      const monthlyMatch = block.match(/Monthly payment\s*\$?([\d,]+(?:\.\d{2})?)/i);
      const monthly = monthlyMatch ? Number(monthlyMatch[1].replace(/,/g, "")) : null;

      const openedMatch = block.match(/Opened\s+([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4})/i);
      const opened = openedMatch ? openedMatch[1] : null;

      const lastPayMatch = block.match(/Last payment\s+([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4})/i);
      const lastPay = lastPayMatch ? lastPayMatch[1] : null;

      const utilMatch = block.match(/using\s+(\d+)%/i);
      const utilization = utilMatch ? Number(utilMatch[1]) : null;

      const accountStatusMatch = block.match(/Account status\s+(Open|Closed|Paid)/i);
      let accountStatus = accountStatusMatch ? accountStatusMatch[1] : null;
      // Summary fallback: pick up status badge ("In good standing" → Open, "Needs Attention" → Open with issues, "Closed" → Closed)
      if (!accountStatus) {
        if (/Closed/.test(block.slice(0, 100)) && !/Account closed/.test(block)) accountStatus = "Closed";
        else if (/In good standing|Needs Attention/.test(block.slice(0, 100))) accountStatus = "Open";
      }

      const lateMatch = block.match(/Times 30\/60\/90\+\s+days late\s+(\d+)\/(\d+)\/(\d+)/i);
      const lates = lateMatch ? { d30: Number(lateMatch[1]), d60: Number(lateMatch[2]), d90: Number(lateMatch[3]) } : null;

      const typeMatch = block.match(/Type\s+(Credit Card|Charge Account|Flexible Spending Credit Card|Secured Credit Card)/i);
      const cardType = typeMatch ? typeMatch[1] : "Credit Card";

      const closedMatch = block.match(/Closed\s+([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4})/i);
      const closedDate = closedMatch ? closedMatch[1] : null;

      const overLimit = limit > 0 && balance > limit;

      // Dedupe: same name + same opened date + same limit = same card reported twice
      const dedupeKey = `${mt.rawName}|${opened || "?"}|${limit || 0}|${balance || 0}`;
      if (seenCards.has(dedupeKey)) return;
      seenCards.add(dedupeKey);

      const friendlyName = friendlyNames[mt.rawName] || mt.rawName;
      const isClosed = accountStatus && accountStatus.toLowerCase() !== "open";

      const cardTypeKey = cardType.toLowerCase().includes("charge") ? "charge" : "credit";

      result.cards.push({
        name: friendlyName,
        issuer: mt.rawName,
        balance,
        limit,
        monthlyPayment: monthly,
        opened: parseFlexDate(opened),
        lastPayment: parseFlexDate(lastPay),
        utilization,
        accountStatus,
        lates,
        cardType: cardTypeKey,
        closedDate: parseFlexDate(closedDate),
        isClosed,
        reportedDate: parseFlexDate(mt.reportedDate),
        overLimit,
        noLimitInfo: noLimit,
        detected: true,
      });
    });

    // Parse hard inquiries — same-line format: "<NAME> Inquiry: <date>"
    // Try both spaced and concatenated variants since CK exports vary.
    const inquiryRegexes = [
      /\b([A-Z][A-Z0-9&./\s\-]{1,38}[A-Z0-9])\s+Inquiry:\s*([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4})/g,
      /([A-Z][A-Z0-9&/\s\-]{1,38}[A-Z0-9])Inquiry:\s*([A-Z][a-z]{2,9}\.?\s+\d{1,2},?\s+\d{4})/g,
    ];
    const seenInq = new Set();
    inquiryRegexes.forEach((rx) => {
      let inq;
      while ((inq = rx.exec(text)) !== null) {
        let reasonName = inq[1].trim();
        // Strip trailing "Banks" prefix or other category labels
        reasonName = reasonName.replace(/^(Banks|Auto|Mortgage|Cards|Other)\s+/i, "").trim();
        if (/CREDIT CARDS|TODAY CREDIT|HARD INQUIRIES/i.test(reasonName)) continue;
        if ((reasonName.match(/[A-Z]/g) || []).length < 3) continue;
        const date = parseFlexDate(inq[2]);
        if (!date) continue;
        const key = `${reasonName}|${date}`;
        if (seenInq.has(key)) continue;
        seenInq.add(key);
        result.inquiries.push({
          date,
          reason: friendlyNames[reasonName] || reasonName,
          bureau: result.bureau || null,
        });
      }
    });

    // Detect derogatory remarks (late payment patterns from cards that have lates)
    result.cards.forEach((c) => {
      if (c.lates && (c.lates.d60 > 0 || c.lates.d90 > 0)) {
        const worstStr = c.lates.d90 > 0 ? "90+ days late" : "60+ days late";
        result.negatives.push({
          type: "late_payment",
          creditor: c.name,
          note: `${c.lates.d30}/${c.lates.d60}/${c.lates.d90} (30/60/90+ days late) — worst: ${worstStr}`,
          date: c.lastPayment || c.reportedDate || todayStr(),
        });
      }
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
      const openCards = result.cards.filter((c) => !c.isClosed).length;
      const closedCards = result.cards.filter((c) => c.isClosed).length;
      html += `<div class="detected-cards-title">${result.cards.length} card${result.cards.length === 1 ? "" : "s"} detected (${openCards} open · ${closedCards} closed)</div>`;
      html += '<div class="detected-cards">';
      result.cards.forEach((c, i) => {
        const utilStr = c.utilization != null ? `${c.utilization}%` : (c.limit > 0 ? `${Math.round((c.balance / c.limit) * 100)}%` : "—");
        const statusBadge = c.isClosed
          ? '<span class="dc-badge closed">Closed</span>'
          : (c.overLimit || (c.utilization && c.utilization >= 100))
            ? '<span class="dc-badge over">Over limit</span>'
            : (c.utilization && c.utilization >= 80)
              ? '<span class="dc-badge warn">High util</span>'
              : '<span class="dc-badge ok">OK</span>';
        const lateStr = c.lates && (c.lates.d30 + c.lates.d60 + c.lates.d90) > 0
          ? ` · Lates ${c.lates.d30}/${c.lates.d60}/${c.lates.d90}`
          : "";
        const openedStr = c.opened ? ` · Opened ${c.opened}` : "";
        const alreadyPresent = state.cards.some((sc) => sc.name.toLowerCase() === c.name.toLowerCase());
        const checkedAttr = (!c.isClosed && !alreadyPresent) ? "checked" : "";
        html += `
          <div class="detected-card">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap">
                <strong>${escapeHtml(c.name)}</strong>
                ${statusBadge}
              </div>
              <div class="detected-mini">Bal ${fmt(c.balance)} / Limit ${c.noLimitInfo ? "—" : fmt(c.limit)} · Util ${utilStr}${lateStr}${openedStr}</div>
              <div class="detected-mini" style="opacity:0.7">Raw: ${escapeHtml(c.issuer)}</div>
            </div>
            <label class="detected-toggle">
              <input type="checkbox" data-card-idx="${i}" ${checkedAttr} />
              Import
            </label>
          </div>`;
      });
      html += '</div>';
    } else {
      html += `<div class="detected-row warn"><span>No cards detected — try uploading the PDF instead, or check that the report has "Reported:" date markers.</span></div>`;
    }

    if (result.inquiries.length) {
      html += `<div class="detected-cards-title">${result.inquiries.length} hard inquir${result.inquiries.length === 1 ? "y" : "ies"} detected</div>`;
      html += '<div class="detected-cards">';
      result.inquiries.forEach((inq, i) => {
        const alreadyPresent = state.creditInquiries.some((existing) =>
          existing.date === inq.date && existing.reason.toLowerCase() === inq.reason.toLowerCase()
        );
        html += `
          <div class="detected-card">
            <div style="flex:1">
              <strong>${escapeHtml(inq.reason)}</strong>
              <div class="detected-mini">${inq.date}${inq.bureau ? " · " + inq.bureau : ""}</div>
            </div>
            <label class="detected-toggle">
              <input type="checkbox" data-inq-idx="${i}" ${alreadyPresent ? "" : "checked"} />
              Import
            </label>
          </div>`;
      });
      html += '</div>';
    }

    if (result.negatives.length) {
      html += `<div class="detected-cards-title">${result.negatives.length} late-payment record${result.negatives.length === 1 ? "" : "s"} detected</div>`;
      html += '<div class="detected-cards">';
      result.negatives.forEach((neg, i) => {
        html += `
          <div class="detected-card">
            <div style="flex:1">
              <strong>${escapeHtml(neg.creditor)}</strong>
              <div class="detected-mini">${escapeHtml(neg.note)}</div>
            </div>
            <label class="detected-toggle">
              <input type="checkbox" data-neg-idx="${i}" />
              Import
            </label>
          </div>`;
      });
      html += '</div>';
    }

    detected.innerHTML = html;
    preview.hidden = false;
    status.textContent = `Found ${result.cards.length} card${result.cards.length === 1 ? "" : "s"}, ${result.inquiries.length} inquir${result.inquiries.length === 1 ? "y" : "ies"}. Review and confirm below.`;

    // Debug: stash a "show raw extracted text" link so users can see what the
    // parser received and report when something looks off.
    if (result.cards.length < 3 || (result.cards.length > 0 && result.cards.every((c) => c.name === "Capital One"))) {
      const debugBtn = document.createElement("button");
      debugBtn.className = "btn-secondary block";
      debugBtn.style.marginTop = "0.5rem";
      debugBtn.textContent = "🔧 Show raw extracted text (debug)";
      debugBtn.addEventListener("click", () => {
        const sample = text.slice(0, 5000);
        alert(`First 5000 chars of extracted text:\n\n${sample}\n\n[Total length: ${text.length}]`);
      });
      detected.appendChild(debugBtn);
    }
  }

  function applyImport() {
    if (!parsedReport) return;
    let saved = 0;

    // Save score
    if (parsedReport.score) {
      state.creditScores.push(touchRecord({
        id: uid(),
        score: parsedReport.score,
        date: parsedReport.reportDate || todayStr(),
        bureau: parsedReport.bureau || null,
        source: parsedReport.source || "Imported",
        type: parsedReport.type || "VantageScore",
        note: "Imported from credit report",
      }));
      saved += 1;
    }

    // Save selected cards
    const checkedCards = $$('#importDetected input[data-card-idx]:checked');
    checkedCards.forEach((cb) => {
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

      state.cards.push(touchRecord({
        id: uid(),
        name: c.name,
        issuer: c.issuer,
        last4: "",
        limit: c.limit,
        balance: c.balance,
        statement: c.monthlyPayment || null,
        apr: null,
        dueDay: null,
        opened: c.opened || null,
        cardType: c.cardType || "credit",
        autopay: false,
        annualFee: 0,
        cashbackRate: 0,
        signupBonus: 0,
        // Imported metadata for richer credit views
        accountStatus: c.accountStatus || null,
        lastPayment: c.lastPayment || null,
        lates: c.lates || null,
        utilization: c.utilization || null,
        closedDate: c.closedDate || null,
        importedAt: Date.now(),
        importedFrom: parsedReport.source || "Imported",
      }));
      saved += 1;
    });

    // Save selected inquiries
    const checkedInquiries = $$('#importDetected input[data-inq-idx]:checked');
    checkedInquiries.forEach((cb) => {
      const idx = Number(cb.dataset.inqIdx);
      const inq = parsedReport.inquiries[idx];
      if (!inq) return;
      // Dedupe: same date+reason
      const exists = state.creditInquiries.find(
        (existing) => existing.date === inq.date &&
                       existing.reason.toLowerCase() === inq.reason.toLowerCase()
      );
      if (exists) return;
      state.creditInquiries.push(touchRecord({
        id: uid(),
        date: inq.date,
        reason: inq.reason,
        bureau: inq.bureau,
        type: "hard",
      }));
      saved += 1;
    });

    // Save selected late-payment records as negative items
    const checkedNeg = $$('#importDetected input[data-neg-idx]:checked');
    checkedNeg.forEach((cb) => {
      const idx = Number(cb.dataset.negIdx);
      const neg = parsedReport.negatives[idx];
      if (!neg) return;
      // Dedupe by creditor+date
      const exists = state.negativeItems.find(
        (existing) => existing.creditor === neg.creditor && existing.date === neg.date
      );
      if (exists) return;
      state.negativeItems.push(touchRecord({
        id: uid(),
        type: neg.type,
        date: neg.date,
        creditor: neg.creditor,
        amount: 0,
        note: neg.note,
      }));
      saved += 1;
    });

    saveData();
    closeImportCreditModal();
    renderCredit();
    showToast(`Imported ${saved} item${saved === 1 ? "" : "s"}`);
  }

  /* ---------- Family ---------- */
  function familyTransactions() {
    // Outgoing money sent to a person (existing behavior — used by the Sent total)
    return state.expenses.filter(
      (e) => e.personId && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
  }

  // Incoming money tagged as received from a person (e.g. "received from sister")
  function familyReceivedTransactions() {
    return state.expenses.filter(
      (e) => e.personId && e.type === "income"
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
    const received = filterFamilyByPeriod(familyReceivedTransactions())
      .reduce((s, e) => s + Number(e.amount), 0);
    const net = total - received;
    const txnCount = filterFamilyByPeriod(familyTransactions()).length
      + filterFamilyByPeriod(familyReceivedTransactions()).length;
    const pillText = received > 0
      ? `Sent ${fmt(total)} · Received ${fmt(received)} · Net ${net >= 0 ? "−" : "+"}${fmt(Math.abs(net))} · ${txnCount} txn${txnCount === 1 ? "" : "s"}`
      : `Total sent: ${fmt(total)} · ${txnCount} txn${txnCount === 1 ? "" : "s"}`;
    $("#familyTotalPill").textContent = pillText;
  }

  function renderPeopleList() {
    const list = $("#peopleList");
    if (!list) return;
    if (!state.people.length) {
      list.innerHTML = '<li class="empty">No people yet.</li>';
      return;
    }
    const relationIcons = {
      parent: "👨‍👩‍👧", spouse: "💑", sibling: "👫", child: "👶",
      friend: "🧑‍🤝‍🧑", relative: "👪", other: "👤",
    };
    list.innerHTML = state.people
      .map((p) => {
        const sentAll = state.expenses
          .filter((e) => e.personId === p.id && e.type === "expense")
          .reduce((s, e) => s + Number(e.amount), 0);
        const receivedAll = state.expenses
          .filter((e) => e.personId === p.id && e.type === "income")
          .reduce((s, e) => s + Number(e.amount), 0);
        const notes = p.notes ? ` · ${escapeHtml(p.notes)}` : "";
        const icon = relationIcons[p.relation] || "👤";
        let amountHtml;
        if (sentAll > 0 && receivedAll > 0) {
          const net = sentAll - receivedAll;
          amountHtml = `${fmt(sentAll)} sent<div class="list-item-sub" style="margin-top:0.15rem">${fmt(receivedAll)} received · net ${net >= 0 ? "−" : "+"}${fmt(Math.abs(net))}</div>`;
        } else if (receivedAll > 0) {
          amountHtml = `<span class="positive">${fmt(receivedAll)}</span><div class="list-item-sub" style="margin-top:0.15rem">received all-time</div>`;
        } else {
          amountHtml = `${fmt(sentAll)}<div class="list-item-sub" style="margin-top:0.15rem">all-time</div>`;
        }
        return `
          <li class="list-item person-item" style="border-left: 4px solid ${p.color || "#5b3fb8"}">
            <div class="list-item-main">
              <div class="list-item-title">${icon} ${escapeHtml(p.name)}</div>
              <div class="list-item-sub">${escapeHtml(p.relation || "Other")}${notes}</div>
            </div>
            <div class="list-item-amount">${amountHtml}</div>
            <div class="list-item-actions">
              <button data-action="quick-send-person" data-id="${p.id}" title="Send money">💸</button>
              <button data-action="quick-receive-person" data-id="${p.id}" title="Received from">💰</button>
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
    const sentTxns = filterFamilyByPeriod(familyTransactions());
    const recvTxns = filterFamilyByPeriod(familyReceivedTransactions());
    const totalSent = sentTxns.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const totalReceived = recvTxns.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const totalActivity = totalSent + totalReceived;

    const rows = state.people.map((p) => {
      const personSent = sentTxns.filter((e) => e.personId === p.id);
      const personRecv = recvTxns.filter((e) => e.personId === p.id);
      const sent = personSent.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const received = personRecv.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const net = sent - received;
      const personActivity = sent + received;
      const pct = totalActivity > 0 ? (personActivity / totalActivity) * 100 : 0;
      return { person: p, sent, received, net, pct, count: personSent.length + personRecv.length };
    });

    rows.sort((a, b) => (b.sent + b.received) - (a.sent + a.received));

    el.innerHTML = rows
      .map((r) => {
        const sentPct = totalActivity > 0 ? (r.sent / totalActivity) * 100 : 0;
        const recvPct = totalActivity > 0 ? (r.received / totalActivity) * 100 : 0;
        const netLabel = r.received > 0
          ? `Sent ${fmt(r.sent)} · Received ${fmt(r.received)} · Net ${r.net >= 0 ? "−" : "+"}${fmt(Math.abs(r.net))}`
          : `${fmt(r.sent)} · ${r.count} txn${r.count === 1 ? "" : "s"}`;
        // When both directions exist, show two bars (sent in person color, received in green)
        const barsHtml = r.received > 0
          ? `<div class="progress-bar progress-bar-stack">
              <div class="progress-fill" style="width: ${sentPct.toFixed(1)}%; background: ${r.person.color || "var(--primary)"}" title="Sent ${fmt(r.sent)}"></div>
              <div class="progress-fill" style="width: ${recvPct.toFixed(1)}%; background: #22c55e" title="Received ${fmt(r.received)}"></div>
            </div>`
          : `<div class="progress-bar">
              <div class="progress-fill" style="width: ${r.pct.toFixed(1)}%; background: ${r.person.color || "var(--primary)"}"></div>
            </div>`;
        return `
          <div class="progress-item person-progress" style="border-left: 4px solid ${r.person.color || "#5b3fb8"}">
            <div class="progress-header">
              <span class="progress-name">${escapeHtml(r.person.name)} <span class="progress-amount">${escapeHtml(r.person.relation || "")}</span></span>
              <span class="progress-amount">${netLabel}</span>
            </div>
            ${barsHtml}
          </div>`;
      })
      .join("");

    if (totalActivity === 0) {
      el.innerHTML += `<p class="empty" style="margin-top:0.75rem">No transactions for this period yet.</p>`;
    }
  }

  function renderFamilyTrend() {
    if (typeof Chart === "undefined") return;
    destroyChart("familyTrend");
    const ctx = $("#chartFamilyTrend");
    if (!ctx) return;

    // Include BOTH sent and received transactions in the trend
    const sentTxns = familyTransactions();
    const recvTxns = familyReceivedTransactions();
    const allTxns = [...sentTxns, ...recvTxns];
    const emptyEl = $("#familyTrendEmpty");
    if (!allTxns.length || !state.people.length) {
      if (emptyEl) emptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    ctx.style.display = "block";

    // Last 6 months totals per person (net = sent − received)
    const m = currentMonth();
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(monthOffset(m, -i));

    const datasets = state.people.map((p) => {
      const data = months.map((mk) => {
        const sent = sentTxns
          .filter((e) => e.personId === p.id && monthKey(e.date) === mk)
          .reduce((s, e) => s + Number(e.amount), 0);
        const received = recvTxns
          .filter((e) => e.personId === p.id && monthKey(e.date) === mk)
          .reduce((s, e) => s + Number(e.amount), 0);
        // Net (sent minus received) — positive = you sent net, negative = you received net
        return sent - received;
      });
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

  let familyTxnFilterId = ""; // empty = all people

  function renderFamilyTxnList() {
    const list = $("#familyTxnList");
    if (!list) return;

    // Populate the filter dropdown with current people
    const filterSel = $("#familyTxnFilter");
    if (filterSel) {
      const cur = filterSel.value || familyTxnFilterId;
      filterSel.innerHTML =
        '<option value="">All people</option>' +
        state.people
          .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
          .join("");
      if (cur) filterSel.value = cur;
    }

    // Include both sent (expenses) and received (income) transactions tagged
    // with a person, so the list reflects the full money flow with family.
    const sent = filterFamilyByPeriod(familyTransactions());
    const received = filterFamilyByPeriod(familyReceivedTransactions());
    let txns = [...sent, ...received];
    if (familyTxnFilterId) {
      txns = txns.filter((e) => e.personId === familyTxnFilterId);
    }
    txns.sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
    if (!txns.length) {
      list.innerHTML = '<li class="empty">Mark a transaction with a family member using the "Sent to family member" field — works for both expenses and income.</li>';
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
        .reduce((s, e) => s + (Number(e.amount) || 0), 0)
    );
    const spent = months.map((mk) =>
      state.expenses
        .filter((e) => monthKey(e.date) === mk && e.type !== "income"
          && e.type !== "transfer-in" && e.type !== "transfer-out")
        .reduce((s, e) => s + (Number(e.amount) || 0), 0)
    );
    const net = incomes.map((inc, i) => inc - spent[i]);

    const emptyEl = $("#cashFlowEmpty");
    if (incomes.every((v) => v === 0) && spent.every((v) => v === 0)) {
      if (emptyEl) emptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
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
      totals[e.source] = (totals[e.source] || 0) + (Number(e.amount) || 0);
    });
    const labels = Object.keys(totals);
    const data = Object.values(totals);

    const emptyEl = $("#incomeSourcesEmpty");
    if (!labels.length) {
      if (emptyEl) emptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
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
        .reduce((s, e) => s + (Number(e.amount) || 0), 0);
      if (sum > 0) {
        labels.push(typeNames[key]);
        totals.push(sum);
      }
    });

    const emptyEl = $("#incomeTypeEmpty");
    if (!labels.length) {
      if (emptyEl) emptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
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
    const emptyEl = $("#netWorthEmpty");
    if (history.length < 2) {
      if (emptyEl) emptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    ctx.style.display = "block";

    const sorted = [...history].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const labels = sorted.map((s) => {
      const parts = String(s.date || "").split("-");
      if (parts.length < 3) return s.date || "";
      const [y, m, d] = parts;
      return new Date(Number(y), Number(m) - 1, Number(d))
        .toLocaleDateString(undefined, { month: "short", day: "numeric" });
    });
    const data = sorted.map((s) => Number(s.value) || 0);

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
    const heatEmptyEl = $("#heatmapEmpty");
    if (!expenses.length) {
      if (heatEmptyEl) heatEmptyEl.hidden = false;
      el.innerHTML = "";
      return;
    }
    if (heatEmptyEl) heatEmptyEl.hidden = true;

    // Aggregate by day for the past 365 days
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - 364);

    const dayTotals = new Map();
    expenses.forEach((e) => {
      if (!e.date) return;
      // Parse as LOCAL date (not UTC) to match localDateStr() output below.
      // new Date("2025-05-30") parses as UTC; appending T00:00:00 forces local interpretation.
      const d = new Date(e.date + "T00:00:00");
      if (isNaN(d.getTime())) return;
      d.setHours(0, 0, 0, 0);
      if (d < startDate || d > today) return;
      const key = e.date;
      dayTotals.set(key, (dayTotals.get(key) || 0) + (Number(e.amount) || 0));
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
        const dateStr = localDateStr(d);
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
      const key = String(e.desc || "").trim();
      if (!key) return;
      totals[key] = (totals[key] || 0) + (Number(e.amount) || 0);
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
        totals[t] = (totals[t] || 0) + (Number(e.amount) || 0);
      });
    });
    const labels = Object.keys(totals);
    const tagsEmptyEl = $("#tagsEmpty");
    if (!labels.length) {
      if (tagsEmptyEl) tagsEmptyEl.hidden = false;
      ctx.style.display = "none";
      return;
    }
    if (tagsEmptyEl) tagsEmptyEl.hidden = true;
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
    if (!sel) return;
    sel.innerHTML =
      '<option value="">Select category</option>' +
      state.categories
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
  }

  function attachReceiptClicks(container) {
    if (!container) return;
    container.querySelectorAll("[data-receipt]").forEach((img) => {
      img.addEventListener("click", () => {
        const modalImage = $("#modalImage");
        const modal = $("#modal");
        if (modalImage) modalImage.src = img.src;
        if (modal) modal.classList.add("open");
      });
    });
    container.querySelectorAll("[data-receipt-pdf]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.receiptPdf;
        const exp = state.expenses.find((x) => x.id === id);
        if (!exp || !exp.receipt) return;
        // Open the PDF data URL in a new tab
        const w = window.open();
        if (!w) {
          showToast("Popup blocked — allow popups to view PDF receipts");
          return;
        }
        try {
          w.document.write(
            `<iframe src="${exp.receipt}" style="width:100%;height:100vh;border:0"></iframe>`
          );
        } catch (e) {
          console.error("PDF open failed", e);
          showToast("Couldn't open PDF");
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
    populateEventSelect();
    if (prefill && prefill.categoryId) {
      $("#expCategory").value = prefill.categoryId;
    } else if (
      !editingTxnId &&
      currentModalType === "expense" &&
      state.settings?.defaultCategoryId &&
      state.categories.some((c) => c.id === state.settings.defaultCategoryId)
    ) {
      $("#expCategory").value = state.settings.defaultCategoryId;
    }
    if (prefill && prefill.accountId) {
      $("#expAccount").value = prefill.accountId;
    } else if (
      !editingTxnId &&
      state.settings?.defaultAccountId &&
      state.accounts.some((a) => a.id === state.settings.defaultAccountId)
    ) {
      $("#expAccount").value = state.settings.defaultAccountId;
    }
    // Apply account → category mapping if no explicit category set yet
    if (
      !editingTxnId &&
      currentModalType === "expense" &&
      !$("#expCategory").value &&
      $("#expAccount").value
    ) {
      const acctMap = (state.settings && state.settings.accountCategoryMap) || {};
      const mappedCatId = acctMap[$("#expAccount").value];
      if (mappedCatId && state.categories.some((c) => c.id === mappedCatId)) {
        $("#expCategory").value = mappedCatId;
      }
    }
    if (prefill && prefill.personId) {
      $("#expPerson").value = prefill.personId;
    }
    if (prefill && prefill.goalId) {
      $("#expGoal").value = prefill.goalId;
    }
    if (prefill && prefill.eventId) {
      $("#expEvent") && ($("#expEvent").value = prefill.eventId);
    }
    // Stash eventLineItemId on form so save handler can read it (no UI for it)
    const formEl = $("#expenseForm");
    if (formEl) {
      if (prefill && prefill.eventLineItemId) {
        formEl.dataset.eventLineItemId = prefill.eventLineItemId;
      } else {
        delete formEl.dataset.eventLineItemId;
      }
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
      state.recurring.push(touchRecord({
        id: uid(),
        type: "income",
        desc,
        amount,
        categoryId: null,
        dayOfMonth: Math.min(31, Math.max(1, day)),
        active: true,
        lastRunMonth: monthKey(date),
      }));
      saveData();
      renderRecurringList();
      showToast(`"${desc}" set to recur monthly`);
    }, 400);
  }

  /* ---------- Paycheck Logger ---------- */
  // Simplified field set + hidden compatibility fields
  const PAYCHECK_FIELD_IDS = [
    "#pcGross", "#pcTaxes", "#pcBenefits", "#pcOther", "#pcNet",
    "#pcHours", "#pcFedTax", "#pcStateTax", "#pcSsTax", "#pcMedicareTax", "#pcFica",
    "#pcMedical", "#pcDental", "#pcVision", "#pcHsa", "#pc401k", "#pcOtherBenefits", "#pcHealth",
    "#pcAccidentIns", "#pcOtherDed",
  ];

  function openPaycheckModal() {
    $("#pcDate").value = todayStr();
    $("#pcEmployer").value = "";
    PAYCHECK_FIELD_IDS.forEach((id) => {
      const el = $(id); if (el) el.value = "";
    });
    // Reset any stashed paystub metadata
    const form = $("#paycheckForm");
    if (form) delete form.dataset.paystubMeta;
    const status = $("#paystubStatus");
    if (status) {
      status.hidden = true;
      status.textContent = "";
      status.className = "paystub-status";
    }
    populatePaycheckAccountSelect();
    updatePaycheckTotals();
    populateIncomeSourceList();
    $("#paycheckModal").classList.add("open");
    setTimeout(() => $("#pcEmployer")?.focus(), 50);
  }
  function closePaycheckModal() {
    $("#paycheckModal").classList.remove("open");
    // Reset form so a stale paycheck doesn't reappear next open
    const form = $("#paycheckForm");
    if (form) {
      try { form.reset(); } catch (e) {}
      delete form.dataset.paystubMeta;
    }
    const status = $("#paystubStatus");
    if (status) { status.hidden = true; status.textContent = ""; }
    const paste = $("#paystubText");
    if (paste) paste.value = "";
    // Reset Net display label so totals don't carry over
    const netDisplay = $("#pcNetDisplay");
    if (netDisplay) netDisplay.textContent = "$0.00";
  }

  function initPaycheckSplits() {
    // Legacy — no-op, retained so paystub upload code that references it doesn't error.
    // The new simple form uses a single account dropdown instead of split rows.
  }

  function populatePaycheckAccountSelect() {
    const sel = $("#pcAccount");
    if (!sel) return;
    if (!state.accounts.length) {
      sel.innerHTML = '<option value="">(no accounts — add one in Balances)</option>';
      return;
    }
    // Prefer non-credit accounts (cash/checking/savings) for paycheck deposits
    const liquid = state.accounts.filter((a) => (a.type || "").toLowerCase() !== "credit" && !a.cardId);
    const accs = liquid.length ? liquid : state.accounts;
    sel.innerHTML = accs
      .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`)
      .join("");
  }

  // Simple totals: just compute net = gross − taxes − benefits − other and update the label.
  function updatePaycheckTotals() {
    const num = (id) => parseFloat($(id)?.value) || 0;
    const gross = num("#pcGross");
    const taxes = num("#pcTaxes");
    const benefits = num("#pcBenefits");
    const other = num("#pcOther");

    // If user has 0 or only gross (no buckets), don't compute — leave net as whatever was set
    const netEl = $("#pcNet");
    const allBucketsZero = taxes === 0 && benefits === 0 && other === 0;
    let net;
    if (allBucketsZero && netEl && parseFloat(netEl.value) > 0) {
      // Preserve parser-supplied net
      net = parseFloat(netEl.value);
    } else {
      net = Math.max(0, gross - taxes - benefits - other);
      if (netEl) netEl.value = net.toFixed(2);
    }
    const disp = $("#pcNetDisplay");
    if (disp) disp.textContent = fmt(net);
  }

  function updateSplitRemaining() {
    // Legacy — single-account flow doesn't use splits, so this is a no-op.
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
    const setStatus = (msg, cls) => {
      if (!status) return;
      status.hidden = false;
      status.className = cls || "paystub-status";
      status.textContent = msg;
    };
    setStatus("Reading paystub…");
    try {
      let text = "";
      if (file.type === "application/pdf") {
        if (!window.pdfjsLib) {
          setStatus("PDF library not loaded. Try image instead.", "paystub-status warn");
          return;
        }
        const buf = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          // Group items by their Y-coordinate (row), then sort by X (column) within
          // each row so multi-column layouts like ADP paystubs read correctly.
          const rows = new Map();
          const ROW_TOLERANCE = 3; // pixels — items within this Y-band are same row
          for (const it of content.items) {
            if (!it.str || !it.transform) continue;
            const x = it.transform[4];
            const y = Math.round(it.transform[5] / ROW_TOLERANCE) * ROW_TOLERANCE;
            if (!rows.has(y)) rows.set(y, []);
            rows.get(y).push({ x, str: it.str });
          }
          // Sort rows top-to-bottom (PDF y is bottom-up so descending), then left-to-right within
          const sortedRows = [...rows.entries()].sort((a, b) => b[0] - a[0]);
          for (const [, items] of sortedRows) {
            items.sort((a, b) => a.x - b.x);
            const rowText = items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
            if (rowText) text += rowText + "\n";
          }
        }
        // If PDF text is empty (image-only PDF), fall back to OCR by rendering each page
        if (text.replace(/\s+/g, "").length < 50) {
          setStatus("PDF has no text layer. Loading OCR…");
          text = await ocrPdf(buf, (progress, page, pages) => {
            setStatus(`OCR scanning page ${page}/${pages}… ${Math.round(progress * 100)}%`);
          });
        }
      } else if (file.type.startsWith("image/")) {
        setStatus("Loading OCR engine (one-time, ~10MB)…");
        text = await ocrImage(file, (progress) => {
          setStatus(`OCR scanning… ${Math.round(progress * 100)}%`);
        });
      } else {
        setStatus("Unsupported file type. Use PDF or image.", "paystub-status warn");
        return;
      }

      if (!text || text.replace(/\s+/g, "").length < 20) {
        setStatus("Couldn't extract any text. Try a clearer file or fill manually.", "paystub-status warn");
        return;
      }

      setStatus("Parsing paystub data…");
      const parsed = parsePaystub(text);
      applyPaystubToForm(parsed);

      const found = [];
      if (parsed.employer) found.push("employer");
      if (parsed.date) found.push("pay date");
      if (parsed.payPeriodStart || parsed.payPeriodEnd) found.push("period");
      if (parsed.gross !== null) found.push(`gross ${fmt(parsed.gross)}`);
      if (parsed.net !== null) found.push(`net ${fmt(parsed.net)}`);
      if (parsed.fedTax !== null) found.push("fed tax");
      if (parsed.stateTax !== null) found.push("state tax");
      if (parsed.ssTax !== null) found.push("SS");
      if (parsed.medicareTax !== null) found.push("Medicare");
      if (parsed.health || parsed.dental || parsed.vision) found.push("health/dental/vision");
      if (parsed.k401) found.push("401k");
      if (parsed.hsa) found.push("HSA");
      if (parsed.regularHours) found.push(`${parsed.regularHours}h regular`);
      if (parsed.ytdGross) found.push("YTD totals");
      if (parsed._taxesTotal && parsed.fedTax === null && parsed.stateTax === null) found.push(`taxes total ${fmt(parsed._taxesTotal)}`);
      if (parsed._benefitsTotal && !parsed.health && !parsed.dental && !parsed.vision) found.push(`benefits total ${fmt(parsed._benefitsTotal)}`);
      if (parsed._otherTotal) found.push(`other total ${fmt(parsed._otherTotal)}`);

      if (found.length === 0) {
        setStatus("Couldn't auto-detect fields. Fill them in manually.", "paystub-status warn");
      } else if (status) {
        status.className = "paystub-status success";
        status.innerHTML = `✓ Found: ${found.join(", ")}.<br><small>Review the values below before saving.</small>`;
      }
    } catch (e) {
      console.error("Paystub upload failed:", e);
      setStatus(`Failed: ${e.message || e.name || "unknown error"}. Try a different file or fill manually.`, "paystub-status warn");
    }
  }

  // Render each PDF page to a canvas and run Tesseract OCR on the result
  async function ocrPdf(arrayBuffer, progressCb) {
    if (!window.pdfjsLib) throw new Error("PDF library not loaded");
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let allText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      const text = await ocrImage(blob, (p) => {
        if (progressCb) progressCb(p, i, pdf.numPages);
      });
      allText += text + "\n";
    }
    return allText;
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

  // Receipt OCR helper — runs lightweight OCR on the receipt image and pre-fills
  // the expense amount and description if the user hasn't already filled them.
  let _ocrInFlight = false;
  async function maybeOcrReceiptAmount(file) {
    try {
      if (_ocrInFlight) return;
      if (!file || !file.type || !file.type.startsWith("image/")) return;
      // Don't auto-fill on edit flow — the user already has values they care about
      if (typeof editingTxnId !== "undefined" && editingTxnId) return;
      const amtInput = document.getElementById("expAmount");
      const descInput = document.getElementById("expDesc");
      // Don't run if user has already typed an amount
      if (amtInput && amtInput.value && parseFloat(amtInput.value) > 0) return;
      _ocrInFlight = true;
      const hint = document.getElementById("receiptPreview");
      if (hint) {
        const label = document.createElement("div");
        label.className = "card-sub";
        label.id = "receiptOcrLabel";
        label.style.marginTop = "0.4rem";
        label.textContent = "🔍 Reading receipt…";
        hint.appendChild(label);
      }
      const text = await ocrImage(file, (pct) => {
        const lbl = document.getElementById("receiptOcrLabel");
        if (lbl) lbl.textContent = `🔍 Reading receipt… ${Math.round(pct * 100)}%`;
      });
      const lbl = document.getElementById("receiptOcrLabel");
      if (lbl) lbl.remove();
      // If user closed the modal while OCR ran, don't try to fill inputs
      const modal = document.getElementById("expenseModal");
      if (!modal || !modal.classList.contains("open")) return;
      if (!text) {
        showToast("Couldn't read receipt — type the amount manually");
        return;
      }
      // Find an amount: prefer "Total"/"Amount" lines; fall back to last currency-formatted number
      const cleaned = text.replace(/[\u2212\u2013\u2014]/g, "-").replace(/\u00a0/g, " ");
      const lines = cleaned.split(/\r?\n/);
      let amount = null;
      // 1. Look for "TOTAL ... $X.XX" or "AMOUNT ... $X.XX" (case-insensitive)
      const totalRe = /\b(?:grand\s+)?total(?:\s+due)?\b[^0-9$]*\$?\s*(\d{1,3}(?:[,\d]{0,7})\.\d{2})/i;
      for (const line of lines) {
        const m = line.match(totalRe);
        if (m) { amount = parseFloat(m[1].replace(/,/g, "")); break; }
      }
      // 2. If still nothing, take the LAST currency-formatted amount (often the receipt total)
      if (amount == null) {
        const allAmounts = [...cleaned.matchAll(/\$?\s*(\d{1,3}(?:,\d{3})*\.\d{2})/g)]
          .map((m) => parseFloat(m[1].replace(/,/g, "")))
          .filter((n) => !isNaN(n) && n > 0);
        if (allAmounts.length) amount = allAmounts[allAmounts.length - 1];
      }
      // Look for a vendor/description: first non-empty line that's not a date or amount
      let vendor = null;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/^\d/.test(trimmed)) continue; // starts with digit — likely date or number
        if (/^[\d\s\W]+$/.test(trimmed)) continue;
        if (trimmed.length < 3 || trimmed.length > 40) continue;
        vendor = trimmed.replace(/\s+/g, " ");
        break;
      }
      let toastMsg = [];
      if (amount && amtInput && (!amtInput.value || parseFloat(amtInput.value) === 0)) {
        amtInput.value = amount.toFixed(2);
        toastMsg.push(`amount $${amount.toFixed(2)}`);
      }
      if (vendor && descInput && !descInput.value.trim()) {
        descInput.value = vendor;
        toastMsg.push(`vendor "${vendor}"`);
      }
      if (toastMsg.length) {
        showToast(`🧾 Filled ${toastMsg.join(" and ")}`);
      } else {
        showToast("Couldn't auto-fill — receipt text unclear");
      }
    } catch (err) {
      console.error("Receipt OCR failed:", err);
      const lbl = document.getElementById("receiptOcrLabel");
      if (lbl) lbl.remove();
    } finally {
      _ocrInFlight = false;
    }
  }

  function parsePaystub(rawText) {
    // Defensive: ensure we have a string to work with
    if (!rawText || typeof rawText !== "string") {
      return makeEmptyPaystubResult();
    }

    // Normalize: convert unicode minus, en/em dashes to ASCII; nbsp to space.
    let cleaned = String(rawText)
      .replace(/[\u2212\u2013\u2014]/g, "-")
      .replace(/\u00a0/g, " ");

    // OCR fixes: Tesseract often confuses S/$ when reading dollar amounts
    // "S3,086.95" or "S 3,086.95" → "$3,086.95"
    cleaned = cleaned.replace(/\bS(\s*\d{1,3}(?:,\d{3})*\.\d{2})/g, "$$$1");
    // Tesseract sometimes puts a stray period or comma at start: ".$3,086.95"
    cleaned = cleaned.replace(/[.,]\$/g, "$");

    // Insert spaces between glued letter↔digit boundaries
    cleaned = cleaned
      .replace(/([A-Za-z\)])(-?\$?\d)/g, "$1 $2")
      .replace(/(\d)([A-Za-z])/g, "$1 $2")
      .replace(/\$\s+/g, "$");

    // Insert newlines after each dollar amount so each label/amount pair gets its own line
    cleaned = cleaned.replace(/(-?\$\d{1,3}(?:,\d{3})*\.\d{2}\*?)/g, "$1\n");
    // Also after consecutive bare amounts
    cleaned = cleaned.replace(/(\d{1,3}(?:,\d{3})*\.\d{2}\*?)\s+(?=\d{1,3}(?:,\d{3})*\.\d{2})/g, "$1\n");

    const lines = cleaned.split(/\n|\r/).map((l) => l.trim()).filter(Boolean);
    const text = lines.join(" ");
    const result = makeEmptyPaystubResult();

    // --- Helpers
    function dollarAmts(s) {
      const m = String(s || "").match(/-?\$\s*\d{1,3}(?:,\d{3})*\.\d{2}\*?/g);
      if (!m) return [];
      return m.map((x) => Math.abs(Number(x.replace(/[\$,\s\*]/g, "")))).filter((n) => !isNaN(n));
    }
    function anyAmts(s) {
      const m = String(s || "").match(/-?\$?\s*\d{1,3}(?:,\d{3})*\.\d{2}\*?/g);
      if (!m) return [];
      return m.map((x) => Math.abs(Number(x.replace(/[\$,\s\*]/g, "")))).filter((n) => !isNaN(n));
    }

    // Find first amount on any line matching label, walking forward up to 2 lines for the value
    function find(labelRegex, opts = {}) {
      const { dollarOnly = true } = opts;
      const amtFn = dollarOnly ? dollarAmts : anyAmts;
      for (let i = 0; i < lines.length; i++) {
        if (!labelRegex.test(lines[i])) continue;
        let amts = amtFn(lines[i]);
        if (!amts.length && i + 1 < lines.length) amts = amtFn(lines[i + 1]);
        if (!amts.length && i + 2 < lines.length) amts = amtFn(lines[i + 2]);
        // Last resort: any amount on the matched line (for "Gross 173.33 Units $10,608.33")
        if (!amts.length) amts = anyAmts(lines[i]);
        if (amts.length) return { value: amts[0], ytd: amts[1] || null };
      }
      return { value: null, ytd: null };
    }

    // --- Pay date
    const longDate = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i);
    if (longDate) {
      const d = new Date(`${longDate[1]} ${longDate[2]}, ${longDate[3]}`);
      if (!isNaN(d)) result.date = localDateStr(d);
    }
    if (!result.date) {
      const slash = text.match(/Pay\s*Date\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)
        || text.match(/Check\s*Date\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      if (slash) result.date = normalizeDate(slash[1]);
    }
    const ppEnd = text.match(/Period\s*End(?:ing)?\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (ppEnd) result.payPeriodEnd = normalizeDate(ppEnd[1]);
    const ppStart = text.match(/Period\s*Beginning\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (ppStart) result.payPeriodStart = normalizeDate(ppStart[1]);
    if (!result.date && result.payPeriodEnd) result.date = result.payPeriodEnd;

    // --- Gross (prefer the line that has "Gross" but not "Income Tax" etc.)
    {
      const r = find(/^\s*Gross\b(?!\s*(?:Income|Wages\s+for))/i);
      result.gross = r.value;
      result.ytdGross = r.ytd;
    }

    // --- Net / Take Home (prefer "Take Home" since it's the simpler label)
    {
      const r = find(/(?:Show\s*content\s*|Hide\s*content\s*)?Take[\s\-]?Home\b/i);
      result.net = r.value;
      if (result.net === null) {
        const r2 = find(/Net\s*(?:Pay|Check)\b/i);
        result.net = r2.value;
        result.ytdNet = r2.ytd;
      }
    }

    // --- Section totals (collapsed view): "Taxes -$3,086.95", "Benefits -$138.00", "Other -$5,481.26"
    // Accept any decimal amount (not just $-prefixed) since OCR may drop the $.
    function findSectionTotal(headerRegex) {
      for (let i = 0; i < lines.length; i++) {
        if (!headerRegex.test(lines[i])) continue;
        let amts = dollarAmts(lines[i]);
        if (!amts.length) amts = anyAmts(lines[i]);
        if (!amts.length && i + 1 < lines.length) {
          amts = dollarAmts(lines[i + 1]);
          if (!amts.length) amts = anyAmts(lines[i + 1]);
        }
        if (amts.length) return amts[0];
      }
      return null;
    }
    result._taxesTotal = findSectionTotal(/(?:^|\s)(?:Show\s*content\s*|Hide\s*content\s*)?Taxes\b(?!.*Calculator)/i);
    result._benefitsTotal = findSectionTotal(/(?:^|\s)(?:Show\s*content\s*|Hide\s*content\s*)?Benefits\b(?!\s*and\s*Information)/i);
    result._otherTotal = findSectionTotal(/(?:^|\s)(?:Show\s*content\s*|Hide\s*content\s*)?Other\b(?!\s*Benefits\s*and\s*Information)/i);

    // --- Granular taxes (when expanded view is pasted)
    result.fedTax = find(/Federal\s*Income\s*Tax|\bFederal\s*W\/?H\b|\bFIT\b/i).value;
    result.stateTax = find(/State\s*Income\s*Tax|\bState\s*W\/?H\b|\bSIT\b/i).value;
    result.ssTax = find(/Social\s*Security\s*Tax|\bOASDI\b/i).value;
    result.medicareTax = find(/Medicare\s*Tax/i).value;
    if (result.ssTax || result.medicareTax) {
      result.fica = (result.ssTax || 0) + (result.medicareTax || 0);
    }

    // --- Granular benefits
    result.dental = find(/(?:Pre-?Tax\s*)?Dental(?:\s*Insurance)?/i).value;
    result.vision = find(/(?:Pre-?Tax\s*)?Vision(?:\s*Insurance)?/i).value;
    result.health = find(/(?:Pre-?Tax\s*)?(?:Medical|Health\s*Insurance|Health\s*Plan)/i).value;
    result.k401 = find(/\b401\s*\(?k\)?\b|\bRetirement\b|\bPension\b|\bTSP\b|\b403\s*\(?b\)?\b/i).value;
    result.hsa = find(/\bHSA\b|\bFSA\b|Health\s*Savings|Flex\s*Spend/i).value;

    // --- Hours
    const unitsM = text.match(/(\d{1,3}(?:\.\d{1,2})?)\s*Units?\b/i);
    if (unitsM) result.hours = Number(unitsM[1]);

    // Account last 4
    const acct = text.match(/x{4,}(\d{3,4})/i);
    if (acct) result.checkAccountLast4 = acct[1];

    return result;
  }

  function makeEmptyPaystubResult() {
    return {
      employer: null, date: null,
      gross: null, net: null,
      fedTax: null, stateTax: null, fica: null,
      ssTax: null, medicareTax: null,
      health: null, dental: null, vision: null,
      k401: null, hsa: null,
      ytdGross: null, ytdFedTax: null, ytdStateTax: null,
      ytdSs: null, ytdMedicare: null, ytdNet: null,
      regularHours: null, regularRate: null,
      otHours: null, holidayHours: null, ptoHours: null,
      hours: null, payPeriodStart: null, payPeriodEnd: null,
      checkAccountLast4: null, otherDeductions: [], earnings: [],
    };
  }

  function normalizeDate(d) {
    // d like "12/31/2024" or "12/31/24"
    if (!d || typeof d !== "string") return null;
    const parts = d.split("/");
    if (parts.length !== 3) return null;
    let [mm, dd, yy] = parts;
    if (!mm || !dd || !yy) return null;
    if (yy.length === 2) yy = "20" + yy;
    if (mm.length === 1) mm = "0" + mm;
    if (dd.length === 1) dd = "0" + dd;
    // Validate component ranges
    const mNum = Number(mm), dNum = Number(dd), yNum = Number(yy);
    if (isNaN(mNum) || mNum < 1 || mNum > 12) return null;
    if (isNaN(dNum) || dNum < 1 || dNum > 31) return null;
    if (isNaN(yNum) || yNum < 1900 || yNum > 2200) return null;
    const result = `${yy}-${mm}-${dd}`;
    // Sanity: must be parseable
    if (isNaN(new Date(result).getTime())) return null;
    return result;
  }

  function applyPaystubToForm(p) {
    const setVal = (sel, val) => { const el = $(sel); if (el) el.value = val; };
    if (p.employer) setVal("#pcEmployer", p.employer);
    if (p.date) setVal("#pcDate", p.date);
    if (p.gross !== null && p.gross !== undefined) setVal("#pcGross", p.gross.toFixed(2));

    // SIMPLIFIED: collapse parsed details into the 3 buckets the form actually shows
    let taxesItemized = (p.fedTax || 0) + (p.stateTax || 0) + (p.ssTax || 0) + (p.medicareTax || 0);
    if (taxesItemized < 0.01 && p.fica) taxesItemized = p.fica;
    const taxesTotal = taxesItemized > 0 ? taxesItemized : (p._taxesTotal || 0);
    if (taxesTotal > 0) setVal("#pcTaxes", taxesTotal.toFixed(2));

    const benefitsItemized = (p.health || 0) + (p.dental || 0) + (p.vision || 0)
      + (p.k401 || 0) + (p.hsa || 0);
    const benefitsTotal = benefitsItemized > 0 ? benefitsItemized : (p._benefitsTotal || 0);
    if (benefitsTotal > 0) setVal("#pcBenefits", benefitsTotal.toFixed(2));

    if (p._otherTotal && p._otherTotal > 0) {
      setVal("#pcOther", p._otherTotal.toFixed(2));
    }

    // Stash all parsed metadata onto the form for the eventual save record
    const form = $("#paycheckForm");
    if (form) {
      form.dataset.paystubMeta = JSON.stringify({
        ssTax: p.ssTax,
        medicareTax: p.medicareTax,
        dental: p.dental,
        vision: p.vision,
        regularRate: p.regularRate,
        regularHours: p.regularHours,
        otHours: p.otHours,
        holidayHours: p.holidayHours,
        ptoHours: p.ptoHours,
        hours: p.hours,
        ytdGross: p.ytdGross,
        ytdNet: p.ytdNet,
        ytdFedTax: p.ytdFedTax,
        ytdStateTax: p.ytdStateTax,
        ytdSs: p.ytdSs,
        ytdMedicare: p.ytdMedicare,
        payPeriodStart: p.payPeriodStart,
        payPeriodEnd: p.payPeriodEnd,
        checkAccountLast4: p.checkAccountLast4,
        earnings: p.earnings,
        // Granular tax / benefit breakouts
        fedTax: p.fedTax,
        stateTax: p.stateTax,
        health: p.health,
        k401: p.k401,
        hsa: p.hsa,
      });
    }

    // Recompute net display
    updatePaycheckTotals();

    // If parser supplied both a gross AND a net but our buckets don't add up,
    // it's because the parser didn't find Taxes/Benefits/Other. Don't silently
    // dump the difference into "Other" — leave the net as the override and let
    // the user fill in the buckets manually if they care.
    if (p.net !== null && p.gross !== null) {
      const netEl = $("#pcNet");
      if (netEl) netEl.value = p.net.toFixed(2);
      const dispEl = $("#pcNetDisplay");
      if (dispEl) dispEl.textContent = fmt(p.net);
    }
  }

  function savePaycheck() {
    // Make sure live totals are current
    updatePaycheckTotals();

    const employer = $("#pcEmployer").value.trim();
    const date = $("#pcDate").value;
    const gross = parseFloat($("#pcGross").value);
    const net = parseFloat($("#pcNet").value);
    if (!employer || !date || isNaN(gross) || isNaN(net)) {
      showToast("Fill in employer, date, and gross pay");
      return false;
    }

    // Simple bucket totals from the form
    const taxesTotal = parseFloat($("#pcTaxes").value) || 0;
    const benefitsTotal = parseFloat($("#pcBenefits").value) || 0;
    const otherTotal = parseFloat($("#pcOther").value) || 0;

    // Backwards-compat fields (kept on the saved record)
    const fedTax = parseFloat($("#pcFedTax").value) || 0;
    const stateTax = parseFloat($("#pcStateTax").value) || 0;
    const fica = parseFloat($("#pcFica").value) || 0;
    const health = parseFloat($("#pcHealth").value) || 0;
    const k401 = parseFloat($("#pc401k").value) || 0;
    const hsa = parseFloat($("#pcHsa").value) || 0;

    // Granular breakouts (mostly from paystub metadata stash)
    const ssTaxField = parseFloat($("#pcSsTax")?.value) || 0;
    const medicareTaxField = parseFloat($("#pcMedicareTax")?.value) || 0;
    const medical = parseFloat($("#pcMedical")?.value) || 0;
    const dental = parseFloat($("#pcDental")?.value) || 0;
    const vision = parseFloat($("#pcVision")?.value) || 0;
    const otherBenefits = parseFloat($("#pcOtherBenefits")?.value) || 0;
    const accidentIns = parseFloat($("#pcAccidentIns")?.value) || 0;
    const otherDed = parseFloat($("#pcOtherDed")?.value) || 0;
    const hours = parseFloat($("#pcHours")?.value) || 0;

    // Single deposit account from the dropdown
    const depositAccountId = $("#pcAccount")?.value || null;
    if (!depositAccountId) {
      const proceed = confirm("No deposit account selected. Save without depositing the net to an account?");
      if (!proceed) return false;
    }

    const paycheckId = uid();

    // Read any uploaded paystub metadata stashed on the form
    let stub = {};
    try {
      const raw = $("#paycheckForm")?.dataset?.paystubMeta;
      if (raw) stub = JSON.parse(raw) || {};
    } catch (e) { /* ignore */ }

    // Create ONE income transaction for the NET pay deposited to the chosen account.
    // Gross / taxes / benefits / other are stored on the record (paycheckMeta) for reporting,
    // but they DO NOT create expense transactions — your "spent" totals stay clean.
    state.expenses.push(touchRecord({
      id: uid(),
      type: "income",
      desc: `Paycheck — ${employer}`,
      amount: net,
      date,
      categoryId: null,
      accountId: depositAccountId || null,
      personId: null,
      tags: ["paycheck"],
      receipt: null,
      incomeType: "salary",
      source: employer,
      preTax: false, // amount is the net, no longer pre-tax
      paycheckId,
      paycheckMeta: {
        gross, net,
        taxesTotal, benefitsTotal, otherTotal,
        // Detailed breakouts (from form or paystub paste, if present)
        fedTax, stateTax, fica, health, k401, hsa,
        ssTax: ssTaxField || (stub.ssTax ?? null),
        medicareTax: medicareTaxField || (stub.medicareTax ?? null),
        medical: medical || null,
        dental: dental || (stub.dental ?? null),
        vision: vision || (stub.vision ?? null),
        otherBenefits: otherBenefits || null,
        accidentIns: accidentIns || null,
        otherDed: otherDed || null,
        hours: hours || (stub.hours ?? null),
        regularRate: stub.regularRate ?? null,
        regularHours: stub.regularHours ?? null,
        otHours: stub.otHours ?? null,
        holidayHours: stub.holidayHours ?? null,
        ptoHours: stub.ptoHours ?? null,
        ytdGross: stub.ytdGross ?? null,
        ytdNet: stub.ytdNet ?? null,
        ytdFedTax: stub.ytdFedTax ?? null,
        ytdStateTax: stub.ytdStateTax ?? null,
        ytdSs: stub.ytdSs ?? null,
        ytdMedicare: stub.ytdMedicare ?? null,
        payPeriodStart: stub.payPeriodStart ?? null,
        payPeriodEnd: stub.payPeriodEnd ?? null,
        checkAccountLast4: stub.checkAccountLast4 ?? null,
        earnings: stub.earnings ?? null,
      },
    }));

    // Create deduction expenses — three high-level buckets matching the form
    // REMOVED: deductions are no longer recorded as separate expense transactions.
    // They are stored in paycheckMeta on the income record above for reporting only.
    // This keeps your "spent" totals clean — only what you actually spent counts.

    // Single transfer-in for the net pay to the chosen account
    // REMOVED: the income transaction itself is already attributed to the deposit account
    // (accountId set on the income above), so no separate transfer is needed.

    // Auto-add employer to saved income sources if not already there
    if (employer && !state.incomeSources.some((s) => (s.name || "").toLowerCase() === employer.toLowerCase())) {
      state.incomeSources.push(touchRecord({
        id: uid(),
        name: employer,
        type: "salary",
        defaultAmount: gross,
        note: "Auto-added from paycheck",
      }));
    }

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
    // Manually saved sources (from Settings)
    (state.incomeSources || []).forEach((s) => {
      if (s && s.name) sources.add(s.name);
    });
    // Auto-detected from past income transactions
    state.expenses
      .filter((e) => e.type === "income" && e.source)
      .forEach((e) => sources.add(e.source));
    list.innerHTML = [...sources]
      .map((s) => `<option value="${escapeHtml(s)}"></option>`)
      .join("");
  }

  // Track which preset groups are collapsed (collapsed by default for less clutter,
  // except Favorites which expands by default).
  const collapsedPresetGroups = new Set(["daily", "subscription", "custom"]);

  function renderPresets() {
    const list = $("#presetsList");
    const items = state.presets.filter((p) => p.type === currentModalType);
    if (!items.length) {
      list.innerHTML = '<span class="empty-chip">No presets for this type. Use "Save as preset" below.</span>';
      return;
    }

    // Group: favorites first, then by group key
    const groupOrder = currentModalType === "income"
      ? [["income", "💼 Income"]]
      : [["favorite", "⭐ Favorites"], ["daily", "☕ Daily"], ["subscription", "📺 Subscriptions"], ["custom", "🏷️ Custom"]];

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
      const collapsed = collapsedPresetGroups.has(key);
      const arrow = collapsed ? "▸" : "▾";
      html += `
        <div class="preset-group ${collapsed ? "collapsed" : ""}" data-group="${key}">
          <button type="button" class="preset-group-header" data-toggle-group="${key}">
            <span class="preset-group-arrow">${arrow}</span>
            <span class="preset-group-title">${label}</span>
            <span class="preset-group-count">${arr.length}</span>
          </button>
          <div class="preset-row">`;
      arr.forEach((p) => {
        const amt = Number(p.amount) > 0 ? `<span class="preset-amt">${fmt(p.amount)}</span>` : "";
        html += `
          <button type="button" class="preset-card" data-preset="${p.id}">
            <span class="preset-icon">${p.icon || "💸"}</span>
            <span class="preset-name">${escapeHtml(p.desc)}</span>
            ${amt}
          </button>`;
      });
      html += `</div></div>`;
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
      if (!m || isNaN(amount)) {
        showToast("Pick a month and enter an amount");
        return;
      }
      // Validate YYYY-MM format and that the month is sensible (not year 1900 or 9999)
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
        showToast("Month must be in YYYY-MM format");
        return;
      }
      const yr = Number(m.slice(0, 4));
      if (yr < 1970 || yr > 2200) {
        showToast("Pick a sensible year");
        return;
      }
      if (amount < 0) {
        showToast("Income can't be negative");
        return;
      }
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
      if (!name || isNaN(limit)) {
        showToast("Add a name and a numeric limit");
        return;
      }
      // Prevent duplicates (case-insensitive)
      const dup = state.categories.find((c) => (c.name || "").toLowerCase() === name.toLowerCase());
      if (dup) {
        showToast(`"${dup.name}" already exists`);
        return;
      }
      state.categories.push(touchRecord({ id: uid(), name, limit }));
      saveData();
      $("#catName").value = "";
      $("#catLimit").value = "";
      renderAll();
      showToast("Category added");
    });

    // Merge duplicate accounts by name
    $("#mergeDupAccountsBtn")?.addEventListener("click", () => {
      const groups = new Map();
      state.accounts.forEach((a) => {
        const key = (a.name || "").trim().toLowerCase();
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
      });

      const idRemap = new Map();
      const losersToTombstone = [];
      groups.forEach((arr) => {
        if (arr.length < 2) return;
        const sorted = arr.slice().sort((a, b) => recordTimestamp(a) - recordTimestamp(b));
        const winner = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          idRemap.set(sorted[i].id, winner.id);
          losersToTombstone.push(sorted[i].id);
        }
      });

      if (idRemap.size === 0) {
        showToast("No duplicate accounts found");
        return;
      }

      const dupCount = idRemap.size;
      if (!confirm(`Merge ${dupCount} duplicate account${dupCount === 1 ? "" : "s"}? Transactions will be re-pointed to the surviving account.`)) {
        return;
      }

      const remap = (rec, key) => {
        if (rec[key] && idRemap.has(rec[key])) {
          rec[key] = idRemap.get(rec[key]);
          touchRecord(rec);
        }
      };
      state.expenses.forEach((e) => remap(e, "accountId"));

      losersToTombstone.forEach((id) => tombstoneRecord("accounts", id));
      const loserSet = new Set(losersToTombstone);
      state.accounts = state.accounts.filter((a) => !loserSet.has(a.id));

      saveData();
      renderAll();
      showToast(`Merged ${dupCount} duplicate${dupCount === 1 ? "" : "s"}`);
    });

    // Restore default categories
    $("#restoreCategoriesBtn")?.addEventListener("click", () => {
      const defaults = [
        { name: "Groceries", limit: 400 },
        { name: "Rent", limit: 1500 },
        { name: "Utilities", limit: 200 },
        { name: "Transport", limit: 150 },
        { name: "Eating Out", limit: 200 },
        { name: "Subscriptions", limit: 100 },
        { name: "Healthcare", limit: 150 },
        { name: "Entertainment", limit: 100 },
        { name: "Shopping", limit: 200 },
        { name: "Personal Care", limit: 75 },
        { name: "Family", limit: 0 },
        { name: "Credit Payment", limit: 0 },
        { name: "Other", limit: 200 },
      ];
      const existingNames = new Set(state.categories.map((c) => c.name.toLowerCase()));
      let added = 0;
      defaults.forEach((d) => {
        if (existingNames.has(d.name.toLowerCase())) return;
        state.categories.push(touchRecord({ id: uid(), name: d.name, limit: d.limit }));
        added += 1;
      });
      saveData();
      renderAll();
      showToast(added > 0 ? `Added ${added} default categor${added === 1 ? "y" : "ies"}` : "All defaults already present");
    });

    // Merge duplicate categories by name (keeps oldest, repoints all references)
    $("#mergeDupCategoriesBtn")?.addEventListener("click", () => {
      // Group by lowercased name
      const groups = new Map();
      state.categories.forEach((c) => {
        const key = (c.name || "").trim().toLowerCase();
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      });

      // For each group with >1 entry, pick a winner (oldest createdAt-equivalent
      // = smallest id base36 prefix) and remap everything to its id.
      const idRemap = new Map(); // oldId -> winnerId
      const losersToTombstone = [];
      groups.forEach((arr) => {
        if (arr.length < 2) return;
        // Sort by record timestamp ascending (oldest first)
        const sorted = arr.slice().sort((a, b) => recordTimestamp(a) - recordTimestamp(b));
        const winner = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          idRemap.set(sorted[i].id, winner.id);
          losersToTombstone.push(sorted[i].id);
        }
      });

      if (idRemap.size === 0) {
        showToast("No duplicate categories found");
        return;
      }

      const dupCount = idRemap.size;
      if (!confirm(`Merge ${dupCount} duplicate categor${dupCount === 1 ? "y" : "ies"}? Transactions, presets, and recurring rules will be re-pointed to the surviving category.`)) {
        return;
      }

      // Remap all references
      const remap = (rec, key) => {
        if (rec[key] && idRemap.has(rec[key])) {
          rec[key] = idRemap.get(rec[key]);
          touchRecord(rec);
        }
      };
      state.expenses.forEach((e) => remap(e, "categoryId"));
      state.recurring.forEach((r) => remap(r, "categoryId"));
      state.presets.forEach((p) => remap(p, "categoryId"));

      // Tombstone the losers and remove from state.categories
      losersToTombstone.forEach((id) => tombstoneRecord("categories", id));
      const loserSet = new Set(losersToTombstone);
      state.categories = state.categories.filter((c) => !loserSet.has(c.id));

      saveData();
      renderAll();
      showToast(`Merged ${dupCount} duplicate${dupCount === 1 ? "" : "s"}`);
    });

    // Restore default accounts
    $("#restoreAccountsBtn")?.addEventListener("click", () => {
      const defaults = [
        { name: "Cash", type: "cash", color: "#22c55e" },
        { name: "Checking", type: "checking", color: "#3b82f6" },
        { name: "Credit Card", type: "credit", color: "#ec4899" },
        { name: "Savings", type: "savings", color: "#f59e0b" },
      ];
      const existingNames = new Set(state.accounts.map((a) => a.name.toLowerCase()));
      let added = 0;
      defaults.forEach((d) => {
        if (existingNames.has(d.name.toLowerCase())) return;
        state.accounts.push(touchRecord({ id: uid(), name: d.name, type: d.type, balance: 0, color: d.color }));
        added += 1;
      });
      saveData();
      renderAll();
      showToast(added > 0 ? `Added ${added} default account${added === 1 ? "" : "s"}` : "All defaults already present");
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
          // Try OCR auto-fill if amount is empty
          maybeOcrReceiptAmount(file);
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
      const eventId = $("#expEvent")?.value || "";
      const eventLineItemId = $("#expenseForm")?.dataset?.eventLineItemId || null;
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

      if (!desc || isNaN(amount) || !date) {
        showToast("Fill description, amount, and date");
        return;
      }
      if (type === "expense" && !categoryId) {
        showToast("Pick a category");
        return;
      }

      // If a person is tagged on an expense and no category is set (or "Other" was picked),
      // auto-route to the Family category. Lets the family money flow stay separate from
      // generic spending in charts / budgets.
      let finalCategoryId = categoryId || null;
      if (type === "expense" && personId) {
        const familyCat = state.categories.find((c) => /^family$/i.test(c.name));
        if (familyCat) {
          const currentCat = state.categories.find((c) => c.id === finalCategoryId);
          // Only override if no category was set, or current is "Other"
          if (!finalCategoryId || (currentCat && /^other$/i.test(currentCat.name))) {
            finalCategoryId = familyCat.id;
          }
        }
      }

      if (editId) {
        const idx = state.expenses.findIndex((x) => x.id === editId);
        if (idx >= 0) {
          state.expenses[idx] = touchRecord({
            ...state.expenses[idx],
            type, desc, amount, date,
            categoryId: finalCategoryId,
            accountId: accountId || null,
            personId: personId || null,
            goalId: goalId || null,
            eventId: eventId || null,
            eventLineItemId: eventLineItemId || null,
            tags,
            receipt,
            incomeType,
            source,
            preTax,
          });
        }
      } else {
        state.expenses.push(touchRecord({
          id: uid(), type, desc, amount, date,
          categoryId: finalCategoryId,
          accountId: accountId || null,
          personId: personId || null,
          goalId: goalId || null,
          eventId: eventId || null,
          eventLineItemId: eventLineItemId || null,
          tags,
          receipt,
          incomeType,
          source,
          preTax,
        }));

        // Goal contribution: txn already gets counted via goalSavedTotal(),
        // so we don't increment goal.saved here (avoids double-count and keeps
        // the display in sync after edits/deletes).

        // Round-up savings — record as a separate transaction tagged to the goal,
        // so it survives sync, edits, and recomputation.
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
              state.expenses.push(touchRecord({
                id: uid(),
                type: "expense",
                desc: `Round-up → ${g.name}`,
                amount: roundUp,
                date,
                categoryId: null,
                accountId: null,
                personId: null,
                goalId: g.id,
                tags: ["round-up"],
                receipt: null,
              }));
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
      // Group toggle (collapse/expand)
      const toggle = e.target.closest("[data-toggle-group]");
      if (toggle) {
        const key = toggle.dataset.toggleGroup;
        if (collapsedPresetGroups.has(key)) collapsedPresetGroups.delete(key);
        else collapsedPresetGroups.add(key);
        renderPresets();
        return;
      }
      // Apply preset
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
      state.presets.push(touchRecord({
        id: uid(),
        type: currentModalType,
        desc,
        amount: isNaN(amount) ? 0 : amount,
        categoryId,
        group,
        icon,
        favorite: false,
      }));
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
          state.presets.push(touchRecord(d));
          existingKeys.add(key);
          added += 1;
        }
      });
      saveData();
      renderPresetsManage();
      renderPresets();
      showToast(added > 0 ? `Added ${added} default preset${added === 1 ? "" : "s"}` : "All defaults already present");
    });

    // Re-link presets to categories (manual fix for the "—" category issue).
    // Also auto-creates any missing default categories so the link can succeed.
    $("#relinkPresetsBtn")?.addEventListener("click", () => {
      const categoryDefaults = [
        { name: "Groceries", limit: 400 },
        { name: "Rent", limit: 1500 },
        { name: "Utilities", limit: 200 },
        { name: "Transport", limit: 150 },
        { name: "Eating Out", limit: 200 },
        { name: "Subscriptions", limit: 100 },
        { name: "Healthcare", limit: 150 },
        { name: "Entertainment", limit: 100 },
        { name: "Shopping", limit: 200 },
        { name: "Personal Care", limit: 75 },
        { name: "Other", limit: 200 },
      ];
      const wantedNames = new Set(Object.values(PRESET_CATEGORY_MAP));
      const existingNames = new Set(state.categories.map((c) => c.name.toLowerCase()));
      let addedCats = 0;
      categoryDefaults.forEach((d) => {
        if (!wantedNames.has(d.name)) return;
        if (existingNames.has(d.name.toLowerCase())) return;
        state.categories.push(touchRecord({ id: uid(), name: d.name, limit: d.limit }));
        existingNames.add(d.name.toLowerCase());
        addedCats += 1;
      });

      const updated = relinkPresetsToCategories();
      saveData();
      renderAll();

      const parts = [];
      if (addedCats > 0) parts.push(`+${addedCats} categor${addedCats === 1 ? "y" : "ies"}`);
      if (updated > 0) parts.push(`${updated} preset${updated === 1 ? "" : "s"} re-linked`);
      showToast(parts.length ? parts.join(" · ") : "Already linked");
    });

    // Delete all presets
    $("#deleteAllPresetsBtn")?.addEventListener("click", () => {
      if (!state.presets.length) {
        showToast("No presets to delete.");
        return;
      }
      if (!confirm(`Delete all ${state.presets.length} presets? You can restore the default library afterwards.`)) return;
      // Tombstone each so deletion propagates across devices
      state.presets.forEach((p) => tombstoneRecord("presets", p.id));
      state.presets = [];
      saveData();
      // Re-render everything (not just the preset views) so the Add Transaction
      // modal and other UI stay consistent. Some users reported dropdowns going
      // empty after this action; full renderAll keeps every control fresh.
      renderAll();
      showToast("All presets deleted");
    });

    // Remove duplicate presets — same desc + amount + group
    $("#dedupePresetsBtn")?.addEventListener("click", () => {
      if (!state.presets.length) {
        showToast("No presets to dedupe.");
        return;
      }
      const groups = new Map();
      state.presets.forEach((p) => {
        const key = `${p.type || "expense"}|${(p.desc || "").trim().toLowerCase()}|${Number(p.amount) || 0}|${p.group || "custom"}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      });
      const losers = [];
      const winners = [];
      groups.forEach((arr) => {
        if (arr.length <= 1) { winners.push(arr[0]); return; }
        const sorted = arr.slice().sort((a, b) => recordTimestamp(a) - recordTimestamp(b));
        const keeper = sorted[0];
        if (sorted.some((p) => p.favorite)) keeper.favorite = true;
        winners.push(keeper);
        sorted.slice(1).forEach((p) => losers.push(p));
      });
      if (losers.length === 0) {
        showToast("No duplicates found");
        return;
      }
      if (!confirm(`Remove ${losers.length} duplicate preset${losers.length === 1 ? "" : "s"}? The original copy of each will stay.`)) return;
      losers.forEach((p) => tombstoneRecord("presets", p.id));
      state.presets = winners;
      saveData();
      renderAll();
      showToast(`Removed ${losers.length} duplicate${losers.length === 1 ? "" : "s"}`);
    });

    // Show/hide the full preset list (defaults to hidden — keeps Settings tidy)
    const presetsListToggle = $("#presetsListToggle");
    const presetsManageList = $("#presetsManageList");
    if (presetsListToggle && presetsManageList) {
      // Restore last preference (default hidden)
      const stored = localStorage.getItem("mb_presets_list_visible");
      const startVisible = stored === "true";
      presetsManageList.hidden = !startVisible;
      presetsListToggle.setAttribute("aria-expanded", String(startVisible));
      presetsListToggle.textContent = startVisible
        ? `▾ Hide preset list (${state.presets.length})`
        : `▸ Show preset list (${state.presets.length})`;
      presetsListToggle.addEventListener("click", () => {
        const isVisible = !presetsManageList.hidden;
        const next = !isVisible;
        presetsManageList.hidden = !next;
        presetsListToggle.setAttribute("aria-expanded", String(next));
        presetsListToggle.textContent = next
          ? `▾ Hide preset list (${state.presets.length})`
          : `▸ Show preset list (${state.presets.length})`;
        try { localStorage.setItem("mb_presets_list_visible", next ? "true" : "false"); } catch (_) {}
      });
    }

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

    // Tax-friendly CSV export — full year, with totals per category, suitable
    // for handing to an accountant or pasting into a spreadsheet.
    $("#exportTaxCsvBtn")?.addEventListener("click", exportTaxCsv);

    // FAB and modal close
    $("#fab").addEventListener("click", () => {
      // If menu is open, close it; otherwise open expense modal directly
      const menu = $("#fabMenu");
      if (!menu.hidden) {
        menu.hidden = true;
        return;
      }
      openExpenseModal();
    });

    // Long-press FAB to open menu
    let fabPressTimer;
    const fab = $("#fab");
    const startPress = (e) => {
      fabPressTimer = setTimeout(() => {
        $("#fabMenu").hidden = false;
        if (navigator.vibrate) navigator.vibrate(10);
      }, 500);
    };
    const cancelPress = () => clearTimeout(fabPressTimer);
    fab.addEventListener("mousedown", startPress);
    fab.addEventListener("touchstart", startPress, { passive: true });
    fab.addEventListener("mouseup", cancelPress);
    fab.addEventListener("mouseleave", cancelPress);
    fab.addEventListener("touchend", cancelPress);

    // FAB menu actions
    $$(".fab-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.fabAction;
        $("#fabMenu").hidden = true;
        if (action === "expense") openExpenseModal();
        else if (action === "income") openExpenseModal({ type: "income" });
        else if (action === "transfer") openTransferModal();
        else if (action === "paycheck") openPaycheckModal();
      });
    });
    // Close menu on outside click
    document.addEventListener("click", (e) => {
      const menu = $("#fabMenu");
      if (!menu || menu.hidden) return;
      if (e.target.closest(".fab-stack")) return;
      menu.hidden = true;
    });
    $("#helpBtn")?.addEventListener("click", showShortcutsHelp);
    $("#replayTourBtn")?.addEventListener("click", () => {
      localStorage.removeItem(TOUR_KEY);
      startTour();
    });
    $("#showShortcutsBtn")?.addEventListener("click", showShortcutsHelp);

    // Print monthly report
    $("#printReportBtn")?.addEventListener("click", openPrintReport);

    // Sync settings
    const syncTokenInput = $("#syncToken");
    const syncGistIdInput = $("#syncGistId");
    if (syncTokenInput) {
      const stored = localStorage.getItem(KEYS.syncToken) || "";
      syncTokenInput.value = stored ? stored.slice(0, 4) + "•••••••••••" + stored.slice(-4) : "";
      syncTokenInput.addEventListener("focus", () => {
        if (syncTokenInput.dataset.unlocked !== "true") {
          syncTokenInput.value = stored;
          syncTokenInput.dataset.unlocked = "true";
        }
      });
    }
    if (syncGistIdInput) {
      syncGistIdInput.value = localStorage.getItem(KEYS.syncGistId) || "";
    }
    const deviceLabelInput = $("#deviceLabelInput");
    if (deviceLabelInput) {
      deviceLabelInput.value = localStorage.getItem("mb_device_label") || getDeviceLabel();
      deviceLabelInput.addEventListener("change", (e) => {
        const label = e.target.value.trim();
        if (label) {
          localStorage.setItem("mb_device_label", label);
          showToast("Device name saved");
        } else {
          // User cleared the field — reset to auto-detected default rather than a stuck old value
          localStorage.removeItem("mb_device_label");
          deviceLabelInput.value = getDeviceLabel();
          showToast("Device name reset to default");
        }
      });
    }
    $("#syncSaveBtn")?.addEventListener("click", () => {
      const token = $("#syncToken").value.trim();
      const gistId = $("#syncGistId").value.trim();
      if (token && !token.includes("•")) {
        localStorage.setItem(KEYS.syncToken, token);
      }
      if (gistId) {
        localStorage.setItem(KEYS.syncGistId, gistId);
      } else {
        localStorage.removeItem(KEYS.syncGistId);
      }
      // Default auto-sync ON the first time sync is configured. Without this,
      // changes only push when the user manually taps "Sync Now".
      if (localStorage.getItem(KEYS.syncToken) && localStorage.getItem("mb_auto_sync") === null) {
        localStorage.setItem("mb_auto_sync", "true");
        const t = $("#autoSyncToggle");
        if (t) t.checked = true;
        startAutoSync();
      }
      showSyncStatus("Settings saved. Auto-sync is on.", "success");
      // Refresh offline banner state since sync config changed
      try { updateNetStatus(); } catch (e) {}
    });
    $("#syncPushBtn")?.addEventListener("click", syncPush);
    $("#syncPullBtn")?.addEventListener("click", syncPull);

    // Sync diagnostic — runs a full cycle of checks and renders results into a
    // structured modal that's readable on mobile (instead of a giant alert popup).
    async function runSyncDiagnostic() {
      const body = $("#syncDiagBody");
      if (!body) return;
      body.innerHTML = '<p class="empty">Running checks…</p>';

      const sections = [];
      const sectionRow = (key, val, tone) => {
        const cls = tone ? ` ${tone}` : "";
        return `<div class="diag-row"><span class="diag-key">${escapeHtml(key)}</span><span class="diag-val${cls}">${escapeHtml(String(val))}</span></div>`;
      };

      // 1. Device & config snapshot
      const token = localStorage.getItem(KEYS.syncToken);
      const gistId = localStorage.getItem(KEYS.syncGistId);
      const autoSync = localStorage.getItem("mb_auto_sync") === "true";
      sections.push({
        title: "Device & Config",
        rows: [
          sectionRow("Device", getDeviceLabel()),
          sectionRow("Auto-sync", autoSync ? "ON" : "OFF", autoSync ? "ok" : "warn"),
          sectionRow("Token", token ? "Set" : "Missing", token ? "ok" : "bad"),
          sectionRow("Gist ID", gistId || "Missing", gistId ? "ok" : "bad"),
          sectionRow("Online", navigator.onLine ? "Yes" : "No", navigator.onLine ? "ok" : "bad"),
          sectionRow("Crypto key", cryptoKey ? "Ready" : "Missing", cryptoKey ? "ok" : "bad"),
        ],
      });

      // 2. Local data snapshot
      sections.push({
        title: "Local Data",
        rows: [
          sectionRow("Categories", state.categories.length),
          sectionRow("Accounts", state.accounts.length),
          sectionRow("Expenses", state.expenses.length),
          sectionRow("Recurring", state.recurring.length),
          sectionRow("Goals", state.goals.length),
          sectionRow("Cards", state.cards.length),
          sectionRow("Last synced", lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "Never"),
        ],
      });

      // 3. Cloud check (if configured)
      const cloudRows = [];
      if (token && gistId) {
        try {
          const r = await fetch(`https://api.github.com/gists/${gistId}`, {
            headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
          });
          cloudRows.push(sectionRow("HTTP status", r.status, r.ok ? "ok" : "bad"));
          if (r.ok) {
            const d = await r.json();
            cloudRows.push(sectionRow("Updated at", d.updated_at ? new Date(d.updated_at).toLocaleString() : "?"));
            const f = d.files && d.files[SYNC_FILENAME];
            cloudRows.push(sectionRow("Data file", f ? `${(f.size / 1024).toFixed(1)} KB` : "Missing", f ? "ok" : "bad"));
            if (f) {
              try {
                const p = JSON.parse(f.content);
                cloudRows.push(sectionRow("Last device", p.device || "unknown"));
                cloudRows.push(sectionRow("Last push", p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "?"));
              } catch (e) {
                cloudRows.push(sectionRow("Parse error", e.message, "bad"));
              }
            }
          } else {
            const txt = await r.text();
            cloudRows.push(sectionRow("Error", txt.slice(0, 100), "bad"));
          }
        } catch (e) {
          cloudRows.push(sectionRow("Network error", e.message, "bad"));
        }
      } else {
        cloudRows.push(sectionRow("Status", "Not configured", "warn"));
      }
      sections.push({ title: "Cloud", rows: cloudRows });

      // 4. Run a forced push and pull
      const actionRows = [];
      if (token && gistId && cryptoKey) {
        try {
          await syncPush({ silent: true, force: true });
          actionRows.push(sectionRow("Push", "Completed", "ok"));
        } catch (e) {
          actionRows.push(sectionRow("Push failed", e.message, "bad"));
        }
        try {
          await syncPull({ skipConfirm: true, silent: true });
          actionRows.push(sectionRow("Pull", "Completed", "ok"));
        } catch (e) {
          actionRows.push(sectionRow("Pull failed", e.message, "bad"));
        }
      } else {
        actionRows.push(sectionRow("Skipped", "Sync not fully configured", "warn"));
      }
      sections.push({ title: "Forced Sync", rows: actionRows });

      // Render
      body.innerHTML = sections.map((s) => `
        <div class="diag-section">
          <div class="diag-section-title">${escapeHtml(s.title)}</div>
          ${s.rows.join("")}
        </div>
      `).join("");
    }

    $("#syncDiagBtn")?.addEventListener("click", () => {
      $("#syncDiagModal").classList.add("open");
      runSyncDiagnostic();
    });
    $("#syncDiagClose")?.addEventListener("click", () => $("#syncDiagModal").classList.remove("open"));
    $("#syncDiagModal")?.addEventListener("click", (e) => {
      if (e.target.id === "syncDiagModal") $("#syncDiagModal").classList.remove("open");
    });
    $("#syncDiagRerun")?.addEventListener("click", runSyncDiagnostic);
    $("#syncDiagCopy")?.addEventListener("click", async () => {
      const body = $("#syncDiagBody");
      if (!body) return;
      // Convert to plain text for copy
      const sections = body.querySelectorAll(".diag-section");
      const lines = [];
      sections.forEach((sec) => {
        const title = sec.querySelector(".diag-section-title")?.textContent || "";
        lines.push(`--- ${title} ---`);
        sec.querySelectorAll(".diag-row").forEach((row) => {
          const k = row.querySelector(".diag-key")?.textContent || "";
          const v = row.querySelector(".diag-val")?.textContent || "";
          lines.push(`${k}: ${v}`);
        });
        lines.push("");
      });
      try {
        await navigator.clipboard.writeText(lines.join("\n"));
        showToast("Copied to clipboard");
      } catch (e) {
        showToast("Copy failed — long-press to select");
      }
    });

    // CSV upload
    $("#csvUploadBtn")?.addEventListener("click", () => $("#csvFile").click());
    $("#csvFile")?.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) handleCsvUpload(f);
    });

    const autoSyncToggle = $("#autoSyncToggle");
    if (autoSyncToggle) {
      autoSyncToggle.checked = localStorage.getItem("mb_auto_sync") === "true";
      autoSyncToggle.addEventListener("change", (e) => {
        localStorage.setItem("mb_auto_sync", e.target.checked ? "true" : "false");
        if (e.target.checked) {
          startAutoSync();
          showToast("Auto-sync enabled");
        } else {
          stopAutoSync();
          showToast("Auto-sync disabled");
        }
        updateSyncIndicator("synced");
      });
    }

    // QR setup
    $("#syncQrBtn")?.addEventListener("click", openSyncQrModal);
    $("#syncQrClose")?.addEventListener("click", () => $("#syncQrModal").classList.remove("open"));
    $("#syncQrModal")?.addEventListener("click", (e) => {
      if (e.target.id === "syncQrModal") $("#syncQrModal").classList.remove("open");
    });
    $("#syncCopyLink")?.addEventListener("click", () => {
      const link = $("#syncSetupLink").value;
      navigator.clipboard.writeText(link).then(() => showToast("Link copied"));
    });

    // QR scanner (camera)
    $("#syncQrScanBtn")?.addEventListener("click", openSyncQrScanModal);
    $("#syncQrScanClose")?.addEventListener("click", closeSyncQrScanModal);
    $("#syncQrScanModal")?.addEventListener("click", (e) => {
      if (e.target.id === "syncQrScanModal") closeSyncQrScanModal();
    });

    // Sync history
    $("#syncHistoryBtn")?.addEventListener("click", () => {
      renderSyncHistory();
      $("#syncHistoryModal").classList.add("open");
    });
    $("#syncHistoryClose")?.addEventListener("click", () => $("#syncHistoryModal").classList.remove("open"));
    $("#syncHistoryModal")?.addEventListener("click", (e) => {
      if (e.target.id === "syncHistoryModal") $("#syncHistoryModal").classList.remove("open");
    });
    $("#syncHistoryClear")?.addEventListener("click", () => {
      if (confirm("Clear sync history?")) {
        localStorage.removeItem(SYNC_HISTORY_KEY);
        renderSyncHistory();
      }
    });

    // Sync devices view
    $("#syncDevicesBtn")?.addEventListener("click", () => {
      renderSyncDevices();
      $("#syncDevicesModal").classList.add("open");
    });
    $("#syncDevicesClose")?.addEventListener("click", () => $("#syncDevicesModal").classList.remove("open"));
    $("#syncDevicesModal")?.addEventListener("click", (e) => {
      if (e.target.id === "syncDevicesModal") $("#syncDevicesModal").classList.remove("open");
    });

    // Delete cloud data
    $("#syncDeleteCloudBtn")?.addEventListener("click", async () => {
      const token = localStorage.getItem(KEYS.syncToken);
      const gistId = localStorage.getItem(KEYS.syncGistId);
      if (!token || !gistId) {
        showToast("No cloud data to delete.");
        return;
      }
      if (!confirm("Delete the cloud Gist completely? Local data stays. Other devices will lose their cloud copy and will re-create the Gist on their next push.")) return;
      try {
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
          },
        });
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || `HTTP ${res.status}`);
        }
        // Clear local Gist ID + history; keep the token so user can push again
        localStorage.removeItem(KEYS.syncGistId);
        localStorage.removeItem("mb_last_synced");
        localStorage.removeItem(SYNC_HISTORY_KEY);
        lastSyncedAt = null;
        $("#syncGistId").value = "";
        updateSyncIndicator("synced");
        renderDashSyncCard();
        try { updateNetStatus(); } catch (e) {}
        showToast("Cloud data deleted. Push again to re-sync.");
      } catch (e) {
        showToast(`❌ ${e.message || "Delete failed"}`);
      }
    });

    // Force overwrite cloud with local (skip merge step)
    $("#syncForceOverwriteBtn")?.addEventListener("click", async () => {
      if (!confirm("⚠️ Push your local data to cloud, REPLACING whatever's there. Other devices will pull this and lose any unmerged changes. Continue?")) return;
      lastSyncedHash = null; // bust echo prevention
      await syncPush({ force: true });
    });

    // Force replace local with cloud (skip merge — wipe local first)
    $("#syncForceReplaceBtn")?.addEventListener("click", async () => {
      if (!confirm("⚠️ Wipe local data and replace it with cloud's data exactly. You will lose any local changes that aren't in the cloud. Continue?")) return;
      // Clear all relevant collections so merge effectively becomes a replace
      const empty = {
        income: 0, monthlyIncome: {}, categories: [], expenses: [], goals: [],
        presets: [], recurring: [], cards: [], creditScores: [], accounts: [], people: [],
        netWorthHistory: [], creditInquiries: [], negativeItems: [], limitIncreases: [],
        creditGoals: [], utilHistory: [], creditFreezes: {}, annualReports: {}, deletions: {}, mapTimestamps: {},
        billNegotiations: [], incomeSources: [], events: [],
        fxRates: {},
        settingsTimestamps: {},
        settings: { rollover: false, alertsShown: {} },
      };
      state = empty;
      saveData();
      await syncPull({ skipConfirm: true });
    });

    // Skip receipts on cellular toggle
    const skipRecToggle = $("#skipReceiptsCellularToggle");
    if (skipRecToggle) {
      skipRecToggle.checked = localStorage.getItem(KEYS.syncSkipReceiptsCellular) === "true";
      skipRecToggle.addEventListener("change", (e) => {
        localStorage.setItem(KEYS.syncSkipReceiptsCellular, e.target.checked ? "true" : "false");
        showToast(e.target.checked ? "Receipts will be skipped on cellular" : "Receipts always synced");
      });
    }

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

    // Repeat last expense — opens the modal pre-filled with the most recent
    // non-transfer expense's fields. Date defaults to today, amount to the
    // last amount; user just taps Add to confirm.
    $("#repeatLastBtn")?.addEventListener("click", () => {
      const lastExpense = [...state.expenses]
        .filter((e) => e.type === "expense")
        .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id))[0];
      if (!lastExpense) {
        showToast("No previous expense to repeat");
        return;
      }
      // Open modal pre-filled with last expense's fields, but with today's
      // date and a fresh ID so it creates a new transaction
      openExpenseModal({
        ...lastExpense,
        id: null,
        date: todayStr(),
        receipt: null, // don't carry over receipt — that's per-transaction
      });
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
    // Live totals: gross/taxes/benefits/other → net
    ["#pcGross", "#pcTaxes", "#pcBenefits", "#pcOther"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("input", updatePaycheckTotals);
    });
    $("#paycheckForm").addEventListener("submit", (e) => {
      e.preventDefault();
      savePaycheck();
    });

    // Paystub paste-to-fill
    $("#pastePaystubBtn")?.addEventListener("click", () => {
      const box = $("#pastePaystubBox");
      if (box) box.hidden = !box.hidden;
      if (box && !box.hidden) setTimeout(() => $("#pastePaystubText")?.focus(), 50);
    });

    // Paystub picture / PDF upload
    $("#paystubUploadBtn")?.addEventListener("click", () => $("#paystubFile")?.click());
    $("#paystubFile")?.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (file) handlePaystubUpload(file);
      e.target.value = ""; // allow re-uploading same file
    });
    $("#pastePaystubParse")?.addEventListener("click", () => {
      const text = $("#pastePaystubText")?.value || "";
      if (!text.trim()) {
        showToast("Paste some paystub text first");
        return;
      }
      const status = $("#paystubStatus");
      if (status) {
        status.hidden = false;
        status.className = "paystub-status";
        status.textContent = "Parsing paystub data…";
      }
      try {
        const parsed = parsePaystub(text);
        applyPaystubToForm(parsed);
        const found = [];
        if (parsed.employer) found.push("employer");
        if (parsed.date) found.push("pay date");
        if (parsed.gross !== null) found.push(`gross ${fmt(parsed.gross)}`);
        if (parsed.net !== null) found.push(`net ${fmt(parsed.net)}`);
        if (parsed.fedTax !== null) found.push("fed tax");
        if (parsed.stateTax !== null) found.push("state tax");
        if (parsed.ssTax !== null) found.push("SS");
        if (parsed.medicareTax !== null) found.push("Medicare");
        if (parsed.health || parsed.dental || parsed.vision) found.push("health");
        if (parsed.k401) found.push("401k");
        if (parsed._taxesTotal && parsed.fedTax === null && parsed.stateTax === null) found.push(`taxes total ${fmt(parsed._taxesTotal)}`);
        if (parsed._benefitsTotal && !parsed.health && !parsed.dental && !parsed.vision) found.push(`benefits total ${fmt(parsed._benefitsTotal)}`);
        if (parsed._otherTotal) found.push(`other total ${fmt(parsed._otherTotal)}`);
        if (status) {
          if (!found.length) {
            status.className = "paystub-status warn";
            status.textContent = "Couldn't auto-detect fields. Fill them in manually.";
          } else {
            status.className = "paystub-status success";
            status.innerHTML = `✓ Found: ${found.join(", ")}.<br><small>Review the values below before saving.</small>`;
          }
        }
      } catch (err) {
        console.error("Paste parse failed:", err);
        if (status) {
          status.className = "paystub-status warn";
          status.textContent = `Parse error: ${err.message || err.name}`;
        }
      }
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
      if (!name || isNaN(target)) {
        showToast("Add a name and target amount");
        return;
      }
      state.goals.push(touchRecord({ id: uid(), name, target, saved: 0, date }));
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
        setSetting("roundUpEnabled", e.target.checked);
        $("#roundUpGoalRow").style.display = e.target.checked ? "block" : "none";
        saveData();
        renderRoundUpStats();
        renderGoalsTab();
        showToast(e.target.checked ? "Round-up enabled" : "Round-up disabled");
      });
    }
    const ruGoalSel = $("#roundUpGoalSelect");
    if (ruGoalSel) {
      ruGoalSel.addEventListener("change", (e) => {
        setSetting("roundUpGoalId", e.target.value || null);
        saveData();
        renderRoundUpStats();
        renderGoalsTab();
      });
    }
    // Mirror toggles on Goals tab
    const ru2 = $("#roundUpToggle2");
    if (ru2) {
      ru2.addEventListener("change", (e) => {
        setSetting("roundUpEnabled", e.target.checked);
        saveData();
        renderRoundUpStats();
        renderGoalsTab();
        if (roundToggle) roundToggle.checked = e.target.checked;
      });
    }
    const ruSel2 = $("#roundUpGoalSelect2");
    if (ruSel2) {
      ruSel2.addEventListener("change", (e) => {
        setSetting("roundUpGoalId", e.target.value || null);
        saveData();
        renderRoundUpStats();
        renderGoalsTab();
      });
    }
    // + New Goal on the Goals tab opens the form (auto-scroll to it)
    $("#addGoal2Btn")?.addEventListener("click", () => {
      const name = prompt("Goal name:");
      if (!name) return;
      const targetStr = prompt("Target amount:");
      if (!targetStr) return;
      const target = parseFloat(targetStr);
      if (isNaN(target)) return;
      const date = prompt("Target date (YYYY-MM-DD, optional):");
      state.goals.push(touchRecord({ id: uid(), name: name.trim(), target, saved: 0, date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "" }));
      saveData();
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
      const goalId = $("#recGoal").value || null;
      if (!desc || isNaN(amount) || isNaN(dayOfMonth)) {
        showToast("Fill description, amount, and day of month");
        return;
      }
      if (dayOfMonth < 1 || dayOfMonth > 31) {
        showToast("Day must be between 1 and 31");
        return;
      }
      state.recurring.push(touchRecord({
        id: uid(),
        type,
        desc,
        amount,
        categoryId,
        goalId,
        dayOfMonth,
        active: true,
        lastRunMonth: null,
      }));
      saveData();
      processRecurring(); // Catch up immediately for any prior months
      e.target.reset();
      renderAll();
      showToast("Recurring transaction added");
    });

    // Rollover toggle
    $("#rolloverToggle").addEventListener("change", (e) => {
      setSetting("rollover", !!e.target.checked);
      saveData();
      renderDashboard();
      showToast(state.settings.rollover ? "Rollover enabled" : "Rollover disabled");
    });

    // Credit: open card/score modals
    $("#addCardBtn").addEventListener("click", () => openCardModal(null));
    $("#addScoreBtn").addEventListener("click", () => openScoreModal());
    $("#importCreditBtn").addEventListener("click", openImportCreditModal);
    $("#payCardsBtn")?.addEventListener("click", openPayCardModal);
    $("#payMinimumsBtn")?.addEventListener("click", payAllMinimums);
    $("#payPlanOpen")?.addEventListener("click", openPayCardModal);
    $("#payCardModalClose")?.addEventListener("click", closePayCardModal);
    $("#payCardModal")?.addEventListener("click", (e) => {
      if (e.target.id === "payCardModal") closePayCardModal();
    });
    $("#pmApply")?.addEventListener("click", applyPayCardPlan);
    $("#pmKeep")?.addEventListener("input", () => {
      // re-apply current strategy with new keep buffer
      payCardPlanState.keep = Number($("#pmKeep").value) || 0;
      renderPayCardPlanRows();
    });
    $("#pmSource")?.addEventListener("change", () => {
      payCardPlanState.sourceId = $("#pmSource").value;
      renderPayCardPlanRows();
    });
    $$(".pay-strategy-row button[data-strategy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".pay-strategy-row button[data-strategy]").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        payCardPlanState.strategy = btn.dataset.strategy;
        applyStrategyToPlan();
        renderPayCardPlanRows();
      });
    });

    // Card list search & filter
    $("#cardSearch")?.addEventListener("input", (e) => {
      cardListFilters.search = e.target.value;
      renderCardList();
    });
    $("#cardFilter")?.addEventListener("change", (e) => {
      cardListFilters.filter = e.target.value;
      renderCardList();
    });

    // Dashboard card visibility toggles. Selectors can be element IDs or classes.
    function applyDashCardVisibility() {
      let prefs = {};
      try { prefs = JSON.parse(localStorage.getItem("mb_dash_cards") || "{}"); } catch (e) { /* ignore */ }
      document.querySelectorAll("[data-dash-card]").forEach((cb) => {
        const sel = cb.dataset.dashCard;
        const visible = prefs[sel] !== false; // default = visible
        cb.checked = visible;
        // Find the target element — try as ID first, then as class
        const target = document.getElementById(sel) || document.querySelector("." + sel);
        if (target) {
          target.style.display = visible ? "" : "none";
        }
      });
    }
    document.querySelectorAll("[data-dash-card]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const sel = cb.dataset.dashCard;
        let prefs = {};
        try { prefs = JSON.parse(localStorage.getItem("mb_dash_cards") || "{}"); } catch (e) { /* ignore */ }
        prefs[sel] = cb.checked;
        localStorage.setItem("mb_dash_cards", JSON.stringify(prefs));
        applyDashCardVisibility();
      });
    });
    applyDashCardVisibility();

    // Bill negotiation tracker
    if ($("#billNegDate")) $("#billNegDate").value = todayStr();
    $("#billNegForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const vendor = $("#billNegVendor").value.trim();
      const before = parseFloat($("#billNegBefore").value);
      const after = parseFloat($("#billNegAfter").value);
      const date = $("#billNegDate").value || todayStr();
      const note = $("#billNegNote").value.trim();
      if (!vendor || isNaN(before) || isNaN(after)) {
        showToast("Fill vendor, before, and after");
        return;
      }
      const savedMonthly = before - after;
      state.billNegotiations.push(touchRecord({
        id: uid(),
        vendor,
        before,
        after,
        savedMonthly,
        date,
        note,
      }));
      saveData();
      e.target.reset();
      $("#billNegDate").value = todayStr();
      renderBillNegotiations();
      const annual = (savedMonthly * 12).toFixed(0);
      showToast(savedMonthly > 0
        ? `Saved ${fmt(savedMonthly)}/mo (${fmt(annual)}/yr)`
        : `Recorded ${vendor}`);
    });

    // Income sources form (Settings)
    $("#incomeSourceForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = $("#incSrcName").value.trim();
      const type = $("#incSrcType").value || "salary";
      const defaultAmount = parseFloat($("#incSrcAmount").value) || 0;
      const note = $("#incSrcNote").value.trim();
      if (!name) {
        showToast("Add a name for the income source");
        return;
      }
      // De-duplicate by name (case-insensitive)
      const existing = state.incomeSources.find((s) => (s.name || "").toLowerCase() === name.toLowerCase());
      if (existing) {
        existing.type = type;
        existing.defaultAmount = defaultAmount;
        existing.note = note;
        touchRecord(existing);
      } else {
        state.incomeSources.push(touchRecord({
          id: uid(),
          name,
          type,
          defaultAmount,
          note,
        }));
      }
      saveData();
      e.target.reset();
      renderIncomeSourcesManage();
      populateIncomeSourceList();
      showToast(existing ? "Income source updated" : "Income source saved");
    });
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
      if (!name) {
        showToast("Add an account name");
        return;
      }
      // Prevent duplicates (case-insensitive)
      const dup = state.accounts.find((a) => (a.name || "").toLowerCase() === name.toLowerCase());
      if (dup) {
        showToast(`"${dup.name}" already exists`);
        return;
      }
      const colors = ["#22c55e", "#3b82f6", "#ec4899", "#f59e0b", "#8b5cf6", "#14b8a6", "#06b6d4", "#ef4444"];
      const color = colors[state.accounts.length % colors.length];
      state.accounts.push(touchRecord({ id: uid(), name, type, balance, color }));
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
      if (isNaN(amount) || amount <= 0 || !date) {
        showToast("Enter a valid amount and date");
        return;
      }
      const fromAcc = state.accounts.find((a) => a.id === fromId);
      const toAcc = state.accounts.find((a) => a.id === toId);
      if (!fromAcc || !toAcc) {
        showToast("Pick valid accounts");
        return;
      }
      const desc = note || `Transfer: ${fromAcc.name} → ${toAcc.name}`;
      // Two linked transactions
      const transferGroupId = uid();
      state.expenses.push(touchRecord({
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
      }));
      state.expenses.push(touchRecord({
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
      }));
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

    // Events: form
    $("#addEventBtn")?.addEventListener("click", () => openEventModal(null));
    $("#eventsSearch")?.addEventListener("input", (e) => {
      eventsSearchQuery = e.target.value;
      renderEventsTab();
    });

    // Event template quick-create — picks the right preset
    document.addEventListener("click", (e) => {
      const tpl = e.target.closest("[data-template]");
      if (!tpl) return;
      const presets = {
        vacation: {
          name: "Vacation", icon: "🌴", color: "#06b6d4",
          lineItems: [
            { id: uid(), label: "Flights", budget: 0 },
            { id: uid(), label: "Hotel", budget: 0 },
            { id: uid(), label: "Food", budget: 0 },
            { id: uid(), label: "Activities", budget: 0 },
          ],
          checklist: [
            { id: uid(), label: "Pack passport", done: false },
            { id: uid(), label: "Notify bank", done: false },
            { id: uid(), label: "Confirm reservations", done: false },
          ],
        },
        wedding: {
          name: "Wedding", icon: "💍", color: "#ec4899",
          lineItems: [
            { id: uid(), label: "Venue", budget: 0 },
            { id: uid(), label: "Catering", budget: 0 },
            { id: uid(), label: "Photography", budget: 0 },
            { id: uid(), label: "Attire", budget: 0 },
            { id: uid(), label: "Flowers", budget: 0 },
          ],
        },
        move: {
          name: "Moving", icon: "📦", color: "#f59e0b",
          lineItems: [
            { id: uid(), label: "Movers", budget: 0 },
            { id: uid(), label: "Deposit & first month", budget: 0 },
            { id: uid(), label: "Furniture & supplies", budget: 0 },
            { id: uid(), label: "Utility setup", budget: 0 },
          ],
          checklist: [
            { id: uid(), label: "Update address with bank/IRS/DMV", done: false },
            { id: uid(), label: "Set up utilities", done: false },
            { id: uid(), label: "Forward mail (USPS)", done: false },
          ],
        },
        holidays: {
          name: "Holidays", icon: "🎁", color: "#22c55e",
          lineItems: [
            { id: uid(), label: "Gifts", budget: 0 },
            { id: uid(), label: "Travel", budget: 0 },
            { id: uid(), label: "Food & drinks", budget: 0 },
          ],
        },
      };
      const preset = presets[tpl.dataset.template];
      if (preset) {
        openEventModal({
          id: null,
          name: preset.name,
          icon: preset.icon,
          color: preset.color,
          startDate: null,
          endDate: null,
          budget: 0,
          notes: "",
          lineItems: preset.lineItems,
          checklist: preset.checklist || [],
          vacationMode: false,
        });
      }
    });
    $("#eventModalClose")?.addEventListener("click", closeEventModal);
    $("#eventModal")?.addEventListener("click", (e) => {
      if (e.target.id === "eventModal") closeEventModal();
    });
    $("#addEventLineItemBtn")?.addEventListener("click", () => addEventLineItemRow(null));

    // Enter-to-add for checklist inputs (delegated since they're rendered dynamically)
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const input = e.target.closest(".event-check-input");
      if (!input) return;
      e.preventDefault();
      const evId = input.dataset.eventId;
      const label = (input.value || "").trim();
      if (!label) return;
      const ev = state.events.find((x) => x.id === evId);
      if (!ev) return;
      if (!Array.isArray(ev.checklist)) ev.checklist = [];
      ev.checklist.push({ id: uid(), label, done: false });
      touchRecord(ev);
      saveData();
      renderEventsTab();
      setTimeout(() => {
        const panel = document.querySelector(`[data-event-checklist="${evId}"]`);
        if (panel) panel.hidden = false;
        const newInput = document.querySelector(`.event-check-input[data-event-id="${evId}"]`);
        if (newInput) newInput.focus();
      }, 0);
    });
    $("#eventForm")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const editId = $("#eventEditId").value;
      const ev = {
        id: editId || uid(),
        name: $("#eventName").value.trim(),
        icon: $("#eventIcon").value.trim() || "🌴",
        color: $("#eventColor")?.value || "#5b3fb8",
        startDate: $("#eventStart").value || null,
        endDate: $("#eventEnd").value || null,
        budget: parseFloat($("#eventBudget").value) || 0,
        notes: $("#eventNotes").value.trim(),
        lineItems: readEventLineItemsFromForm(),
        // Vacation mode: auto-pause active recurring rules during the event range
        vacationMode: $("#eventVacationMode")?.checked || false,
        linkedGoalId: $("#eventLinkedGoal")?.value || null,
        // Existing checklist preserved when editing
        checklist: editId ? (state.events.find((x) => x.id === editId)?.checklist || []) : [],
      };
      if (!ev.name) {
        showToast("Add an event name");
        return;
      }
      // Validate: if endDate set without startDate, swap
      if (ev.endDate && !ev.startDate) {
        ev.startDate = ev.endDate;
        ev.endDate = null;
      }
      // Validate: endDate must be after or equal startDate
      if (ev.startDate && ev.endDate && ev.endDate < ev.startDate) {
        showToast("End date must be after start date");
        return;
      }
      if (editId) {
        const idx = state.events.findIndex((x) => x.id === editId);
        if (idx >= 0) state.events[idx] = touchRecord({ ...state.events[idx], ...ev });
      } else {
        state.events.push(touchRecord(ev));
      }
      saveData();
      closeEventModal();
      renderAll();
      showToast(editId ? "Event updated" : "Event saved");
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
      if (!person.name) {
        showToast("Add a name");
        return;
      }
      if (editId) {
        const idx = state.people.findIndex((p) => p.id === editId);
        if (idx >= 0) state.people[idx] = touchRecord(person);
      } else {
        state.people.push(touchRecord(person));
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

    // Family transaction filter dropdown
    $("#familyTxnFilter")?.addEventListener("change", (e) => {
      familyTxnFilterId = e.target.value;
      renderFamilyTxnList();
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
        // Preserve existing accountId link if editing
        accountId: oldCard?.accountId || null,
      };
      if (!card.name) {
        showToast("Add a card name");
        return;
      }

      // Auto-log a limit-increase entry if user raised the limit
      if (oldCard && Number(card.limit) > Number(oldCard.limit) && oldCard.limit > 0) {
        state.limitIncreases.push(touchRecord({
          id: uid(),
          cardId: card.id,
          oldLimit: Number(oldCard.limit),
          newLimit: Number(card.limit),
          date: todayStr(),
          note: "Auto-logged from card edit",
        }));
      }

      // Auto-create or sync paired account so the card's debt shows up on Balances
      if (!card.accountId) {
        // Create a new account for this card with starting balance = -current debt
        const palette = ["#ec4899", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444"];
        const acc = touchRecord({
          id: uid(),
          name: card.name,
          type: "credit",
          balance: -Math.abs(Number(card.balance) || 0), // negative = debt
          color: palette[state.accounts.length % palette.length],
          cardId: card.id, // back-reference
        });
        state.accounts.push(acc);
        card.accountId = acc.id;
      } else {
        // Sync paired account when name or balance changes. Recompute starting balance so
        // accountBalance(account.id) = -current_card_balance after considering existing txns.
        const acc = state.accounts.find((a) => a.id === card.accountId);
        if (acc) {
          let dirty = false;
          if (acc.name !== card.name) { acc.name = card.name; dirty = true; }
          // Compute current account txn delta and adjust starting balance to match new card balance
          const txnDelta = state.expenses
            .filter((e) => e.accountId === acc.id)
            .reduce((s, t) => {
              if (t.type === "income") return s + Number(t.amount);
              if (t.type === "transfer-out") return s - Number(t.amount);
              if (t.type === "transfer-in") return s + Number(t.amount);
              return s - Number(t.amount);
            }, 0);
          const desiredAccBal = -Math.abs(Number(card.balance) || 0);
          const newStarting = desiredAccBal - txnDelta;
          if (Math.abs((Number(acc.balance) || 0) - newStarting) > 0.005) {
            acc.balance = newStarting;
            dirty = true;
          }
          if (dirty) touchRecord(acc);
        }
      }

      if (editId) {
        const idx = state.cards.findIndex((c) => c.id === editId);
        if (idx >= 0) state.cards[idx] = touchRecord(card);
      } else {
        state.cards.push(touchRecord(card));
      }
      saveData();
      closeCardModal();
      renderAll();
      showToast(editId ? "Card updated" : "Card added with paired account");
    });

    // Score form
    $("#scoreForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const score = parseInt($("#scoreValue").value, 10);
      const date = $("#scoreDate").value;
      if (!score || score < 300 || score > 850 || !date) {
        showToast("Score must be 300-850 with a date");
        return;
      }
      state.creditScores.push(touchRecord({
        id: uid(),
        score,
        date,
        bureau: $("#scoreBureau").value || null,
        source: $("#scoreSource").value,
        type: $("#scoreType").value,
        note: $("#scoreNote").value.trim(),
      }));
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
      if (!date || !reason) {
        showToast("Add a date and reason");
        return;
      }
      state.creditInquiries.push(touchRecord({
        id: uid(), date, reason, bureau, type: "hard",
      }));
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
      state.negativeItems.push(touchRecord({
        id: uid(),
        type, date,
        creditor: $("#negCreditor").value.trim(),
        amount: parseFloat($("#negAmount").value) || 0,
        note: $("#negNote").value.trim(),
      }));
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
      if (!targetScore || !targetDate) {
        showToast("Set a target score and date");
        return;
      }
      state.creditGoals.push(touchRecord({
        id: uid(), targetScore, targetDate, note,
      }));
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
        touchMapKey("creditFreezes", bureau);
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
      filters.tags.clear();
      filters.search = "";
      filters.hideTransfers = false;
      filters.eventId = "";
      $("#filterStart").value = "";
      $("#filterEnd").value = "";
      $("#txnSearch").value = "";
      const ht = $("#hideTransfersToggle"); if (ht) ht.checked = false;
      const fe = $("#filterEvent"); if (fe) fe.value = "";
      renderFilterChips();
      renderPersonFilterChips();
      renderTagFilterChips();
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
    $("#hideTransfersToggle")?.addEventListener("change", (e) => {
      filters.hideTransfers = e.target.checked;
      renderTransactions();
    });
    $("#filterEvent")?.addEventListener("change", (e) => {
      filters.eventId = e.target.value;
      renderTransactions();
    });

    // Bulk actions
    $("#bulkClearBtn").addEventListener("click", () => {
      selectedTxns.clear();
      renderTransactions();
    });
    $("#bulkSelectAllBtn")?.addEventListener("click", () => {
      // Select every txn currently rendered (matches active filters)
      const visible = document.querySelectorAll("[data-txn-row]");
      visible.forEach((el) => {
        const id = el.dataset.txnRow;
        if (id) selectedTxns.add(id);
      });
      renderTransactions();
    });
    $("#bulkRecategorizeBtn")?.addEventListener("click", () => {
      if (!selectedTxns.size) return;
      if (!state.categories.length) {
        showToast("Add a category first");
        return;
      }
      const ids = [...selectedTxns];
      // Build a numbered prompt so user picks a category
      const list = state.categories.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
      const choice = prompt(`Recategorize ${ids.length} transaction${ids.length === 1 ? "" : "s"} to which category?\n\n${list}\n\nEnter the number:`);
      if (choice === null) return;
      const idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= state.categories.length) {
        showToast("Invalid selection");
        return;
      }
      const targetCatId = state.categories[idx].id;
      const targetCatName = state.categories[idx].name;
      let updated = 0;
      state.expenses.forEach((e) => {
        if (ids.includes(e.id)) {
          e.categoryId = targetCatId;
          touchRecord(e);
          updated += 1;
        }
      });
      selectedTxns.clear();
      saveData();
      renderAll();
      showToast(`Moved ${updated} to ${targetCatName}`);
    });
    $("#bulkDeleteBtn").addEventListener("click", () => {
      if (!selectedTxns.size) return;
      const ids = [...selectedTxns];
      if (!confirmDeleteTxn(`Delete ${ids.length} transaction${ids.length === 1 ? "" : "s"}?`)) return;
      const removed = state.expenses.filter((e) => ids.includes(e.id));
      ids.forEach((id) => tombstoneRecord("expenses", id));
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

    // Person dropdown -> if a person is picked and no category set yet, auto-pick Family
    $("#expPerson")?.addEventListener("change", (e) => {
      if (!e.target.value) return;
      if (currentModalType !== "expense") return;
      const catSel = $("#expCategory");
      if (!catSel || catSel.value) return; // don't override user's pick
      const familyCat = state.categories.find((c) => /^family$/i.test(c.name));
      if (familyCat) catSel.value = familyCat.id;
    });

    // Account dropdown change -> apply account→category mapping when category is empty
    $("#expAccount")?.addEventListener("change", (e) => {
      if (currentModalType !== "expense") return;
      if (!e.target.value) return;
      const catSel = $("#expCategory");
      if (!catSel || catSel.value) return; // don't override user's pick
      const acctMap = (state.settings && state.settings.accountCategoryMap) || {};
      const mappedCatId = acctMap[e.target.value];
      if (mappedCatId && state.categories.some((c) => c.id === mappedCatId)) {
        catSel.value = mappedCatId;
      }
    });

    // Event dropdown change -> clear stale line-item stash (line item belongs to the old event)
    $("#expEvent")?.addEventListener("change", () => {
      const formEl = $("#expenseForm");
      if (formEl) delete formEl.dataset.eventLineItemId;
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

    // Insights event filter
    $("#insightsEventFilter")?.addEventListener("change", (e) => {
      insightsEventFilterId = e.target.value;
      renderInsights();
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
      const tchip = e.target.closest("[data-tag-chip]");
      if (tchip) {
        const tag = tchip.dataset.tagChip;
        if (filters.tags.has(tag)) filters.tags.delete(tag);
        else filters.tags.add(tag);
        renderTagFilterChips();
        renderTransactions();
        return;
      }

      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === "del-cat") {
        const cat = state.categories.find((c) => c.id === id);
        // Warn extra-strong if this is a system-managed category that auto-routes txns
        const isSystem = cat && /^(family|credit\s*payment)$/i.test(cat.name);
        const promptMsg = isSystem
          ? `Delete "${cat.name}"? This category auto-categorizes ${cat.name === "Family" ? "transactions tagged with a person" : "credit card payments"}. They'll show as Uncategorized after.`
          : "Delete this category? Transactions will show 'Uncategorized'.";
        if (confirm(promptMsg)) {
          tombstoneRecord("categories", id);
          state.categories = state.categories.filter((c) => c.id !== id);
          // Clear orphan references on transactions and recurring rules, then remove from filter chip set
          state.expenses.forEach((e) => {
            if (e.categoryId === id) {
              e.categoryId = null;
              touchRecord(e);
            }
          });
          state.recurring.forEach((r) => {
            if (r.categoryId === id) {
              r.categoryId = null;
              touchRecord(r);
            }
          });
          state.presets.forEach((p) => {
            if (p.categoryId === id) {
              p.categoryId = null;
              touchRecord(p);
            }
          });
          // Clear default-category setting if it pointed here
          if (state.settings?.defaultCategoryId === id) {
            setSetting("defaultCategoryId", null);
          }
          // Drop any account → category mappings that pointed to this category
          if (state.settings?.accountCategoryMap) {
            const newMap = { ...state.settings.accountCategoryMap };
            let mapChanged = false;
            Object.keys(newMap).forEach((acctId) => {
              if (newMap[acctId] === id) {
                delete newMap[acctId];
                mapChanged = true;
              }
            });
            if (mapChanged) setSetting("accountCategoryMap", newMap);
          }
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
        if (!isNaN(lim) && lim !== Number(cat.limit)) {
          // Snapshot the old limit as effective through the current month.
          // The new limit applies starting next month (current-month spend stays
          // measured against the limit it was tracking with).
          if (!Array.isArray(cat.limitHistory)) cat.limitHistory = [];
          cat.limitHistory.push({ until: currentMonth(), limit: Number(cat.limit) || 0 });
          cat.limit = lim;
        } else if (!isNaN(lim)) {
          cat.limit = lim;
        }
        touchRecord(cat);
        saveData();
        renderAll();
      } else if (action === "del-exp") {
        const txn = state.expenses.find((x) => x.id === id);
        if (txn && confirmDeleteTxn("Delete this transaction?")) {
          // Find any linked transactions (transfer pair, paycheck deductions+splits)
          const linked = [];
          if (txn.transferGroupId) {
            state.expenses.forEach((e) => {
              if (e.transferGroupId === txn.transferGroupId && e.id !== id) linked.push(e);
            });
          }
          if (txn.paycheckId) {
            state.expenses.forEach((e) => {
              if (e.paycheckId === txn.paycheckId && e.id !== id) linked.push(e);
            });
          }
          if (linked.length > 0) {
            const skipConfirm = state.settings?.skipDeleteConfirm;
            if (!skipConfirm) {
              const proceed = confirm(
                `This is part of a ${txn.transferGroupId ? "transfer" : "paycheck"} group of ${linked.length + 1} linked transactions. ` +
                `Delete the whole group?`
              );
              if (!proceed) return;
            }
          }
          const allRemoved = [txn, ...linked];
          // If this group is a credit-payment, restore the card balance before deleting
          const creditPay = allRemoved.find((t) => t.kind === "credit-payment" && t.cardId);
          if (creditPay) {
            const card = state.cards.find((c) => c.id === creditPay.cardId);
            if (card) {
              card.balance = (Number(card.balance) || 0) + Number(creditPay.amount || 0);
              touchRecord(card);
            }
          }
          allRemoved.forEach((t) => tombstoneRecord("expenses", t.id));
          const removeIds = new Set(allRemoved.map((t) => t.id));
          state.expenses = state.expenses.filter((x) => !removeIds.has(x.id));
          saveData();
          renderAll();
          showUndoToast(allRemoved);
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
          tombstoneRecord("presets", id);
          state.presets = state.presets.filter((p) => p.id !== id);
          saveData();
          renderPresetsManage();
        }
      } else if (action === "del-billneg") {
        if (confirm("Delete this negotiation record?")) {
          tombstoneRecord("billNegotiations", id);
          state.billNegotiations = state.billNegotiations.filter((n) => n.id !== id);
          saveData();
          renderBillNegotiations();
        }
      } else if (action === "del-incsrc") {
        if (confirm("Delete this income source?")) {
          tombstoneRecord("incomeSources", id);
          state.incomeSources = state.incomeSources.filter((s) => s.id !== id);
          saveData();
          renderIncomeSourcesManage();
          populateIncomeSourceList();
        }
      } else if (action === "use-incsrc") {
        const src = state.incomeSources.find((s) => s.id === id);
        if (!src) return;
        openPaycheckModal();
        // Pre-fill employer + default amount
        setTimeout(() => {
          const empEl = $("#pcEmployer");
          if (empEl) empEl.value = src.name;
          if (Number(src.defaultAmount) > 0) {
            const grossEl = $("#pcGross");
            if (grossEl && !grossEl.value) grossEl.value = Number(src.defaultAmount).toFixed(2);
          }
        }, 100);
      } else if (action === "preset-fav") {
        const p = state.presets.find((x) => x.id === id);
        if (!p) return;
        p.favorite = !p.favorite;
        touchRecord(p);
        saveData();
        renderPresetsManage();
        renderPresets();
      } else if (action === "preset-recurring") {
        const p = state.presets.find((x) => x.id === id);
        if (!p) return;
        const day = prompt(`Make "${p.desc}" recurring on which day of month? (1-31)`, "1");
        if (day === null) return;
        const dayOfMonth = Math.min(31, Math.max(1, parseInt(day, 10) || 1));
        state.recurring.push(touchRecord({
          id: uid(),
          type: p.type,
          desc: p.desc,
          amount: p.amount,
          categoryId: p.categoryId,
          dayOfMonth,
          active: true,
          lastRunMonth: null,
        }));
        saveData();
        renderRecurringList();
        showToast(`"${p.desc}" is now recurring on day ${dayOfMonth}`);
      } else if (action === "toggle-rec") {
        const r = state.recurring.find((x) => x.id === id);
        if (r) {
          r.active = !r.active;
          touchRecord(r);
          saveData();
          renderRecurringList();
          showToast(r.active ? "Recurring resumed" : "Recurring paused");
        }
      } else if (action === "edit-rec") {
        const r = state.recurring.find((x) => x.id === id);
        if (!r) return;
        const newDesc = prompt("Description:", r.desc);
        if (newDesc === null) return;
        const newAmt = prompt("Amount:", r.amount);
        if (newAmt === null) return;
        const newDay = prompt("Day of month (1-31):", r.dayOfMonth);
        if (newDay === null) return;
        const desc = newDesc.trim() || r.desc;
        const amount = parseFloat(newAmt);
        const dayOfMonth = Math.min(31, Math.max(1, parseInt(newDay, 10) || r.dayOfMonth));
        if (isNaN(amount)) return;
        r.desc = desc;
        r.amount = amount;
        r.dayOfMonth = dayOfMonth;
        touchRecord(r);
        saveData();
        renderRecurringList();
        showToast("Recurring updated");
      } else if (action === "del-rec") {
        if (confirm("Delete this recurring transaction? Existing transactions stay.")) {
          tombstoneRecord("recurring", id);
          state.recurring = state.recurring.filter((x) => x.id !== id);
          saveData();
          renderRecurringList();
        }
      } else if (action === "cleanup-stale-rec") {
        // Delete all paused rules whose last run is 3+ months ago
        const m = currentMonth();
        const stale = state.recurring.filter((r) => !r.active && r.lastRunMonth && monthDiff(r.lastRunMonth, m) >= 3);
        if (!stale.length) return;
        if (!confirm(`Delete ${stale.length} stale paused rule${stale.length === 1 ? "" : "s"}? Existing transactions stay.`)) return;
        stale.forEach((r) => tombstoneRecord("recurring", r.id));
        const ids = new Set(stale.map((r) => r.id));
        state.recurring = state.recurring.filter((r) => !ids.has(r.id));
        saveData();
        renderRecurringList();
        showToast(`Removed ${stale.length} stale rule${stale.length === 1 ? "" : "s"}`);
      } else if (action === "edit-card") {
        const card = state.cards.find((c) => c.id === id);
        if (card) openCardModal(card);
      } else if (action === "expand-card") {
        const panel = document.querySelector(`[data-card-detail="${id}"]`);
        if (panel) panel.hidden = !panel.hidden;
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
        touchRecord(acc);
        saveData();
        renderAll();
      } else if (action === "edit-month-income") {
        const m = btn.dataset.month;
        const cur = (state.monthlyIncome && state.monthlyIncome[m]) || "";
        const newVal = prompt(`Income for ${monthLabel(m)}:`, cur);
        if (newVal === null) return;
        const v = parseFloat(newVal);
        if (isNaN(v)) {
          showToast("Enter a valid amount");
          return;
        }
        setIncomeForMonth(m, v);
        saveData();
        renderAll();
        showToast("Updated");
      } else if (action === "del-month-income") {
        const m = btn.dataset.month;
        if (confirm(`Remove income override for ${monthLabel(m)}? Default will be used instead.`)) {
          delete state.monthlyIncome[m];
          tombstoneMapKey("monthlyIncome", m);
          saveData();
          renderAll();
        }
      } else if (action === "del-acc") {
        const acc = state.accounts.find((a) => a.id === id);
        // Block deleting credit-card-linked accounts (migration will recreate them anyway)
        if (acc?.cardId) {
          showToast("Linked to a credit card — delete the card instead");
          return;
        }
        if (confirm("Delete this account? Transactions assigned to it will keep their record.")) {
          tombstoneRecord("accounts", id);
          state.accounts = state.accounts.filter((a) => a.id !== id);
          // Clear orphan references on transactions
          state.expenses.forEach((e) => {
            if (e.accountId === id) {
              e.accountId = null;
              touchRecord(e);
            }
          });
          // Clear default-account setting if it pointed here
          if (state.settings?.defaultAccountId === id) {
            setSetting("defaultAccountId", null);
          }
          // Drop account-category mapping for this account
          if (state.settings?.accountCategoryMap && state.settings.accountCategoryMap[id]) {
            const newMap = { ...state.settings.accountCategoryMap };
            delete newMap[id];
            setSetting("accountCategoryMap", newMap);
          }
          saveData();
          renderAll();
        }
      } else if (action === "edit-person") {
        const p = state.people.find((x) => x.id === id);
        if (p) openPersonModal(p);
      } else if (action === "edit-event") {
        const ev = state.events.find((x) => x.id === id);
        if (ev) openEventModal(ev);
      } else if (action === "del-event") {
        const ev = state.events.find((x) => x.id === id);
        if (!ev) return;
        const tagged = state.expenses.filter((e) => e.eventId === id).length;
        const msg = tagged > 0
          ? `Delete "${ev.name}"? ${tagged} transaction${tagged === 1 ? "" : "s"} tagged to this event will be unlinked but kept.`
          : `Delete "${ev.name}"?`;
        if (!confirm(msg)) return;
        tombstoneRecord("events", id);
        state.events = state.events.filter((x) => x.id !== id);
        // Unlink txns from the deleted event
        state.expenses.forEach((e) => {
          if (e.eventId === id) {
            e.eventId = null;
            e.eventLineItemId = null;
            touchRecord(e);
          }
        });
        saveData();
        renderAll();
        showToast("Event deleted");
      } else if (action === "quick-event-spend") {
        const ev = state.events.find((x) => x.id === id);
        if (!ev) return;
        openExpenseModal({
          type: "expense",
          desc: `${ev.name} expense`,
          eventId: ev.id,
          date: todayStr(),
        });
      } else if (action === "quick-line-spend") {
        const evId = btn.dataset.eventId;
        const lineId = btn.dataset.lineId;
        const ev = state.events.find((x) => x.id === evId);
        if (!ev) return;
        const li = (ev.lineItems || []).find((x) => x.id === lineId);
        openExpenseModal({
          type: "expense",
          desc: `${ev.name} · ${li?.label || ""}`,
          eventId: ev.id,
          eventLineItemId: lineId,
          date: todayStr(),
        });
      } else if (action === "event-checklist") {
        const panel = document.querySelector(`[data-event-checklist="${id}"]`);
        if (panel) panel.hidden = !panel.hidden;
      } else if (action === "event-txns") {
        const panel = document.querySelector(`[data-event-txns="${id}"]`);
        if (panel) panel.hidden = !panel.hidden;
      } else if (action === "event-report") {
        const ev = state.events.find((x) => x.id === id);
        if (ev) openEventReport(ev);
      } else if (action === "event-csv") {
        const ev = state.events.find((x) => x.id === id);
        if (!ev) return;
        exportEventCsv(ev);
      } else if (action === "event-complete") {
        const ev = state.events.find((x) => x.id === id);
        if (!ev) return;
        ev.status = "completed";
        if (!ev.endDate) ev.endDate = todayStr();
        touchRecord(ev);
        saveData();
        renderAll();
        showToast(`"${ev.name}" marked completed`);
      } else if (action === "event-reopen") {
        const ev = state.events.find((x) => x.id === id);
        if (!ev) return;
        ev.status = null; // let derived status pick up from dates
        touchRecord(ev);
        saveData();
        renderAll();
        showToast(`"${ev.name}" reopened`);
      } else if (action === "dup-event") {
        const ev = state.events.find((x) => x.id === id);
        if (!ev) return;
        // Open the event modal with cloned data (no id, no checklist done states, no dates)
        openEventModal({
          id: null, // forces new
          name: `${ev.name} (copy)`,
          icon: ev.icon,
          color: ev.color,
          budget: ev.budget,
          notes: ev.notes,
          startDate: null,
          endDate: null,
          vacationMode: ev.vacationMode,
          // Reset line item ids so duplicates don't share txn-tagging keys
          lineItems: (ev.lineItems || []).map((li) => ({ id: uid(), label: li.label, budget: li.budget })),
          // Fresh checklist (carry labels but reset done state)
          checklist: (ev.checklist || []).map((it) => ({ id: uid(), label: it.label, done: false })),
        });
      } else if (action === "add-event-check") {
        const evId = btn.dataset.eventId;
        const input = document.querySelector(`.event-check-input[data-event-id="${evId}"]`);
        const label = (input?.value || "").trim();
        if (!label) return;
        const ev = state.events.find((x) => x.id === evId);
        if (!ev) return;
        if (!Array.isArray(ev.checklist)) ev.checklist = [];
        ev.checklist.push({ id: uid(), label, done: false });
        touchRecord(ev);
        saveData();
        renderEventsTab();
        // Re-open the panel after re-render
        setTimeout(() => {
          const panel = document.querySelector(`[data-event-checklist="${evId}"]`);
          if (panel) panel.hidden = false;
          const newInput = document.querySelector(`.event-check-input[data-event-id="${evId}"]`);
          if (newInput) newInput.focus();
        }, 0);
      } else if (action === "toggle-event-check") {
        const evId = btn.dataset.eventId;
        const checkId = btn.dataset.checkId;
        const ev = state.events.find((x) => x.id === evId);
        if (!ev || !Array.isArray(ev.checklist)) return;
        const it = ev.checklist.find((x) => x.id === checkId);
        if (!it) return;
        it.done = !!btn.checked;
        touchRecord(ev);
        saveData();
        renderEventsTab();
        setTimeout(() => {
          const panel = document.querySelector(`[data-event-checklist="${evId}"]`);
          if (panel) panel.hidden = false;
        }, 0);
      } else if (action === "del-event-check") {
        const evId = btn.dataset.eventId;
        const checkId = btn.dataset.checkId;
        const ev = state.events.find((x) => x.id === evId);
        if (!ev || !Array.isArray(ev.checklist)) return;
        ev.checklist = ev.checklist.filter((x) => x.id !== checkId);
        touchRecord(ev);
        saveData();
        renderEventsTab();
        setTimeout(() => {
          const panel = document.querySelector(`[data-event-checklist="${evId}"]`);
          if (panel) panel.hidden = false;
        }, 0);
      } else if (action === "quick-send-person") {
        // Open Add Transaction modal pre-filled with this person and Family category
        const p = state.people.find((x) => x.id === id);
        if (!p) return;
        const familyCat = state.categories.find((c) => /^family$/i.test(c.name));
        openExpenseModal({
          type: "expense",
          desc: `Sent to ${p.name}`,
          personId: p.id,
          categoryId: familyCat ? familyCat.id : null,
          date: todayStr(),
        });
      } else if (action === "quick-receive-person") {
        // Open Add Transaction modal as INCOME pre-filled with this person
        const p = state.people.find((x) => x.id === id);
        if (!p) return;
        openExpenseModal({
          type: "income",
          desc: `Received from ${p.name}`,
          personId: p.id,
          source: p.name,
          date: todayStr(),
        });
      } else if (action === "del-person") {
        if (confirm("Delete this person? Transactions linked to them will keep their record but lose the link.")) {
          tombstoneRecord("people", id);
          state.people = state.people.filter((p) => p.id !== id);
          // Unlink transactions and remove from filter chip set
          state.expenses.forEach((e) => {
            if (e.personId === id) {
              e.personId = null;
              touchRecord(e);
            }
          });
          filters.people.delete(id);
          saveData();
          renderAll();
        }
      } else if (action === "del-card") {
        if (confirm("Delete this card?")) {
          const card = state.cards.find((c) => c.id === id);
          tombstoneRecord("cards", id);
          state.cards = state.cards.filter((c) => c.id !== id);
          // Remove paired account if it was auto-created and has no transaction history
          if (card?.accountId) {
            const pairedHasTxns = state.expenses.some((e) => e.accountId === card.accountId);
            if (!pairedHasTxns) {
              tombstoneRecord("accounts", card.accountId);
              state.accounts = state.accounts.filter((a) => a.id !== card.accountId);
              // Clean stale settings pointing at the removed paired account
              if (state.settings?.defaultAccountId === card.accountId) {
                setSetting("defaultAccountId", null);
              }
              if (state.settings?.accountCategoryMap && state.settings.accountCategoryMap[card.accountId]) {
                const newMap = { ...state.settings.accountCategoryMap };
                delete newMap[card.accountId];
                setSetting("accountCategoryMap", newMap);
              }
            }
          }
          saveData();
          renderAll();
        }
      } else if (action === "quick-pay-card") {
        openPayCardModal(id);
      } else if (action === "del-score") {
        if (confirm("Delete this score entry?")) {
          tombstoneRecord("creditScores", id);
          state.creditScores = state.creditScores.filter((s) => s.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "del-inquiry") {
        if (confirm("Delete this inquiry?")) {
          tombstoneRecord("creditInquiries", id);
          state.creditInquiries = state.creditInquiries.filter((x) => x.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "del-negative") {
        if (confirm("Delete this negative item?")) {
          tombstoneRecord("negativeItems", id);
          state.negativeItems = state.negativeItems.filter((x) => x.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "del-limit") {
        if (confirm("Delete this limit increase entry?")) {
          tombstoneRecord("limitIncreases", id);
          state.limitIncreases = state.limitIncreases.filter((x) => x.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "del-credit-goal") {
        if (confirm("Delete this credit goal?")) {
          tombstoneRecord("creditGoals", id);
          state.creditGoals = state.creditGoals.filter((x) => x.id !== id);
          saveData();
          renderCredit();
        }
      } else if (action === "mark-pulled") {
        const bureau = btn.dataset.bureau;
        state.annualReports[bureau] = { lastPulled: todayStr() };
        touchMapKey("annualReports", bureau);
        saveData();
        renderAnnualReports();
        showToast(`${bureau} report marked pulled today`);
      } else if (action === "convert-sub") {
        const idx = Number(btn.dataset.idx);
        const el = $("#subscriptionSuggestions");
        let suggestions = [];
        try { suggestions = JSON.parse(el?.dataset?.suggestionsJson || "[]"); } catch (e) { suggestions = []; }
        const s = suggestions[idx];
        if (!s) return;
        state.recurring.push(touchRecord({
          id: uid(),
          type: "expense",
          desc: s.desc,
          amount: s.amount,
          categoryId: s.categoryId || null,
          dayOfMonth: s.dayOfMonth || 1,
          active: true,
          lastRunMonth: currentMonth(),
        }));
        saveData();
        renderRecurringList();
        showToast("Converted to recurring");
      } else if (action === "dismiss-sub") {
        const idx = Number(btn.dataset.idx);
        const el = $("#subscriptionSuggestions");
        let suggestions = [];
        try { suggestions = JSON.parse(el?.dataset?.suggestionsJson || "[]"); } catch (e) { suggestions = []; }
        const s = suggestions[idx];
        if (s) {
          dismissedSubs.add(s.desc.toLowerCase().trim());
          renderSubscriptionSuggestions();
        }
      } else if (action === "del-goal") {
        if (confirm("Delete this goal?")) {
          tombstoneRecord("goals", id);
          state.goals = state.goals.filter((g) => g.id !== id);
          // Clear orphan goalId references
          state.expenses.forEach((e) => {
            if (e.goalId === id) {
              e.goalId = null;
              touchRecord(e);
            }
          });
          // Clear round-up destination if it pointed here
          if (state.settings.roundUpGoalId === id) {
            setSetting("roundUpGoalId", null);
          }
          // Clear linkedGoalId references on events
          state.events.forEach((ev) => {
            if (ev.linkedGoalId === id) {
              ev.linkedGoalId = null;
              touchRecord(ev);
            }
          });
          // Clear goalId on recurring rules
          state.recurring.forEach((r) => {
            if (r.goalId === id) {
              r.goalId = null;
              touchRecord(r);
            }
          });
          saveData();
          renderAll();
        }
      } else if (action === "add-saving") {
        const input = document.querySelector(`[data-goal-input="${id}"]`);
        if (!input) return;
        const amt = parseFloat(input.value);
        if (isNaN(amt) || amt <= 0) return;
        const goal = state.goals.find((g) => g.id === id);
        if (!goal) return;
        // Manual contribution — add to baseline (no transaction record)
        goal.saved = (Number(goal.saved) || 0) + amt;
        touchRecord(goal);
        saveData();
        renderAll();
        showToast("Savings updated");
      } else if (action === "suggest-goal-amount") {
        // Quick-fill the goal input with the suggested amount
        const amt = btn.dataset.amt;
        const input = document.querySelector(`[data-goal-input="${id}"]`);
        if (input && amt) {
          input.value = amt;
          input.focus();
        }
      } else if (action === "quick-goal-amt") {
        // One-tap chip: directly add this amount to the goal
        const amt = parseFloat(btn.dataset.amt);
        if (isNaN(amt) || amt <= 0) return;
        const goal = state.goals.find((g) => g.id === id);
        if (!goal) return;
        const liquid = liquidAccounts ? liquidAccounts() : [];
        const acct = liquid[0] ? liquid[0].id : null;
        state.expenses.push(touchRecord({
          id: uid(),
          type: "expense",
          desc: `Saved to ${goal.name}`,
          amount: amt,
          date: todayStr(),
          categoryId: null,
          accountId: acct,
          personId: null,
          goalId: id,
          tags: ["goal-contribution"],
          receipt: null,
        }));
        saveData();
        renderAll();
        showToast(`+${fmt(amt)} → ${goal.name}`);
      }
    });

    // Lock buttons
    $("#lockNowBtn").addEventListener("click", lockNow);
    $("#lockNowBtnDesktop").addEventListener("click", lockNow);

    // Currency
    $("#currencySelect").addEventListener("change", (e) => {
      currency = e.target.value;
      localStorage.setItem(KEYS.currency, currency);
      // Also store in state.settings so it syncs across devices
      setSetting("currency", currency);
      saveData();
      renderAll();
      renderFxRatesList();
    });

    // FX rates
    const fxSaveBtn = $("#fxSaveBtn");
    if (fxSaveBtn) {
      fxSaveBtn.addEventListener("click", () => {
        const from = ($("#fxFromInput")?.value || "").trim().toUpperCase();
        const to = ($("#fxToInput")?.value || "").trim().toUpperCase();
        const rate = parseFloat($("#fxRateInput")?.value);
        if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
          showAlertToast("Enter 3-letter currency codes (e.g. USD, EUR)", "warning");
          return;
        }
        if (from === to) {
          showAlertToast("From and To currencies must differ", "warning");
          return;
        }
        if (isNaN(rate) || rate <= 0) {
          showAlertToast("Rate must be a positive number", "warning");
          return;
        }
        if (!state.fxRates) state.fxRates = {};
        state.fxRates[`${from}_${to}`] = rate;
        // Also store the inverse for convenience
        state.fxRates[`${to}_${from}`] = 1 / rate;
        // Stamp both directions so cross-device sync picks them up
        if (!state.mapTimestamps) state.mapTimestamps = {};
        if (!state.mapTimestamps.fxRates) state.mapTimestamps.fxRates = {};
        const now = Date.now();
        state.mapTimestamps.fxRates[`${from}_${to}`] = now;
        state.mapTimestamps.fxRates[`${to}_${from}`] = now;
        // Clear any previous tombstones for these keys
        if (state.deletions && state.deletions.fxRates) {
          delete state.deletions.fxRates[`${from}_${to}`];
          delete state.deletions.fxRates[`${to}_${from}`];
        }
        saveData();
        renderFxRatesList();
        showToast(`💱 Saved 1 ${from} = ${rate} ${to}`);
        $("#fxFromInput").value = "";
        $("#fxToInput").value = "";
        $("#fxRateInput").value = "";
      });
    }
    renderFxRatesList();

    // Language selector
    const langSel = $("#languageSelect");
    if (langSel && window.i18n) {
      langSel.value = window.i18n.getLocale();
      langSel.addEventListener("change", (e) => {
        window.i18n.setLocale(e.target.value);
        showToast("✓ Language updated");
      });
    }

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

      // Re-derive new key first; only update the stored hash AFTER re-encryption succeeds.
      // Otherwise a deriveKey failure would leave the password hash mismatched with the
      // still-old encryption key, locking the user out on next launch.
      let newKey;
      try {
        newKey = await deriveKey(newPwd);
      } catch (e) {
        console.error("Failed to derive key from new password", e);
        alert("Could not change password — your data is unchanged. Try again.");
        return;
      }
      const previousKey = cryptoKey;
      try {
        cryptoKey = newKey;
        cachedPassword = newPwd;
        saveData(); // Re-saves with the new key
        // Only commit the hash after a successful re-save with the new key
        localStorage.setItem(KEYS.pwd, await sha256(newPwd));
      } catch (e) {
        // Roll back to old key so user can still read their data
        cryptoKey = previousKey;
        console.error("Failed to re-encrypt with new password", e);
        alert("Could not save with new password — kept the old one.");
        return;
      }
      // Biometric blob holds the old password — clear it so user re-enrolls
      if (localStorage.getItem(BIO_CRED_KEY) || localStorage.getItem(BIO_PWD_KEY)) {
        localStorage.removeItem(BIO_CRED_KEY);
        localStorage.removeItem(BIO_PWD_KEY);
        showToast("Password changed · re-enable biometric in Security");
      } else {
        showToast("Password changed");
      }
    });

    // Lock now
    $("#lockNowBtn")?.addEventListener("click", () => {
      lockNow();
    });

    // Biometric enrollment buttons
    const bioEnrollBtn = $("#bioEnrollBtn");
    const bioDisableBtn = $("#bioDisableBtn");
    function refreshBioButtons() {
      const isReg = !!localStorage.getItem(BIO_CRED_KEY) && !!localStorage.getItem(BIO_PWD_KEY);
      const supported = !!window.PublicKeyCredential;
      if (bioEnrollBtn) bioEnrollBtn.hidden = !supported || isReg;
      if (bioDisableBtn) bioDisableBtn.hidden = !supported || !isReg;
    }
    refreshBioButtons();
    if (bioEnrollBtn) {
      bioEnrollBtn.addEventListener("click", async () => {
        // Use the in-memory password from the active session — user is already authenticated.
        // Avoids prompt() which breaks the user-gesture chain on iOS Safari for WebAuthn create().
        if (!cachedPassword) {
          showToast("Lock and unlock once first, then enable biometric.");
          return;
        }
        // Verify platform authenticator availability before attempting enrollment
        if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function") {
          try {
            const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            if (!available) {
              showToast("No Face ID / Touch ID / Windows Hello detected on this device.");
              return;
            }
          } catch (e) { /* fall through */ }
        }
        const ok = await registerBiometric(cachedPassword);
        if (ok) refreshBioButtons();
      });
    }
    if (bioDisableBtn) {
      bioDisableBtn.addEventListener("click", () => {
        if (!confirm("Disable biometric unlock on this device?")) return;
        disableBiometric();
        refreshBioButtons();
      });
    }

    // Skip delete confirmations toggle
    const skipDelToggle = $("#skipDeleteConfirmToggle");
    if (skipDelToggle) {
      skipDelToggle.checked = !!state.settings.skipDeleteConfirm;
      skipDelToggle.addEventListener("change", (e) => {
        setSetting("skipDeleteConfirm", e.target.checked);
        saveData();
        showToast(e.target.checked ? "Delete confirmations off" : "Delete confirmations on");
      });
    }

    // Compact mode toggle
    const compactToggle = $("#compactModeToggle");
    if (compactToggle) {
      compactToggle.checked = !!state.settings?.compactMode;
      // Apply on init if already on
      if (state.settings?.compactMode) {
        document.documentElement.classList.add("compact-mode");
      }
      compactToggle.addEventListener("change", (e) => {
        setSetting("compactMode", e.target.checked);
        saveData();
        document.documentElement.classList.toggle("compact-mode", e.target.checked);
        showToast(e.target.checked ? "📏 Compact mode on" : "Default density");
      });
    }

    // Default account / category for Add Transaction
    populateDefaultsSelects();
    $("#defaultAccountSelect")?.addEventListener("change", (e) => {
      setSetting("defaultAccountId", e.target.value || null);
      saveData();
      showToast(e.target.value ? "Default account saved" : "Default account cleared");
    });
    $("#defaultCategorySelect")?.addEventListener("change", (e) => {
      setSetting("defaultCategoryId", e.target.value || null);
      saveData();
      showToast(e.target.value ? "Default category saved" : "Default category cleared");
    });

    // Settings search filter
    const settingsSearch = $("#settingsSearchInput");
    if (settingsSearch) {
      settingsSearch.addEventListener("input", filterSettingsCards);
    }

    // Notification preference toggles
    [
      ["#notifyCat80Toggle", "cat80"],
      ["#notifyCat100Toggle", "cat100"],
      ["#notifyTotalOverToggle", "totalOver"],
      ["#notifyStatementToggle", "statementClose"],
      ["#notifyStaleRecurringToggle", "staleRecurring"],
    ].forEach(([sel, key]) => {
      const el = $(sel);
      if (!el) return;
      el.checked = notifEnabled(key);
      el.addEventListener("change", (e) => {
        setNotifPref(key, e.target.checked);
        saveData();
        showToast(e.target.checked ? "Notification enabled" : "Notification muted");
      });
    });

    // Browser/system notifications toggle (shows OS notifications even when app is closed)
    const sysNotifEl = $("#notifySystemToggle");
    if (sysNotifEl) {
      const supported = typeof Notification !== "undefined";

      // Show iOS Safari hint when not installed to Home Screen — Notifications API
      // only works in installed PWAs on iOS 16.4+, not in regular Safari tabs.
      const ua = navigator.userAgent || "";
      const isIos = /iPhone|iPad|iPod/i.test(ua);
      const isStandalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
        || window.navigator.standalone === true;
      const iosHint = $("#notifyIosHint");
      if (iosHint && isIos && !isStandalone) {
        iosHint.hidden = false;
      }

      if (!supported) {
        sysNotifEl.disabled = true;
        sysNotifEl.checked = false;
      } else {
        sysNotifEl.checked = !!state.settings.notifyEnableSystem && Notification.permission === "granted";
        sysNotifEl.addEventListener("change", async (e) => {
          if (e.target.checked) {
            try {
              const perm = await Notification.requestPermission();
              if (perm === "granted") {
                setSetting("notifyEnableSystem", true);
                saveData();
                showToast("🔔 System notifications enabled");
                try { new Notification("Pocket Budget", { body: "You'll get notified about updates and alerts.", icon: "icon-192.svg" }); } catch (_) {}
              } else {
                e.target.checked = false;
                showAlertToast("Notification permission denied — enable it in your browser settings", "warning");
              }
            } catch (err) {
              e.target.checked = false;
              showAlertToast("Could not request notification permission", "danger");
            }
          } else {
            setSetting("notifyEnableSystem", false);
            saveData();
            showToast("System notifications off");
          }
        });
      }
    }

    // Theme accent color
    document.querySelectorAll(".accent-swatch").forEach((sw) => {
      sw.addEventListener("click", () => {
        const hex = sw.dataset.accent;
        applyAccentColor(hex);
        setSetting("accentColor", hex);
        saveData();
        loadAccentFromState();
        showToast("Accent color updated");
      });
    });
    $("#accentCustomInput")?.addEventListener("change", (e) => {
      const hex = e.target.value;
      applyAccentColor(hex);
      setSetting("accentColor", hex);
      saveData();
      loadAccentFromState();
      showToast("Custom accent saved");
    });
    $("#accentResetBtn")?.addEventListener("click", () => {
      applyAccentColor(null);
      setSetting("accentColor", null);
      saveData();
      loadAccentFromState();
      showToast("Reset to default accent");
    });

    // Reset specific data
    $("#resetTxnsBtn")?.addEventListener("click", () => {
      const n = (state.expenses || []).length;
      if (!n) { showToast("No transactions to clear"); return; }
      if (!confirm(`Delete all ${n} transactions? Accounts, categories, and goals stay. This cannot be undone.`)) return;
      state.expenses.forEach((e) => tombstoneRecord("expenses", e.id));
      state.expenses = [];
      saveData();
      renderAll();
      showToast(`Cleared ${n} transactions`);
    });
    $("#resetReceiptsBtn")?.addEventListener("click", () => {
      const withReceipts = (state.expenses || []).filter((e) => e.receipt);
      if (!withReceipts.length) { showToast("No receipts attached"); return; }
      if (!confirm(`Strip ${withReceipts.length} receipt photo${withReceipts.length === 1 ? "" : "s"}? Transactions stay. This cannot be undone.`)) return;
      withReceipts.forEach((e) => {
        delete e.receipt;
        touchRecord(e);
      });
      saveData();
      renderAll();
      showToast(`Stripped ${withReceipts.length} receipt${withReceipts.length === 1 ? "" : "s"}`);
    });
    $("#resetPresetsBtn")?.addEventListener("click", () => {
      const n = (state.presets || []).length;
      if (!n) { showToast("No presets to clear"); return; }
      if (!confirm(`Delete all ${n} quick-add presets? This cannot be undone.`)) return;
      state.presets.forEach((p) => tombstoneRecord("presets", p.id));
      state.presets = [];
      saveData();
      renderAll();
      showToast(`Cleared ${n} preset${n === 1 ? "" : "s"}`);
    });
    $("#resetEventsBtn")?.addEventListener("click", () => {
      const n = (state.events || []).length;
      if (!n) { showToast("No events to clear"); return; }
      if (!confirm(`Delete all ${n} event${n === 1 ? "" : "s"}? Linked transactions stay but lose their event tag. This cannot be undone.`)) return;
      const ids = new Set(state.events.map((ev) => ev.id));
      state.events.forEach((ev) => tombstoneRecord("events", ev.id));
      state.events = [];
      // Untag transactions
      (state.expenses || []).forEach((ex) => {
        if (ex.eventId && ids.has(ex.eventId)) {
          delete ex.eventId;
          delete ex.eventLineItemId;
          touchRecord(ex);
        }
      });
      saveData();
      renderAll();
      showToast(`Cleared ${n} event${n === 1 ? "" : "s"}`);
    });
    $("#resetRecurringBtn")?.addEventListener("click", () => {
      const n = (state.recurring || []).length;
      if (!n) { showToast("No recurring rules to clear"); return; }
      if (!confirm(`Delete all ${n} recurring rule${n === 1 ? "" : "s"}? Existing transactions stay. This cannot be undone.`)) return;
      state.recurring.forEach((r) => tombstoneRecord("recurring", r.id));
      state.recurring = [];
      saveData();
      renderAll();
      showToast(`Cleared ${n} rule${n === 1 ? "" : "s"}`);
    });

    // Export
    $("#exportBtn").addEventListener("click", () => {
      const payload = {
        _meta: {
          app: "pocket-budget",
          version: 1,
          exportedAt: new Date().toISOString(),
          txnCount: (state.expenses || []).length,
          categoriesCount: (state.categories || []).length,
          accountsCount: (state.accounts || []).length,
        },
        ...state,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pocket-budget-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setSetting("lastBackupAt", Date.now());
      saveData();
      renderBackupHealth();
      showToast(`Exported ${payload._meta.txnCount} transaction${payload._meta.txnCount === 1 ? "" : "s"}`);
    });

    // Email summary — generate plain-text monthly report and open mailto:
    $("#emailSummaryBtn")?.addEventListener("click", () => {
      try {
        const month = currentMonth();
        const monthExpenses = state.expenses.filter(
          (e) => monthKey(e.date) === month && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
        );
        const monthIncomes = state.expenses.filter((e) => monthKey(e.date) === month && e.type === "income");
        const totalSpent = monthExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const totalIncome = monthIncomes.reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const net = totalIncome - totalSpent;

        // Per-category breakdown
        const byCat = {};
        monthExpenses.forEach((e) => {
          const cat = state.categories.find((c) => c.id === e.categoryId);
          const name = cat ? cat.name : "Uncategorized";
          byCat[name] = (byCat[name] || 0) + (Number(e.amount) || 0);
        });
        const catLines = Object.entries(byCat)
          .sort((a, b) => b[1] - a[1])
          .map(([name, amt]) => `  - ${name}: ${fmt(amt)}`)
          .join("\n");

        // Top 5 transactions
        const top = [...monthExpenses]
          .sort((a, b) => Number(b.amount) - Number(a.amount))
          .slice(0, 5)
          .map((e) => `  - ${e.date}  ${e.desc || "(no description)"}  ${fmt(e.amount)}`)
          .join("\n");

        const subject = `Pocket Budget — ${month} summary`;
        const body =
`Pocket Budget — ${month}

Income:    ${fmt(totalIncome)}
Spent:     ${fmt(totalSpent)}
Net:       ${fmt(net)}
Txns:      ${monthExpenses.length}

By Category:
${catLines || "  (none)"}

Top Transactions:
${top || "  (none)"}

— sent from Pocket Budget`;
        const url = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        // Some platforms block long mailto URLs (~2k char limit). Truncate gracefully.
        const finalBody = url.length > 2000 ? body.slice(0, 1500) + "\n…(truncated)" : body;
        const finalUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(finalBody)}`;
        // Use a temp anchor click — more reliable than window.location across browsers
        const a = document.createElement("a");
        a.href = finalUrl;
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
        showToast("📧 Email draft opened");
      } catch (err) {
        showAlertToast("Could not generate email summary", "danger");
        console.error(err);
      }
    });

    // Share read-only snapshot — generates a base64 data URL with balances/totals only (no transactions)
    $("#shareSnapshotBtn")?.addEventListener("click", async () => {
      try {
        const month = currentMonth();
        const monthExpenses = state.expenses.filter(
          (e) => monthKey(e.date) === month && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
        );
        const totalSpent = monthExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const monthIncomes = state.expenses.filter((e) => monthKey(e.date) === month && e.type === "income");
        const totalIncome = monthIncomes.reduce((s, e) => s + (Number(e.amount) || 0), 0);

        const accountSnaps = (state.accounts || []).map((a) => ({
          name: a.name,
          balance: typeof accountBalance === "function" ? accountBalance(a.id) : 0,
          type: a.type,
        }));
        const goalSnaps = (state.goals || []).map((g) => ({
          name: g.name,
          saved: Number(g.saved) || 0,
          target: Number(g.target) || 0,
        }));
        const catSnaps = (state.categories || []).map((c) => {
          const spent = monthExpenses
            .filter((e) => e.categoryId === c.id)
            .reduce((s, e) => s + (Number(e.amount) || 0), 0);
          return { name: c.name, spent, limit: Number(c.limit) || 0 };
        });
        const snapshot = {
          app: "pocket-budget-snapshot",
          v: 1,
          generatedAt: Date.now(),
          month,
          totals: { income: totalIncome, spent: totalSpent, net: totalIncome - totalSpent },
          accounts: accountSnaps,
          goals: goalSnaps,
          categories: catSnaps,
        };
        const json = JSON.stringify(snapshot);
        // Base64-encode safely (UTF-8 friendly, chunk to avoid call-stack limits)
        const bytes = new TextEncoder().encode(json);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        const b64 = btoa(bin);
        // Build a printable text summary for sharing
        const textSummary =
`Pocket Budget — Read-only Snapshot — ${month}
Income: ${fmt(totalIncome)}  Spent: ${fmt(totalSpent)}  Net: ${fmt(totalIncome - totalSpent)}
Generated: ${new Date().toLocaleString()}

Accounts: ${accountSnaps.length}, Goals: ${goalSnaps.length}, Categories: ${catSnaps.length}

(Snapshot data — copy and share)
${b64}`;
        // Prefer Web Share API on mobile
        if (navigator.share) {
          try {
            await navigator.share({ title: "Pocket Budget snapshot", text: textSummary });
            showToast("🤝 Snapshot shared");
            return;
          } catch (_) { /* user cancelled — fall through to copy */ }
        }
        try {
          await navigator.clipboard.writeText(textSummary);
          showToast("🤝 Snapshot copied to clipboard");
        } catch (_) {
          // Final fallback: download as text file
          const blob = new Blob([textSummary], { type: "text/plain" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `pocket-budget-snapshot-${month}.txt`;
          a.click();
          URL.revokeObjectURL(url);
          showToast("🤝 Snapshot saved");
        }
      } catch (err) {
        showAlertToast("Could not generate snapshot", "danger");
        console.error(err);
      }
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
          // Validate: must look like a budget app export (has at least one expected key)
          const hasShape = data && typeof data === "object" && !Array.isArray(data) && (
            Array.isArray(data.expenses) ||
            Array.isArray(data.categories) ||
            Array.isArray(data.accounts) ||
            (data._meta && data._meta.app === "pocket-budget")
          );
          if (!hasShape) {
            alert("This doesn't look like a Pocket Budget export. Cancelled.");
            return;
          }
          const txnCount = Array.isArray(data.expenses) ? data.expenses.length : 0;
          const exportedAt = data._meta?.exportedAt
            ? new Date(data._meta.exportedAt).toLocaleString()
            : "unknown date";
          if (!confirm(`Replace ALL current data with imported file?\n\nFile contains: ${txnCount} transactions\nExported: ${exportedAt}\n\nThis cannot be undone.`)) return;
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
            billNegotiations: data.billNegotiations || [],
            incomeSources: data.incomeSources || [],
            events: data.events || [],
            fxRates: data.fxRates || {},
            creditFreezes: data.creditFreezes || {},
            annualReports: data.annualReports || {},
            deletions: data.deletions || {},
            mapTimestamps: data.mapTimestamps || {},
            settingsTimestamps: data.settingsTimestamps || {},
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

    // Force app update — unregister SW, delete caches, hard reload
    $("#forceUpdateBtn")?.addEventListener("click", async () => {
      if (!confirm("This will clear the app's cache and reload with the latest code. Your data is safe. Continue?")) return;
      try {
        showToast("Clearing cache…");
        // Unregister all service workers
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        // Delete all caches
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
        showToast("Cache cleared. Reloading…");
        // The boolean argument to reload() is deprecated and ignored in modern browsers.
        setTimeout(() => location.reload(), 500);
      } catch (e) {
        console.error("Force update failed:", e);
        alert("Failed: " + (e.message || e.name));
      }
    });

    // Clear all
    $("#clearAllBtn").addEventListener("click", () => {
      if (confirm("Delete ALL budget data? This cannot be undone.")) {
        // Tombstone every existing record so sync doesn't resurrect it from another device.
        const now = Date.now();
        const tomb = (collection, ids) => {
          if (!ids.length) return;
          if (!state.deletions[collection]) state.deletions[collection] = {};
          ids.forEach((id) => { state.deletions[collection][id] = now; });
        };
        const newDeletions = { ...(state.deletions || {}) };
        const collectionMap = {
          categories: state.categories,
          expenses: state.expenses,
          goals: state.goals,
          presets: state.presets,
          recurring: state.recurring,
          cards: state.cards,
          creditScores: state.creditScores,
          accounts: state.accounts,
          people: state.people,
          creditInquiries: state.creditInquiries,
          negativeItems: state.negativeItems,
          limitIncreases: state.limitIncreases,
          creditGoals: state.creditGoals,
          billNegotiations: state.billNegotiations,
          incomeSources: state.incomeSources,
          events: state.events,
        };
        Object.keys(collectionMap).forEach((key) => {
          if (!newDeletions[key]) newDeletions[key] = {};
          (collectionMap[key] || []).forEach((rec) => {
            newDeletions[key][rec.id] = now;
          });
        });
        // Tombstone map-collection keys too
        ["monthlyIncome", "creditFreezes", "annualReports", "fxRates"].forEach((key) => {
          if (!newDeletions[key]) newDeletions[key] = {};
          Object.keys(state[key] || {}).forEach((mk) => {
            newDeletions[key][mk] = now;
          });
        });

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
          billNegotiations: [],
          incomeSources: [],
          events: [],
          fxRates: {},
          deletions: newDeletions,
          mapTimestamps: {},
          settingsTimestamps: {},
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

  /* ---------- Global Search ---------- */
  function initGlobalSearch() {
    document.addEventListener("keydown", (e) => {
      // Cmd/Ctrl + K opens search
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openGlobalSearch();
      }
    });

    $("#globalSearchClose")?.addEventListener("click", closeGlobalSearch);
    $("#globalSearchOverlay")?.addEventListener("click", (e) => {
      if (e.target.id === "globalSearchOverlay") closeGlobalSearch();
    });

    const input = $("#globalSearchInput");
    if (input) {
      input.addEventListener("input", (e) => renderGlobalSearchResults(e.target.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeGlobalSearch();
      });
    }
  }

  function openGlobalSearch() {
    if ($("#app").hidden) return;
    $("#globalSearchOverlay").hidden = false;
    $("#globalSearchInput").value = "";
    renderGlobalSearchResults("");
    setTimeout(() => $("#globalSearchInput").focus(), 50);
  }

  function closeGlobalSearch() {
    $("#globalSearchOverlay").hidden = true;
  }

  function renderGlobalSearchResults(q) {
    const el = $("#globalSearchResults");
    if (!el) return;
    const query = q.toLowerCase().trim();
    if (!query) {
      el.innerHTML = '<p class="empty">Type to search. Try "starbucks", "$50", or "starbucks last week".</p>';
      return;
    }

    // Smart parse: extract amount (e.g. "$50" or "50.25") and date keywords ("last week", "this month")
    let textPart = query;
    let amountFilter = null;
    const amtMatch = query.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
    if (amtMatch) {
      amountFilter = parseFloat(amtMatch[1]);
      textPart = textPart.replace(amtMatch[0], "").trim();
    }
    let dateRangeFilter = null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayMs = 86400000;
    const fmtDate = (d) => localDateStr(d);
    if (/\blast\s*week\b/.test(query)) {
      const start = new Date(today.getTime() - 7 * dayMs);
      dateRangeFilter = { from: fmtDate(start), to: fmtDate(today) };
      textPart = textPart.replace(/\blast\s*week\b/, "").trim();
    } else if (/\bthis\s*week\b/.test(query)) {
      const day = today.getDay();
      const monday = new Date(today.getTime() - ((day + 6) % 7) * dayMs);
      dateRangeFilter = { from: fmtDate(monday), to: fmtDate(today) };
      textPart = textPart.replace(/\bthis\s*week\b/, "").trim();
    } else if (/\blast\s*month\b/.test(query)) {
      const m = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      dateRangeFilter = { from: fmtDate(m), to: fmtDate(end) };
      textPart = textPart.replace(/\blast\s*month\b/, "").trim();
    } else if (/\bthis\s*month\b/.test(query)) {
      const m = new Date(today.getFullYear(), today.getMonth(), 1);
      dateRangeFilter = { from: fmtDate(m), to: fmtDate(today) };
      textPart = textPart.replace(/\bthis\s*month\b/, "").trim();
    } else if (/\btoday\b/.test(query)) {
      dateRangeFilter = { from: fmtDate(today), to: fmtDate(today) };
      textPart = textPart.replace(/\btoday\b/, "").trim();
    } else if (/\byesterday\b/.test(query)) {
      const y = new Date(today.getTime() - dayMs);
      dateRangeFilter = { from: fmtDate(y), to: fmtDate(y) };
      textPart = textPart.replace(/\byesterday\b/, "").trim();
    }
    textPart = textPart.replace(/\s+/g, " ").trim();

    const matches = (str) => {
      if (!textPart) return true;
      return str && str.toLowerCase().includes(textPart);
    };

    const txnHits = state.expenses
      .filter((e) => {
        if (textPart && !(matches(e.desc) || (e.tags || []).some(matches))) return false;
        if (amountFilter != null) {
          const diff = Math.abs((Number(e.amount) || 0) - amountFilter);
          if (diff > 0.01) return false;
        }
        if (dateRangeFilter && e.date) {
          if (e.date < dateRangeFilter.from || e.date > dateRangeFilter.to) return false;
        }
        return true;
      })
      .slice(0, 10)
      .map((e) => {
        const cat = state.categories.find((c) => c.id === e.categoryId);
        return {
          icon: e.type === "income" ? "💰" : "💸",
          title: e.desc || "(no description)",
          sub: `${e.date} · ${cat ? cat.name : "Uncategorized"} · ${fmt(e.amount)}`,
          action: () => { closeGlobalSearch(); openExpenseModal(e); },
        };
      });

    // Cards/people/etc. only match by text — skip if query has no text part
    const cardHits = textPart ? state.cards.filter((c) => matches(c.name) || matches(c.issuer)).map((c) => {
      const bal = cardCurrentBalance(c);
      return {
        icon: "💳",
        title: c.name,
        sub: c.issuer ? `${c.issuer} · Balance ${fmt(bal)}` : `Balance ${fmt(bal)}`,
        action: () => { closeGlobalSearch(); $('[data-tab="credit"]').click(); },
      };
    }) : [];

    const peopleHits = state.people.filter((p) => matches(p.name) || matches(p.relation)).map((p) => ({
      icon: "👤",
      title: p.name,
      sub: p.relation || "",
      action: () => { closeGlobalSearch(); $('[data-tab="family"]').click(); },
    }));

    const presetHits = state.presets.filter((p) => matches(p.desc)).slice(0, 5).map((p) => ({
      icon: p.icon || "💸",
      title: p.desc,
      sub: `Preset · ${fmt(p.amount)}`,
      action: () => { closeGlobalSearch(); openExpenseModal({ ...p, type: p.type, id: null }); },
    }));

    const accountHits = state.accounts.filter((a) => matches(a.name)).map((a) => ({
      icon: "🏦",
      title: a.name,
      sub: `${a.type} · ${fmt(accountBalance(a.id))}`,
      action: () => { closeGlobalSearch(); $('[data-tab="balances"]').click(); },
    }));

    const goalHits = state.goals.filter((g) => matches(g.name)).map((g) => ({
      icon: "🎯",
      title: g.name,
      sub: `Goal · ${fmt(goalSavedTotal(g))} of ${fmt(g.target)}`,
      action: () => { closeGlobalSearch(); $('[data-tab="balances"]').click(); },
    }));

    const allGroups = [
      { name: "Transactions", items: txnHits },
      { name: "Cards", items: cardHits },
      { name: "Family", items: peopleHits },
      { name: "Accounts", items: accountHits },
      { name: "Goals", items: goalHits },
      { name: "Presets", items: presetHits },
    ].filter((g) => g.items.length);

    if (!allGroups.length) {
      el.innerHTML = '<p class="empty">No matches.</p>';
      return;
    }

    let html = "";
    let idx = 0;
    allGroups.forEach((g) => {
      html += `<div class="search-group-label">${g.name}</div>`;
      g.items.forEach((item) => {
        html += `
          <button class="search-result" data-idx="${idx}">
            <span class="search-result-icon">${item.icon}</span>
            <div class="search-result-text">
              <div class="search-result-title">${escapeHtml(item.title)}</div>
              <div class="search-result-sub">${escapeHtml(item.sub)}</div>
            </div>
          </button>`;
        idx += 1;
      });
    });
    el.innerHTML = html;

    // Wire actions
    const flat = allGroups.flatMap((g) => g.items);
    el.querySelectorAll(".search-result").forEach((btn, i) => {
      btn.addEventListener("click", () => {
        if (flat[i]) flat[i].action();
      });
    });
  }
  function initSwipeGestures() {
    // Pull-to-refresh: tug down at the top of the dashboard to trigger sync pull
    let pullStartY = 0;
    let pulling = false;
    let pullIndicator = null;

    const ensurePullIndicator = () => {
      if (pullIndicator) return pullIndicator;
      pullIndicator = document.createElement("div");
      pullIndicator.id = "pullToRefresh";
      pullIndicator.style.cssText = "position:fixed;top:0;left:50%;transform:translateX(-50%) translateY(-100%);background:var(--primary);color:#fff;padding:0.5rem 1rem;border-radius:0 0 var(--radius-sm) var(--radius-sm);font-size:0.85rem;font-weight:600;z-index:1000;transition:transform 0.2s;pointer-events:none;";
      pullIndicator.textContent = "↓ Pull to sync";
      document.body.appendChild(pullIndicator);
      return pullIndicator;
    };

    document.addEventListener("touchstart", (e) => {
      // Only trigger when scrolled to top of page
      if (window.scrollY > 5) return;
      const dashboard = document.getElementById("dashboard");
      if (!dashboard || !dashboard.classList.contains("active")) return;
      pullStartY = e.touches[0].clientY;
      pulling = true;
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - pullStartY;
      if (dy <= 0) return;
      const ind = ensurePullIndicator();
      const offset = Math.min(60, dy * 0.5);
      ind.style.transform = `translateX(-50%) translateY(${offset - 60}px)`;
      ind.textContent = dy > 100 ? "↓ Release to sync" : "↓ Pull to sync";
    }, { passive: true });

    document.addEventListener("touchend", (e) => {
      if (!pulling) return;
      pulling = false;
      const dy = (e.changedTouches[0].clientY) - pullStartY;
      if (pullIndicator) {
        pullIndicator.style.transform = "translateX(-50%) translateY(-100%)";
      }
      if (dy > 100) {
        // Trigger sync
        if (localStorage.getItem(KEYS.syncToken) && localStorage.getItem(KEYS.syncGistId) && cryptoKey) {
          showToast("Syncing…");
          syncPull({ skipConfirm: true, silent: true }).catch(() => {});
        }
      }
    }, { passive: true });

    let startX = 0, startY = 0, target = null;
    document.addEventListener("touchstart", (e) => {
      const row = e.target.closest(".txn-item");
      if (!row) return;
      target = row;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (!target) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      // Only swipe if more horizontal than vertical
      if (Math.abs(dy) > Math.abs(dx)) { target = null; return; }
      target.style.transform = `translateX(${dx}px)`;
      target.style.transition = "none";
      // Color hint
      if (dx > 60) target.style.background = "rgba(91, 63, 184, 0.1)"; // edit
      else if (dx < -60) target.style.background = "rgba(239, 68, 68, 0.1)"; // delete
      else target.style.background = "";
    }, { passive: true });

    document.addEventListener("touchend", (e) => {
      if (!target) return;
      const finalDx = parseInt(target.style.transform.replace(/[^-\d]/g, ""), 10) || 0;
      const id = target.dataset.txnRow;
      target.style.transition = "transform 0.2s, background 0.2s";
      target.style.transform = "";
      target.style.background = "";

      if (Math.abs(finalDx) > 100 && id) {
        if (finalDx < 0) {
          // Swipe left = delete
          if (confirmDeleteTxn("Delete this transaction?")) {
            const txn = state.expenses.find((x) => x.id === id);
            tombstoneRecord("expenses", id);
            state.expenses = state.expenses.filter((x) => x.id !== id);
            saveData();
            renderAll();
            if (txn) showUndoToast([txn]);
          }
        } else {
          // Swipe right = edit
          const exp = state.expenses.find((x) => x.id === id);
          if (exp) openExpenseModal(exp);
        }
      }
      target = null;
    });
  }
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

      // Transaction list arrow-key navigation when on Transactions page
      const txnsActive = $('#transactions')?.classList.contains("active");
      if (txnsActive && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Delete" || e.key === "Backspace")) {
        const rows = Array.from(document.querySelectorAll("#expenseList .txn-item[data-txn-row]"));
        if (!rows.length) return;
        const currentIdx = rows.findIndex((r) => r.classList.contains("kbd-focused"));
        if (e.key === "ArrowDown") {
          e.preventDefault();
          rows.forEach((r) => r.classList.remove("kbd-focused"));
          const next = rows[Math.min(rows.length - 1, currentIdx + 1)] || rows[0];
          next.classList.add("kbd-focused");
          next.scrollIntoView({ block: "nearest" });
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          rows.forEach((r) => r.classList.remove("kbd-focused"));
          const prev = rows[Math.max(0, currentIdx - 1)] || rows[0];
          prev.classList.add("kbd-focused");
          prev.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter" && currentIdx >= 0) {
          e.preventDefault();
          const id = rows[currentIdx].dataset.txnRow;
          const exp = state.expenses.find((x) => x.id === id);
          if (exp) openExpenseModal(exp);
        } else if ((e.key === "Delete" || e.key === "Backspace") && currentIdx >= 0) {
          e.preventDefault();
          const id = rows[currentIdx].dataset.txnRow;
          const txn = state.expenses.find((x) => x.id === id);
          if (txn && confirmDeleteTxn("Delete this transaction?")) {
            tombstoneRecord("expenses", id);
            state.expenses = state.expenses.filter((x) => x.id !== id);
            saveData();
            renderAll();
            showUndoToast([txn]);
          }
        }
        return;
      }

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
  /* ---------- Bank CSV Import ---------- */
  let csvParsedRows = null;

  function handleCsvUpload(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      try {
        const rows = parseCsv(text);
        if (!rows.length) {
          showToast("CSV is empty");
          return;
        }
        csvParsedRows = rows;
        renderCsvPreview(rows);
      } catch (err) {
        showToast("Could not parse CSV: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  function parseCsv(text) {
    // Lightweight CSV parser handling quoted fields
    const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
    if (!lines.length) return [];
    const splitLine = (line) => {
      const out = [];
      let cur = "";
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
          else inQuote = !inQuote;
        } else if (c === "," && !inQuote) {
          out.push(cur); cur = "";
        } else {
          cur += c;
        }
      }
      out.push(cur);
      return out.map((s) => s.trim());
    };
    const headers = splitLine(lines[0]).map((h) => h.toLowerCase());
    const rows = lines.slice(1).map((l) => {
      const cells = splitLine(l);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] || ""; });
      return obj;
    });
    return rows;
  }

  function detectCsvFields(row) {
    // Find which columns look like date / description / amount
    const keys = Object.keys(row);
    const dateKey = keys.find((k) => /date|posted/i.test(k));
    const descKey = keys.find((k) => /desc|name|merchant|payee|memo|details/i.test(k));
    const amountKey = keys.find((k) => /amount|debit|credit|value/i.test(k));
    return { dateKey, descKey, amountKey };
  }

  function autoCategorizeRule(desc) {
    const d = (desc || "").toLowerCase();
    const rules = [
      { match: /starbucks|dunkin|coffee|cafe/, cat: "Eating Out" },
      { match: /uber|lyft|gas|shell|chevron|exxon|bp|fuel|parking/, cat: "Transport" },
      { match: /amazon|walmart|target|costco|grocery|trader|whole foods|kroger|safeway/, cat: "Groceries" },
      { match: /netflix|spotify|hulu|disney|youtube|apple|prime|hbo|paramount|peacock|chatgpt|claude|copilot|dropbox|google one/, cat: "Subscriptions" },
      { match: /electric|gas bill|water|sewer|comcast|xfinity|att|verizon|tmobile|internet/, cat: "Utilities" },
      { match: /rent|landlord|mortgage/, cat: "Rent" },
      { match: /restaurant|grubhub|doordash|ubereats|chipotle|mcdonald|burger|pizza/, cat: "Eating Out" },
      { match: /pharmacy|cvs|walgreens|rite aid|copay|doctor|dentist|hospital|clinic|insurance/, cat: "Healthcare" },
      { match: /movie|theater|cinema|concert|ticketmaster|stubhub|steam|playstation|xbox|nintendo/, cat: "Entertainment" },
      { match: /haircut|salon|barber|spa|nails|skincare/, cat: "Personal Care" },
      { match: /best buy|macy|nordstrom|gap|h&m|zara|nike|adidas/, cat: "Shopping" },
    ];
    for (const r of rules) {
      if (r.match.test(d)) return r.cat;
    }
    return null;
  }

  function renderCsvPreview(rows) {
    const el = $("#csvPreview");
    if (!el) return;
    const fields = detectCsvFields(rows[0] || {});

    if (!fields.dateKey || !fields.descKey || !fields.amountKey) {
      el.hidden = false;
      el.innerHTML = `<p class="card-sub" style="color:var(--warning)">⚠️ Couldn't detect date/description/amount columns. Headers found: <strong>${Object.keys(rows[0]).join(", ")}</strong>. Try a different export.</p>`;
      return;
    }

    // Compute category match summary across ALL rows so user sees the impact
    const categoryCounts = {};
    let uncategorized = 0;
    rows.forEach((r) => {
      const cat = autoCategorizeRule(r[fields.descKey]);
      if (cat) {
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      } else {
        uncategorized += 1;
      }
    });
    const sortedCats = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);

    const matchSummary = sortedCats.length
      ? `<div class="csv-cat-summary"><strong>Auto-categorized:</strong> ${
          sortedCats.map(([cat, n]) => `<span class="csv-cat-pill">${escapeHtml(cat)} · ${n}</span>`).join("")
        }${uncategorized > 0 ? `<span class="csv-cat-pill csv-cat-pill-warn">Uncategorized · ${uncategorized}</span>` : ""}</div>`
      : `<div class="csv-cat-summary"><span class="card-sub">⚠️ No auto-categorization matched any of the ${rows.length} rows. They'll all import as Uncategorized — you can recategorize after.</span></div>`;

    const sample = rows.slice(0, 8).map((r) => {
      const cat = autoCategorizeRule(r[fields.descKey]);
      const amt = parseFloat(String(r[fields.amountKey]).replace(/[^-\d.]/g, ""));
      const catCell = cat
        ? `<span class="csv-cat-pill">${escapeHtml(cat)}</span>`
        : `<span class="csv-cat-pill csv-cat-pill-warn">Uncategorized</span>`;
      return `
        <tr>
          <td>${escapeHtml(r[fields.dateKey])}</td>
          <td>${escapeHtml(r[fields.descKey])}</td>
          <td class="right">${isNaN(amt) ? "?" : fmt(Math.abs(amt))}</td>
          <td>${catCell}</td>
        </tr>`;
    }).join("");

    el.hidden = false;
    el.innerHTML = `
      <p class="card-sub" style="margin-top:0.75rem">Found <strong>${rows.length}</strong> rows. Preview (first 8):</p>
      ${matchSummary}
      <table class="csv-table">
        <thead><tr><th>Date</th><th>Description</th><th class="right">Amount</th><th>Category</th></tr></thead>
        <tbody>${sample}</tbody>
      </table>
      <div class="form-row" style="margin-top:0.85rem">
        <label>Default account</label>
        <select id="csvAccountSelect">
          ${state.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join("")}
        </select>
      </div>
      <button id="csvImportBtn" class="btn-primary block" style="margin-top:0.5rem">Import ${rows.length} transactions</button>
    `;

    $("#csvImportBtn").addEventListener("click", () => importCsvRows(fields));
  }

  function importCsvRows(fields) {
    if (!csvParsedRows) return;
    const accountId = $("#csvAccountSelect").value || null;
    let added = 0, skipped = 0, duplicates = 0;

    // Build a quick set of existing keys to prevent duplicate imports of the same file
    const existingKeys = new Set();
    state.expenses.forEach((e) => {
      if (!e.date || !e.desc) return;
      existingKeys.add(`${e.date}|${(e.desc || "").toLowerCase()}|${Number(e.amount).toFixed(2)}`);
    });

    csvParsedRows.forEach((r) => {
      const dateRaw = r[fields.dateKey];
      const desc = r[fields.descKey];
      const amtRaw = r[fields.amountKey];
      const amount = parseFloat(String(amtRaw).replace(/[^-\d.]/g, ""));
      if (!desc || isNaN(amount)) { skipped += 1; return; }

      // Date normalize
      const d = new Date(dateRaw);
      if (isNaN(d.getTime())) { skipped += 1; return; }
      const date = localDateStr(d);

      // Type: negative = expense; positive = income (most US bank exports use this convention)
      const type = amount < 0 ? "expense" : "income";
      const absAmt = Math.abs(amount);

      // Skip duplicates already in state
      const key = `${date}|${String(desc).toLowerCase()}|${absAmt.toFixed(2)}`;
      if (existingKeys.has(key)) { duplicates += 1; return; }
      existingKeys.add(key);

      // Category from rule
      let categoryId = null;
      if (type === "expense") {
        const catName = autoCategorizeRule(desc);
        if (catName) {
          categoryId = state.categories.find(
            (c) => (c.name || "").toLowerCase() === catName.toLowerCase()
          )?.id || null;
        }
      }

      state.expenses.push(touchRecord({
        id: uid(),
        type,
        desc,
        amount: absAmt,
        date,
        categoryId,
        accountId,
        personId: null,
        tags: ["csv-import"],
        receipt: null,
      }));
      added += 1;
    });
    saveData();
    renderAll();
    csvParsedRows = null;
    $("#csvPreview").hidden = true;
    $("#csvFile").value = "";
    const parts = [`Imported ${added}`];
    if (duplicates) parts.push(`${duplicates} duplicates skipped`);
    if (skipped) parts.push(`${skipped} invalid rows`);
    showToast(parts.join(" · "));
  }

  /* ---------- Merge engine for cross-device sync ---------- */
  // Collections that have id-keyed records and should be merged item-by-item
  const MERGE_COLLECTIONS = [
    "categories", "expenses", "goals", "presets", "recurring",
    "cards", "creditScores", "accounts", "people",
    "creditInquiries", "negativeItems", "limitIncreases", "creditGoals",
    "billNegotiations", "incomeSources", "events",
  ];
  // Date-keyed time series — keep newest value per date
  const DATE_SERIES_COLLECTIONS = ["netWorthHistory", "utilHistory"];
  // Map-style settings — merge keys
  const MAP_COLLECTIONS = ["monthlyIncome", "creditFreezes", "annualReports", "fxRates"];

  function recordTimestamp(rec) {
    if (rec.updatedAt) return Number(rec.updatedAt);
    // Fall back: extract creation time from id (uid format = Date.now().toString(36) + 6 random chars)
    if (typeof rec.id === "string" && rec.id.length >= 8) {
      // Date.now() in base36 is currently 8 chars (until ~year 4199), so take the first 8.
      const timePart = rec.id.slice(0, 8);
      const t = parseInt(timePart, 36);
      if (!isNaN(t) && t > 1577836800000 && t < 4102444800000) return t; // 2020 to 2100
    }
    return 0;
  }

  function mergeStates(local, remote) {
    const merged = { ...local };

    // Merge each id-keyed collection
    MERGE_COLLECTIONS.forEach((key) => {
      const localArr = Array.isArray(local[key]) ? local[key] : [];
      const remoteArr = Array.isArray(remote[key]) ? remote[key] : [];
      const localDel = (local.deletions && local.deletions[key]) || {};
      const remoteDel = (remote.deletions && remote.deletions[key]) || {};

      const byId = new Map();
      localArr.forEach((r) => byId.set(r.id, r));
      remoteArr.forEach((r) => {
        const existing = byId.get(r.id);
        if (!existing) byId.set(r.id, r);
        else if (recordTimestamp(r) > recordTimestamp(existing)) {
          // Remote is newer — but if remote has _receiptStripped and local has a real receipt,
          // keep the local receipt to avoid losing it just because cellular sync stripped it.
          if (key === "expenses" && r._receiptStripped && existing.receipt) {
            byId.set(r.id, { ...r, receipt: existing.receipt, _receiptStripped: false });
          } else {
            byId.set(r.id, r);
          }
        }
      });

      // Remove items that have been tombstoned more recently than the record was updated
      const result = [];
      byId.forEach((r) => {
        const localDelTs = localDel[r.id] || 0;
        const remoteDelTs = remoteDel[r.id] || 0;
        const delTs = Math.max(localDelTs, remoteDelTs);
        if (delTs > 0 && delTs > recordTimestamp(r)) return; // deletion wins
        result.push(r);
      });
      merged[key] = result;
    });

    // Merge date-keyed time series — for same date, prefer larger magnitude
    // (snapshots can fluctuate intra-day; the larger value is usually closer to
    // the truth because it was taken after more transactions were recorded).
    DATE_SERIES_COLLECTIONS.forEach((key) => {
      const localArr = Array.isArray(local[key]) ? local[key] : [];
      const remoteArr = Array.isArray(remote[key]) ? remote[key] : [];
      const byDate = new Map();
      localArr.forEach((r) => byDate.set(r.date, r));
      remoteArr.forEach((r) => {
        const existing = byDate.get(r.date);
        if (!existing) {
          byDate.set(r.date, r);
        } else {
          // Pick whichever has the larger numeric value (`value` for net worth, `util` for utilization)
          const valKey = "value" in r ? "value" : "util";
          const a = Math.abs(Number(existing[valKey]) || 0);
          const b = Math.abs(Number(r[valKey]) || 0);
          if (b > a) byDate.set(r.date, r);
        }
      });
      merged[key] = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    });

    // Merge map-style settings (e.g. monthly income overrides) — respect tombstones + timestamps
    MAP_COLLECTIONS.forEach((key) => {
      const lm = (local[key] && typeof local[key] === "object") ? local[key] : {};
      const rm = (remote[key] && typeof remote[key] === "object") ? remote[key] : {};
      const lts = (local.mapTimestamps && local.mapTimestamps[key]) || {};
      const rts = (remote.mapTimestamps && remote.mapTimestamps[key]) || {};
      const ldel = (local.deletions && local.deletions[key]) || {};
      const rdel = (remote.deletions && remote.deletions[key]) || {};
      const out = {};
      // Union of all known keys across both sides
      const allKeys = new Set([...Object.keys(lm), ...Object.keys(rm)]);
      allKeys.forEach((mk) => {
        const localTs = Number(lts[mk]) || 0;
        const remoteTs = Number(rts[mk]) || 0;
        const delTs = Math.max(Number(ldel[mk]) || 0, Number(rdel[mk]) || 0);
        const latestUpdate = Math.max(localTs, remoteTs);
        // Tombstone wins if it's at least as recent as the latest update
        if (delTs > 0 && delTs >= latestUpdate) return;
        // Pick newer side; default to local when both timestamps are equal/missing
        if (remoteTs > localTs && Object.prototype.hasOwnProperty.call(rm, mk)) {
          out[mk] = rm[mk];
        } else if (Object.prototype.hasOwnProperty.call(lm, mk)) {
          out[mk] = lm[mk];
        } else if (Object.prototype.hasOwnProperty.call(rm, mk)) {
          out[mk] = rm[mk];
        }
      });
      merged[key] = out;
    });

    // Merge mapTimestamps (max per key)
    const mergedMapTs = {};
    MAP_COLLECTIONS.forEach((key) => {
      const lts = (local.mapTimestamps && local.mapTimestamps[key]) || {};
      const rts = (remote.mapTimestamps && remote.mapTimestamps[key]) || {};
      const out = { ...rts };
      Object.keys(lts).forEach((k) => {
        out[k] = Math.max(Number(out[k]) || 0, Number(lts[k]) || 0);
      });
      // Drop timestamps for keys that no longer exist in the merged result
      const survivingKeys = Object.keys(merged[key] || {});
      Object.keys(out).forEach((k) => {
        if (!survivingKeys.includes(k)) delete out[k];
      });
      mergedMapTs[key] = out;
    });
    merged.mapTimestamps = mergedMapTs;

    // Merge tombstones (max timestamp per id) — covers id-keyed and map-keyed collections
    const mergedDeletions = {};
    [...MERGE_COLLECTIONS, ...MAP_COLLECTIONS].forEach((key) => {
      const ld = (local.deletions && local.deletions[key]) || {};
      const rd = (remote.deletions && remote.deletions[key]) || {};
      const out = { ...rd };
      Object.keys(ld).forEach((id) => {
        out[id] = Math.max(out[id] || 0, ld[id]);
      });
      mergedDeletions[key] = out;
    });
    merged.deletions = mergedDeletions;

    // Scalar settings: prefer remote unless local was changed more recently
    // For income (legacy global), use the larger non-zero value as a heuristic
    if (Number(remote.income) > 0 && Number(remote.income) !== Number(local.income)) {
      merged.income = Math.max(Number(local.income) || 0, Number(remote.income) || 0);
    }

    // Settings object — merge sub-keys with per-key timestamps so the most recent
    // toggle on any device wins. Falls back to local-wins for keys without timestamps.
    const localSettings = local.settings || {};
    const remoteSettings = remote.settings || {};
    const localSettingsTs = local.settingsTimestamps || {};
    const remoteSettingsTs = remote.settingsTimestamps || {};
    const mergedSettings = {};
    const settingsKeys = new Set([
      ...Object.keys(localSettings),
      ...Object.keys(remoteSettings),
    ]);
    settingsKeys.forEach((k) => {
      if (k === "alertsShown") return; // handled below as a union
      const lts = Number(localSettingsTs[k]) || 0;
      const rts = Number(remoteSettingsTs[k]) || 0;
      if (rts > lts && Object.prototype.hasOwnProperty.call(remoteSettings, k)) {
        mergedSettings[k] = remoteSettings[k];
      } else if (Object.prototype.hasOwnProperty.call(localSettings, k)) {
        mergedSettings[k] = localSettings[k];
      } else {
        mergedSettings[k] = remoteSettings[k];
      }
    });
    mergedSettings.alertsShown = {
      ...((remoteSettings && remoteSettings.alertsShown) || {}),
      ...((localSettings && localSettings.alertsShown) || {}),
    };
    merged.settings = mergedSettings;

    // Merge settings timestamps (max per key)
    const mergedSettingsTs = { ...remoteSettingsTs };
    Object.keys(localSettingsTs).forEach((k) => {
      mergedSettingsTs[k] = Math.max(Number(mergedSettingsTs[k]) || 0, Number(localSettingsTs[k]) || 0);
    });
    merged.settingsTimestamps = mergedSettingsTs;

    return merged;
  }

  function tombstoneRecord(collection, id) {
    if (!state.deletions) state.deletions = {};
    if (!state.deletions[collection]) state.deletions[collection] = {};
    state.deletions[collection][id] = Date.now();
  }

  // Map preset descriptions (lowercase) to the category name they should belong to.
  // Used both during load-time migration and the manual "Re-link presets" button.
  const PRESET_CATEGORY_MAP = {
    // Eating Out
    "coffee": "Eating Out", "lunch": "Eating Out", "dinner out": "Eating Out", "snacks": "Eating Out",
    // Groceries
    "groceries": "Groceries",
    // Transport
    "gas": "Transport", "uber/lyft": "Transport", "public transit": "Transport", "parking": "Transport",
    // Healthcare
    "pharmacy": "Healthcare", "car insurance": "Healthcare", "health insurance": "Healthcare",
    // Personal Care
    "haircut": "Personal Care",
    // Entertainment
    "movie": "Entertainment",
    // Shopping
    "clothing": "Shopping",
    // Subscriptions
    "netflix": "Subscriptions", "spotify": "Subscriptions", "amazon prime": "Subscriptions",
    "disney+": "Subscriptions", "hbo max": "Subscriptions", "apple tv+": "Subscriptions",
    "paramount+": "Subscriptions", "peacock": "Subscriptions", "youtube premium": "Subscriptions",
    "apple icloud": "Subscriptions", "google one": "Subscriptions", "dropbox": "Subscriptions",
    "chatgpt plus": "Subscriptions", "claude pro": "Subscriptions", "github copilot": "Subscriptions",
    "gym": "Subscriptions",
    // Utilities
    "phone bill": "Utilities", "internet": "Utilities", "electric bill": "Utilities", "water bill": "Utilities",
    // Rent
    "rent": "Rent",
  };

  // Walk through state.presets and link each one to its proper category (by name)
  // when its desc matches a known default. Always overwrites null/missing
  // categoryId or pointers to missing categories. Returns the number of
  // presets that were updated.
  function relinkPresetsToCategories() {
    if (!Array.isArray(state.presets) || !state.presets.length) return 0;
    const catByName = new Map();
    state.categories.forEach((c) => catByName.set((c.name || "").toLowerCase(), c.id));
    let updated = 0;
    state.presets = state.presets.map((p) => {
      if (p.type === "income") return p; // Income presets don't have a category
      const key = String(p.desc || "").toLowerCase().trim();
      const wantedCatName = PRESET_CATEGORY_MAP[key];
      if (!wantedCatName) return p; // No mapping for this preset, leave it alone
      const newCatId = catByName.get(wantedCatName.toLowerCase());
      if (!newCatId) return p; // Target category doesn't exist on this device
      if (p.categoryId === newCatId) return p; // Already linked correctly
      updated += 1;
      return { ...p, categoryId: newCatId, updatedAt: Date.now() };
    });
    return updated;
  }

  // Tombstone a key inside a map-style collection (e.g. monthlyIncome[YYYY-MM])
  function tombstoneMapKey(collection, key) {
    if (!state.deletions) state.deletions = {};
    if (!state.deletions[collection]) state.deletions[collection] = {};
    state.deletions[collection][key] = Date.now();
    // Clear any local timestamp so the deletion is unambiguous
    if (state.mapTimestamps && state.mapTimestamps[collection]) {
      delete state.mapTimestamps[collection][key];
    }
  }

  // Stamp a key inside a map-style collection so sync can compare freshness vs. tombstones
  function touchMapKey(collection, key) {
    if (!state.mapTimestamps) state.mapTimestamps = {};
    if (!state.mapTimestamps[collection]) state.mapTimestamps[collection] = {};
    state.mapTimestamps[collection][key] = Date.now();
    // If this key was previously tombstoned, clear the tombstone
    if (state.deletions && state.deletions[collection]) {
      delete state.deletions[collection][key];
    }
  }

  // Update a setting and stamp its per-key timestamp so cross-device sync picks the newest value.
  function setSetting(key, value) {
    if (!state.settings) state.settings = {};
    state.settings[key] = value;
    if (!state.settingsTimestamps) state.settingsTimestamps = {};
    state.settingsTimestamps[key] = Date.now();
  }

  // Populate the default-account and default-category selects in Settings
  function populateDefaultsSelects() {
    const accSel = $("#defaultAccountSelect");
    if (accSel) {
      accSel.innerHTML = '<option value="">— None —</option>' +
        (state.accounts || []).map((a) =>
          `<option value="${a.id}">${escapeHtml(a.name)}</option>`
        ).join("");
      accSel.value = state.settings?.defaultAccountId || "";
    }
    const catSel = $("#defaultCategorySelect");
    if (catSel) {
      catSel.innerHTML = '<option value="">— None —</option>' +
        (state.categories || [])
          .filter((c) => !/^income$/i.test(c.name))
          .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
          .join("");
      catSel.value = state.settings?.defaultCategoryId || "";
    }
  }

  // Live-filter the Settings page by search query
  function filterSettingsCards() {
    const q = ($("#settingsSearchInput")?.value || "").trim().toLowerCase();
    const page = $("#settings");
    if (!page) return;
    const cards = page.querySelectorAll(".card");
    let visibleCount = 0;
    cards.forEach((card) => {
      if (!q) {
        card.hidden = false;
        visibleCount += 1;
        return;
      }
      const text = (card.textContent || "").toLowerCase();
      const match = text.includes(q);
      card.hidden = !match;
      if (match) visibleCount += 1;
    });
    const empty = $("#settingsSearchEmpty");
    if (empty) empty.hidden = !q || visibleCount > 0;
  }

  // Show backup freshness in the Data card
  function renderBackupHealth() {
    const el = $("#backupHealth");
    if (!el) return;
    const last = state.settings?.lastBackupAt;
    if (!last) {
      el.className = "sync-status warning";
      el.innerHTML = "⚠️ No local backup yet — export a JSON to keep your data safe.";
      return;
    }
    const days = Math.floor((Date.now() - last) / 86400000);
    const when = new Date(last).toLocaleString();
    if (days >= 30) {
      el.className = "sync-status warning";
      el.innerHTML = `⚠️ Last backup: ${when} (${days} days ago) — consider exporting again.`;
    } else if (days >= 7) {
      el.className = "sync-status";
      el.innerHTML = `📦 Last backup: ${when} (${days} day${days === 1 ? "" : "s"} ago).`;
    } else {
      el.className = "sync-status success";
      el.innerHTML = `✓ Last backup: ${when}${days === 0 ? " (today)" : ` (${days} day${days === 1 ? "" : "s"} ago)`}.`;
    }
  }

  // Lightweight confirm that respects the "Skip delete confirmations" setting.
  // Use only for txn deletes (not for nuking-all-data, etc.).
  function confirmDeleteTxn(message) {
    if (state.settings?.skipDeleteConfirm) return true;
    return confirm(message || "Delete this transaction?");
  }

  /* ---------- Settings: Account → Category mapping ---------- */
  function renderAccountCategoryMap() {
    const list = $("#accountCatMapList");
    if (!list) return;
    if (!state.accounts || !state.accounts.length) {
      list.innerHTML = '<li class="empty">Add accounts to enable mapping.</li>';
      return;
    }
    const map = (state.settings && state.settings.accountCategoryMap) || {};
    const catOptions = '<option value="">— Use default category —</option>' +
      (state.categories || [])
        .filter((c) => !/^income$/i.test(c.name))
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
    list.innerHTML = state.accounts.map((a) => `
      <li class="acct-cat-map-row" data-acct="${a.id}">
        <span class="acm-name">${escapeHtml(a.name)}</span>
        <select class="acm-select" data-acct="${a.id}">${catOptions}</select>
      </li>
    `).join("");
    // Set selected values
    list.querySelectorAll(".acm-select").forEach((sel) => {
      const acctId = sel.dataset.acct;
      sel.value = map[acctId] || "";
      sel.addEventListener("change", (e) => {
        const newMap = { ...((state.settings && state.settings.accountCategoryMap) || {}) };
        if (e.target.value) {
          newMap[acctId] = e.target.value;
        } else {
          delete newMap[acctId];
        }
        setSetting("accountCategoryMap", newMap);
        saveData();
        showToast("Mapping updated");
      });
    });
  }

  /* ---------- Settings: Notification preferences ---------- */
  // Returns true if the named notification is enabled (defaults to true if unset)
  function notifEnabled(key) {
    const prefs = state.settings && state.settings.notifications;
    if (!prefs || typeof prefs[key] === "undefined") return true;
    return !!prefs[key];
  }
  function setNotifPref(key, val) {
    const prefs = { ...((state.settings && state.settings.notifications) || {}) };
    prefs[key] = !!val;
    setSetting("notifications", prefs);
  }

  /* ---------- Settings: Data Summary ---------- */
  function renderDataSummary() {
    const grid = $("#dataSummaryGrid");
    if (!grid) return;
    const tiles = [
      { label: "Transactions", n: (state.expenses || []).length },
      { label: "Accounts", n: (state.accounts || []).length },
      { label: "Categories", n: (state.categories || []).length },
      { label: "Goals", n: (state.goals || []).length },
      { label: "Events", n: (state.events || []).length },
      { label: "Presets", n: (state.presets || []).length },
      { label: "People", n: (state.people || []).length },
      { label: "Credit cards", n: (state.cards || []).length },
      { label: "Recurring rules", n: (state.recurring || []).length },
      { label: "Receipts", n: (state.expenses || []).filter((e) => e.receipt).length },
    ];
    grid.innerHTML = tiles.map((t) => `
      <div class="data-summary-tile">
        <div class="ds-num">${t.n}</div>
        <div class="ds-label">${t.label}</div>
      </div>
    `).join("");
  }

  /* ---------- Settings: Theme accent color ---------- */
  function applyAccentColor(hex) {
    if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) {
      // Reset
      document.documentElement.style.removeProperty("--primary");
      document.documentElement.style.removeProperty("--primary-hover");
      document.documentElement.style.removeProperty("--primary-soft");
      return;
    }
    const root = document.documentElement;
    root.style.setProperty("--primary", hex);
    // Slightly darker shade for hover
    root.style.setProperty("--primary-hover", shadeHex(hex, -12));
    // Soft tint for backgrounds (mix with white at ~14% opacity feel)
    root.style.setProperty("--primary-soft", hexToSoft(hex));
  }
  function shadeHex(hex, percent) {
    const num = parseInt(hex.replace("#", ""), 16);
    let r = (num >> 16) + Math.round((255 * percent) / 100);
    let g = ((num >> 8) & 0xff) + Math.round((255 * percent) / 100);
    let b = (num & 0xff) + Math.round((255 * percent) / 100);
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  function hexToSoft(hex) {
    const num = parseInt(hex.replace("#", ""), 16);
    const r = (num >> 16) & 0xff;
    const g = (num >> 8) & 0xff;
    const b = num & 0xff;
    // Mix with white at ~88%
    const mix = (c) => Math.round(c + (255 - c) * 0.85);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }
  function loadAccentFromState() {
    const accent = state.settings && state.settings.accentColor;
    if (accent) applyAccentColor(accent);
    // Reflect into UI
    const swatches = document.querySelectorAll(".accent-swatch");
    swatches.forEach((s) => {
      s.classList.toggle("active", s.dataset.accent.toLowerCase() === (accent || "").toLowerCase());
    });
    const customInput = $("#accentCustomInput");
    if (customInput && accent) customInput.value = accent;
  }

  // Purge tombstones older than 90 days — anything that old is unlikely to come back from a stale device
  function purgeOldTombstones() {
    if (!state.deletions) return;
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    let purged = 0;
    Object.keys(state.deletions).forEach((coll) => {
      const map = state.deletions[coll] || {};
      Object.keys(map).forEach((id) => {
        if (map[id] < cutoff) {
          delete map[id];
          purged += 1;
        }
      });
    });
    return purged;
  }

  function touchRecord(rec) {
    rec.updatedAt = Date.now();
    return rec;
  }
  const SYNC_FILENAME = "pocket-budget-encrypted.json";
  let autoSyncTimer = null;
  let dirtyForSync = false;
  let lastSyncedAt = null;
  let pushDebounceTimer = null;
  let syncRetryCount = 0;
  // Track IDs added on the most recent pull, so the UI can highlight them
  const recentlyPulledIds = new Set();
  // Hash of the most recently synced encrypted blob — for echo prevention
  let lastSyncedHash = null;
  // Most recent remote updated_at we've seen — for cheap freshness check
  let lastKnownRemoteUpdate = null;
  // Global flag to prevent concurrent syncs (e.g. Sync Now spam-click)
  let syncInFlight = false;
  const SYNC_HISTORY_KEY = "mb_sync_history";

  function logSyncEvent(action, status, message) {
    try {
      const history = JSON.parse(localStorage.getItem(SYNC_HISTORY_KEY) || "[]");
      history.unshift({
        ts: Date.now(),
        action,    // 'push' | 'pull' | 'check'
        status,    // 'success' | 'error' | 'conflict' | 'offline'
        message: String(message || "").slice(0, 200),
        device: getDeviceLabel(),
      });
      localStorage.setItem(SYNC_HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
    } catch (e) { /* ignore */ }
  }

  // Cheap, fast hash for echo prevention (not cryptographic)
  function quickHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  }

  // Detect cellular via Network Information API
  function isOnCellular() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!c) return false;
    if (c.type === "cellular") return true;
    // 'effectiveType' = 'slow-2g' | '2g' | '3g' | '4g' (for 4G, type may not be 'cellular' but bandwidth limited)
    if (["slow-2g", "2g", "3g"].includes(c.effectiveType)) return true;
    return false;
  }

  function startAutoSync() {
    stopAutoSync();
    // First-launch default: if sync is configured and user never explicitly
    // turned auto-sync on or off, default it ON. Without this, devices only
    // sync when the user taps "Sync Now" manually.
    if (
      localStorage.getItem("mb_auto_sync") === null &&
      localStorage.getItem(KEYS.syncToken) &&
      localStorage.getItem(KEYS.syncGistId)
    ) {
      localStorage.setItem("mb_auto_sync", "true");
      const t = $("#autoSyncToggle");
      if (t) t.checked = true;
    }
    if (localStorage.getItem("mb_auto_sync") !== "true") return;
    if (!localStorage.getItem(KEYS.syncToken)) return;
    // Clear any previous timer before creating a new one — startAutoSync is called from
    // multiple paths (initial load, sync settings change, online event) and would otherwise leak.
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    autoSyncTimer = setInterval(() => {
      if (dirtyForSync && navigator.onLine) {
        syncPush({ silent: true });
      }
    }, 5 * 60 * 1000);

    // Pull every 30 seconds when app is visible (so other devices' changes show up)
    if (window._pullPollTimer) clearInterval(window._pullPollTimer);
    window._pullPollTimer = setInterval(async () => {
      if (document.hidden) return;
      if (!navigator.onLine) return;
      if (!localStorage.getItem(KEYS.syncGistId)) return;

      // Brief visual feedback — flash "syncing…" indicator
      updateSyncIndicator("syncing");
      const restoreStatus = () => {
        updateSyncIndicator(dirtyForSync ? "dirty" : "synced");
      };

      try {
        const token = localStorage.getItem(KEYS.syncToken);
        const gistId = localStorage.getItem(KEYS.syncGistId);
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          if (res.status === 401) {
            showAlertToast("⚠️ Sync token rejected — it may have expired. Generate a new one in Settings.", "danger");
            stopAutoSync();
            return;
          }
          restoreStatus();
          return;
        }
        const data = await res.json();
        if (lastKnownRemoteUpdate && data.updated_at === lastKnownRemoteUpdate) {
          // Nothing new — flash done and restore
          setTimeout(restoreStatus, 400);
          return;
        }
        // Remote has newer data — briefly show "behind" before pulling
        if (lastKnownRemoteUpdate) {
          updateSyncIndicator("behind");
        }
        lastKnownRemoteUpdate = data.updated_at;
        // Newer remote — do a silent pull
        await syncPull({ skipConfirm: true, silent: true });
      } catch (e) {
        restoreStatus();
      }
    }, 15 * 1000);

    // Refresh "X min ago" badge every minute
    if (window._syncBadgeTimer) clearInterval(window._syncBadgeTimer);
    window._syncBadgeTimer = setInterval(() => {
      if (lastSyncedAt) updateSyncIndicator(dirtyForSync ? "dirty" : "synced");
    }, 60 * 1000);

    // Online/offline
    window.removeEventListener("online", handleOnline);
    window.addEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    window.addEventListener("offline", handleOffline);

    // Connection quality changes (Network Information API)
    try {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn && !conn._mbWired) {
        conn.addEventListener("change", () => { try { updateNetStatus(); } catch (e) {} });
        conn._mbWired = true;
      }
    } catch (e) {}

    // Visibility change — pull when returning to app
    document.removeEventListener("visibilitychange", handleVisibility);
    document.addEventListener("visibilitychange", handleVisibility);

    // Initial network status indicator
    updateNetStatus();
  }

  function handleOnline() {
    showAlertToast("📡 Back online", "success");
    if (dirtyForSync) syncPush({ silent: true });
    updateSyncIndicator(dirtyForSync ? "dirty" : "synced");
    // Reset session dismiss so the banner can show again next time we go offline
    window._offlineBannerDismissed = false;
    updateNetStatus();
  }
  function handleOffline() {
    updateSyncIndicator("offline");
    updateNetStatus();
  }

  function updateNetStatus() {
    const online = navigator.onLine;
    // Detect connection quality
    let quality = "ok";
    try {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn && conn.effectiveType) {
        if (["slow-2g", "2g"].includes(conn.effectiveType)) quality = "slow";
        else if (conn.saveData) quality = "slow";
      }
    } catch (e) {}

    // Topbar pill
    const el = $("#netStatusIndicator");
    if (el) {
      let statusClass, statusLabel, statusTitle;
      if (!online) {
        statusClass = "offline";
        statusLabel = "Offline";
        statusTitle = "Offline — changes saved locally, will sync when reconnected";
      } else if (quality === "slow") {
        statusClass = "slow";
        statusLabel = "Slow";
        statusTitle = "Slow connection — sync may take longer than usual";
      } else {
        statusClass = "online";
        statusLabel = "Online";
        statusTitle = "Connected — sync and AI insights available";
      }
      el.className = `net-status ${statusClass}`;
      el.innerHTML = `<span class="label">${statusLabel}</span>`;
      el.title = statusTitle;
      // Make tappable for quick detail (idempotent — re-registering is fine)
      if (!el._wiredClick) {
        el.style.cursor = "pointer";
        el.addEventListener("click", () => {
          const isOnline = navigator.onLine;
          const lastSync = parseInt(localStorage.getItem("mb_last_synced") || "0", 10);
          let detail;
          if (!isOnline) {
            detail = "📵 Offline · changes saved locally";
          } else if (quality === "slow") {
            detail = "🟡 Slow connection · sync may be slow";
          } else if (lastSync) {
            const ago = Date.now() - lastSync;
            const m = Math.floor(ago / 60000);
            detail = m < 1 ? "🟢 Online · synced just now" :
              m < 60 ? `🟢 Online · synced ${m}m ago` :
              `🟢 Online · synced ${Math.floor(m / 60)}h ago`;
          } else {
            detail = "🟢 Online · sync not configured";
          }
          showToast(detail);
        });
        el._wiredClick = true;
      }
    }

    // Lock screen pill (only meaningful when offline — keeps the lock card clean otherwise)
    const lockEl = $("#lockNetStatus");
    if (lockEl) {
      if (!online) {
        lockEl.className = "lock-net-status offline";
        lockEl.innerHTML = "Offline mode";
        lockEl.title = "No internet — you can still unlock and use the app fully";
        lockEl.hidden = false;
      } else {
        lockEl.hidden = true;
      }
    }

    // Show/hide offline banner (only when sync is configured AND lock screen is closed)
    if (!document.body) return; // very early in init
    let banner = $("#offlineBanner");
    const syncConfigured = !!(localStorage.getItem(KEYS.syncToken) && localStorage.getItem(KEYS.syncGistId));
    const lockOpen = !!($("#lockScreen") && $("#lockScreen").classList.contains("open"));
    // User-dismissed for this session (via the × button) — don't re-show until reload or back online → offline cycle
    const sessionDismissed = window._offlineBannerDismissed === true;
    const shouldShowBanner = !online && syncConfigured && !lockOpen && !sessionDismissed;
    if (shouldShowBanner) {
      // Count pending changes since last sync (if dirty flag is true)
      let countMsg = "";
      if (typeof dirtyForSync !== "undefined" && dirtyForSync) {
        countMsg = " · pending changes";
      }
      const msg = `📵 Offline${countMsg} — your changes are saved locally and will sync when you reconnect`;
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "offlineBanner";
        banner.className = "offline-banner";
        banner.innerHTML = `<span>${msg}</span><button type="button" class="offline-banner-retry">🔁 Retry sync</button><button type="button" class="offline-banner-close" aria-label="Dismiss" title="Dismiss">×</button>`;
        document.body.appendChild(banner);
        // Wire the retry button
        const retryBtn = banner.querySelector(".offline-banner-retry");
        if (retryBtn) {
          retryBtn.addEventListener("click", async () => {
            retryBtn.disabled = true;
            retryBtn.textContent = "Trying…";
            try {
              if (typeof syncPush === "function") {
                await syncPush({ silent: false });
              }
            } catch (e) {
              showToast("Retry failed — still offline");
            } finally {
              retryBtn.disabled = false;
              retryBtn.textContent = "🔁 Retry sync";
            }
          });
        }
        // Wire the dismiss × button — hides banner for this session
        const closeBtn = banner.querySelector(".offline-banner-close");
        if (closeBtn) {
          closeBtn.addEventListener("click", () => {
            window._offlineBannerDismissed = true;
            banner.classList.remove("show");
            document.body.classList.remove("has-offline-banner");
            // Schedule removal after CSS transition
            if (banner._removalTimer) clearTimeout(banner._removalTimer);
            banner._removalTimer = setTimeout(() => {
              if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
            }, 400);
            showToast("Offline banner dismissed for this session");
          });
        }
        // Cancel any pending removal from a previous offline→online flicker
        if (banner._removalTimer) {
          clearTimeout(banner._removalTimer);
          banner._removalTimer = null;
        }
        // Trigger reflow then add show class for slide-in animation
        requestAnimationFrame(() => banner.classList.add("show"));
      } else {
        // Update message in case dirty count changed
        const span = banner.querySelector("span");
        if (span) span.textContent = msg;
        // Cancel pending removal if user just went online→offline again
        if (banner._removalTimer) {
          clearTimeout(banner._removalTimer);
          banner._removalTimer = null;
        }
        banner.classList.add("show");
      }
      // Push the page content down so the banner doesn't overlap headings/buttons
      document.body.classList.add("has-offline-banner");
    } else if (banner) {
      banner.classList.remove("show");
      document.body.classList.remove("has-offline-banner");
      // Remove after transition (cancellable)
      if (banner._removalTimer) clearTimeout(banner._removalTimer);
      const ref = banner; // freeze for closure
      ref._removalTimer = setTimeout(() => {
        // Re-check at fire time — state may have changed
        if (ref && !ref.classList.contains("show") && ref.parentNode) {
          ref.parentNode.removeChild(ref);
        }
      }, 400);
    } else {
      // No banner element exists — make sure body class is also off
      document.body.classList.remove("has-offline-banner");
    }
  }
  function handleVisibility() {
    if (!document.hidden && localStorage.getItem("mb_auto_sync") === "true") {
      // Quick remote-newer check
      checkForRemoteUpdate();
    }
  }

  function stopAutoSync() {
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    autoSyncTimer = null;
    if (window._pullPollTimer) clearInterval(window._pullPollTimer);
    window._pullPollTimer = null;
    if (window._syncBadgeTimer) clearInterval(window._syncBadgeTimer);
    window._syncBadgeTimer = null;
  }

  function markDirty() {
    dirtyForSync = true;
    updateSyncIndicator("dirty");
    schedulePushIfAuto();
    // Refresh offline banner to reflect "pending changes" if currently offline
    if (!navigator.onLine) {
      try { updateNetStatus(); } catch (e) {}
    }
  }

  function schedulePushIfAuto() {
    if (localStorage.getItem("mb_auto_sync") !== "true") return;
    if (!localStorage.getItem(KEYS.syncToken)) return;
    if (!navigator.onLine) {
      updateSyncIndicator("offline");
      return;
    }
    clearTimeout(pushDebounceTimer);
    pushDebounceTimer = setTimeout(() => {
      if (dirtyForSync) syncPush({ silent: true });
    }, 3000); // 3 seconds after last change
  }

  function updateSyncIndicator(status) {
    // status: 'synced' | 'dirty' | 'syncing' | 'error' | 'off' | 'offline' | 'conflict'
    const ind = $("#syncIndicator");
    const indDesk = $("#syncIndicatorDesktop");
    const dashBadge = $("#dashSyncBadge");
    if (!ind && !indDesk && !dashBadge) return;

    const enabled = localStorage.getItem(KEYS.syncToken) && localStorage.getItem(KEYS.syncGistId);
    if (!enabled) {
      if (ind) ind.hidden = true;
      if (indDesk) indDesk.hidden = true;
      if (dashBadge) dashBadge.hidden = true;
      return;
    }
    if (ind) ind.hidden = false;
    if (indDesk) indDesk.hidden = false;
    if (dashBadge) dashBadge.hidden = false;

    const pretty = {
      synced: { icon: "🟢", text: "Synced", title: lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleTimeString()} from ${getDeviceLabel()}` : "Synced" },
      dirty: { icon: "🟡", text: "Pending", title: "Local changes pending sync" },
      behind: { icon: "🟠", text: "Behind", title: "Cloud has newer data — pull to update" },
      syncing: { icon: "🔄", text: "Syncing…", title: "Sync in progress" },
      error: { icon: "🔴", text: "Sync error", title: "Last sync failed" },
      offline: { icon: "📵", text: "Offline", title: "Will push when back online" },
      conflict: { icon: "⚠️", text: "Conflict", title: "Cloud and local diverged — resolve in Settings" },
      off: { icon: "⚪", text: "Off", title: "Sync disabled" },
    };
    const p = pretty[status] || pretty.synced;
    [ind, indDesk, dashBadge].forEach((el) => {
      if (!el) return;
      if (el === ind) {
        el.textContent = p.icon;
      } else {
        const time = lastSyncedAt ? ` · ${formatSyncRelative(lastSyncedAt)}` : "";
        el.textContent = `${p.icon} ${p.text}${el === dashBadge ? time : ""}`;
      }
      el.title = p.title;
    });

    // Re-render the dashboard sync card too (cheap)
    if (typeof renderDashSyncCard === "function") renderDashSyncCard();
  }

  function formatSyncRelative(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  async function syncPush(opts = {}) {
    const silent = !!opts.silent;
    const force = !!opts.force;
    const token = localStorage.getItem(KEYS.syncToken);
    if (!token) {
      if (!silent) showSyncStatus("Add a GitHub token first.", "warn");
      return;
    }
    if (!cryptoKey) {
      if (!silent) showSyncStatus("Unlock the app first.", "warn");
      return;
    }
    if (!navigator.onLine) {
      updateSyncIndicator("offline");
      logSyncEvent("push", "offline", "Browser is offline");
      if (!silent) showSyncStatus("📵 You're offline. Will retry when back online.", "warn");
      return;
    }
    if (syncInFlight) {
      if (!silent) showSyncStatus("Another sync is in progress — try again in a moment.", "warn");
      return;
    }
    syncInFlight = true;

    if (!silent) showSyncStatus("⬆️ Encrypting and uploading…", "loading");
    updateSyncIndicator("syncing");
    try {
      const gistId = localStorage.getItem(KEYS.syncGistId);

      // Always pull-and-merge first so we never lose remote changes
      if (gistId && !force) {
        try {
          const checkRes = await fetch(`https://api.github.com/gists/${gistId}`, {
            headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
          });
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            const file = checkData.files[SYNC_FILENAME];
            if (file) {
              const remotePayload = JSON.parse(file.content);
              if (remotePayload.encrypted) {
                // Decrypt remote with the right key
                if (remotePayload.salt && remotePayload.salt !== localStorage.getItem(KEYS.salt)) {
                  // Salt mismatch — re-derive with cached password if available
                  if (cachedPassword) {
                    localStorage.setItem(KEYS.salt, remotePayload.salt);
                    try {
                      cryptoKey = await deriveKey(cachedPassword);
                    } catch (e) {
                      console.warn("Re-derive failed during push-merge", e);
                    }
                  } else {
                    console.warn("Salt mismatch on push-merge, no cached password to re-derive");
                  }
                }
                const remoteState = await decryptState(remotePayload.encrypted);
                if (remoteState) {
                  const merged = mergeStates(state, remoteState);
                  state = merged;
                  saveData();
                }
              }
            }
          }
        } catch (e) {
          console.warn("Push-merge step failed", e);
        }
      }

      // If on cellular and user opted to skip receipts, strip them from the payload
      let stateToEncrypt = state;
      if (isOnCellular() && localStorage.getItem(KEYS.syncSkipReceiptsCellular) === "true") {
        stateToEncrypt = {
          ...state,
          expenses: state.expenses.map((e) => {
            if (e.receipt) return { ...e, receipt: null, _receiptStripped: true };
            return e;
          }),
        };
      }
      const encBlob = await encryptState(stateToEncrypt);
      if (!encBlob) throw new Error("Encryption failed");

      // Echo prevention: skip if encrypted blob hash matches last successful sync.
      // This avoids pointless re-pushes after a pull-merge that produced no actual change.
      const blobHash = quickHash(encBlob);
      if (!force && lastSyncedHash === blobHash && dirtyForSync === false) {
        if (!silent) showSyncStatus("Already synced — nothing to push.", "success");
        updateSyncIndicator("synced");
        return;
      }

      // Read this device's local sync history to include in the payload
      let localHistory = [];
      try { localHistory = JSON.parse(localStorage.getItem(SYNC_HISTORY_KEY) || "[]"); }
      catch (e) { localHistory = []; }

      const payload = JSON.stringify({
        version: 1,
        encrypted: encBlob,
        salt: localStorage.getItem(KEYS.salt),
        updatedAt: new Date().toISOString(),
        device: getDeviceLabel(),
        history: localHistory.slice(0, 100), // Most recent 100 events from this device
      });

      const body = {
        description: "Pocket Budget App — encrypted backup",
        public: false,
        files: { [SYNC_FILENAME]: { content: payload } },
      };

      let res, data;
      if (gistId) {
        res = await fetch(`https://api.github.com/gists/${gistId}`, {
          method: "PATCH",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.message || "Update failed");
      } else {
        res = await fetch("https://api.github.com/gists", {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.message || "Create failed");
        localStorage.setItem(KEYS.syncGistId, data.id);
        $("#syncGistId").value = data.id;
      }
      const sizeMsg = `Pushed ${(payload.length / 1024).toFixed(1)} KB · ${new Date().toLocaleTimeString()}`;
      showSyncStatus(`✓ ${sizeMsg}`, "success");
      lastSyncedAt = Date.now();
      lastSyncedHash = blobHash;
      lastKnownRemoteUpdate = data.updated_at || null;
      localStorage.setItem("mb_last_synced", String(lastSyncedAt));
      localStorage.setItem("mb_last_synced_hash", lastSyncedHash);
      dirtyForSync = false;
      syncRetryCount = 0;
      updateSyncIndicator("synced");
      logSyncEvent("push", "success", sizeMsg);

      // Size warning at 80% of 1 MB Gist limit
      const usagePct = (payload.length / (1024 * 1024)) * 100;
      if (usagePct >= 80) {
        showAlertToast(`⚠️ Sync data at ${usagePct.toFixed(0)}% of GitHub Gist's 1 MB limit. Consider deleting old receipts.`, "warning");
      }
      renderSyncHistory();
    } catch (e) {
      console.error(e);
      logSyncEvent("push", "error", e.message);

      // Specific guidance for token expiration / auth errors
      const isAuth = /401|403|bad credentials|unauthorized|expired|invalid/i.test(String(e.message));
      if (isAuth) {
        showAlertToast("⚠️ Sync token rejected — generate a new one in Settings → Sync.", "danger");
        stopAutoSync();
        updateSyncIndicator("error");
        renderSyncHistory();
        return;
      }

      // Retry with backoff (max 3 attempts)
      if (silent && syncRetryCount < 3) {
        syncRetryCount += 1;
        const delay = Math.pow(2, syncRetryCount) * 1000;
        setTimeout(() => syncPush({ silent: true }), delay);
        updateSyncIndicator("dirty");
      } else {
        if (!silent) showSyncStatus(`❌ ${e.message || "Push failed"}`, "warn");
        updateSyncIndicator("error");
      }
      renderSyncHistory();
    } finally {
      syncInFlight = false;
    }
  }

  function getDeviceLabel() {
    let label = localStorage.getItem("mb_device_label");
    if (!label) {
      const ua = navigator.userAgent;
      if (/iPhone/.test(ua)) label = "iPhone";
      else if (/iPad/.test(ua)) label = "iPad";
      else if (/Android/.test(ua)) label = "Android";
      else if (/Mac/.test(ua)) label = "Mac";
      else if (/Windows/.test(ua)) label = "Windows";
      else label = "Browser";
      localStorage.setItem("mb_device_label", label);
    }
    return label;
  }

  function showConflictDialog(remotePayload, remoteTime) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal open";
      overlay.style.zIndex = "9500";
      overlay.innerHTML = `
        <div class="modal-card">
          <div class="modal-header">
            <h2>⚠️ Sync Conflict</h2>
          </div>
          <p>Cloud was updated by another device <strong>${new Date(remoteTime).toLocaleString()}</strong> (${escapeHtml(remotePayload.device || "unknown device")}).</p>
          <p>Your local changes are <strong>${formatSyncRelative(lastSyncedAt)}</strong>. What do you want to do?</p>
          <div style="display:flex;flex-direction:column;gap:0.5rem;margin-top:1rem">
            <button class="btn-secondary" data-conflict="pull">⬇️ Pull cloud (replace local)</button>
            <button class="btn-danger" data-conflict="overwrite">⬆️ Push my changes (overwrite cloud)</button>
            <button class="btn-secondary" data-conflict="cancel">Cancel</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const cleanup = (choice) => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        resolve(choice);
      };
      const onKey = (e) => {
        if (e.key === "Escape") cleanup("cancel");
      };
      document.addEventListener("keydown", onKey);

      overlay.querySelectorAll("[data-conflict]").forEach((btn) => {
        btn.addEventListener("click", () => cleanup(btn.dataset.conflict));
      });
      // Click outside the card cancels
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) cleanup("cancel");
      });
    });
  }

  async function syncPull(opts = {}) {
    const skipConfirm = !!opts.skipConfirm;
    const silent = !!opts.silent;
    const token = localStorage.getItem(KEYS.syncToken);
    const gistId = localStorage.getItem(KEYS.syncGistId);
    if (!token) {
      if (!silent) showSyncStatus("Add a GitHub token first.", "warn");
      return;
    }
    if (!gistId) {
      if (!silent) showSyncStatus("No Gist ID — push from another device first.", "warn");
      return;
    }
    if (!cryptoKey) {
      if (!silent) showSyncStatus("Unlock the app first.", "warn");
      return;
    }
    if (syncInFlight) {
      if (!silent) showSyncStatus("Another sync is in progress — try again in a moment.", "warn");
      return;
    }
    syncInFlight = true;

    if (!skipConfirm && !confirm("Pull will merge cloud data with local. Continue?")) {
      syncInFlight = false;
      return;
    }

    if (!silent) showSyncStatus("⬇️ Downloading and merging…", "loading");
    updateSyncIndicator("syncing");
    try {
      const res = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Fetch failed");
      const file = data.files[SYNC_FILENAME];
      if (!file) throw new Error("Gist doesn't contain budget file");
      const payload = JSON.parse(file.content);
      if (!payload.encrypted) throw new Error("No encrypted data in gist");

      if (payload.salt && payload.salt !== localStorage.getItem(KEYS.salt)) {
        // Salt mismatch — try to re-derive with cached password silently
        if (cachedPassword) {
          localStorage.setItem(KEYS.salt, payload.salt);
          try {
            cryptoKey = await deriveKey(cachedPassword);
          } catch (e) {
            updateSyncIndicator("error");
            if (!silent) showSyncStatus("❌ Salt mismatch — try locking and unlocking", "warn");
            return;
          }
        } else if (silent) {
          updateSyncIndicator("error");
          return;
        } else {
          const pwd = prompt("Enter your password to decrypt the cloud backup:");
          if (!pwd) { showSyncStatus("Cancelled.", "warn"); return; }
          // Adopt the remote salt before re-deriving so the key matches the cloud blob
          localStorage.setItem(KEYS.salt, payload.salt);
          cryptoKey = await deriveKey(pwd);
          cachedPassword = pwd;
        }
      }

      const decrypted = await decryptState(payload.encrypted);
      if (!decrypted) throw new Error("Decryption failed — wrong password?");

      // Merge sync history from the cloud payload (so all devices see all events)
      if (Array.isArray(payload.history)) {
        try {
          const localHist = JSON.parse(localStorage.getItem(SYNC_HISTORY_KEY) || "[]");
          // Merge by timestamp+device — dedupe identical events
          const seen = new Set();
          const combined = [...localHist, ...payload.history].filter((ev) => {
            const key = `${ev.ts}|${ev.device || ""}|${ev.action}|${ev.status}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          combined.sort((a, b) => b.ts - a.ts);
          localStorage.setItem(SYNC_HISTORY_KEY, JSON.stringify(combined.slice(0, 200)));
        } catch (e) { /* ignore */ }
      }

      // Merge remote into local (devices converge to same data)
      const localIds = new Set(state.expenses.map((e) => e.id));
      recentlyPulledIds.clear();
      (decrypted.expenses || []).forEach((e) => {
        if (!localIds.has(e.id)) recentlyPulledIds.add(e.id);
      });

      const beforeCount = state.expenses.length;
      state = mergeStates(state, decrypted);
      // After merge, run dedupe in case sync introduced duplicate recurring entries
      try { dedupeRecurringTransactions(); } catch (e) { /* ignore */ }
      const addedCount = recentlyPulledIds.size;
      const totalAfter = state.expenses.length;
      saveData();
      renderAll();
      const msg = `Synced from ${new Date(payload.updatedAt).toLocaleString()} (${payload.device || "unknown"}) · merged to ${totalAfter} txns`;
      const summary = addedCount > 0
        ? `✓ ${msg} · ${addedCount} new highlighted`
        : `✓ ${msg}`;
      if (!silent) showSyncStatus(summary, "success");
      if (addedCount > 0 && !silent) {
        showAlertToast(`Merged ${addedCount} new transaction${addedCount === 1 ? "" : "s"} from cloud`, "success");
      }
      lastSyncedAt = Date.now();
      localStorage.setItem("mb_last_synced", String(lastSyncedAt));
      dirtyForSync = false;
      updateSyncIndicator("synced");
      logSyncEvent("pull", "success", msg);
      renderSyncHistory();

      // Auto-clear the highlight after 30 seconds
      setTimeout(() => {
        recentlyPulledIds.clear();
        renderAll();
      }, 30000);
    } catch (e) {
      console.error(e);
      logSyncEvent("pull", "error", e.message);
      if (!silent) showSyncStatus(`❌ ${e.message || "Pull failed"}`, "warn");
      updateSyncIndicator("error");
      renderSyncHistory();
    } finally {
      syncInFlight = false;
    }
  }

  function showSyncStatus(msg, type) {
    const el = $("#syncStatus");
    if (!el) return;
    el.hidden = false;
    el.className = `sync-status ${type || ""}`;
    el.textContent = msg;
  }

  /* ---------- Sync QR + history + setup link ---------- */
  function openSyncQrModal() {
    const token = localStorage.getItem(KEYS.syncToken);
    const gistId = localStorage.getItem(KEYS.syncGistId);
    if (!token || !gistId) {
      showToast("Set up sync first (push from this device once).");
      return;
    }
    // Build a fragment-only link (never sent to server)
    const url = `${location.origin}${location.pathname}#sync=${encodeURIComponent(token)}|${encodeURIComponent(gistId)}`;
    $("#syncSetupLink").value = url;

    const canvas = $("#syncQrCanvas");
    canvas.innerHTML = "";
    if (typeof QRCode !== "undefined") {
      new QRCode(canvas, { text: url, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
    } else {
      canvas.innerHTML = '<p class="empty">QR library failed to load. Use the link below.</p>';
    }
    $("#syncQrModal").classList.add("open");
  }

  function processSyncSetupHash() {
    if (!location.hash || !location.hash.startsWith("#sync=")) return;
    let data, token, gistId;
    try {
      data = decodeURIComponent(location.hash.slice(6));
      [token, gistId] = data.split("|").map(decodeURIComponent);
    } catch (e) {
      // Malformed hash — clear it and bail
      history.replaceState(null, "", location.pathname);
      return;
    }
    if (!token || !gistId) return;
    if (confirm("Set up cloud sync from a paired device? This saves the token + Gist ID locally.")) {
      localStorage.setItem(KEYS.syncToken, token);
      localStorage.setItem(KEYS.syncGistId, gistId);
      localStorage.setItem("mb_auto_sync", "true");
      // Clear hash so it doesn't sit in URL
      history.replaceState(null, "", location.pathname);
      showToast("Sync paired. Pull from cloud to load data.");
    } else {
      history.replaceState(null, "", location.pathname);
    }
  }

  /* ---------- Camera-based QR scanner for sync setup ---------- */
  let _qrScanState = null;

  function setQrScanStatus(msg, type) {
    const el = $("#syncQrScanStatus");
    if (!el) return;
    el.className = `sync-status ${type || ""}`;
    el.textContent = msg;
  }

  function stopQrScanStream() {
    if (!_qrScanState) return;
    if (_qrScanState.rafId) cancelAnimationFrame(_qrScanState.rafId);
    if (_qrScanState.stream) {
      _qrScanState.stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    }
    const video = $("#syncQrVideo");
    if (video) { try { video.srcObject = null; } catch (e) {} }
    _qrScanState = null;
  }

  function closeSyncQrScanModal() {
    stopQrScanStream();
    $("#syncQrScanModal")?.classList.remove("open");
  }

  function loadJsQR() {
    if (typeof window.jsQR === "function") return Promise.resolve(window.jsQR);
    if (window._jsQRLoadingPromise) return window._jsQRLoadingPromise;
    window._jsQRLoadingPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
      s.async = true;
      s.onload = () => resolve(window.jsQR);
      s.onerror = () => reject(new Error("Failed to load jsQR library"));
      document.head.appendChild(s);
    });
    return window._jsQRLoadingPromise;
  }

  function parseSyncFromText(text) {
    if (!text || typeof text !== "string") return null;
    let token = null;
    let gistId = null;
    try {
      // Match either full URL with #sync= or just sync=token|gistId
      let payload = null;
      const hashIdx = text.indexOf("#sync=");
      if (hashIdx >= 0) {
        payload = text.slice(hashIdx + 6);
      } else if (text.startsWith("sync=")) {
        payload = text.slice(5);
      } else if (text.includes("|") && !text.includes("://")) {
        // Bare token|gistId
        payload = text;
      } else {
        return null;
      }
      // Strip trailing whitespace / extra params
      payload = payload.split(/\s/)[0];
      const decoded = decodeURIComponent(payload);
      const parts = decoded.split("|").map(decodeURIComponent);
      if (parts.length >= 2 && parts[0] && parts[1]) {
        token = parts[0];
        gistId = parts[1];
      }
    } catch (e) {
      return null;
    }
    if (!token || !gistId) return null;
    return { token, gistId };
  }

  function applyScannedSync(parsed) {
    if (!parsed || !parsed.token || !parsed.gistId) return false;
    localStorage.setItem(KEYS.syncToken, parsed.token);
    localStorage.setItem(KEYS.syncGistId, parsed.gistId);
    localStorage.setItem("mb_auto_sync", "true");
    // Update visible Settings inputs if present (HTML IDs are #syncToken / #syncGistId)
    const tokInput = $("#syncToken");
    const gistInput = $("#syncGistId");
    if (tokInput) {
      tokInput.value = parsed.token;
      tokInput.dataset.unlocked = "true";
    }
    if (gistInput) gistInput.value = parsed.gistId;
    const autoTog = $("#autoSyncToggle");
    if (autoTog) autoTog.checked = true;
    return true;
  }

  async function openSyncQrScanModal() {
    const modal = $("#syncQrScanModal");
    if (!modal) return;
    modal.classList.add("open");
    setQrScanStatus("Initializing camera…", "");

    // Permissions / API check
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setQrScanStatus("Camera not supported on this browser.", "error");
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      setQrScanStatus("Camera blocked. Allow camera permission and try again.", "error");
      return;
    }

    const video = $("#syncQrVideo");
    const canvas = $("#syncQrScanCanvas");
    if (!video || !canvas) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    _qrScanState = { stream, rafId: null, stopped: false };

    video.srcObject = stream;
    try { await video.play(); } catch (e) {}

    setQrScanStatus("📷 Looking for QR code…", "");

    // Prefer native BarcodeDetector if available
    let detector = null;
    if ("BarcodeDetector" in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        if (supported && supported.indexOf("qr_code") >= 0) {
          detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        }
      } catch (e) { detector = null; }
    }

    let jsQR = null;
    if (!detector) {
      try {
        jsQR = await loadJsQR();
      } catch (e) {
        setQrScanStatus("Couldn't load QR scanner. Check your connection.", "error");
        stopQrScanStream();
        return;
      }
    }

    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function scanFrame() {
      if (!_qrScanState || _qrScanState.stopped) return;
      if (video.readyState < 2 || video.videoWidth === 0) {
        _qrScanState.rafId = requestAnimationFrame(scanFrame);
        return;
      }
      let raw = null;
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes && codes.length) raw = codes[0].rawValue;
        } else if (jsQR) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
          if (code && code.data) raw = code.data;
        }
      } catch (e) { /* keep scanning */ }

      if (raw) {
        const parsed = parseSyncFromText(raw);
        if (parsed) {
          _qrScanState.stopped = true;
          setQrScanStatus("✓ QR matched. Saving sync…", "success");
          if (applyScannedSync(parsed)) {
            stopQrScanStream();
            closeSyncQrScanModal();
            showToast("Sync configured. Tap Pull to load your data.");
            try { renderAll(); } catch (e) {}
            // Optional: auto-pull after pairing
            try {
              if (typeof pullFromCloud === "function") {
                setTimeout(() => { pullFromCloud(); }, 400);
              }
            } catch (e) {}
            return;
          } else {
            setQrScanStatus("QR data invalid — couldn't apply.", "error");
            _qrScanState.stopped = false;
          }
        } else {
          setQrScanStatus("Found a QR but it isn't a Pocket Budget sync code. Keep scanning…", "");
        }
      }

      _qrScanState.rafId = requestAnimationFrame(scanFrame);
    }
    _qrScanState.rafId = requestAnimationFrame(scanFrame);
  }

  function renderSyncHistory() {
    const list = $("#syncHistoryList");
    if (!list) return;
    let history;
    try { history = JSON.parse(localStorage.getItem(SYNC_HISTORY_KEY) || "[]"); }
    catch (e) { history = []; }
    if (!history.length) {
      list.innerHTML = '<li class="empty">No sync events yet.</li>';
      return;
    }
    list.innerHTML = history.map((ev) => {
      const time = new Date(ev.ts).toLocaleString();
      const icon = ev.status === "success" ? "✓"
        : ev.status === "error" ? "❌"
        : ev.status === "conflict" ? "⚠️"
        : ev.status === "offline" ? "📵"
        : "·";
      const cls = ev.status === "success" ? "positive"
        : ev.status === "error" ? "negative"
        : "";
      const dev = ev.device ? ` · ${escapeHtml(ev.device)}` : "";
      const action = escapeHtml(String(ev.action || "").toUpperCase());
      return `
        <li class="list-item">
          <div class="list-item-main">
            <div class="list-item-title ${cls}">${icon} ${action}${dev}</div>
            <div class="list-item-sub">${escapeHtml(time)} · ${escapeHtml(String(ev.message || ""))}</div>
          </div>
        </li>`;
    }).join("");
  }

  /* ---------- Synced devices view ---------- */
  function getDevicesFromHistory() {
    let history;
    try { history = JSON.parse(localStorage.getItem(SYNC_HISTORY_KEY) || "[]"); }
    catch (e) { history = []; }
    const devices = {};
    history.forEach((ev) => {
      if (!ev.device) return;
      if (ev.status !== "success") return;
      if (!devices[ev.device] || ev.ts > devices[ev.device].lastTs) {
        devices[ev.device] = {
          name: ev.device,
          lastTs: ev.ts,
          lastAction: ev.action,
          count: (devices[ev.device]?.count || 0) + 1,
        };
      } else {
        devices[ev.device].count += 1;
      }
    });
    return Object.values(devices).sort((a, b) => b.lastTs - a.lastTs);
  }

  function renderSyncDevices() {
    const list = $("#syncDevicesList");
    if (!list) return;
    const devices = getDevicesFromHistory();
    if (!devices.length) {
      list.innerHTML = '<li class="empty">No devices yet — make a push to start.</li>';
      return;
    }
    const myName = getDeviceLabel();
    list.innerHTML = devices.map((d) => {
      const isThis = d.name === myName;
      const action = d.lastAction === "push" ? "⬆️ Last pushed" : "⬇️ Last pulled";
      return `
        <li class="list-item ${isThis ? "this-device" : ""}">
          <div class="list-item-main">
            <div class="list-item-title">
              ${isThis ? "📍 " : "🖥️ "}${escapeHtml(d.name)}${isThis ? " <span class=\"this-tag\">This device</span>" : ""}
            </div>
            <div class="list-item-sub">${action} ${formatSyncRelative(d.lastTs)} · ${d.count} sync${d.count === 1 ? "" : "s"} total</div>
          </div>
        </li>`;
    }).join("");
  }

  /* ---------- AI Insights (BYOK) ---------- */
  async function askAiInsights() {
    const provider = localStorage.getItem(KEYS.aiProvider);
    const key = localStorage.getItem(KEYS.aiKey);
    const responseEl = $("#aiResponse");
    if (!responseEl) return;
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
    const totalIncome = monthIncomes.reduce((s, e) => s + incomeReportingAmount(e), 0);

    const catTotals = {};
    monthExpenses.forEach((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const name = cat ? cat.name : "Uncategorized";
      catTotals[name] = (catTotals[name] || 0) + Number(e.amount);
    });

    const top10 = [...monthExpenses]
      .sort((a, b) => Number(b.amount) - Number(a.amount))
      .slice(0, 10)
      .map((e) => `${e.desc || "(no description)"}: ${currencySymbols[currency] || "$"}${(Number(e.amount) || 0).toFixed(2)}`);

    const cardSummary = state.cards.map((c) =>
      `${c.name}: balance ${currencySymbols[currency] || "$"}${cardCurrentBalance(c).toFixed(0)} of ${(c.limit || 0).toFixed(0)} limit`
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
        response = data?.choices?.[0]?.message?.content;
        if (!response) throw new Error("OpenAI returned no content");
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
        response = data?.content?.[0]?.text;
        if (!response) throw new Error("Anthropic returned no content");
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

  /* ---------- Event CSV export ---------- */
  function exportEventCsv(ev) {
    const txns = state.expenses
      .filter((e) => e.eventId === ev.id && e.type === "expense")
      .sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
    const headers = ["Date", "Description", "Category", "Account", "Line Item", "Person", "Amount", "Tags"];
    const rows = txns.map((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const acc = e.accountId ? state.accounts.find((a) => a.id === e.accountId) : null;
      const li = e.eventLineItemId ? (ev.lineItems || []).find((x) => x.id === e.eventLineItemId) : null;
      const person = e.personId ? state.people.find((p) => p.id === e.personId) : null;
      return [
        e.date,
        e.desc,
        cat ? cat.name : "Uncategorized",
        acc ? acc.name : "",
        li ? li.label : "",
        person ? person.name : "",
        Number(e.amount).toFixed(2),
        Array.isArray(e.tags) ? e.tags.join("; ") : "",
      ].map(csvEscape).join(",");
    });
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = (ev.name || "event").replace(/[^a-z0-9]+/gi, "_");
    a.href = url;
    a.download = `event_${safe}_${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${txns.length} txn${txns.length === 1 ? "" : "s"}`);
  }

  /* ---------- Event report (printable) ---------- */
  function openEventReport(ev) {
    const status = eventStatus(ev);
    const txns = state.expenses
      .filter((e) => e.eventId === ev.id && e.type === "expense")
      .sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
    const totalSpent = txns.reduce((s, e) => s + Number(e.amount), 0);
    const budget = Number(ev.budget) || 0;
    const remaining = budget - totalSpent;
    const lineItems = Array.isArray(ev.lineItems) ? ev.lineItems : [];

    // Group by category
    const catTotals = {};
    txns.forEach((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      const name = cat ? cat.name : "Uncategorized";
      catTotals[name] = (catTotals[name] || 0) + Number(e.amount);
    });
    const sortedCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);

    // Group by account (so user sees which card/cash they used)
    const acctTotals = {};
    txns.forEach((e) => {
      const acc = e.accountId ? state.accounts.find((a) => a.id === e.accountId) : null;
      const name = acc ? acc.name : "Unassigned";
      acctTotals[name] = (acctTotals[name] || 0) + Number(e.amount);
    });
    const sortedAccts = Object.entries(acctTotals).sort((a, b) => b[1] - a[1]);

    // Group by person (family money during the event)
    const personTotals = {};
    txns.forEach((e) => {
      if (!e.personId) return;
      const p = state.people.find((x) => x.id === e.personId);
      if (!p) return;
      personTotals[p.name] = (personTotals[p.name] || 0) + Number(e.amount);
    });
    const sortedPeople = Object.entries(personTotals).sort((a, b) => b[1] - a[1]);

    const w = window.open("", "_blank");
    if (!w) {
      showToast("Please allow popups to view report");
      return;
    }
    w.document.write(`
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>${escapeHtml(ev.name)} — Event Report</title>
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
  .negative { color: #dc2626; }
  .positive { color: #16a34a; }
  .footer { margin-top: 2rem; font-size: 0.8rem; color: #7a7a8a; text-align: center; border-top: 1px solid #e6e1d5; padding-top: 1rem; }
  .notes { background: #faf7f1; padding: 0.75rem; border-radius: 8px; white-space: pre-wrap; font-size: 0.9rem; }
  .progress { background: #e6e1d5; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 0.3rem; }
  .progress-fill { height: 100%; background: #5b3fb8; }
  @media print { body { padding: 20px; } .no-print { display: none; } }
</style>
</head><body>
<button class="no-print" onclick="window.print()" style="float:right;padding:0.5rem 1rem;background:#5b3fb8;color:#fff;border:0;border-radius:6px;cursor:pointer">🖨 Print / Save PDF</button>
<h1>${ev.icon || "🌴"} ${escapeHtml(ev.name)}</h1>
<div class="meta">
  ${ev.startDate || "—"} → ${ev.endDate || "—"} ·
  Status: ${status.charAt(0).toUpperCase() + status.slice(1)} ·
  Generated ${new Date().toLocaleString()}
</div>

<div class="stats-grid">
  <div class="stat"><div class="stat-label">Budget</div><div class="stat-value">${fmt(budget)}</div></div>
  <div class="stat"><div class="stat-label">Spent</div><div class="stat-value">${fmt(totalSpent)}</div></div>
  <div class="stat"><div class="stat-label">${remaining >= 0 ? "Remaining" : "Over"}</div><div class="stat-value ${remaining < 0 ? "negative" : "positive"}">${fmt(Math.abs(remaining))}</div></div>
  <div class="stat"><div class="stat-label">Transactions</div><div class="stat-value">${txns.length}</div></div>
</div>

${lineItems.length ? `
<h2>Line Items</h2>
<table>
  <thead><tr><th>Item</th><th class="right">Spent</th><th class="right">Budget</th><th class="right">% Used</th></tr></thead>
  <tbody>
    ${lineItems.map((li) => {
      const liSpent = eventSpentTotal(ev.id, li.id);
      const liBudget = Number(li.budget) || 0;
      const liPct = liBudget > 0 ? (liSpent / liBudget) * 100 : 0;
      return `<tr>
        <td>${escapeHtml(li.label)}</td>
        <td class="right">${fmt(liSpent)}</td>
        <td class="right">${fmt(liBudget)}</td>
        <td class="right ${liPct > 100 ? "negative" : ""}">${liBudget > 0 ? liPct.toFixed(0) + "%" : "—"}</td>
      </tr>`;
    }).join("")}
  </tbody>
</table>
` : ""}

${sortedCats.length ? `
<h2>By Category</h2>
<table>
  <thead><tr><th>Category</th><th class="right">Amount</th><th class="right">% of Total</th></tr></thead>
  <tbody>
    ${sortedCats.map(([name, amt]) => `<tr>
      <td>${escapeHtml(name)}</td>
      <td class="right">${fmt(amt)}</td>
      <td class="right">${totalSpent > 0 ? ((amt / totalSpent) * 100).toFixed(0) + "%" : "—"}</td>
    </tr>`).join("")}
  </tbody>
</table>
` : ""}

${sortedAccts.length ? `
<h2>By Account / Card</h2>
<table>
  <thead><tr><th>Account</th><th class="right">Amount</th><th class="right">% of Total</th></tr></thead>
  <tbody>
    ${sortedAccts.map(([name, amt]) => `<tr>
      <td>${escapeHtml(name)}</td>
      <td class="right">${fmt(amt)}</td>
      <td class="right">${totalSpent > 0 ? ((amt / totalSpent) * 100).toFixed(0) + "%" : "—"}</td>
    </tr>`).join("")}
  </tbody>
</table>
` : ""}

${sortedPeople.length ? `
<h2>By Family Member</h2>
<table>
  <thead><tr><th>Person</th><th class="right">Amount</th></tr></thead>
  <tbody>
    ${sortedPeople.map(([name, amt]) => `<tr>
      <td>${escapeHtml(name)}</td>
      <td class="right">${fmt(amt)}</td>
    </tr>`).join("")}
  </tbody>
</table>
` : ""}

${txns.length ? `
<h2>All Transactions (${txns.length})</h2>
<table>
  <thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="right">Amount</th></tr></thead>
  <tbody>
    ${txns.map((e) => {
      const cat = state.categories.find((c) => c.id === e.categoryId);
      return `<tr>
        <td>${e.date}</td>
        <td>${escapeHtml(e.desc)}</td>
        <td>${escapeHtml(cat ? cat.name : "Uncategorized")}</td>
        <td class="right">${fmt(e.amount)}</td>
      </tr>`;
    }).join("")}
  </tbody>
</table>
` : '<p>No transactions tagged to this event yet.</p>'}

${ev.notes ? `<h2>Notes</h2><div class="notes">${escapeHtml(ev.notes)}</div>` : ""}

${Array.isArray(ev.checklist) && ev.checklist.length ? `
<h2>Checklist</h2>
<ul>
  ${ev.checklist.map((it) => `<li>${it.done ? "✓" : "☐"} ${escapeHtml(it.label)}</li>`).join("")}
</ul>
` : ""}

<div class="footer">
  Generated by Pocket Budget App
</div>
</body></html>
    `);
    w.document.close();
  }

  /* ---------- Monthly print report ---------- */
  function openPrintReport() {
    const m = currentMonth();
    const monthExpenses = state.expenses.filter(
      (e) => monthKey(e.date) === m && e.type !== "income" && e.type !== "transfer-in" && e.type !== "transfer-out"
    );
    const monthIncomes = state.expenses.filter((e) => e.type === "income" && monthKey(e.date) === m);
    const totalSpent = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalIncome = monthIncomes.reduce((s, e) => s + incomeReportingAmount(e), 0);
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
      const v = String(e.desc || "").trim();
      if (!v) return;
      vendorTotals[v] = (vendorTotals[v] || 0) + (Number(e.amount) || 0);
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
    // Apply saved theme BEFORE the lock screen renders so it respects dark/light immediately
    try {
      const savedTheme = localStorage.getItem(KEYS.theme);
      const sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      const initialTheme = savedTheme || (sysDark ? "dark" : "light");
      document.documentElement.setAttribute("data-theme", initialTheme);
    } catch (e) { /* ignore */ }
    // Apply saved/detected locale before initial render
    try { if (window.i18n) window.i18n.applyTranslations(); } catch (e) {}

    // SW update prompt — show pill when a new version is ready
    window.addEventListener("mb:sw-update-ready", () => {
      const prompt = document.getElementById("updatePrompt");
      if (prompt) prompt.hidden = false;

      // Auto-install path: when the toggle is on and the app is in the
      // background (or about to be), apply the update silently. Otherwise
      // we still show the pill and rely on the user tap.
      maybeAutoInstallUpdate();

      // Also push an OS-level notification so users see the update on iOS
      // home screen / Windows action center even if the app isn't focused.
      // showSystemNotification respects the user's notify toggle and skips
      // when the app is in the foreground (visible).
      try {
        // Read current version from the loaded script tag (?v=N)
        let currentVer = "";
        try {
          const myScript = document.querySelector('script[src*="app.js?v="]');
          const m = myScript?.src.match(/\?v=(\d+)/);
          currentVer = m ? `v${m[1]}` : "";
        } catch (e) { /* ignore */ }

        // Ask the new SW for its cache version (best effort)
        const sw = window._pendingSW;
        let newVer = "";
        if (sw && typeof sw.postMessage === "function") {
          try {
            const channel = new MessageChannel();
            channel.port1.onmessage = (ev) => {
              if (ev.data && ev.data.type === "version") {
                const match = String(ev.data.version || "").match(/v(\d+)/);
                if (match) newVer = `v${match[1]}`;
                fireUpdateNotification(currentVer, newVer);
              }
            };
            sw.postMessage("getVersion", [channel.port2]);
            // Fallback if SW doesn't reply within 1s
            setTimeout(() => {
              if (!newVer) fireUpdateNotification(currentVer, "");
            }, 1000);
          } catch (e) {
            fireUpdateNotification(currentVer, "");
          }
        } else {
          fireUpdateNotification(currentVer, "");
        }

        function fireUpdateNotification(curr, next) {
          if (typeof showSystemNotification !== "function") return;
          const title = "📦 Pocket Budget update available";
          const body = next && curr
            ? `Tap to install ${next} (you're on ${curr}).`
            : (next ? `Tap to install ${next}.` : "Open the app to install the update.");
          showSystemNotification(title, body);
        }
      } catch (e) { /* ignore */ }
    });
    document.getElementById("updatePromptBtn")?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      // Prevent double-tap from posting skipWaiting twice
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "Updating…";
      const sw = window._pendingSW;
      if (sw && typeof sw.postMessage === "function") {
        sw.postMessage("skipWaiting");
        // Safety net: if the controllerchange / reload doesn't fire within 3s, force reload
        setTimeout(() => { window.location.reload(); }, 3000);
      } else {
        window.location.reload();
      }
    });
    document.getElementById("updatePromptDismiss")?.addEventListener("click", () => {
      const prompt = document.getElementById("updatePrompt");
      if (prompt) prompt.hidden = true;
    });

    // Auto-install: if the user opted in, apply the pending update either
    // (a) immediately when it arrives and the app is hidden, or
    // (b) the next time the app becomes hidden, or
    // (c) after 60s of idle (no input) while visible.
    let _autoUpdateIdleTimer = null;
    let _autoUpdateArmed = false;          // Prevents stacking listeners on repeat calls
    let _autoUpdateApplied = false;        // Idempotency guard
    let _autoUpdateOnHidden = null;        // Reference for cleanup
    const _autoUpdateInputEvents = ["mousemove", "keydown", "touchstart", "scroll"];
    function _autoUpdateCleanup() {
      if (_autoUpdateOnHidden) {
        document.removeEventListener("visibilitychange", _autoUpdateOnHidden);
        _autoUpdateOnHidden = null;
      }
      _autoUpdateInputEvents.forEach((evt) => {
        try { window.removeEventListener(evt, _autoUpdateResetIdle); } catch (_) {}
      });
      if (_autoUpdateIdleTimer) {
        clearTimeout(_autoUpdateIdleTimer);
        _autoUpdateIdleTimer = null;
      }
      _autoUpdateArmed = false;
    }
    function _autoUpdateResetIdle() {
      if (_autoUpdateApplied) return;
      if (_autoUpdateIdleTimer) clearTimeout(_autoUpdateIdleTimer);
      _autoUpdateIdleTimer = setTimeout(() => {
        // Don't interrupt typing in a modal
        const modalOpen = !!document.querySelector(".modal.open");
        if (modalOpen) { _autoUpdateResetIdle(); return; }
        _autoUpdateApply();
      }, 60 * 1000);
    }
    function _autoUpdateApply() {
      if (_autoUpdateApplied) return;
      const sw = window._pendingSW;
      if (!sw || typeof sw.postMessage !== "function") return;
      _autoUpdateApplied = true;
      try { sw.postMessage("skipWaiting"); } catch (_) {}
      _autoUpdateCleanup();
    }
    function maybeAutoInstallUpdate() {
      if (localStorage.getItem("mb_auto_update") !== "true") return;
      if (_autoUpdateApplied || _autoUpdateArmed) return; // already running or done
      const sw = window._pendingSW;
      if (!sw || typeof sw.postMessage !== "function") return;
      // If hidden right now, install immediately
      if (document.visibilityState === "hidden") {
        _autoUpdateApply();
        return;
      }
      _autoUpdateArmed = true;
      // Otherwise queue for next "hidden" or 60s idle window
      _autoUpdateOnHidden = () => {
        if (document.visibilityState === "hidden") _autoUpdateApply();
      };
      document.addEventListener("visibilitychange", _autoUpdateOnHidden);
      _autoUpdateInputEvents.forEach((evt) => {
        window.addEventListener(evt, _autoUpdateResetIdle, { passive: true });
      });
      _autoUpdateResetIdle();
    }

    // Auto-update toggle in Settings
    const autoUpdateTog = document.getElementById("autoUpdateToggle");
    if (autoUpdateTog) {
      // Disable if service workers aren't supported (e.g. private window in some browsers)
      if (!("serviceWorker" in navigator)) {
        autoUpdateTog.disabled = true;
        autoUpdateTog.checked = false;
        autoUpdateTog.title = "Service workers not supported in this context";
      } else {
        autoUpdateTog.checked = localStorage.getItem("mb_auto_update") === "true";
        autoUpdateTog.addEventListener("change", (e) => {
          localStorage.setItem("mb_auto_update", e.target.checked ? "true" : "false");
          if (e.target.checked) {
            showToast("⚡ Auto-install on — updates apply silently in the background");
            // If a pending update is already waiting, start the auto-install flow now
            if (window._pendingSW) maybeAutoInstallUpdate();
          } else {
            showToast("Auto-install off — updates wait for your tap");
            // Cancel any in-flight queued install when user opts out
            _autoUpdateCleanup();
          }
        });
      }
    }

    // Live system theme follow — when user picks "Auto" (no saved theme) and system flips
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onSysThemeChange = (e) => {
        // Only follow system if user hasn't explicitly picked a theme
        if (!localStorage.getItem(KEYS.theme)) {
          applyTheme(e.matches ? "dark" : "light");
        }
      };
      // Modern + legacy listener pattern
      if (mq.addEventListener) mq.addEventListener("change", onSysThemeChange);
      else if (mq.addListener) mq.addListener(onSysThemeChange);
    }
    processSyncSetupHash();
    initLock();
    initNav();
    initForms();
    initKeyboardShortcuts();
    initSwipeGestures();
    initGlobalSearch();
    initStatCardDrag();
    // Set the version pill from the script tag's ?v= param
    try {
      const myScript = document.querySelector('script[src*="app.js"]');
      const m = myScript?.src.match(/\?v=(\d+)/);
      const ver = m ? m[1] : "?";
      const pill = document.getElementById("appVersionPill");
      if (pill) pill.textContent = "v" + ver;
      const top = document.getElementById("appVersionTopPill");
      if (top) top.textContent = "v" + ver;
    } catch (e) { /* ignore */ }
  });
})();
