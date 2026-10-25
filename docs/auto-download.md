# Nightly auto-download: discovery notes

This is the spec for the job that runs at 00:01, downloads the day's marketplace files, and imports them. Invoice PDFs and orders stay manual (the seller uploads those).

## Meesho (walked through in Chrome on 22 Oct 2026)

Every Supplier Panel address carries a short code for the account, written `<slug>` below; the app reads it from `MEESHO_PANEL_SLUG` in `.env`, and the nightly plan prints the full addresses. File names carry the numeric supplier ID, written `<supplier-id>`.

### 1. Delivered returns (return closure)

1. Go to `https://supplier.meesho.com/panel/v3/new/fulfillment/<slug>/returns/returnTracking-completed_delivered`. Through the menus this is Returns → **Return Tracking** → **Delivered**. The tabs on that page are: In transit · Out for Delivery · Delivered · Lost · No Return No Charge · Disposed.
2. The default filter is **"Delivered in last 2 weeks"**. Exporting it every night is safe because the importer merges overlapping rows. A missed night of up to 14 days is also covered without changing any filter.
3. Click the **"N/N files ready"** button at the top right of the table. A panel opens titled "Download Table Data — It will take few minutes", with an **Export Data** button.
4. After you click Export Data, a new entry appears at the top of the "Exported Files" list, labelled `completed_delivered_last_2_week` with the export time. It shows "Processing" first, then **Download**.
   - On 22 Oct it was ready within 3 seconds.
   - The seller has seen it take 30–60 seconds. The job waits for up to 10 minutes.
5. The download is `completed_delivered______last_2_week____2026-10-22_12_0-12_59_<supplier-id>__.csv` (100 KB). The name follows `<tab>_<filter>_<export date>_<hour window>_<supplier id>__.csv`, so the job never relies on an exact file name.

### 2. Returns created yesterday (return created)

1. Go to `https://supplier.meesho.com/panel/v3/new/fulfillment/<slug>/returns/returnTracking-intransit`, the **In transit** tab.
2. Set the filter **Return Created → Yesterday**. The other options are Last 3 days, Last 1 week, Last 2 weeks, Last 1 month, Last 3 months, and Custom date range.
3. Export and download exactly as above. The list entry is labelled `intransit_yesterday`, and the file is `intransit_______yesterday___2026-10-22_12_0-12_59_<supplier-id>__.csv` (11 KB, ready in about 10 seconds).
4. **Missed days:** if the last good run was more than a day ago, widen the filter to Last 3 days, Last 1 week, or a Custom date range that covers the gap. The overlap is merged on import.

### 3. Payments: one file per payment (the seller's quicker route)

1. **List the payments.** Go to `https://supplier.meesho.com/panel/v3/new/payouts/<slug>/payments/previous-payments`, which the Payments page links to as "Last 30 days". It shows a row for every payment in the last 30 days (30 rows on 22 Oct, almost every weekday), each with:
   - payment date
   - order amount
   - **ads cost** and **loan settlement**
   - net amount
   - NEFT ID
   - View Details

   The Payments page itself only shows the last 3 dates under Completed Payments.
2. **For each payment date not yet imported,** go to `https://supplier.meesho.com/panel/v3/new/payouts/<slug>/payments/payment-details/2/<YYYY-MM-DD>`. This is the same as clicking the date and then its "Sales and returns" amount. The page shows the NEFT/UTR, Net Order Amount, Platform Recovery, Compensation and Total, with tabs for Order Details, Platform Recovery and Platform Compensation.
3. Click **Payment Excel** at the top right. The button greys out while the file is prepared.
   - On 22 Oct the file arrived in about 15 seconds as `meesho_PREVIOUS_PAYMENT_2026-10-19.zip` (46 KB), containing `<supplier-id>_SP_ORDER_ADS_REFERRAL_PAYMENT_FILE_PREVIOUS_PAYMENT_2026-10-19.xlsx`.
   - It holds every order line and ads line of that payment.
