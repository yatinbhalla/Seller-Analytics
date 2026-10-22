<div align="center">

# 📊 Seller Analytics
### *One local dashboard for Flipkart, Shopsy and Meesho: orders, returns, real profit and stock, from the marketplaces' own files and with no double counting.*

[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![Tailwind](https://img.shields.io/badge/Tailwind-4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Recharts](https://img.shields.io/badge/Recharts-3-22B5BF)](https://recharts.org)
[![Gemini](https://img.shields.io/badge/Gemini-Flash--Lite-4285F4?logo=google&logoColor=white)](https://ai.google.dev)
[![Tests](https://img.shields.io/badge/tests-77_passing-2EA44F?logo=vitest&logoColor=white)](#-testing)
[![License: PolyForm NC](https://img.shields.io/badge/License-PolyForm_Noncommercial-yellow.svg)](LICENSE.md)

**Built end-to-end by a PM-Builder · React + Node + SQLite + Gemini · Runs 100% locally**

</div>

---

## 📖 Table of Contents

- [🎯 About](#-about)
- [✨ Highlights](#-highlights)
- [🚀 Quick Start](#-quick-start)
- [📥 Daily Imports](#-daily-imports)
- [🛡️ Why Uploads Can't Corrupt or Double-Count](#️-why-uploads-cant-corrupt-or-double-count)
- [🧮 How the Numbers Work](#-how-the-numbers-work)
- [📦 Products, SKUs & Stock](#-products-skus--stock)
- [🌙 Nightly Auto-Download](#-nightly-auto-download)
- [🤖 Ask AI (Gemini)](#-ask-ai-gemini)
- [📄 Pages](#-pages)
- [🗂️ Project Layout](#️-project-layout)
- [🛠️ Tech Stack](#️-tech-stack)
- [🧪 Testing](#-testing)
- [⚠️ Known Limitations](#️-known-limitations)
- [🗺️ Roadmap](#️-roadmap)
- [🤝 Contributing](#-contributing)
- [📜 License](#-license)
- [👤 Author](#-author)

---

## 🎯 About

**Problem.** A seller on Flipkart, Shopsy and Meesho gets the truth in pieces:
- invoices in one place, payouts in another, and returns in two more reports;
- every platform with its own columns, IDs and timing;
- payment arriving 7–15 days after dispatch.

The same order turns up in a different file every few days. Seller panels show revenue, but not what a product really earns after:
- fees,
- returns and RTO,
- the packet that was shipped and lost,
- the cost of the piece itself.

So "which products should I scale, fix or stop?" gets answered from memory and paper.

**Solution.** A local app that reads the files the marketplaces already give you:
- invoice PDFs
- payment/settlement Excel
- return-created and return-closure reports
- cancellations

It merges them per order line and works out real profit per product, pack size, SKU and listing, on each platform and combined. Every upload is previewed before it is saved. Overlapping daily files merge instead of doubling. Every figure traces back to the file and row it came from.

**Why it matters.**
- Profit is counted **after** returns, RTO, packaging and cost of goods, not just as revenue.
- Return reasons are visible per product and platform.
- Money still on its way from the marketplaces is tracked by due date.
- Stock follows the actual dispatches.
- It all stays on the seller's PC.

**What I built (as PM + Builder).**
- **Scoped** the problem from "a sales dashboard" to "one trustworthy order line per sale, assembled from every file that mentions it", because nothing else matters if the numbers can't be trusted.
- **Designed** an import pipeline where data integrity comes first:
  - content-based file detection
  - natural keys per platform
  - a staging preview
  - atomic commits with read-back reconciliation to the paisa
  - one-click undo
  - automatic backups
- **Engineered** 7 importers from real marketplace exports, including PDF label/invoice parsing with arithmetic validation. Each one was checked against the seller's own files, and every total reconciled to the marketplace's figure.
- **Modelled** the real economics of selling on Indian marketplaces:
  - packaging per packet (not per piece) that is lost on returns
  - TCS/TDS kept out of profit, on their own page
  - a GST switch for sellers who offset output tax with input credit
  - payment windows
  - packs of 1, 2 and 4 drawing on one shared stock shelf
- **Automated** the daily routine. A nightly Claude scheduled task downloads the reports in the seller's own Chrome, and a local script works out what's missing, imports it and raises a WhatsApp alert only when something needs attention.
- **Validated** with 77 automated tests, including golden tests that run on real export files when they are present.

---

## ✨ Highlights

> Every number is traceable. Nothing is guessed.

- 📥 **Drop all of the day's files at once.** PDF, XLSX, XLS, CSV or ZIP, from any platform. Each is identified from its contents, not its name.
- 🔁 **Overlapping files merge; they never double.** The same order in Monday's and Tuesday's download lands once. Repeated files are recognised by SHA-256. A changed amount stops and asks.
- 👀 **Preview before commit.** For every file you see new, updated, already-known and set-aside rows, money totals, date range and new SKU codes.
- ✅ **Commits that check themselves.** One transaction per batch, a backup first, and every row read back and compared to the paisa before it closes. Any import can be undone.
- 💸 **Real profit per order line.** Payout before TCS/TDS − cost of goods − ₹7 packaging per packet. Payouts not yet settled are estimated from similar orders and labelled *estimated*.
- ↩️ **Returns that tell you why.** Reasons and sub-reasons per product and platform, RTO vs customer returns, return cost, and returns still open after 30 days (worth a claim).
- 📦 **Stock that follows dispatches.** Packs of 1, 2 and 4 and `_SET` variation listings share one shelf. Good returns restock; damaged and lost ones are written off.
- 🗓️ **Payments on the way.** Unpaid orders split into not-due, due-now and overdue, with the expected money by day.
- 🧾 **TCS & TDS on their own page.** They're held from payouts and claimed back, so they're never in profit.
- 🌙 **Nightly auto-download.** Missed nights are caught up, and nothing is downloaded twice.
- 🤖 **Ask your data.** Gemini answers questions by calling the app's own metric functions, so it explains numbers and never invents them.
- 🔒 **Local-first.** The server listens on localhost only. Buyer names, addresses and phone numbers are never stored (only state and PIN code). Real cost prices live in a git-ignored file.

---

## 🚀 Quick Start

```bash
git clone https://github.com/yatinbhalla/Seller-Analytics
cd Seller-Analytics
npm install
cp .env.example .env                                            # Gemini key, lister folders, nightly settings
cp src/server/seed/costs.example.js src/server/seed/costs.local.js   # your purchase prices (git-ignored)
npm start                                                       # opens http://localhost:5175
```

On Windows you can double-click `start.bat` instead. The API runs on port `3003`, so it sits next to the [Meesho Lister](https://github.com/yatinbhalla/Meesho-listing) (3001/5173) and the [Flipkart Lister](https://github.com/yatinbhalla/Flipkart-listing) (3002/5174).

The product catalog is read (never written) from the Flipkart Lister's path configs and both listers' SKU ledgers. Point `LISTER_FLIPKART_DIR` and `LISTER_MEESHO_DIR` in `.env` at them. Without the listers, new SKU codes are added from the Import page as they appear.

---

## 📥 Daily Imports

Open **Import files** and drop in the day's files from both platforms:

| File | Flipkart / Shopsy | Meesho |
|---|---|---|
| Order invoice | label + invoice PDF | label + invoice PDF |
| Payments | settlement report (Excel), or a per-payment report | payment file (Excel, or the `.zip` it comes in) |
| Return created | returns report (approved in a date range) | returns: in transit |
| Return closure | returns report (closed in a date range) | returns: delivered |
| Cancellations | cancelled orders list | — |

The preview also lists any **new SKU codes**, which you can give a cost right there. Nothing is saved until you press **Commit**.

---

## 🛡️ Why Uploads Can't Corrupt or Double-Count

- **Same file twice:** recognised by its SHA-256 hash and skipped. A `.zip` is unpacked and its files are checked the same way.
- **Overlapping files:** rows are keyed by *what they are*, not by file:
  - an invoice line by platform + order item;
  - a return by its return ID;
  - a payment line by order item, type and settlement reference.

  Flipkart and Shopsy share one key space, so a Shopsy order seen as "Flipkart" in one file isn't counted twice.
- **Return created + return closed:** these merge into one return. A closed return is never reopened by an older file. A condition you set by hand beats one read from a file.
- **Cancellations:** a cancellation before dispatch marks the line cancelled, and a later reprint of its label can't bring it back. Courier returns in the cancellations file are skipped, because the returns report already has them.
- **Changed amounts:** if the same row comes back with a **different amount**, it waits for you to accept or refuse it.
- **Strict parsing:**
  - IDs stay text, and anything Excel mangled into `1.2E+17` is refused.
  - Dates are read day-first.
  - Money is stored in integer paise.
  - Each PDF invoice must add up (taxable + tax = total, gross − discount = total) or it is set aside with a reason.
- **Atomic commits:** one transaction, a backup first, and a read-back of every written row with the money compared to the paisa. If anything differs, nothing is committed.
- **Undo:** any import can be undone from the import history, and the rows it changed are put back.
- **Data Health** lists:
  - missed upload days
  - unpaid orders
  - returns still open after 30 days
  - codes without a cost
  - shelves below zero

---

## 🧮 How the Numbers Work

- **Profit per order line** = payout before TCS/TDS − cost price (unless the item came back and was restocked) − **₹7 packaging per packet**.
- **Packaging** is charged once per packet whatever the pack size, and is never reversed on a return or RTO, because the packet and label are gone.
- **TCS and TDS** are held back from payouts but claimed back, so they're never in profit. The **TCS & TDS** page shows them by month and by payment.
- **GST:** profit is shown **before GST** by default, for sellers who offset GST on sales with input credit on purchases. Switch it on in Settings → General to take each kept sale's GST off profit.
- **Payout** is the real settlement once it's imported. Until then it's estimated from similar settled orders and labelled *estimated*.
- **Return cost** = return/RTO charges + ₹7 packaging lost + the cost of anything that came back damaged or lost.
- **Costs** are per unit as sold: a 4-pack costs four pieces. A cost change takes effect from a date, so older orders keep the cost they had.
- **History before the first invoice upload.** Payment and returns files reach back weeks.
  - An order known only from a payment file is still in every report. Its GST is estimated, and it never moves stock.
  - A return of a sale from before the history counts in return reasons, but not in money or return rates.

---

## 📦 Products, SKUs & Stock

```text
Category (vertical)      e.g. Hanging Organizers
  └ Product (design)     e.g. Wall Hanging Organizer – Black Floral
      └ Variant          e.g. Pack of 2      ← codes WH_MFO, WH_MFO_SET
          └ Listing SKU  e.g. WH_MFO/40365   (each listing copy)
```

- A SKU's **code** is everything before the last `/`. `WH_MFO/40365`, `WH_MFO/7` and `WH_MFO/1.1` are all `WH_MFO`.
- **Pack recipes** map each code to physical pieces. Selling `WH_4MFO` takes 4 pieces from the same shelf that `WH_1MFO` takes 1 from. Mixed packs wait under Settings → Pack recipes until you say which pieces they use.
- **Stock** is a ledger: your opening count and purchases, minus invoiced dispatches, plus returns closed in good condition.
- The **Stock** page shows:
  - on-hand pieces per shelf
  - packs you can still make of each size
  - days of cover
  - value at cost
- **Aliases** map old or misspelt codes to their current code, and an unknown code in any upload asks for a cost and a home.

---

## 🌙 Nightly Auto-Download

The marketplaces offer no free API for these reports, so the download is done the way the seller does it, in the browser.

- **The browsing.** A [Claude scheduled task](https://claude.com/claude-code) runs at 00:01 in the seller's own Chrome, which is already signed in. It follows the walkthrough in [`docs/auto-download.md`](docs/auto-download.md):
  - **Meesho:** delivered returns, in-transit returns, payments.
  - **Flipkart:** closed and created returns, cancellations, prepaid and postpaid payments.
- **The exact part** lives in this repo, in [`src/fetch/nightly.js`](src/fetch/nightly.js):

  ```bash
  npm run fetch -- plan                 # what to download tonight (JSON): ranges per step, payments already imported
  npm run fetch -- import               # import tonight's downloads with the usual checks; commit clean files
  npm run fetch -- mark <step> <date>   # record a step as done; it only moves forward
  npm run fetch -- status               # the saved state
  ```

- **Catch-up:** each step remembers the last day it got, and payments are checked against what the database already holds. A night the PC was off is fetched the next time. A Meesho payment date missing from the panel's 30-day list is checked through its date-range download, so no payment is skipped.
- **Review and alerts:** files with set-aside rows or changed amounts wait on the Import page under **Waiting for your decision**. The task sends one WhatsApp message only when something needs attention: a site signed out, a file refused, a new SKU code.

---

## 🤖 Ask AI (Gemini)

Add a key to `.env` (free at [Google AI Studio](https://aistudio.google.com/app/apikey)):

```ini
GEMINI_API_KEY=your_key
```

- **Ask your data:** questions like "Why did Black Floral's profit fall on Meesho this month?"
  - Gemini answers by calling the app's own functions: overview, product metrics, returns, P&L, payments due, TCS/TDS, stock and data health.
  - Every number comes from the app's calculations. The AI only explains and suggests.
- **Digest and return themes:** a period summary, and return reasons grouped into themes per product.
- **Privacy:** only totals and product names are sent, never buyer details.
- **Without a key** the app works fully; the AI panels just say a key is missing.
- **Models:** a model fallback chain (Flash-Lite first) with retry on rate limits, the same client as the listers. Pin a model with `GEMINI_MODEL`.

---

## 📄 Pages

| Page | What it answers |
|---|---|
| **Overview** | Sales, profit, returns and payments on the way, per platform and combined |
| **Products** | Every product → pack size → code, with a platform-compare toggle |
| **Product detail** | Variants × platforms, the P&L waterfall, return reasons, stock |
| **Orders** | Every order line with its source, payout and status |
| **Returns** | Reasons, RTO vs customer returns, return cost, returns still open |
| **P&L** | A waterfall that always adds up, from sales to profit |
| **Stock** | On-hand per shelf, packs you can make, days of cover, value |
| **TCS & TDS** | Held-back tax by month and by payment |
| **Import** | Upload, preview, commit, review, undo |
| **Data Health** | Gaps, unpaid orders, stale returns, missing costs |
| **Ask AI** | Questions about your own data, answered from the app's numbers |
| **Settings** | Costs with history, SKU mapping, pack recipes, packaging, GST, payment window, backups |

---

## 🗂️ Project Layout

```text
Seller-Analytics/
├── 📁 src/
│   ├── 📁 server/                    Express API (port 3003)
│   │   ├── index.js                  Integrity check + catalog sync at startup
│   │   ├── 📁 db/                    schema.sql · views.sql · db.js (WAL, migrations, backups)
│   │   ├── 📁 catalog/               Lister sync · SKU parsing · costs & aliases
│   │   ├── 📁 seed/                  costs.js (loader) · costs.example.js · costs.local.js (git-ignored)
│   │   ├── 📁 importers/             detect → stage → commit → undo
│   │   │   ├── 📁 flipkart/          invoices (PDF) · settlement · returns · cancellations
│   │   │   ├── 📁 meesho/            invoices (PDF) · payments · returns
│   │   │   └── table.js · pdf.js · keys.js · entities.js · stage.js · commit.js
│   │   ├── 📁 metrics/               lines.js (the one order-line query) · economics · reports · health
│   │   ├── 📁 inventory/             Stock ledger and pack recipes
│   │   ├── 📁 ai/                    Gemini client · tools · insights
│   │   └── 📁 routes/api.js
│   ├── 📁 fetch/nightly.js           Plan / import / mark for the nightly download
│   └── 📁 client/                    React 18 + Vite + Tailwind 4 (port 5175)
│       ├── 📁 pages/                 Overview, Products, Returns, P&L, Stock, Import, …
│       └── 📁 components/ · lib/
├── 📁 test/                          Vitest: parsing, imports, invoices, economics, catalog, real layouts
├── 📁 docs/auto-download.md          Click-by-click walkthrough of every nightly download
├── 📁 samples/                       Your own exports for golden tests (git-ignored)
├── 📁 data/                          Database, backups, kept import files (git-ignored)
└── 📄 .env.example                   Gemini key, lister folders, nightly settings
```

---

## 🛠️ Tech Stack

| Layer | Stack | Why |
|---|---|---|
| **Frontend** | React 18 · React Router 7 · Vite 7 · Tailwind 4 · Recharts 3 | Fast local dev; charts that read in light and dark |
| **Backend** | Node 24 · Express 4 | Same stack as the listers, so all three apps run side by side |
| **Database** | SQLite via `better-sqlite3` (WAL, `synchronous=FULL`) | Zero setup, one file, real transactions; online backups keep the last 30 |
| **Parsing** | SheetJS · `pdfjs-dist` · `fflate` · `zod` | Excel/CSV read as text; PDF labels rebuilt line by line; zips unpacked in memory |
| **AI** | `@google/generative-ai` · Gemini Flash-Lite chain | Function calling over the app's own metrics; free tier is enough |
| **Automation** | Claude scheduled task + Claude in Chrome · `src/fetch/nightly.js` | Uses the seller's signed-in browser; all catch-up and import logic stays in code |
| **Tests** | Vitest | 77 tests; golden tests on real exports when `samples/` has them |

---

## 🧪 Testing

```bash
npm test          # 77 tests
npm run build     # production client into dist/
```

- **Real layouts:** the marketplaces' real file layouts are rebuilt with made-up buyers, orders and IDs:
  - Meesho's supplier preamble
  - Flipkart's per-NEFT rounding
  - PDF labels where the tax wraps onto the next line
  - the empty "No data is available" payment day
  - cancellations
- **Integrity:**
  - importing day 1 then day 2 gives the same result as their union;
  - re-imports change nothing;
  - a changed amount waits for confirmation;
  - a truncated or renamed-column file is refused.
- **Economics:**
  - ₹7 once per packet;
  - packaging kept on RTO;
  - COGS only on damaged or lost returns;
  - TCS/TDS outside profit;
  - payment windows.
- **Golden tests:** drop your own exports in `samples/flipkart` and `samples/meesho`, and they run on them too. Totals must match each file's own figure to the paisa.

---

## ⚠️ Known Limitations

| Area | Limitation | Mitigation / Roadmap |
|---|---|---|
| **Report formats** | Marketplaces rename columns from time to time. | Detection names the missing column and imports nothing. The fix is one alias line in that importer. |
| **Nightly download** | Needs the Claude desktop app open and Chrome signed in; seller panels change their UI. | Missed nights are caught up; the walkthrough lives in one doc the task re-reads; failures raise a WhatsApp alert. |
| **Meesho loan settlements** | Not in Meesho's payment Excel, so the app's payout can be above the bank credit by that amount. | Profit is unaffected (it's a loan repayment); importing them from the payments list is on the roadmap. |
| **Single seller, local only** | One account per platform, one PC. | Tables carry an `account` column; going online is on the roadmap. |
| **History** | Stock and invoice-level detail start at the first invoice upload. | Older orders still come in from payment and returns files, flagged as such. |

---

## 🗺️ Roadmap

- [ ] **Sale events** — an events calendar (Big Billion Days, Meesho mega sales) with event-vs-baseline comparisons and spike detection.
- [ ] **Scale / Fix / Stop tags** — per product and platform, with Gemini explanations.
- [ ] **Meesho loan settlements** — read from the payments list so payouts match the bank to the paisa.
- [ ] **Flipkart Seller API** — orders and returns without downloads; push stock levels back.
- [ ] **Amazon** — the next platform.
- [ ] **Online mode** — hosted database for access away from the shop PC.

---

## 🤝 Contributing

**Open to collaborators.** Issues and pull requests are welcome, especially:

- importers for other marketplaces (Amazon Seller Central, Myntra, JioMart);
- new report layouts as Flipkart and Meesho change theirs (please share the header row, never buyer data);
- better return-reason themes and recommendation rules.

1. **Fork** the repo and create a branch (`git checkout -b feat/your-idea`).
2. Run `npm test` before pushing.
3. **Open a PR** describing what you built, why, and the trade-offs you considered.

---

## 📜 License

[PolyForm Noncommercial License 1.0.0](LICENSE.md) — **free for any noncommercial use**: personal projects, learning, hobby use, research, and nonprofit/educational/government use. Fork it, modify it, share it.

**Commercial use is not permitted** under this license. You can't use it in a business to make or save money, ship it inside a paid product, or run it for an enterprise without a separate commercial license. Want to use it commercially? [Reach out](mailto:yatinbhalla42@gmail.com).

---

## 👤 Author

**Yatin Bhalla** · Product Manager & AI Builder

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Yatin%20Bhalla-0A66C2?logo=linkedin&logoColor=white)](https://linkedin.com/in/yatinbhalla42)
[![Gmail](https://img.shields.io/badge/Gmail-yatinbhalla42%40gmail.com-EA4335?logo=gmail&logoColor=white)](mailto:yatinbhalla42@gmail.com)
[![X](https://img.shields.io/badge/X-@yatinbhalla42-000000?logo=x&logoColor=white)](https://x.com/yatinbhalla42)

<sub>If this project saved you time, a ⭐ on the repo makes my day. If it didn't — tell me why, and I'll fix it.</sub>
