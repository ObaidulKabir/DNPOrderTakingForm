# PrintPilot Administrator User Manual

Welcome to the **PrintPilot Administrator User Manual**. This document explains how to access and operate the **PrintPilot Admin Dashboard**, feed live operational and historical data into the **PostgreSQL (Relational + `JSONB`)** database, onboard new print products without writing code, and tune supplier routing, courier logistics, and pricing models.

**Start here if you are adding a product:** [Section 4 — Making a New Product Operational](#4-making-a-new-product-operational-go-live-checklist). A catalog row alone does not make quotes work.

---

## Table of Contents

1. [Accessing the Admin Dashboard](#1-accessing-the-admin-dashboard)
2. [System Architecture & Storage Modes](#2-system-architecture--storage-modes)
3. [Dashboard Overview](#3-dashboard-overview)
4. [Making a New Product Operational (Go-Live Checklist)](#4-making-a-new-product-operational-go-live-checklist)
5. [Module 1: Products & Dynamic Attributes (`JSONB` Catalog)](#5-module-1-products--dynamic-attributes-jsonb-catalog)
6. [Module 2: Supplier Capabilities & Machine Exclusions](#6-module-2-supplier-capabilities--machine-exclusions)
7. [Module 3: Feeding HRJ Historical Jobs (Vendor Settlement Model V3)](#7-module-3-feeding-hrj-historical-jobs-vendor-settlement-model-v3)
8. [Module 4: Feeding DNP Selling Observations (Customer Price Model V1)](#8-module-4-feeding-dnp-selling-observations-customer-price-model-v1)
9. [Module 5: Managing Route1 Standard Tariffs ($\ge 72\text{h}$ Matrix)](#9-module-5-managing-route1-standard-tariffs-ge-72texth-matrix)
10. [Module 6: Couriers, Distance Bands & Verified Postcode Distances](#10-module-6-couriers-distance-bands--verified-postcode-distances)
11. [Module 7: Global Business Rules & Cutoff Configuration](#11-module-7-global-business-rules--cutoff-configuration)
12. [REST API Reference for Automated Data Feeds](#12-rest-api-reference-for-automated-data-feeds)
13. [Troubleshooting & FAQ](#13-troubleshooting--faq)

---

## 1. Accessing the Admin Dashboard

1. Start the PrintPilot server:
   ```bash
   npm start
   # or in development watch mode:
   npm run dev
   ```
2. Open your browser and navigate to:
   - **Admin Dashboard**: `http://localhost:3000/admin.html` (or click the **⚙ Admin** button in the top-right corner of the main storefront at `http://localhost:3000/`).
   - **Built-in Interactive Manual**: Click **📖 Admin User Manual** in the top navigation bar or left sidebar of the Admin Dashboard at any time.

---

## 2. System Architecture & Storage Modes

PrintPilot uses a **PostgreSQL (Relational + `JSONB`)** architecture by default:
- **External PostgreSQL Server**: Set `DATABASE_URL=postgres://user:password@host:5432/dbname` before running `npm start` to connect to a production PostgreSQL instance.
- **Embedded PostgreSQL (`@electric-sql/pglite`)**: When `DATABASE_URL` is omitted, PrintPilot automatically boots an in-process PostgreSQL engine with full `JSONB` and `GIN` index support, seeded from the files in `data/`. Set `PGDATA_DIR=./pgdata` to persist embedded PostgreSQL tables on disk across restarts.
- **Alternative Adapters**: Set `STORAGE_MODE=json` (direct `data/*.json` & `data/*.csv` persistence) or `STORAGE_MODE=sqlite` (SQLite adapter).

Every change saved in the Admin Dashboard immediately updates the active repository and takes effect on the very next customer conversation turn or sidebar edit—no server restart is required.

---

## 3. Dashboard Overview

The **Dashboard Overview** tab displays:
- **Live KPI Counters**:
  - **Active Products**: Total products configured in the catalog.
  - **HRJ V3 Historical Jobs**: Count of verified BO1/BO2 vendor settlements powering the urgent cost model.
  - **DNP V1 Selling Records**: Count of historical customer selling price observations powering the urgent commercial quote model.
  - **Route1 Standard Tariffs**: Count of standard price matrix rows ($\ge 72\text{h}$).
- **Configured Multi-Product Catalog Table**: Lists every product, its category, VAT rate badge (`0% VAT` vs. `20% VAT`), dynamic `JSONB` attribute keys, and NLP detection keywords. Click **Edit Schema** on any row to jump directly to its configuration.

---

## 4. Making a New Product Operational (Go-Live Checklist)

Saving a product in **Products & Attributes** is **not enough**. The storefront can detect it and ask questions, but **automatic quotes stay held** until supplier limits and the three pricing datasets are also fed for that product.

Work the steps **in this order**. Each step names the dashboard tab, the button to click, and what happens if you skip it.

### What “operational” means

A product is operational when a customer can:

1. Type a natural-language request that **selects this product** (NLP keywords).
2. Complete the chat (every **required** attribute is asked and stored).
3. Receive an **automatic quote** for:
   - **Urgent jobs** (deadline **under 72 hours**) — HRJ V3 cost + DNP V1 selling price.
   - **Standard jobs** (deadline **72 hours or more**) — Route1 tariff lookup.

Courier bands and verified postcodes are **shared across all products**. You do not re-enter them for each new product unless you are adding a new delivery postcode.

### Go-live sequence

| Step | Dashboard tab | What you feed | Required for | If you skip it |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Products & Attributes** | Product ID, names, VAT, keywords, RFC hours, pricing config, required attribute questions | Chat can start and collect a spec | Storefront never switches to this product; bot has nothing to ask |
| **2** | **Supplier Capabilities** | At least one **HRJ Media** row for this Product ID, with quantity limits by hours | Quantity pills, max copies for the time window, machine holds | Quantity step uses global defaults; large jobs may be quoted when they should be held (or the reverse) |
| **3** | **HRJ Historical Jobs (V3)** | Completed vendor settlements tagged to this Product | Urgent **cost** model (`< 72h`) | Protected HRJ cost is £0; urgent quotes are unsafe or held |
| **4** | **DNP Selling Obs (V1)** | Historical **customer selling prices** tagged to this Product | Urgent **customer price** model (`< 72h`) | Selling model is empty; urgent quote is held |
| **5** | **Route1 Standard Tariff** | Supplier price rows for every Size / Quantity / Pages combination you want to auto-quote | Standard quotes (`≥ 72h`) | Diagnostics show “No supported Route1 … cost”; quote stays on **checking** |
| **6** | **Couriers & Postcodes** | Only if a new destination postcode is not already listed | Mileage and courier band | Bot asks the customer for approximate mileage (shared, not product-specific) |
| **7** | Live storefront (`/`) | Run the verification prompts below | Proof it is live | — |

Optional: add a **PrintedEasy** capability row if PE should also be eligible for this product.

### Step 1 — Create the product schema

1. Open **Products & Attributes**.
2. Click **+ Create New Product**.
3. Fill **Core Product Metadata**:
   - **Product ID (slug)**: lowercase, unique, never change later (e.g. `business-cards`).
   - **Plural Name** / **Singular Name**: storefront and bot wording.
   - **VAT Rate**: `0` (zero-rated, e.g. booklets/leaflets) or `0.20` (20% VAT, e.g. banners, cards, posters).
   - **NLP Detection Keywords**: comma-separated words the customer might type. Use **distinct** terms (`business card`, `business cards`) so this product is not confused with booklets or flyers.
4. Set **RFC Production Forecast Config** (Base / Min / P80 hours) to the typical HRJ turnaround for this item.
5. Set **Pricing & Compression Config**. Leave **Standard Route Threshold** at `72` unless this product should switch to the tariff table earlier or later.
6. Click **+ Add Attribute Question** for every field the bot must collect **before** deadline/quantity (for example `size`, `sides`, `finish`). For each attribute:
   - Mark it required by giving **Allowed Values** and **Quick Choice Buttons**.
   - The **Attribute Key** is stored in PostgreSQL `JSONB` and must be stable (e.g. `size`, not `Size`).
7. Click **💾 Save Product to PostgreSQL**.

The product now appears in **Dashboard Overview**. Chat can detect it. **It still cannot quote.**

### Step 2 — Attach supplier capabilities

1. Open **Supplier Capabilities**.
2. Set **Supplier ID** to `hrj-media` and **Supplier Name** to `HRJ Media`.
3. Choose the new product in the **Product** dropdown.
4. Enter **Default Quantity Quick Choices** (the pills shown when time is plentiful), e.g. `50, 100, 250, 500`.
5. Enter **Quantity Limits by Hours**. Copy this pattern and adjust `maxQty` / `choices` to what HRJ can actually produce:

```json
[
  { "maxHours": 12, "maxQty": 100, "choices": [25, 50, 100] },
  { "maxHours": 24, "maxQty": 250, "choices": [50, 100, 250] },
  { "maxHours": 48, "maxQty": 500, "choices": [50, 100, 250, 500] },
  { "maxHours": 120, "maxQty": 1000, "choices": [100, 250, 500, 1000] }
]
```

6. Leave **Excluded Attribute Combinations** as `[]` unless a machine cannot run a combo (then use the format in [Module 2](#6-module-2-supplier-capabilities--machine-exclusions)).
7. Click **💾 Save Supplier Capability**.

Repeat for `printed-easy` / `PrintedEasy` if that supplier should be on the routing list.

### Step 3 — Feed HRJ historical jobs (urgent cost)

Open **HRJ Historical Jobs (V3)**. For **each completed job** of this product:

1. **Order ID**: unique (e.g. `BC-10412`).
2. **Product**: select the new product (this tags `product_id` — do not leave it on booklets).
3. **Actual HRJ Settlement (£)**: what was paid to HRJ (`vendor_due`).
4. **Quantity**: copies on that job.
5. **Finished Size** and **Pages (or complexity eq.)**: see [Pricing keys](#pricing-keys-size-and-pages) below. These must match how the engine will look the product up.
6. **Hours to Deadline** at the time the job was paid.
7. **Source**: `BO2` when the urgency timestamp is reliable.
8. Click **+ Feed HRJ Job Record**.

**How many?** Feed a spread, not a single row. Aim for **at least 8–12 jobs** covering small/medium/large quantities, both A4 and A5 (or your product sizes), and both tight (`≤12h`) and looser (`24–48h`) windows. Support is **Weak** below ~4 effective neighbours, **Moderate** around 4.5–8, **Strong** at 8+.

### Step 4 — Feed DNP selling observations (urgent customer price)

Open **DNP Selling Obs (V1)**. For the **same jobs** (or the same commercial history):

1. **Order ID** (can match the HRJ order id).
2. **Product**: the new product.
3. **Customer Selling Price (£)** (`sell`) and **Vendor Cost (£)**.
4. Same **Quantity / Size / Pages / Hours to Deadline** as the HRJ row so the two models stay aligned.
5. Click **+ Feed Selling Price Record**.

Without DNP rows for this product, the urgent selling model returns empty and the quote is held.

### Step 5 — Feed Route1 standard tariffs (72h+ quotes)

Open **Route1 Standard Tariff**. For every combination you want to auto-quote when the customer has **≥ 72 hours**:

1. Select the new **Product**.
2. Enter **Size**, **Quantity**, **Pages**, and **Supplier Price (£)** (Route1 production price, not the customer total).
3. Click the add/update control for that row.

The engine looks up the **smallest tariff whose size matches, pages ≥ the job’s page-equivalent, and quantity ≥ the job’s quantity**. If nothing is large enough, the storefront holds the quote.

Start with the quantities customers actually order (for cards, e.g. 50 / 100 / 250 / 500 / 1000) and the page-equivalent you chose in Step 3.

### Pricing keys (Size and Pages)

HRJ V3, DNP V1, and Route1 all match on **Size + Pages + Quantity + urgency**. Customer-facing attributes (corners, lamination, cassette) are **not** lookup keys unless you also store them as Size/Pages.

| Product type | Size to feed | Pages to feed |
| :--- | :--- | :--- |
| Saddle-stitched booklets | Real finished size (`A4` or `A5`) | Real page count (multiples of 4) |
| Flyers / leaflets | `A5` or `A4` (`A6` is treated as `A5`) | `4` single-sided, `8` double-sided |
| Roller banners | Always `A4` in the pricing tables | `16` standard base, `24` premium/teardrop |
| **Any new product** (cards, posters, …) | Must **exactly match** the `size` value the customer will choose, **or** use `A4`/`A5` as the allowed size values | Use a **complexity equivalent**. If the product has no page count, feed **16** (engine default) and put Route1 rows at 16pp |

**Rule:** the Size string in HRJ / DNP / Route1 must equal the Size the quote engine will emit. If the attribute allowed value is `85x55mm`, tariff rows must say `85x55mm`, not `A4`. If you would rather reuse the booklet tariff shape, make the product’s size choices `A4` / `A5`.

### Step 6 — Verify on the live storefront

1. Click **← Open Live Quote Storefront** (or open `http://localhost:3000/`).
2. **Detection:** type a prompt that includes a keyword, e.g. `I need 100 business cards tomorrow by 3pm`. The bot greeting should use the **singular name** of the new product.
3. Complete any remaining questions (size, artwork, postcode, address, mileage, hotel).
4. **Urgent quote:** deadline tomorrow → you should see a numbered total, not “We're checking this deadline”.
5. In the right-hand card, open **Staging diagnostics**. Confirm the product name, HRJ V3 support is not empty, and a courier is selected.
6. Repeat with a deadline **four or more days out** to confirm the **STANDARD PRICING** (Route1) path.

If either path holds, use the table at the top of this section and [Troubleshooting](#13-troubleshooting--faq).

### Worked example — Luxury business cards

1. **Products & Attributes** — ID `business-cards`; keywords `business card, business cards, visiting card`; VAT `0.20`; attributes `size` (`A5`, `A4` as commercial size bands) and `corners` (`Square`, `Rounded`).
2. **Supplier Capabilities** — HRJ Media, `maxQty` 500 in 12h, 1000 in 24h, choices `50, 100, 250, 500, 1000`.
3. **HRJ V3** — 10 jobs, Size `A5`/`A4`, Pages `16`, quantities 50–500, `vendor_due` from real settlements.
4. **DNP V1** — the same 10 jobs with `sell` = what the customer paid.
5. **Route1** — rows for `A5` and `A4` at 16 pages for 50, 100, 250, 500, 1000.
6. Storefront prompt: `250 A5 business cards, artwork ready, 39 Solent House, E1 3NL, 3.4 miles, tomorrow by 4pm`.

---

## 5. Module 1: Products & Dynamic Attributes (`JSONB` Catalog)

Navigate to **Products & Attributes** in the left sidebar to edit existing products (`Saddle-stitched booklets`, `Flat flyers & leaflets`, `Pull-up roller banners`) or onboard a brand-new product (e.g. `Business Cards`, `Perfect-Bound Books`, `Posters`).

### Step-by-Step: Creating a New Product
1. Click **+ Create New Product** in the top-right corner.
2. Fill in the **Core Product Metadata**:
   - **Product ID (slug)**: Unique lowercase identifier (e.g. `business-cards`).
   - **Plural Name**: Shown in headers and diagnostics (e.g. `Luxury business cards`).
   - **Singular Name**: Shown in the specification sidebar and bot greeting (e.g. `Luxury business card`).
   - **Category**: Grouping label (e.g. `Stationery`).
   - **VAT Rate**: Enter `0` for zero-rated items (booklets/leaflets) or `0.20` for standard 20% VAT items. PrintPilot automatically calculates and adds VAT to the customer quote when `vatRate > 0`.
   - **Default Paper / Material**: Default substrate name (e.g. `400gsm Matt Laminated`).
   - **NLP Detection Keywords**: Comma-separated keywords (e.g. `business card, business cards, calling card`). When a user types any of these words in the home prompt box, PrintPilot automatically selects this product!
3. Configure **RFC Production Forecast Parameters**:
   - **Base Expected Hours**: Baseline hours required by HRJ Media to produce the item.
   - **Min Expected Hours**: Floor on expected production hours.
   - **P80 Anchor Hours**: Conservative 80th-percentile turnaround anchor used to compute **Conservative RFC**.
4. Configure **Pricing & Compression Parameters**:
   - **Standard Route Threshold (Hours)**: Hours threshold (default `72`) above which the standard tariff table is used instead of urgent pricing.
   - **Standard Delivery Allowance (£)**: Flat delivery allowance added to standard tariff quotes.
   - **Protected Cost Floor Multiplier**: Minimum commercial floor relative to protected fulfilment cost (default `2` = $2\times$ protected cost).
5. Define **Dynamic Product Attributes (Conversational Questions & Sidebar Inputs)**:
   - Click **+ Add Attribute Question** for each specification attribute your product needs:
     - **Attribute Key (`JSONB` key)**: Short identifier (e.g. `size`, `sides`, `corners`, `lamination`).
     - **Sidebar Label**: Human-readable label displayed in the right-hand specification card.
     - **Input Type**:
       - `select`: Renders a dropdown in the sidebar and validates against **Allowed Values**.
       - `number`: Renders a numeric input in the sidebar.
       - `text`: Renders a free-text input.
     - **Conversational Bot Question Prompt**: The exact question the chat bot asks when this attribute has not yet been provided by the customer.
     - **Allowed Values**: Comma-separated list of valid options (e.g. `Square, Rounded`).
     - **Quick Choice Buttons**: Comma-separated `Label:Value` pairs (e.g. `Square Corners:Square, Rounded Corners:Rounded`) rendered as clickable pills under the bot's question.
6. Click **💾 Save Product to PostgreSQL**.

---

## 6. Module 2: Supplier Capabilities & Machine Exclusions

Navigate to **Supplier Capabilities** to control how each supplier (`HRJ Media`, `PrintedEasy`) handles each product:

1. **Turnaround Quantity Limits by Hours (`quantityLimitsByHours`)**:
   - Defines how many copies can be automatically quoted for a given time window without requiring a manual check.
   - Format (JSON array):
     ```json
     [
       { "maxHours": 12, "maxQty": 50, "choices": [5, 10, 25, 50] },
       { "maxHours": 24, "maxQty": 100, "choices": [10, 25, 50, 75, 100] }
     ]
     ```
2. **Excluded Attribute Combinations (`excludedCombinations`)**:
   - Defines machine limitations that automatically place an order on hold (`checking` state) when matched.
   - Example (blocking A4 Landscape booklets on HRJ Media when deadline is under 72 hours):
     ```json
     [
       {
         "attributes": { "size": "A4", "orientation": "Landscape" },
         "maxHours": 72,
         "reason": "HRJ excluded: A4 Landscape cannot be produced on its machine. Manual alternative supplier confirmation required."
       }
     ]
     ```
3. Click **Load into Editor** on any existing capability row to modify it, then click **💾 Save Supplier Capability**.

---

## 7. Module 3: Feeding HRJ Historical Jobs (Vendor Settlement Model V3)

Navigate to **HRJ Historical Jobs (V3)** to feed completed urgent job settlements into the database.

### How the Model Uses This Data
- Each record represents an actual negotiated vendor settlement (`vendor_due`) paid to HRJ Media for a completed urgent job.
- When a customer requests an urgent quote ($<72\text{h}$), **HRJ Pricing Model V3** computes:
  1. **Kernel Distance & Similarity** across quantity, page/complexity count, size (`A4`/`A5`), and urgency bucket.
  2. **Recency Weighting** based on `paid_at` (newer jobs carry higher weight).
  3. **Weighted Quantiles (`P30`, `Median`, `P80`, `P90`)** blended with a **Recency-Weighted Ridge Regression** structural estimate.
  4. **Protected HRJ Allowance**: $\max(\text{Expected} + £35, P_{80})$, which protects margin against difficult urgent negotiations.

### Feeding a New HRJ Job
1. Enter the **Order ID** (e.g. `19850`), select the **Product**, and enter the **Actual HRJ Settlement (£)**.
2. Enter **Quantity**, **Finished Size** (`A4`/`A5`), **Pages** (or complexity equivalent), and **Hours to Deadline**.
3. Choose the **Source** (`BO2` for controlled urgency timestamps, `BO1` for legacy) and whether **Urgency is Reliable**.
4. Click **+ Feed HRJ Job Record**. You can also delete erroneous records using the **Delete** button in the table.

---

## 8. Module 4: Feeding DNP Selling Observations (Customer Price Model V1)

Navigate to **DNP Selling Obs (V1)** to feed historical customer selling prices (`sell`).

### How the Model Uses This Data
- Customer selling price is modelled independently of HRJ cost using kernel similarity and recency weighting over observed customer prices.
- Based on hours remaining until deadline, PrintPilot selects a target commercial percentile:
  - $\le 12\text{h}$: **P75** (upper-middle historical band)
  - $\le 24\text{h}$: **P65**
  - $> 24\text{h}$: **P50 (Median)**
- The quote is then bounded below by the **Protected Cost Floor** ($2\times$ protected fulfilment cost) and augmented by the **Deadline Compression Barrier** when $<18\text{h}$ remain.

### Feeding a New Selling Observation
1. Enter **Order ID**, select the **Product**, and enter **Customer Selling Price (£)** and **Vendor Cost (£)**.
2. Fill in **Quantity**, **Size**, **Pages**, and **Hours to Deadline**, then click **+ Feed Selling Price Record**.

---

## 9. Module 5: Managing Route1 Standard Tariffs ($\ge 72\text{h}$ Matrix)

Navigate to **Route1 Standard Tariff** to manage the lookup table used when a customer's deadline is $\ge 72$ hours away:
- Use the **Filter** box to search across the 478+ tariff rows by size, quantity, or pages (e.g. `A4 100 20`).
- Use the **Add / Update Standard Price Row** form to insert a new `(Product, Size, Quantity, Pages, Supplier Price)` combination or update an existing row's supplier price.

---

## 10. Module 6: Couriers, Distance Bands & Verified Postcode Distances

Navigate to **Couriers & Postcodes** to manage delivery feasibility and courier pricing:

### A. Verified Postcode Road Distances
- Add any UK postcode (e.g. `E1 3NL`, `SW1A 2AA`, `EC2A 3AY`) along with its verified road mileage from HRJ Media (`97 Burdett Road, London E3 4JN`) and provenance note.
- Postcodes are normalized automatically (case-insensitive, spaces stripped for lookup).
- When a customer enters a registered postcode, PrintPilot resolves the exact mileage and courier band automatically.

### B. Courier Distance Bands (Gophr vs. DNP)
- Edit the 7 mileage tiers (`0–3 mi` through `35–80 mi`):
  - **Gophr Baseline (£)**: Historical baseline cost for third-party Gophr courier.
  - **DNP Baseline (£)**: Baseline cost for DNP's own/dedicated courier route.
  - **DNP Post-RFC Buffer (Hours)**: Mileage-sensitive operational buffer required after Conservative RFC for DNP direct delivery (`0.25h` for `0–3 mi` up to `0.83h` for `20+ mi`).
- Click **💾 Save Distance Bands** after editing.

---

## 11. Module 7: Global Business Rules & Cutoff Configuration

Navigate to **Global Business Rules** to adjust operational cutoffs and surcharges:
- **PE Customer Payment Cutoff**: Minutes from midnight on weekdays (default `930` = `15:30`).
- **PE Supplier Order Cutoff**: Minutes from midnight (default `960` = `16:00`).
- **HRJ Safe Next-Day Delivery Hour**: Hour of day (`13` = `13:00`) before which a next-day deadline requires tonight's collection + overnight hold.
- **HRJ Min Hours (Early Tomorrow / Direct)**: Minimum hours required for HRJ eligibility.
- **DNP Out-of-Hours (OOH) Surcharge (£)**: Flat surcharge (default `£20`) added when collection is between `21:00` and `07:00` or held overnight.
- **Gophr Compressed Window Threshold (Hours)**: Conservative courier window below which Gophr is treated as compressed/high-risk (default `6h`).
- **Urban Planning Travel Speed (MPH)**: Speed used to estimate urban pickup/drop travel time (default `18 mph`).

---

## 12. REST API Reference for Automated Data Feeds

External scripts, ERP systems, or ETL pipelines can feed data directly via JSON HTTP requests:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/admin/summary` | `GET` | Returns record counts, product catalog, supplier capabilities, and business config |
| `/api/data/products` | `GET`, `POST` | List all products or upsert a product definition + dynamic `JSONB` attributes |
| `/api/data/products/:id` | `GET`, `PUT` | Get or update a specific product by slug |
| `/api/data/supplier-capabilities` | `GET`, `POST` | List or upsert supplier capabilities, turnaround quantity limits, and exclusions |
| `/api/data/hrj-jobs` | `GET`, `POST`, `PUT` | List, append (`POST`), or bulk-replace (`PUT`) HRJ V3 historical job settlements |
| `/api/data/hrj-jobs/:orderId` | `DELETE` | Delete a specific HRJ historical job by `order_id` |
| `/api/data/dnp-selling` | `GET`, `POST`, `PUT` | List, append (`POST`), or bulk-replace (`PUT`) DNP V1 selling price observations |
| `/api/data/dnp-selling/:id` | `DELETE` | Delete a specific DNP selling price observation by `id` |
| `/api/data/route1-prices` | `GET`, `POST`, `PUT` | List, upsert single row (`POST`), or bulk-replace (`PUT`) standard price matrix rows |
| `/api/data/distance-bands` | `GET`, `PUT` | Get or update courier distance bands and post-RFC buffers |
| `/api/data/postcodes` | `GET`, `POST` | Get verified postcodes or upsert `{ postcode, miles, source }` |
| `/api/data/business-config` | `GET`, `PUT` | Get or update global cutoff and courier rules |

---

## 13. Troubleshooting & FAQ

- **I saved a new product but the storefront still quotes booklets.**
  The home prompt did not contain one of that product’s **NLP Detection Keywords**. Add the words customers actually type, and put distinctive terms first (e.g. `business card` rather than only `print`).
- **The bot detects the product but never issues a price.**
  The catalog row is only Step 1. Feed **HRJ jobs**, **DNP selling observations**, and **Route1 rows** tagged to **this Product ID**, plus an **HRJ Media** capability. See [Section 4](#4-making-a-new-product-operational-go-live-checklist).
- **Urgent jobs (`< 72h`) hold; longer jobs quote (or the reverse).**
  Urgent path needs HRJ V3 + DNP V1 rows for this product. Standard path needs a Route1 row whose Size matches exactly and whose Quantity and Pages are **≥** the job. Feed the missing dataset.
- **Route1 rows exist but the quote still says there is no supported cost.**
  Size strings must match character-for-character (`A4` ≠ `a4 ` ≠ `85x55mm`). Pages and quantity on the tariff must be **at least** the job’s page-equivalent and copy count.
- **Why is a customer quote held ("We're checking this deadline")?**
  Open the **Staging diagnostics** accordion at the bottom of the right-hand quote card on the storefront. Section **8. FINAL AUTOMATION DECISION** shows the exact Production and Delivery traffic-light scores (`GREEN`, `AMBER`, or `RED`) and why automatic payment was held (e.g. Conservative RFC runs past the deadline, no courier passes the post-RFC buffer, or an HRJ machine exclusion was triggered).
- **Why does the bot ask for approximate mileage?**
  If the customer's UK postcode is not yet in the **Verified Postcode Road Distances** table (and no developer override mileage was provided), PrintPilot asks for an approximate mileage to select the courier distance band. Add the postcode under **Couriers & Postcodes** in the Admin Dashboard to resolve it automatically.
- **How do I persist embedded PostgreSQL changes to disk?**
  Set the environment variable `PGDATA_DIR=./pgdata` when starting the server (`PGDATA_DIR=./pgdata npm start`), or connect to an external PostgreSQL server via `DATABASE_URL`.