4. **It reconciles:** the order amount minus the ads cost equals what the app imports, and minus the loan settlement shown on the list it equals what reached the bank, to the paisa. Imported after an earlier payment file that overlapped it, every line was recognised as already known.
5. **Missed days, with no payment skipped:** the job checks every date from the day after the last checked date up to yesterday.
   - **A date on the 30-day list** that isn't imported yet is downloaded from its payment-details page (steps 2–3).
   - **A date not on the list** is checked with the other route below, so the job never relies on the list being complete. Consecutive missing dates go in one range.
     - If the file says "No data is available", that date had no payment and is marked checked.
     - If the file has rows, they are imported like any payment file.
   - A date is marked checked only after its file has imported cleanly. A failure leaves it unchecked, so the next night tries it again and the job sends a WhatsApp alert.
   - On the first run, the job backfills the whole 30 days.
6. **Loan settlements** are not in the Excel, but they are in the 30-day list, one per payment. The job can record them as their own lines so the app's payout matches the bank to the paisa.

**The other route** is used for dates not on the list, and as a fallback if a payment-details page fails: Payments → **Download ▾** → **Payments to Date** → Custom Date Range.
- The range runs From/To, at most 31 days, and filters by payment date.
- It gives the same zip, in about 4 seconds.
- A day with no payment comes back as "No data is available for these dates", which the app now accepts as an empty day.
- Rows that overlap with a file already imported from the details page are recognised as unchanged.

### 4. Orders report (nightly, two days behind)

Orders run two days behind the other downloads: the run on the 25th fetches returns and payments up to the 24th, but orders only up to the 23rd. The plan gives the ranges (`plan.meesho.orders.downloads`).

1. Open the Orders page (`plan.meesho.orders.url`). It may open with a notice of its own, such as "N orders accepted successfully". Close it with **Got it**.
2. Click **Download Orders Data ▾** at the top right, then **Select Date Range**.
3. Pick From and To on the calendar, using **‹** and **›** to change month. The range can be at most 1 month: later days grey out once From is picked. Click **Export data**.
   - For more than a month, export once per range in the plan. Meesho generates them side by side.
   - On 25 Oct three 30-day exports (26 Jul–24 Aug, 25 Aug–23 Sep, 24 Sep–23 Oct) were ready within about a minute.
4. Reopen the menu, which doesn't refresh by itself. Each export appears under "Exported Files" with its dates and a **Download** link.
5. The file is `Orders_<from>_<to>_<export date>_<hour window>_<supplier-id>.csv`, one row per sub-order.
   - The column "Reason for Credit Entry" is the order status: DELIVERED, SHIPPED, READY_TO_SHIP, CANCELLED, RTO_*, LOST or DOOR_STEP_EXCHANGED.
   - The price is the supplier's price incl. GST, the same figure as the invoice's item total.
6. **Door-step exchanges** reuse the sub-order number: the replacement parcel appears as a second row days later, with a new packet. The app keeps the earlier row, which is the sale.

### Already handled in the app

- `.zip` uploads are unpacked and the Excel inside is imported. A second download of the same zip is recognised as the same file.
- Empty days ("No data is available") import with nothing set aside.
- Overlapping exports (two weeks of delivered returns every night) are merged, with no duplicates.

### Not in the files

**Loan settlements** are not in the payment Excel. They are repayments of a Meesho loan, not costs of sales, so profit is right without them. To match bank receipts, the job reads them from the 30-day payments list (see payments, step 6).

## Flipkart (walked through in Chrome on 22 Oct 2026)

Every page is under `https://seller.flipkart.com/index.html#dashboard/…`.

### 1. Closed returns (return closure)

1. Hover **Orders** and click **Returns**, then open the **All Returns** tab (`#dashboard/returnsV2?tab=all_returns&state=all`).
2. In the filter bar, set **Date of Closure** to yesterday. It takes one date; later dates are greyed out. Click **Apply**. On 21 Oct this gave 3 results.
   - The list only covers returns approved in the window above it, which defaults to the last 90 days. A return that took longer than 90 days to close would be missed, but that should be rare.
3. Click **Request Download** at the right of the filter bar. Flipkart shows "Report Requested Successfully".
4. Click **Previous Downloads**. A panel lists the latest 10 requests, showing each one's dates, filters and status: "Pending", then "Ready to download".
   - The panel does not refresh by itself. Close it and open it again.
   - On 22 Oct the file was ready within 30 seconds.
