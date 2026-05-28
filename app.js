/* ============================================================
 * My Budget — local-only budgeting app
 * Data persists in localStorage. Receipts stored as data URLs.
 * Password is stored as SHA-256 hash (not encryption — see README).
 * ============================================================ */

(() => {
  "use strict";

  /* ---------- Storage keys ---------- */
  const KEYS = {
    pwd: "mb_password_hash",
    data: "mb_data",
    currency: "mb_currency",
  };

  /* Default password hash (SHA-256 of the preset password).
   * Used when no password has been set yet in this browser. */
  const DEFAULT_PWD_HASH =
    "32ea448e581deafe4684d8bffce21c999be2b68f67440c165496b47ca0eb8f1f";

  /* ---------- State ---------- */
  let state = {
    income: 0,
    categories: [],   // { id, name, limit }
    expenses: [],     // { id, desc, amount, date, categoryId, receipt }
    goals: [],        // { id, name, target, saved, date }
  };

  let currency = "USD";
  const currencySymbols = {
    USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹", AUD: "$", CAD: "$",
  };

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

  const monthKey = (dateStr) => (dateStr || "").slice(0, 7); // YYYY-MM
  const currentMonth = () => todayStr().slice(0, 7);

  const monthLabel = (key) => {
    if (!key) return "";
    const [y, m] = key.split("-");
    const date = new Date(Number(y), Number(m) - 1, 1);
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
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

  /* ---------- Lock screen ---------- */
  async function initLock() {
    // If no password is set yet in this browser, seed the default hash
    // so the user is prompted to unlock instead of creating a password.
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
        const confirm = confirmInput.value;
        if (pwd.length < 4) {
          errEl.textContent = "Password must be at least 4 characters";
          errEl.hidden = false;
          return;
        }
        if (pwd !== confirm) {
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
      if (
        confirm(
          "This will erase your data and reset the password to the preset. Continue?"
        )
      ) {
        localStorage.removeItem(KEYS.data);
        localStorage.setItem(KEYS.pwd, DEFAULT_PWD_HASH);
        location.reload();
      }
    });

    // Auto-focus the password input so the user can type without clicking,
    // helpful when browser overlays cover parts of the page.
    setTimeout(() => {
      const input = $("#passwordInput");
      if (input) input.focus();
    }, 100);
  }

  function unlock() {
    $("#lockScreen").style.display = "none";
    $("#app").hidden = false;
    loadData();
    renderAll();
  }

  function lockNow() {
    $("#app").hidden = true;
    $("#lockScreen").style.display = "flex";
    $("#passwordInput").value = "";
    $("#passwordConfirm").value = "";
    $("#lockError").hidden = true;
  }

  /* ---------- Tabs ---------- */
  function initTabs() {
    $$(".tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".tab").forEach((b) => b.classList.remove("active"));
        $$(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        $(`#${btn.dataset.tab}`).classList.add("active");
      });
    });
  }

  /* ---------- Renderers ---------- */
  function renderAll() {
    $("#monthLabel").textContent = monthLabel(currentMonth());
    renderOverview();
    renderBudget();
    renderExpenses();
    renderSavings();
    renderSettings();
    populateExpenseCategorySelect();
    populateMonthFilter();
  }

  function renderOverview() {
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
      progressEl.innerHTML = '<p class="empty">No budget categories yet. Add some in the Budget tab.</p>';
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

    // Recent expenses
    const recentEl = $("#recentExpenses");
    const recent = [...state.expenses]
      .sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id))
      .slice(0, 5);
    if (!recent.length) {
      recentEl.innerHTML = '<li class="empty">No expenses recorded yet.</li>';
    } else {
      recentEl.innerHTML = recent.map(renderExpenseItem).join("");
      attachReceiptClicks(recentEl);
    }
  }

  function renderBudget() {
    $("#incomeAmount").value = state.income || "";

    const list = $("#categoryList");
    if (!state.categories.length) {
      list.innerHTML = '<li class="empty">No categories added yet.</li>';
      return;
    }
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

  function renderExpenses() {
    const filterMonth = $("#expFilter").value;
    const list = $("#expenseList");
    let items = [...state.expenses].sort((a, b) =>
      (b.date + b.id).localeCompare(a.date + a.id)
    );
    if (filterMonth) {
      items = items.filter((e) => monthKey(e.date) === filterMonth);
    }
    if (!items.length) {
      list.innerHTML = '<li class="empty">No expenses recorded yet.</li>';
      return;
    }
    list.innerHTML = items.map(renderExpenseItem).join("");
    attachReceiptClicks(list);
  }

  function renderExpenseItem(exp) {
    const cat = state.categories.find((c) => c.id === exp.categoryId);
    const catName = cat ? cat.name : "Uncategorized";
    const receiptHtml = exp.receipt
      ? `<img src="${exp.receipt}" class="receipt-thumb" data-receipt="${exp.id}" alt="Receipt" />`
      : "";
    return `
      <li class="list-item">
        ${receiptHtml}
        <div class="list-item-main">
          <div class="list-item-title">${escapeHtml(exp.desc)}</div>
          <div class="list-item-sub">${escapeHtml(catName)} · ${exp.date}</div>
        </div>
        <div class="list-item-amount">${fmt(exp.amount)}</div>
        <div class="list-item-actions">
          <button data-action="del-exp" data-id="${exp.id}" title="Delete">🗑️</button>
        </div>
      </li>`;
  }

  function renderSavings() {
    const list = $("#goalList");
    if (!state.goals.length) {
      list.innerHTML = '<li class="empty">No savings goals yet.</li>';
      return;
    }
    list.innerHTML = state.goals
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
            <div class="progress-fill" style="width: ${pct}%"></div>
          </div>
          <div class="row-form" style="margin-top:0.6rem">
            <input type="number" placeholder="Add to savings" step="0.01" min="0" data-goal-input="${g.id}" />
            <button class="primary" data-action="add-saving" data-id="${g.id}">Add</button>
            <button class="secondary" data-action="del-goal" data-id="${g.id}">Delete</button>
          </div>
        </li>`;
      })
      .join("");
  }

  function renderSettings() {
    $("#currencySelect").value = currency;
  }

  function populateExpenseCategorySelect() {
    const sel = $("#expCategory");
    sel.innerHTML =
      '<option value="">Select category</option>' +
      state.categories
        .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
        .join("");
  }

  function populateMonthFilter() {
    const sel = $("#expFilter");
    const months = [...new Set(state.expenses.map((e) => monthKey(e.date)))]
      .filter(Boolean)
      .sort()
      .reverse();
    const current = sel.value;
    sel.innerHTML =
      '<option value="">All months</option>' +
      months
        .map((m) => `<option value="${m}">${monthLabel(m)}</option>`)
        .join("");
    sel.value = current;
  }

  function attachReceiptClicks(container) {
    container.querySelectorAll("[data-receipt]").forEach((img) => {
      img.addEventListener("click", () => {
        $("#modalImage").src = img.src;
        $("#modal").hidden = false;
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

    // Expense form
    $("#expDate").value = todayStr();

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

    $("#expenseForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const desc = $("#expDesc").value.trim();
      const amount = parseFloat($("#expAmount").value);
      const date = $("#expDate").value;
      const categoryId = $("#expCategory").value;
      const receipt = $("#receiptPreview").dataset.dataUrl || null;

      if (!desc || isNaN(amount) || !date || !categoryId) return;

      state.expenses.push({
        id: uid(), desc, amount, date, categoryId, receipt,
      });
      saveData();

      e.target.reset();
      $("#expDate").value = todayStr();
      const preview = $("#receiptPreview");
      preview.hidden = true;
      preview.innerHTML = "";
      delete preview.dataset.dataUrl;

      renderAll();
      showToast("Expense added");
    });

    // Filter
    $("#expFilter").addEventListener("change", renderExpenses);

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

    // Delegated clicks (categories, expenses, goals)
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === "del-cat") {
        if (confirm("Delete this category? Expenses will keep their record but show 'Uncategorized'.")) {
          state.categories = state.categories.filter((c) => c.id !== id);
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
        if (confirm("Delete this expense?")) {
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

    // Header lock button
    $("#lockNowBtn").addEventListener("click", lockNow);

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
      if (newPwd.length < 4) {
        alert("Password too short.");
        return;
      }
      const confirmPwd = prompt("Confirm new password:");
      if (newPwd !== confirmPwd) {
        alert("Passwords do not match.");
        return;
      }
      localStorage.setItem(KEYS.pwd, await sha256(newPwd));
      showToast("Password changed");
    });

    // Export
    $("#exportBtn").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `my-budget-${todayStr()}.json`;
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
      if (
        confirm(
          "Delete ALL budget data (categories, expenses, goals, receipts)? This cannot be undone."
        )
      ) {
        state = { income: 0, categories: [], expenses: [], goals: [] };
        saveData();
        renderAll();
        showToast("All data cleared");
      }
    });

    // Modal close
    $("#modalClose").addEventListener("click", () => ($("#modal").hidden = true));
    $("#modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") $("#modal").hidden = true;
    });
  }

  /* ---------- Image compression for receipts ---------- */
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
    initTabs();
    initForms();
  });
})();
