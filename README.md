# 👛 Pocket Budget App

A mobile-friendly, offline-first budget app that runs entirely in your browser. Track monthly income and expenses, set savings goals, and snap photos of receipts on your phone.

## Features

- 🔒 **Password lock** — set a password on first launch
- 📅 **Monthly budgeting** — categories with limits and live progress bars
- 💸 **Expense tracking** — record spend with description, amount, date, and category
- 🧾 **Receipt uploads** — take a photo with your phone or upload an image; preview and view full-size
- 🎯 **Savings goals** — set targets, optional deadlines, and add to savings over time
- 📱 **Mobile-first UI** — works great on phones, tablets, and desktop
- 💾 **Local-only data** — everything stays in your browser via localStorage
- 📤 **Export / Import** — back up your data as JSON
- 💱 **Multi-currency** — USD, EUR, GBP, JPY, INR, AUD, CAD
- 🏗️ **Credit Builder** — utilization, payment reminders, score log, account age (see below)

### Credit Builder

The **Credit** tab has a Credit Builder panel that turns your cards and score log into concrete next steps:

- **Utilization** — overall balance ÷ limit with a colour band (≤10% excellent, ≤30% good, ≤50% watch out, >50% too high), a per-card progress bar, and "pay down $X to reach 30% / 10%" hints.
- **Payment reminders** — next due date per card, soonest first, with days-until-due. Cards due within 7 days are highlighted; a card whose due day already passed this month while still carrying a balance is flagged. The next payment also shows on the Quick Glance view.
- **Credit score** — latest score with its band (Poor → Exceptional) and the change since the previous entry. Scores are logged via **+ Log Score** (300–850, date, source) and plotted in the Score Trend chart; entries can be deleted from Score History.
- **Account age** — oldest and average account age in years/months, from each card's opened date.
- **Credit-building habits** — a short checklist of habits that move the score.
- **Paste from bank** — tap **📋 Paste from bank** on the Credit tab, paste the account summary copied from your bank's website (e.g. Chase: current balance, pending charges, available credit, total credit limit, next closing date, balance on last statement, remaining statement balance), review the recognized fields, and import. A card whose last 4 digits (or name) match is updated in place; otherwise the Add Card form opens pre-filled.

Cards (name, limit, balance, due day 1–31, optional APR and opened date) and scores are stored in localStorage with the rest of your data and are included in JSON backups. A **Credit Builder** PWA shortcut (`?action=credit-builder`) deep-links straight to the panel.

## Run locally

It's just static HTML/CSS/JS — no build step.

Open `index.html` directly in your browser, or serve the folder:

```bash
# Python
python -m http.server 8000

# Node (npx)
npx serve .
```

Then visit `http://localhost:8000`.

## Deploy with GitHub Pages

This repo includes a GitHub Actions workflow that publishes the site automatically.

1. Create a new repo on GitHub and push this folder (see below).
2. In your repo, go to **Settings → Pages → Source: GitHub Actions**.
3. Push to `main` and your app will deploy to `https://<username>.github.io/<repo>/`.

### Push to GitHub

```bash
git init
git add .
git commit -m "feat: initial budget app"
git branch -M main
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```

## Security Notes

- The password is stored as a **SHA-256 hash** in localStorage. It prevents casual access on a shared device but is **not encryption** — anyone with full access to the browser's storage can clear it and read the unencrypted budget data.
- For sensitive financial data, use this on a personal device only and lock your device with its OS-level password.
- The app makes **no network requests**. Everything runs locally.

## Project structure

```
.
├── index.html    # markup
├── styles.css    # mobile-first styles
├── app.js        # all app logic
├── tests/        # node --test unit tests (parseCardPaste)
└── .github/workflows/deploy.yml  # GitHub Pages deploy
```