5. Click **Download**. The file is `off-returns-all-api_<id>_.csv`, with the same 43 columns as `samples/flipkart/return closed.csv`. The app reads it as a Flipkart returns report: 3 new rows, none set aside.
6. **Missed days:** run steps 2–5 once for each missed date. Overlapping rows merge on import.

### 2. Returns created

1. On the same tab, click **Reset**, then open **Returns approved in** (just under the tabs; it shows "last 90 days").
2. The panel has presets (last 7, 30, 60, 90 and 180 days) and a two-month calendar. Step the calendar to the right month with **›**. Click yesterday twice, once as the start and once as the end, then click **Done**.
   - On 21 Oct this gave 3 returns, all courier returns (RTO).
   - One of them showed "Approved on Oct 22" in the table. Flipkart's day boundary may not be exactly midnight IST. The overlap merges on import, so this does no harm.
3. Download it as in steps 3–5 above. It is the same report and the same file format. Imported after the samples, it gave 2 new returns and 1 already known.
4. **Missed days:** one range from the first missed day to yesterday covers them all.

### 3. Cancellations

1. Hover **Orders** and click **Cancellations** (`#dashboard/cancelled_orders/…`).
2. In the filter panel on the left, scroll down to **Order Cancellation** and click its **On / From-To** box.
   - The calendar opens below the box, so scroll it into view.
   - Double-click a date for a single day, or click a start date and then an end date for a range. The list refreshes by itself.
   - On 21 Oct it showed 2 cancellations.
3. The chosen range is saved in the page address as `order_cancellation_range`, with `date1` and `date2` in UTC, e.g. 2026-10-20T18:30Z for 21 Oct IST. The job can open the filtered list directly.
4. Click **Download Order List**. `Cancelled-Orders.csv` downloads at once, with no request queue.
5. **What it holds:** each row has a cancellation date, type, reason, SKU, quantity, total, payment type and invoice number, plus the buyer's name and address. The buyer details stay in the local database only.
6. **"Logistics Return: Yes"** marks a courier return (RTO). Both of the 21 Oct rows were RTOs, and the returns report already has the same lines with their Return IDs. The app skips them and counts them as "courier returns (already in the returns report)".
7. **"Logistics Return: No"** marks a cancellation before dispatch, which the app could not see before. It now marks the order line cancelled, so the line leaves sales, stock and the ₹7 packaging. What its invoice said is kept, and a later reprint of the label does not bring it back.

### 4. Payments: prepaid and postpaid

1. Click **Payments**. Under **Previous Payments** the last 4 dates are shown. Click **See All**, which opens a new tab at `#dashboard/payments/previous-payments?query={"start_date":"2026-10-01","end_date":"2026-10-22",…}` with month tabs (Oct'26 back to May'26, then Other Dates).
2. Every payment date has two rows, **Prepaid** and **Postpaid**, each with an NEFT ID and an amount. When nothing was paid, the row shows ₹0 and a reason:
   - **Bank Holiday:** paid with the next date. On 22 Oct, 21 Oct was a bank holiday and Flipkart said it had been settled early with 19 Oct.
   - **Net Balance Negative** or **Balance Negative:** carried forward. On 22 Oct, 19 Oct was ₹0 for this reason.
3. Click a row to open **Payment Details**. Its dropdowns are Previous Payments, the date, and Prepaid or Postpaid, and it shows the NEFT ID. Click **Request Download** at the top right. Then switch the dropdown to the other type and click **Request Download** again.
   - If that payment was already requested, Flipkart says the report "has already been requested … and the download link is still active". Go straight to Reports.
4. Go to **Reports → Reports Centre**. On a small window, Reports sits under **More** in the left menu. Both appear as "Payment Reports · Last Payment Transaction Details · Oct 16 2026 To Oct 16 2026", Generated, with a **Download** button. The list does not say which is prepaid and which is postpaid. That doesn't matter, because both are imported.
5. **The files:** each is `<request id>_<timestamp>.xlsx` (about 60 KB), with the same sheets as the settlement sample.
   - On 22 Oct both totals matched the amounts Seller Hub shows for that date, which it rounds (₹X.XXK).
   - Both imported with nothing set aside.
6. **Missed days:** download every Prepaid or Postpaid row on the list that has an NEFT ID and isn't imported yet. ₹0 rows need nothing.

