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
└── .github/workflows/deploy.yml  # GitHub Pages deploy
```
