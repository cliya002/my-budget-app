/* Pocket Budget — internationalization
 * Translations are keyed by a stable string (e.g. "nav.dashboard").
 * To add a language: copy the `en` object, translate values, register in LOCALES.
 * Strings not yet translated fall back to English automatically.
 */
(function (window) {
  "use strict";

  const en = {
    /* Navigation */
    "nav.dashboard": "Dashboard",
    "nav.balances": "Balances",
    "nav.goals": "Goals",
    "nav.events": "Events",
    "nav.transactions": "Transactions",
    "nav.insights": "Insights",
    "nav.credit": "Credit",
    "nav.family": "Family",
    "nav.settings": "Settings",

    /* Dashboard */
    "dash.title": "My Dashboard",
    "dash.report": "📄 Report",
    "dash.logPaycheck": "💼 Log Paycheck",
    "dash.repeatLast": "🔁 Repeat last",
    "dash.addIncome": "+ Income",
    "dash.addTxn": "+ Add Transaction",

    /* Balances */
    "balances.title": "Balances",

    /* Goals */
    "goals.title": "Savings Goals",

    /* Events */
    "events.title": "Events",

    /* Transactions */
    "txn.title": "Transactions",

    /* Insights */
    "insights.title": "Insights",

    /* Credit */
    "credit.title": "Credit",

    /* Family */
    "family.title": "Family",

    /* Settings */
    "settings.title": "Settings",
    "settings.search": "🔍 Search settings (e.g. theme, sync, password)…",
    "settings.budgetBehavior": "Budget Behavior",
    "settings.dashboardCards": "Dashboard Cards",
    "settings.appearance": "Appearance",
    "settings.themeLight": "☀️ Light",
    "settings.themeDark": "🌙 Dark",
    "settings.themeAuto": "⚙️ Auto",
    "settings.currency": "Currency",
    "settings.security": "Security",
    "settings.changePwd": "Change Password",
    "settings.lockNow": "🔒 Lock now",
    "settings.bioEnable": "👆 Enable biometric unlock",
    "settings.bioDisable": "🚫 Disable biometric unlock",
    "settings.autoLock": "Auto-lock after (minutes)",
    "settings.never": "Never",
    "settings.hideAmounts": "Hide amounts (stealth mode)",
    "settings.skipDelete": "Skip delete confirmations",
    "settings.data": "Data",
    "settings.exportJson": "Export Backup (JSON)",
    "settings.exportCsv": "Export Transactions (CSV)",
    "settings.exportTax": "Export YTD for Taxes (CSV)",
    "settings.import": "Import Backup",
    "settings.forceUpdate": "🔄 Force App Update (clear cache)",
    "settings.clearAll": "Clear All Data",
    "settings.language": "Language",
    "settings.help": "Help",

    /* Lock screen */
    "lock.title": "Pocket Budget",
    "lock.tagline": "Made by Chaturanga Liyanage",
    "lock.subtitle": "Enter your password to continue",
    "lock.unlock": "Unlock",
    "lock.password": "Password",
    "lock.confirmPassword": "Confirm password",
    "lock.bioUnlock": "Unlock with biometrics",
    "lock.bioVerifying": "Verifying…",
    "lock.modePassword": "🔑 Password",
    "lock.modePin": "🔢 PIN",
    "lock.forgot": "Forgot password? Reset app",
    "lock.capsLock": "⚠ Caps Lock is on",
    "lock.offlineMode": "Offline mode",
    "lock.setTitle": "Set Your Password",
    "lock.setSubtitle": "Create a password to protect your data",
    "lock.setBtn": "Set Password",
    "lock.lastOpen": "Last open",
    "lock.syncReady": "Sync ready",

    /* Network status */
    "net.online": "Online",
    "net.offline": "Offline",
    "net.offlineBanner": "📵 Offline — your changes are saved locally and will sync when you reconnect",
    "net.pendingChanges": "pending changes",

    /* Common */
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.add": "Add",
    "common.close": "Close",
    "common.confirm": "Confirm",
    "common.yes": "Yes",
    "common.no": "No",
    "common.search": "Search",
    "common.filter": "Filter",
    "common.export": "Export",
    "common.import": "Import",
    "common.loading": "Loading…",
    "common.error": "Error",
    "common.success": "Success",
  };

  const si = {
    /* Sinhala (Sri Lanka) */
    "nav.dashboard": "උපකරණ පුවරුව",
    "nav.balances": "ශේෂ",
    "nav.goals": "ඉලක්ක",
    "nav.events": "සිදුවීම්",
    "nav.transactions": "ගනුදෙනු",
    "nav.insights": "තීක්ෂ්ණ දෘෂ්ටි",
    "nav.credit": "ණය",
    "nav.family": "පවුල",
    "nav.settings": "සැකසුම්",

    "dash.title": "මගේ උපකරණ පුවරුව",
    "dash.report": "📄 වාර්තාව",
    "dash.logPaycheck": "💼 වැටුප සටහන් කරන්න",
    "dash.repeatLast": "🔁 අවසන් එක නැවත",
    "dash.addIncome": "+ ආදායම",
    "dash.addTxn": "+ ගනුදෙනුවක් එක් කරන්න",

    "balances.title": "ශේෂ",
    "goals.title": "ඉතිරිකිරීමේ ඉලක්ක",
    "events.title": "සිදුවීම්",
    "txn.title": "ගනුදෙනු",
    "insights.title": "තීක්ෂ්ණ දෘෂ්ටි",
    "credit.title": "ණය",
    "family.title": "පවුල",
    "settings.title": "සැකසුම්",
    "settings.search": "🔍 සැකසුම් සොයන්න…",
    "settings.budgetBehavior": "අයවැය හැසිරීම",
    "settings.dashboardCards": "උපකරණ පුවරු කාඩ්පත්",
    "settings.appearance": "පෙනුම",
    "settings.themeLight": "☀️ ආලෝකය",
    "settings.themeDark": "🌙 අඳුර",
    "settings.themeAuto": "⚙️ ස්වයංක්‍රීය",
    "settings.currency": "මුදල්",
    "settings.security": "ආරක්ෂාව",
    "settings.changePwd": "මුරපදය වෙනස් කරන්න",
    "settings.lockNow": "🔒 දැන් අගුළු දමන්න",
    "settings.bioEnable": "👆 ජීවමාන අගුළු හැරීම සක්‍රීය කරන්න",
    "settings.bioDisable": "🚫 ජීවමාන අගුළු හැරීම අක්‍රීය කරන්න",
    "settings.autoLock": "ස්වයංක්‍රීය අගුළු දැමීම (මිනිත්තු)",
    "settings.never": "කවදාවත්",
    "settings.hideAmounts": "මුදල් සඟවන්න (රහස්‍ය ආකාරය)",
    "settings.skipDelete": "මකා දැමීමේ තහවුරු කිරීම් මඟ හරින්න",
    "settings.data": "දත්ත",
    "settings.exportJson": "උපස්ථය නිර්යාත කරන්න (JSON)",
    "settings.exportCsv": "ගනුදෙනු නිර්යාත කරන්න (CSV)",
    "settings.exportTax": "බදු සඳහා YTD නිර්යාත (CSV)",
    "settings.import": "උපස්ථය ආයාත කරන්න",
    "settings.forceUpdate": "🔄 යෙදුම නැවත පූරණය කරන්න",
    "settings.clearAll": "සියලු දත්ත මකා දමන්න",
    "settings.language": "භාෂාව",
    "settings.help": "උදව්",

    "lock.subtitle": "දිගටම කරගෙන යාමට ඔබේ මුරපදය ඇතුළත් කරන්න",
    "lock.unlock": "අගුළු හරින්න",
    "lock.password": "මුරපදය",
    "lock.confirmPassword": "මුරපදය තහවුරු කරන්න",
    "lock.bioUnlock": "ජීවමාන තොරතුරු සමඟ අගුළු හරින්න",
    "lock.bioVerifying": "පරීක්ෂා කරමින්…",
    "lock.modePassword": "🔑 මුරපදය",
    "lock.modePin": "🔢 PIN",
    "lock.forgot": "මුරපදය අමතකද? යෙදුම යළි පිහිටුවන්න",
    "lock.capsLock": "⚠ Caps Lock සක්‍රීයයි",
    "lock.offlineMode": "අන්තර්ජාල සම්බන්ධය නැත",
    "lock.setTitle": "ඔබේ මුරපදය සකසන්න",
    "lock.setSubtitle": "ඔබේ දත්ත ආරක්ෂා කිරීමට මුරපදයක් සාදන්න",
    "lock.setBtn": "මුරපදය සකසන්න",
    "lock.lastOpen": "අවසන් වරට විවෘත කළේ",
    "lock.syncReady": "සමමුහුර්තය සූදානම්",

    "net.online": "අන්තර්ජාලය",
    "net.offline": "අන්තර්ජාලය නැත",
    "net.offlineBanner": "📵 අන්තර්ජාල සම්බන්ධය නැත — ඔබේ වෙනස්කම් දේශීයව සුරකිනු ලැබේ සහ නැවත සම්බන්ධ වූ විට සමමුහුර්ත වේ",
    "net.pendingChanges": "පොරොත්තු වෙනස්කම්",

    "common.save": "සුරකින්න",
    "common.cancel": "අවලංගු",
    "common.delete": "මකන්න",
    "common.edit": "සංස්කරණය",
    "common.add": "එක් කරන්න",
    "common.close": "වසන්න",
    "common.confirm": "තහවුරු කරන්න",
    "common.yes": "ඔව්",
    "common.no": "නැත",
    "common.search": "සොයන්න",
    "common.filter": "පෙරහන",
    "common.export": "නිර්යාත",
    "common.import": "ආයාත",
    "common.loading": "පූරණය…",
    "common.error": "දෝෂය",
    "common.success": "සාර්ථකයි",
  };

  const LOCALES = {
    en: { name: "English", strings: en },
    si: { name: "සිංහල", strings: si },
  };

  let currentLocale = "en";

  function setLocale(code) {
    if (LOCALES[code]) {
      currentLocale = code;
      try { localStorage.setItem("mb_locale", code); } catch (e) {}
      applyTranslations();
    }
  }

  function getLocale() {
    return currentLocale;
  }

  function getAvailableLocales() {
    return Object.entries(LOCALES).map(([code, info]) => ({ code, name: info.name }));
  }

  function detectLocale() {
    // Priority: saved → browser language prefix → English
    try {
      const saved = localStorage.getItem("mb_locale");
      if (saved && LOCALES[saved]) return saved;
    } catch (e) {}
    if (navigator.language) {
      const prefix = navigator.language.slice(0, 2).toLowerCase();
      if (LOCALES[prefix]) return prefix;
    }
    return "en";
  }

  function t(key, fallback) {
    const dict = LOCALES[currentLocale] && LOCALES[currentLocale].strings;
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) {
      return dict[key];
    }
    // Fall back to English
    if (LOCALES.en && LOCALES.en.strings && Object.prototype.hasOwnProperty.call(LOCALES.en.strings, key)) {
      return LOCALES.en.strings[key];
    }
    return fallback != null ? fallback : key;
  }

  function applyTranslations() {
    // Translate all elements with [data-i18n="key"]
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      const text = t(key);
      // For inputs, set placeholder if data-i18n-attr="placeholder"; else textContent
      const attr = el.getAttribute("data-i18n-attr");
      if (attr) {
        el.setAttribute(attr, text);
      } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        el.placeholder = text;
      } else {
        // Preserve any leading icon span before the translated text by writing into a child if present
        // Otherwise replace textContent
        const child = el.querySelector(".nav-icon, .icon");
        if (child && el.children.length === 1 && el.firstElementChild === child) {
          // Element has icon span; append text after
          const textNode = el.childNodes[el.childNodes.length - 1];
          if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            textNode.nodeValue = " " + text;
          } else {
            el.appendChild(document.createTextNode(" " + text));
          }
        } else {
          el.textContent = text;
        }
      }
    });

    // Translate elements with [data-i18n-title="key"] (tooltip)
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      if (key) el.title = t(key);
    });

    // Translate elements with [data-i18n-placeholder="key"]
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      if (key) el.placeholder = t(key);
    });

    // Update document language attribute
    document.documentElement.setAttribute("lang", currentLocale);
  }

  // Auto-detect on load
  currentLocale = detectLocale();

  // Expose globally
  window.i18n = { t, setLocale, getLocale, getAvailableLocales, applyTranslations };
})(window);