**The other route,** for a date not on the list (the same rule as Meesho), or if a request fails: Reports Centre → **Request New Report** → Payment Reports → **Settled Transactions** for a date range.
- One file covers every prepaid and postpaid NEFT in the range.
- The 1–10 Oct report requested on 21 Oct had all 5 NEFTs paid on 5, 7 and 9 Oct, matching the list.
- It is the same file as `samples/flipkart/payment (2).xlsx`, so the app already reads it.
- The Request New Report form for this report hasn't been walked through yet.

### 5. Orders report (nightly, two days behind)

Like Meesho, orders run two days behind: the run on the 25th fetches orders up to the 23rd (`plan.flipkart.orders`).

1. Go to **Reports → Reports Centre** (`plan.flipkart.orders.url`) and click **Request New Report**.
2. Click **Fulfilment Reports**, then **Request Report** under "Orders".
3. Keep **One Time Request**. Click **Select Date Range**, choose **custom**, then click the start day and the end day in the two-month calendar.
   - On a short window the calendar is cut off. Its day cells are labelled like "Choose Sunday, July 26, 2026 as your check-in date", and its arrows "Move backward/forward to switch to the previous/next month".
   - 26 Jul–23 Oct (90 days) was accepted on 25 Oct.
4. Click **Submit**. Flipkart says "Report is requested successfully" and shows the Scheduled tab; switch to **Requested**.
5. The new row ("Fulfilment Reports · Orders · <from> To <to>") shows In Progress, then Generated. On 25 Oct the 90-day report was ready within about 3 minutes. Click its **Download**.
6. The file is `<request id>_<timestamp>.xlsx`, the same shape of name as a payment report; the app tells them apart by their columns.
   - Its sheets are "Help" and "Orders".
   - Statuses seen: DELIVERED, READY_TO_SHIP, RETURN_REQUESTED, RETURNED, CANCELLED, APPROVED.
   - There is no price column. SKUs come wrapped as `"""SKU:WH_P/1"""`, and the app unwraps them.

## How the nightly job runs

It's built like the seller's X and LinkedIn routines: a Claude scheduled task does the browsing in the seller's own Chrome, which is already signed in, and a script in this app does everything that must be exact.

- **The scheduled task:** "Nightly Meesho + Flipkart download (00:01)". Its routine is in `C:\Users\DeLL\.claude\scheduled-tasks\nightly-marketplace-download\SKILL.md`.
  - It runs daily at 00:01. The app adds a few minutes of spread, so it shows as 12:14 AM.
  - It runs only while the Claude desktop app is open. If the app was closed at that time, it runs the next time the app opens.
  - It needs Chrome open, with the Claude extension connected.
  - Its clicks follow this file. When a page changes, update the section above and the task follows it.
- **The script:** `npm run fetch -- <command>` (`src/fetch/nightly.js`).
  - `plan`: what to download tonight. It works out each step's range from `data/fetch-state.json`, the last day each step got. It also lists the Meesho payment dates and Flipkart NEFT IDs already in the database.
    - Returns, cancellations and payments go up to yesterday. Orders go up to the day before yesterday, split into ranges each site accepts (Meesho 30 days, Flipkart 90).
    - On the first run it fetches yesterday's returns, the last 30 days of payments and the last 3 months of orders.
  - `import`: takes the files that arrived in Downloads since `plan`, matching the marketplaces' file names (nothing else is touched), and moves them into `data/fetch/<date>/`.
    - It imports them with the app's own checks: duplicates, staging, backup, read-back.
    - Clean files are committed.
    - A file with rows set aside or changed amounts stays staged, and the Import page shows it under "Waiting for your decision".
    - New SKU codes don't hold a file back. Their lines show "cost missing" until priced.
  - `mark <step> <date>`: records a step as done through that date. It only moves forward. A step that failed isn't marked, so the next night retries it from the same day.
  - `status`: shows the saved state.
- **Alerts:** only when something needs attention: a site signed out, an export never ready, a file refused or waiting for review, a new SKU code, or a script error. The task sends one WhatsApp message to the seller's own number through WhatsApp Web in Chrome, or through the WhatsApp desktop app if the web version fails. A night with no problems sends nothing.
