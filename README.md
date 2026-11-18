# StowNest Expense Manager

An internal web app for recording and reporting StowNest's operational expenses.

- **Data:** one Google Spreadsheet (tabs: `Expenses`, `Categories`, `Lists`)
- **Backend:** Google Apps Script bound to that spreadsheet
- **Bills:** Google Drive folder `StowNest Expense Bills`, viewable only by stownest.com users
- **Frontend:** plain HTML, CSS and vanilla JavaScript, served by the same Apps Script web app

It is completely separate from the StowNest production codebase and database.

---

## 1. How it fits together

```
Employee's browser (signed in to a stownest.com Google account)
        │  opens the Web App /exec URL
        ▼
Google checks the user is in stownest.com  ──►  not in the domain? blocked by Google
        │
        ▼
doGet()  ──►  serves Index.html (+ Styles, Js* files pasted in with include())
        │
        │  page calls  google.script.run.api({ action, token, ... })
        ▼
api()  ──►  passcode / session token check  ──►  Sheets + Drive (runs as the script owner)
```

**Two layers of access control:**
1. Google allows only stownest.com accounts to open the app (deployment: *Anyone within StowNest*).
2. The shared passcode is checked **on the backend**. A correct passcode returns a session token, valid for 6 hours, which every later request must send.

**Why the frontend lives inside Apps Script (and not as separate `index.html` / `js/` files):**
with domain-only access, a page hosted elsewhere cannot call the API. The browser doesn't send the Google login with cross-site requests, so Google redirects them to a sign-in page.
Apps Script projects can only contain `.gs` and `.html` files, so the CSS and each JavaScript module are separate `.html` files.

## 2. Files

| File (in Apps Script) | Purpose |
|---|---|
| `Code.gs` | Backend: API, validation, LockService IDs, Drive uploads, `setup()`, `runSelfTest()` |
| `appsscript.json` | Project settings: IST time zone, V8, web app access |
| `Index.html` | Page structure: login, sidebar, the 4 pages, modal |
| `Styles.html` | All CSS |
| `JsUtils.html` | Helpers: formatting, toasts, CSV export, `.xlsx` writer (no library) |
| `JsApi.html` | `Api` (the only code that calls the backend) and `Store` (loaded data) |
| `JsExpenseForm.html` | The expense form, shared by **Add Expense** and **Edit** |
| `JsDashboard.html` | Summary cards and charts |
| `JsExpenses.html` | All Expenses table, filters, details and edit modal |
| `JsReports.html` | Reports and CSV/Excel export |
| `JsApp.html` | Sign-in, data loading, page navigation |

## 3. First-time setup

Do all of this signed in as the account that should own the data. See section 8 about using a shared company account.

### 3.1 Spreadsheet and script
1. Create a Google Sheet named **StowNest Expense Manager**.
2. In it, open **Extensions → Apps Script**. This binds the script to the sheet.
3. Rename the project (click "Untitled project") to **StowNest Expense Manager**.
4. Go to **Project Settings ⚙**, tick **Show "appsscript.json" manifest file in editor**.

### 3.2 Add the code files
In the editor's **Files** panel:
- Replace the contents of `Code.gs` and `appsscript.json` with the files from `apps-script/`.
- For each `.html` file, click **+ → HTML** and type the name **without** `.html`. Names are case-sensitive and must match exactly: `Index`, `Styles`, `JsUtils`, `JsApi`, `JsExpenseForm`, `JsDashboard`, `JsExpenses`, `JsReports`, `JsApp`. Then paste the file's full contents.
- Save (Ctrl/Cmd + S).

### 3.3 Passcode
**Project Settings ⚙ → Script Properties → Add script property**
- Property: `APP_PASSCODE`
- Value: a strong passcode, e.g. four random words. Never put it in code, chat or screenshots.

### 3.4 Create the tabs and Drive folder
In the editor, pick **`setup`** in the function dropdown and click **Run**. Approve the permissions.
This creates:
- the `Expenses`, `Categories` and `Lists` tabs, with the categories prefilled
- the **StowNest Expense Bills** Drive folder (its ID is saved as the `BILLS_FOLDER_ID` script property)

It is safe to re-run. It never overwrites data.

### 3.5 Test the backend
Pick **`runSelfTest`** and click **Run**. The log must end with `ALL TESTS PASSED`.
It adds an expense with a small PDF, edits it, reads it back, checks that invalid data is rejected, then deletes the test row and file.
(Expense IDs are never reused, so the first real expense will be `EXP-000002`.)

### 3.6 Deploy
**Deploy → New deployment → ⚙ Web app**
- Execute as: **Me**
- Who has access: **Anyone within StowNest**

Copy the **Web app URL** and share it with employees, together with the passcode.

### 3.7 Updating the code later
After editing any file: **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**.
This keeps the same URL. ("New deployment" would create a new URL.)
To try changes before publishing, use **Deploy → Test deployments**, which always runs the latest saved code.

