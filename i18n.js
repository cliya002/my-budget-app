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

  const es = {
    /* Spanish */
    "nav.dashboard": "Panel",
    "nav.balances": "Saldos",
    "nav.goals": "Objetivos",
    "nav.events": "Eventos",
    "nav.transactions": "Transacciones",
    "nav.insights": "Análisis",
    "nav.credit": "Crédito",
    "nav.family": "Familia",
    "nav.settings": "Ajustes",

    "dash.title": "Mi Panel",
    "dash.report": "📄 Informe",
    "dash.logPaycheck": "💼 Registrar nómina",
    "dash.repeatLast": "🔁 Repetir último",
    "dash.addIncome": "+ Ingreso",
    "dash.addTxn": "+ Añadir transacción",

    "balances.title": "Saldos",
    "goals.title": "Metas de ahorro",
    "events.title": "Eventos",
    "txn.title": "Transacciones",
    "insights.title": "Análisis",
    "credit.title": "Crédito",
    "family.title": "Familia",
    "settings.title": "Ajustes",
    "settings.search": "🔍 Buscar ajustes (tema, sincronización, contraseña)…",
    "settings.budgetBehavior": "Comportamiento del presupuesto",
    "settings.dashboardCards": "Tarjetas del panel",
    "settings.appearance": "Apariencia",
    "settings.themeLight": "☀️ Claro",
    "settings.themeDark": "🌙 Oscuro",
    "settings.themeAuto": "⚙️ Auto",
    "settings.currency": "Moneda",
    "settings.security": "Seguridad",
    "settings.changePwd": "Cambiar contraseña",
    "settings.lockNow": "🔒 Bloquear ahora",
    "settings.bioEnable": "👆 Activar desbloqueo biométrico",
    "settings.bioDisable": "🚫 Desactivar desbloqueo biométrico",
    "settings.autoLock": "Bloquear automáticamente tras (minutos)",
    "settings.never": "Nunca",
    "settings.hideAmounts": "Ocultar importes (modo discreto)",
    "settings.skipDelete": "Omitir confirmaciones de borrado",
    "settings.data": "Datos",
    "settings.exportJson": "Exportar respaldo (JSON)",
    "settings.exportCsv": "Exportar transacciones (CSV)",
    "settings.exportTax": "Exportar YTD para impuestos (CSV)",
    "settings.import": "Importar respaldo",
    "settings.forceUpdate": "🔄 Forzar actualización (limpiar caché)",
    "settings.clearAll": "Borrar todos los datos",
    "settings.language": "Idioma",
    "settings.help": "Ayuda",

    "lock.subtitle": "Introduce tu contraseña para continuar",
    "lock.unlock": "Desbloquear",
    "lock.password": "Contraseña",
    "lock.confirmPassword": "Confirmar contraseña",
    "lock.bioUnlock": "Desbloquear con biometría",
    "lock.bioVerifying": "Verificando…",
    "lock.modePassword": "🔑 Contraseña",
    "lock.modePin": "🔢 PIN",
    "lock.forgot": "¿Olvidaste la contraseña? Restablecer",
    "lock.capsLock": "⚠ Bloq Mayús está activado",
    "lock.offlineMode": "Modo sin conexión",
    "lock.setTitle": "Establece tu contraseña",
    "lock.setSubtitle": "Crea una contraseña para proteger tus datos",
    "lock.setBtn": "Establecer contraseña",
    "lock.lastOpen": "Última apertura",
    "lock.syncReady": "Sincronización lista",

    "net.online": "En línea",
    "net.offline": "Sin conexión",
    "net.offlineBanner": "📵 Sin conexión — tus cambios se guardan localmente y se sincronizarán al reconectar",
    "net.pendingChanges": "cambios pendientes",

    "common.save": "Guardar",
    "common.cancel": "Cancelar",
    "common.delete": "Borrar",
    "common.edit": "Editar",
    "common.add": "Añadir",
    "common.close": "Cerrar",
    "common.confirm": "Confirmar",
    "common.yes": "Sí",
    "common.no": "No",
    "common.search": "Buscar",
    "common.filter": "Filtrar",
    "common.export": "Exportar",
    "common.import": "Importar",
    "common.loading": "Cargando…",
    "common.error": "Error",
    "common.success": "Éxito",
  };

  const fr = {
    "nav.dashboard": "Tableau",
    "nav.balances": "Soldes",
    "nav.goals": "Objectifs",
    "nav.events": "Événements",
    "nav.transactions": "Transactions",
    "nav.insights": "Analyses",
    "nav.credit": "Crédit",
    "nav.family": "Famille",
    "nav.settings": "Paramètres",

    "dash.title": "Mon Tableau",
    "dash.report": "📄 Rapport",
    "dash.logPaycheck": "💼 Saisir la paie",
    "dash.repeatLast": "🔁 Répéter la dernière",
    "dash.addIncome": "+ Revenu",
    "dash.addTxn": "+ Ajouter une transaction",

    "balances.title": "Soldes",
    "goals.title": "Objectifs d'épargne",
    "events.title": "Événements",
    "txn.title": "Transactions",
    "insights.title": "Analyses",
    "credit.title": "Crédit",
    "family.title": "Famille",
    "settings.title": "Paramètres",
    "settings.search": "🔍 Rechercher (thème, synchro, mot de passe)…",
    "settings.budgetBehavior": "Comportement du budget",
    "settings.dashboardCards": "Cartes du tableau",
    "settings.appearance": "Apparence",
    "settings.themeLight": "☀️ Clair",
    "settings.themeDark": "🌙 Sombre",
    "settings.themeAuto": "⚙️ Auto",
    "settings.currency": "Devise",
    "settings.security": "Sécurité",
    "settings.changePwd": "Changer le mot de passe",
    "settings.lockNow": "🔒 Verrouiller",
    "settings.bioEnable": "👆 Activer le déverrouillage biométrique",
    "settings.bioDisable": "🚫 Désactiver la biométrie",
    "settings.autoLock": "Verrouillage auto après (minutes)",
    "settings.never": "Jamais",
    "settings.hideAmounts": "Masquer les montants (mode discret)",
    "settings.skipDelete": "Ignorer les confirmations de suppression",
    "settings.data": "Données",
    "settings.exportJson": "Exporter la sauvegarde (JSON)",
    "settings.exportCsv": "Exporter les transactions (CSV)",
    "settings.exportTax": "Exporter YTD pour les impôts (CSV)",
    "settings.import": "Importer une sauvegarde",
    "settings.forceUpdate": "🔄 Forcer la mise à jour",
    "settings.clearAll": "Tout effacer",
    "settings.language": "Langue",
    "settings.help": "Aide",

    "lock.subtitle": "Entrez votre mot de passe",
    "lock.unlock": "Déverrouiller",
    "lock.password": "Mot de passe",
    "lock.confirmPassword": "Confirmer le mot de passe",
    "lock.bioUnlock": "Déverrouiller par biométrie",
    "lock.bioVerifying": "Vérification…",
    "lock.modePassword": "🔑 Mot de passe",
    "lock.modePin": "🔢 PIN",
    "lock.forgot": "Mot de passe oublié ? Réinitialiser",
    "lock.capsLock": "⚠ Verr. Maj activé",
    "lock.offlineMode": "Hors ligne",
    "lock.setTitle": "Définir votre mot de passe",
    "lock.setSubtitle": "Créez un mot de passe pour protéger vos données",
    "lock.setBtn": "Définir le mot de passe",
    "lock.lastOpen": "Dernière ouverture",
    "lock.syncReady": "Synchro prête",

    "net.online": "En ligne",
    "net.offline": "Hors ligne",
    "net.offlineBanner": "📵 Hors ligne — vos changements sont enregistrés localement et seront synchronisés à la reconnexion",
    "net.pendingChanges": "changements en attente",

    "common.save": "Enregistrer",
    "common.cancel": "Annuler",
    "common.delete": "Supprimer",
    "common.edit": "Modifier",
    "common.add": "Ajouter",
    "common.close": "Fermer",
    "common.confirm": "Confirmer",
    "common.yes": "Oui",
    "common.no": "Non",
    "common.search": "Rechercher",
    "common.filter": "Filtrer",
    "common.export": "Exporter",
    "common.import": "Importer",
    "common.loading": "Chargement…",
    "common.error": "Erreur",
    "common.success": "Succès",
  };

  const de = {
    "nav.dashboard": "Übersicht",
    "nav.balances": "Salden",
    "nav.goals": "Ziele",
    "nav.events": "Ereignisse",
    "nav.transactions": "Transaktionen",
    "nav.insights": "Einblicke",
    "nav.credit": "Kredit",
    "nav.family": "Familie",
    "nav.settings": "Einstellungen",

    "dash.title": "Meine Übersicht",
    "dash.report": "📄 Bericht",
    "dash.logPaycheck": "💼 Gehalt erfassen",
    "dash.repeatLast": "🔁 Letztes wiederholen",
    "dash.addIncome": "+ Einnahme",
    "dash.addTxn": "+ Transaktion",

    "balances.title": "Salden",
    "goals.title": "Sparziele",
    "events.title": "Ereignisse",
    "txn.title": "Transaktionen",
    "insights.title": "Einblicke",
    "credit.title": "Kredit",
    "family.title": "Familie",
    "settings.title": "Einstellungen",
    "settings.search": "🔍 Einstellungen suchen…",
    "settings.budgetBehavior": "Budget-Verhalten",
    "settings.dashboardCards": "Übersichtskarten",
    "settings.appearance": "Aussehen",
    "settings.themeLight": "☀️ Hell",
    "settings.themeDark": "🌙 Dunkel",
    "settings.themeAuto": "⚙️ Auto",
    "settings.currency": "Währung",
    "settings.security": "Sicherheit",
    "settings.changePwd": "Passwort ändern",
    "settings.lockNow": "🔒 Jetzt sperren",
    "settings.bioEnable": "👆 Biometrische Entsperrung aktivieren",
    "settings.bioDisable": "🚫 Biometrie deaktivieren",
    "settings.autoLock": "Automatisches Sperren nach (Minuten)",
    "settings.never": "Nie",
    "settings.hideAmounts": "Beträge ausblenden (Tarnmodus)",
    "settings.skipDelete": "Löschbestätigungen überspringen",
    "settings.data": "Daten",
    "settings.exportJson": "Backup exportieren (JSON)",
    "settings.exportCsv": "Transaktionen exportieren (CSV)",
    "settings.exportTax": "YTD für Steuer exportieren (CSV)",
    "settings.import": "Backup importieren",
    "settings.forceUpdate": "🔄 App-Aktualisierung erzwingen",
    "settings.clearAll": "Alle Daten löschen",
    "settings.language": "Sprache",
    "settings.help": "Hilfe",

    "lock.subtitle": "Passwort eingeben, um fortzufahren",
    "lock.unlock": "Entsperren",
    "lock.password": "Passwort",
    "lock.confirmPassword": "Passwort bestätigen",
    "lock.bioUnlock": "Mit Biometrie entsperren",
    "lock.bioVerifying": "Überprüfen…",
    "lock.modePassword": "🔑 Passwort",
    "lock.modePin": "🔢 PIN",
    "lock.forgot": "Passwort vergessen? App zurücksetzen",
    "lock.capsLock": "⚠ Feststelltaste ist aktiv",
    "lock.offlineMode": "Offline-Modus",
    "lock.setTitle": "Passwort festlegen",
    "lock.setSubtitle": "Erstelle ein Passwort zum Schutz deiner Daten",
    "lock.setBtn": "Passwort festlegen",
    "lock.lastOpen": "Zuletzt geöffnet",
    "lock.syncReady": "Sync bereit",

    "net.online": "Online",
    "net.offline": "Offline",
    "net.offlineBanner": "📵 Offline — deine Änderungen werden lokal gespeichert und beim erneuten Verbinden synchronisiert",
    "net.pendingChanges": "ausstehende Änderungen",

    "common.save": "Speichern",
    "common.cancel": "Abbrechen",
    "common.delete": "Löschen",
    "common.edit": "Bearbeiten",
    "common.add": "Hinzufügen",
    "common.close": "Schließen",
    "common.confirm": "Bestätigen",
    "common.yes": "Ja",
    "common.no": "Nein",
    "common.search": "Suchen",
    "common.filter": "Filter",
    "common.export": "Exportieren",
    "common.import": "Importieren",
    "common.loading": "Lädt…",
    "common.error": "Fehler",
    "common.success": "Erfolg",
  };

  const pt = {
    "nav.dashboard": "Painel",
    "nav.balances": "Saldos",
    "nav.goals": "Metas",
    "nav.events": "Eventos",
    "nav.transactions": "Transações",
    "nav.insights": "Análises",
    "nav.credit": "Crédito",
    "nav.family": "Família",
    "nav.settings": "Ajustes",

    "dash.title": "Meu Painel",
    "dash.report": "📄 Relatório",
    "dash.logPaycheck": "💼 Registrar salário",
    "dash.repeatLast": "🔁 Repetir última",
    "dash.addIncome": "+ Receita",
    "dash.addTxn": "+ Adicionar transação",

    "balances.title": "Saldos",
    "goals.title": "Metas de poupança",
    "events.title": "Eventos",
    "txn.title": "Transações",
    "insights.title": "Análises",
    "credit.title": "Crédito",
    "family.title": "Família",
    "settings.title": "Ajustes",
    "settings.search": "🔍 Pesquisar ajustes…",
    "settings.budgetBehavior": "Comportamento do orçamento",
    "settings.dashboardCards": "Cartões do painel",
    "settings.appearance": "Aparência",
    "settings.themeLight": "☀️ Claro",
    "settings.themeDark": "🌙 Escuro",
    "settings.themeAuto": "⚙️ Auto",
    "settings.currency": "Moeda",
    "settings.security": "Segurança",
    "settings.changePwd": "Alterar senha",
    "settings.lockNow": "🔒 Bloquear agora",
    "settings.bioEnable": "👆 Ativar desbloqueio biométrico",
    "settings.bioDisable": "🚫 Desativar biometria",
    "settings.autoLock": "Bloquear automaticamente após (minutos)",
    "settings.never": "Nunca",
    "settings.hideAmounts": "Ocultar valores (modo discreto)",
    "settings.skipDelete": "Pular confirmações de exclusão",
    "settings.data": "Dados",
    "settings.exportJson": "Exportar backup (JSON)",
    "settings.exportCsv": "Exportar transações (CSV)",
    "settings.exportTax": "Exportar YTD para impostos (CSV)",
    "settings.import": "Importar backup",
    "settings.forceUpdate": "🔄 Forçar atualização",
    "settings.clearAll": "Apagar todos os dados",
    "settings.language": "Idioma",
    "settings.help": "Ajuda",

    "lock.subtitle": "Digite sua senha para continuar",
    "lock.unlock": "Desbloquear",
    "lock.password": "Senha",
    "lock.confirmPassword": "Confirmar senha",
    "lock.bioUnlock": "Desbloquear com biometria",
    "lock.bioVerifying": "Verificando…",
    "lock.modePassword": "🔑 Senha",
    "lock.modePin": "🔢 PIN",
    "lock.forgot": "Esqueceu a senha? Redefinir",
    "lock.capsLock": "⚠ Caps Lock está ativo",
    "lock.offlineMode": "Modo offline",
    "lock.setTitle": "Defina sua senha",
    "lock.setSubtitle": "Crie uma senha para proteger seus dados",
    "lock.setBtn": "Definir senha",
    "lock.lastOpen": "Último acesso",
    "lock.syncReady": "Sincronização pronta",

    "net.online": "Online",
    "net.offline": "Offline",
    "net.offlineBanner": "📵 Offline — suas alterações são salvas localmente e serão sincronizadas ao reconectar",
    "net.pendingChanges": "alterações pendentes",

    "common.save": "Salvar",
    "common.cancel": "Cancelar",
    "common.delete": "Excluir",
    "common.edit": "Editar",
    "common.add": "Adicionar",
    "common.close": "Fechar",
    "common.confirm": "Confirmar",
    "common.yes": "Sim",
    "common.no": "Não",
    "common.search": "Pesquisar",
    "common.filter": "Filtrar",
    "common.export": "Exportar",
    "common.import": "Importar",
    "common.loading": "Carregando…",
    "common.error": "Erro",
    "common.success": "Sucesso",
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
    es: { name: "Español", strings: es },
    fr: { name: "Français", strings: fr },
    de: { name: "Deutsch", strings: de },
    pt: { name: "Português", strings: pt },
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
