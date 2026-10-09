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

    /* Credit Builder */
    "cb.title": "🏗️ Credit Builder",
    "cb.sub": "Build your score: keep utilization low, pay every card on time, and keep old accounts open.",
    "cb.utilization": "Overall utilization",
    "cb.util.excellent": "Excellent",
    "cb.util.good": "Good",
    "cb.util.warning": "Watch out",
    "cb.util.danger": "Too high",
    "cb.util.noCards": "Add a credit card to see utilization.",
    "cb.util.perCard": "Per card",
    "cb.util.noLimit": "No limit set",
    "cb.util.payDownTo30": "Pay down {amount} to reach 30%",
    "cb.util.payDownTo10": "Pay down {amount} to reach 10%",
    "cb.util.under10": "Under 10% — keep it there.",
    "cb.reminders": "Payment reminders",
    "cb.rem.none": "Add a due day to your cards to see reminders.",
    "cb.rem.dueToday": "Due today",
    "cb.rem.dueTomorrow": "Due tomorrow",
    "cb.rem.dueIn": "Due in {n} days",
    "cb.rem.overdue": "Due day passed {n}d ago — pay now if you haven't",
    "cb.rem.next": "Next due {date}",
    "cb.rem.day": "day",
    "cb.rem.days": "days",
    "cb.rem.paid": "Balance paid off",
    "cb.rem.pay": "Pay",
    "cb.score": "Credit score",
    "cb.score.none": "No score yet. Tap + Log Score to start.",
    "cb.score.change": "{change} since {date}",
    "cb.score.first": "First entry",
    "cb.score.latest": "Latest",
    "cb.band.poor": "Poor",
    "cb.band.fair": "Fair",
    "cb.band.good": "Good",
    "cb.band.veryGood": "Very Good",
    "cb.band.exceptional": "Exceptional",
    "cb.accountAge": "Account age",
    "cb.age.none": "Add opened dates to your cards to see account age.",
    "cb.age.oldest": "Oldest",
    "cb.age.average": "Average",
    "cb.age.yearsMonths": "{y}y {m}m",
    "cb.habits": "✅ Credit-building habits",
    "cb.habit.onTime": "Pay at least the minimum on every card, on time, every month.",
    "cb.habit.util": "Keep utilization under 30% — ideally under 10%.",
    "cb.habit.keepOld": "Don't close your oldest accounts; age helps your score.",
    "cb.habit.inquiries": "Limit new hard inquiries — space applications 6+ months apart.",
    "cb.habit.reports": "Check your credit reports from all three bureaus once a year.",
    "cb.glance.nextDue": "Next card payment",
    "cb.glance.none": "No card payments due",
    "cb.valid.limit": "Credit limit must be greater than 0",
    "cb.valid.balance": "Balance can't be negative",
    "cb.valid.dueDay": "Due day must be between 1 and 31",

    /* Paste from bank */
    "cp.btn": "📋 Paste from bank",
    "cp.title": "📋 Paste account details",
    "cp.hint": "Copy the account summary from your bank's website and paste it here.",
    "cp.textLabel": "Pasted account details",
    "cp.placeholder": "Prime Visa (...3410)\nCurrent balance\n$707.78\nTotal credit limit\n$1,000.00",
    "cp.import": "Import",
    "cp.cancel": "Cancel",
    "cp.recognized": "{n} fields recognized",
    "cp.recognizedOne": "1 field recognized",
    "cp.none": "Nothing recognized yet. Include lines like \"Current balance\" and \"Total credit limit\".",
    "cp.few": "Only a few fields were recognized. Lines not understood:",
    "cp.willUpdate": "Will update {name}",
    "cp.willCreate": "Will open the Add Card form with these values",
    "cp.derived": "computed from balance + available credit",
    "cp.field.name": "Card name",
    "cp.field.last4": "Last 4 digits",
    "cp.field.balance": "Current balance",
    "cp.field.pendingCharges": "Pending charges",
    "cp.field.availableCredit": "Available credit",
    "cp.field.limit": "Credit limit",
    "cp.field.nextClosingDate": "Next closing date",
    "cp.field.lastStatementBalance": "Last statement balance",
    "cp.field.lastStatementDate": "Last statement date",
    "cp.field.remainingStatementBalance": "Remaining statement balance",
    "cp.field.minimumPayment": "Minimum payment",
    "cp.field.paymentDueDate": "Payment due date",
    "cp.field.apr": "APR",
    "cp.field.imported": "Imported",
    "cp.toast.updated": "Updated {name}",
    "cp.toast.prefilled": "Review and save — {n} fields filled in",
    "cp.toast.invalid": "Some values were skipped (negative or invalid numbers)",
    "cp.card.pending": "Pending {amount}",
    "cp.card.available": "Available {amount}",
    "cp.card.closes": "Closes {date} ({when})",
    "cp.card.inDays": "in {n}d",
    "cp.card.today": "today",
    "cp.card.passed": "passed",
    "cp.card.stmtDue": "Stmt due {amount}",
    "cp.card.imported": "Imported {when}",
    "cp.card.lastStmt": "{amount} on {date}",
    "cp.cb.stmtDue": "Statement balance due: {amount}",
    "cp.rel.justNow": "just now",
    "cp.rel.minutes": "{n}m ago",
    "cp.rel.hours": "{n}h ago",
    "cp.rel.days": "{n}d ago",
    "cp.form.nextClose": "Next closing date (optional)",

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

    "cb.title": "🏗️ ණය ගොඩනැගීම",
    "cb.sub": "ඔබේ ලකුණු ගොඩනගන්න: භාවිතය අඩුවෙන් තබන්න, සෑම කාඩ්පතක්ම වේලාවට ගෙවන්න, පැරණි ගිණුම් විවෘතව තබන්න.",
    "cb.utilization": "සමස්ත භාවිතය",
    "cb.util.excellent": "විශිෂ්ටයි",
    "cb.util.good": "හොඳයි",
    "cb.util.warning": "අවධානය",
    "cb.util.danger": "ඉතා ඉහළයි",
    "cb.util.noCards": "භාවිතය බැලීමට ණය කාඩ්පතක් එක් කරන්න.",
    "cb.util.perCard": "කාඩ්පත අනුව",
    "cb.util.noLimit": "සීමාවක් නැත",
    "cb.util.payDownTo30": "30% කරා යාමට {amount} ගෙවන්න",
    "cb.util.payDownTo10": "10% කරා යාමට {amount} ගෙවන්න",
    "cb.util.under10": "10% ට අඩුයි — එසේම තබා ගන්න.",
    "cb.reminders": "ගෙවීම් සිහිකැඩවීම්",
    "cb.rem.none": "සිහිකැඩවීම් බැලීමට කාඩ්පත්වලට ගෙවිය යුතු දිනයක් එක් කරන්න.",
    "cb.rem.dueToday": "අද ගෙවිය යුතුයි",
    "cb.rem.dueTomorrow": "හෙට ගෙවිය යුතුයි",
    "cb.rem.dueIn": "දින {n} කින් ගෙවිය යුතුයි",
    "cb.rem.overdue": "ගෙවිය යුතු දිනය දින {n} කට පෙර ගතවී ඇත — ගෙවා නැත්නම් දැන් ගෙවන්න",
    "cb.rem.next": "ඊළඟ ගෙවීම {date}",
    "cb.rem.day": "දිනය",
    "cb.rem.days": "දින",
    "cb.rem.paid": "ශේෂය ගෙවා අවසන්",
    "cb.rem.pay": "ගෙවන්න",
    "cb.score": "ණය ලකුණු",
    "cb.score.none": "තවම ලකුණු නැත. ආරම්භ කිරීමට + Log Score ඔබන්න.",
    "cb.score.change": "{date} සිට {change}",
    "cb.score.first": "පළමු සටහන",
    "cb.score.latest": "නවතම",
    "cb.band.poor": "දුර්වල",
    "cb.band.fair": "සාධාරණ",
    "cb.band.good": "හොඳ",
    "cb.band.veryGood": "ඉතා හොඳ",
    "cb.band.exceptional": "විශිෂ්ට",
    "cb.accountAge": "ගිණුම් වයස",
    "cb.age.none": "ගිණුම් වයස බැලීමට කාඩ්පත්වලට විවෘත කළ දිනයන් එක් කරන්න.",
    "cb.age.oldest": "පැරණිතම",
    "cb.age.average": "සාමාන්‍ය",
    "cb.age.yearsMonths": "අවු {y} මාස {m}",
    "cb.habits": "✅ ණය ගොඩනැගීමේ පුරුදු",
    "cb.habit.onTime": "සෑම මසකම, සෑම කාඩ්පතකටම අවම වශයෙන් අවම ගෙවීම වේලාවට ගෙවන්න.",
    "cb.habit.util": "භාවිතය 30% ට අඩුවෙන් තබන්න — හැකි නම් 10% ට අඩුවෙන්.",
    "cb.habit.keepOld": "පැරණිතම ගිණුම් වසා නොදමන්න; වයස ඔබේ ලකුණුවලට උපකාරී වේ.",
    "cb.habit.inquiries": "නව hard inquiry සීමා කරන්න — අයදුම්පත් මාස 6+ පරතරයකින් ඉදිරිපත් කරන්න.",
    "cb.habit.reports": "වසරකට වරක් කාර්යාංශ තුනෙන්ම ඔබේ ණය වාර්තා පරීක්ෂා කරන්න.",
    "cb.glance.nextDue": "ඊළඟ කාඩ්පත් ගෙවීම",
    "cb.glance.none": "ගෙවිය යුතු කාඩ්පත් ගෙවීම් නැත",
    "cb.valid.limit": "ණය සීමාව 0 ට වැඩි විය යුතුයි",
    "cb.valid.balance": "ශේෂය සෘණ විය නොහැක",
    "cb.valid.dueDay": "ගෙවිය යුතු දිනය 1 සිට 31 අතර විය යුතුයි",

    /* Paste from bank */
    "cp.btn": "📋 බැංකුවෙන් අලවන්න",
    "cp.title": "📋 ගිණුම් විස්තර අලවන්න",
    "cp.hint": "ඔබේ බැංකු වෙබ් අඩවියෙන් ගිණුම් සාරාංශය පිටපත් කර මෙහි අලවන්න.",
    "cp.textLabel": "අලවන ලද ගිණුම් විස්තර",
    "cp.placeholder": "Prime Visa (...3410)\nCurrent balance\n$707.78\nTotal credit limit\n$1,000.00",
    "cp.import": "ආයාත කරන්න",
    "cp.cancel": "අවලංගු කරන්න",
    "cp.recognized": "ක්ෂේත්‍ර {n} ක් හඳුනාගත්තා",
    "cp.recognizedOne": "ක්ෂේත්‍ර 1 ක් හඳුනාගත්තා",
    "cp.none": "තවම කිසිවක් හඳුනාගත නැත. \"Current balance\" සහ \"Total credit limit\" වැනි පේළි ඇතුළත් කරන්න.",
    "cp.few": "ක්ෂේත්‍ර කිහිපයක් පමණක් හඳුනාගත්තා. තේරුම් නොගත් පේළි:",
    "cp.willUpdate": "{name} යාවත්කාලීන වේ",
    "cp.willCreate": "මෙම අගයන් සමඟ කාඩ්පත එක් කිරීමේ පෝරමය විවෘත වේ",
    "cp.derived": "ශේෂය + ලබාගත හැකි ණය මගින් ගණනය කළා",
    "cp.field.name": "කාඩ්පත් නම",
    "cp.field.last4": "අවසන් ඉලක්කම් 4",
    "cp.field.balance": "වත්මන් ශේෂය",
    "cp.field.pendingCharges": "අපේක්ෂිත ගාස්තු",
    "cp.field.availableCredit": "ලබාගත හැකි ණය",
    "cp.field.limit": "ණය සීමාව",
    "cp.field.nextClosingDate": "ඊළඟ වසා දමන දිනය",
    "cp.field.lastStatementBalance": "අවසන් ප්‍රකාශන ශේෂය",
    "cp.field.lastStatementDate": "අවසන් ප්‍රකාශන දිනය",
    "cp.field.remainingStatementBalance": "ඉතිරි ප්‍රකාශන ශේෂය",
    "cp.field.minimumPayment": "අවම ගෙවීම",
    "cp.field.paymentDueDate": "ගෙවිය යුතු දිනය",
    "cp.field.apr": "APR",
    "cp.field.imported": "ආයාත කළා",
    "cp.toast.updated": "{name} යාවත්කාලීන කළා",
    "cp.toast.prefilled": "සමාලෝචනය කර සුරකින්න — ක්ෂේත්‍ර {n} ක් පුරවා ඇත",
    "cp.toast.invalid": "සමහර අගයන් මඟ හැරුණා (සෘණ හෝ වලංගු නොවන අංක)",
    "cp.card.pending": "අපේක්ෂිත {amount}",
    "cp.card.available": "ලබාගත හැකි {amount}",
    "cp.card.closes": "{date} වසා දමයි ({when})",
    "cp.card.inDays": "දින {n} කින්",
    "cp.card.today": "අද",
    "cp.card.passed": "ගතවී ඇත",
    "cp.card.stmtDue": "ප්‍රකාශන ගෙවීම {amount}",
    "cp.card.imported": "{when} ආයාත කළා",
    "cp.card.lastStmt": "{date} දින {amount}",
    "cp.cb.stmtDue": "ගෙවිය යුතු ප්‍රකාශන ශේෂය: {amount}",
    "cp.rel.justNow": "මේ දැන්",
    "cp.rel.minutes": "මිනිත්තු {n} කට පෙර",
    "cp.rel.hours": "පැය {n} කට පෙර",
    "cp.rel.days": "දින {n} කට පෙර",
    "cp.form.nextClose": "ඊළඟ වසා දමන දිනය (විකල්ප)",

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