## 4. Google Drive

- Bills are saved into **StowNest Expense Bills** as `EXP-000123_<original name>.pdf|jpg|png`.
- Each file is shared as **"StowNest – anyone with the link can view"**. Nothing is public.
- Employees open bills from the app. They must be signed in to their stownest.com account.
- When a bill is replaced during an edit, the old file stays in the folder as an audit trail.
- Limits: PDF, JPG or PNG; at most 5 MB. The backend checks the file's real content, not just its extension.

## 5. Day-to-day maintenance (no code changes needed)

### Add a warehouse or city: `Lists` tab
| Cities | Warehouses | Warehouse City | Departments | Payment Modes |
|---|---|---|---|---|
| Bengaluru | Whitefield Warehouse | Bengaluru | Operations | Cash |

- Each warehouse's city goes in **Warehouse City**, on the same row. It must match a value in **Cities** exactly.
- A warehouse with a blank city is allowed with any city.
- Departments and payment modes work the same way: one value per row.

### Add a category or subcategory: `Categories` tab
| Main Category | Subcategory | Active (Y/N) |
|---|---|---|
| Facility & Warehouse Expenses | Security Guard Charges | Y |

- A category without subcategories is one row with **Subcategory** left blank.
- **Never rename or delete a value that is already used. Set Active to `N` instead.** Saved expenses store names as text, so renaming splits reports into two lines. Inactive values disappear from the dropdowns, but old expenses stay editable.

Changes show up in the app after the page is reloaded or **↻ Refresh data** is clicked.

### Recommended sheet protections (5 minutes)
1. **Data → Protect sheets and ranges → Sheet: Expenses → Only you.** Others can edit Lists and Categories but not expense records. The app can still save, because it runs as the owner.
2. **Lists → Warehouse City column → Data → Data validation → Dropdown (from a range) `Lists!A2:A` → Reject input.** This prevents misspelt cities.
3. **Categories → Active column → Data validation → Dropdown: Y, N.**

Do **not** add data validation to the `Expenses` tab.

## 6. Features

- **Dashboard:** total, current month, number of records, last 12 months trend, category-wise and warehouse-wise totals.
- **Add Expense:**
  - the subcategory list follows the category; the warehouse list follows the city
  - optional bill upload (drag-and-drop)
  - checks in the browser, then on the server
- **All Expenses:**
  - search (ID, description, vendor, invoice, remarks)
  - filters for date range, category, city, warehouse and department
  - filtered total, 25 rows per page
  - details view, edit, open bill
- **Edit:**
  - if two people edit the same expense, the second save is rejected with "changed by someone else"
- **Reports:**
  - Monthly, Category-wise, Warehouse-wise and Date-wise
  - filters for date range, category, city and warehouse
  - **CSV** exports the summary; **Excel** (`.xlsx`) exports the summary plus every matching expense
  - both exports use exactly the current filters

## 7. Testing checklist (run on the real deployment)

| # | Test | Expected |
|---|---|---|
| 1 | Open the URL signed in with a non-stownest account | Google blocks access |
| 2 | Wrong passcode | "Incorrect passcode." |
| 3 | Add an expense with a PDF bill | Success message with an ID; a new row in `Expenses`; the file in the Drive folder |
| 4 | Add an expense with a JPG, and one with no bill | Both saved |
| 5 | Upload a 6 MB file, or a `.docx` | Rejected with a message |
| 6 | Pick a city, then check the warehouse list | Only that city's warehouses |
| 7 | Edit an expense (amount, city/warehouse, replace bill) | Row updated; Created At unchanged; Updated At changed |
| 8 | Open the same expense in two tabs, save in both | The second save shows "changed by someone else" |
| 9 | Click **View** on a bill | Opens in Drive for a stownest.com user |
| 10 | Dashboard numbers | Match a SUM over the `Expenses` sheet |
| 11 | Reports: filter by city, then export CSV and Excel | Files contain only the filtered rows; Excel opens without errors |
| 12 | Add a warehouse in `Lists`, then **↻ Refresh data** | It appears in the dropdown |

## 8. Notes and limits

- **Ownership:** the script, sheet and bills belong to the account that runs `setup` and deploys. If that person leaves, the app can stop working. For production, set it up under a shared company account (e.g. an accounts or admin mailbox) and ask your tech lead to confirm.
- **Data volume:** the app loads all expenses into the browser once after sign-in. That is fine for tens of thousands of rows. If it ever becomes slow, add server-side filtering then, not before.
- **Downloads:** CSV and Excel files are generated in the browser. If a download is blocked by a browser extension or policy, allow downloads for `script.google.com`.
- **Passcode change:** edit `APP_PASSCODE` in Script Properties. New sign-ins use it straight away; existing sessions expire within 6 hours.
- **Execution logs:** server errors are logged under **Executions** in the Apps Script editor.
