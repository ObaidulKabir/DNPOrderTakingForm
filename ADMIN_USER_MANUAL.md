# PrintPilot Administrator User Manual

Welcome to the **PrintPilot Administrator User Manual**. This document explains how to access and operate the **PrintPilot Admin Dashboard**, feed live operational and historical data into the **PostgreSQL (Relational + `JSONB`)** database, onboard new print products without writing code, and tune supplier routing, courier logistics, and pricing models.

---

## Table of Contents

1. [Accessing the Admin Dashboard](#1-accessing-the-admin-dashboard)
2. [System Architecture & Storage Modes](#2-system-architecture--storage-modes)
3. [Dashboard Overview](#3-dashboard-overview)
4. [Module 1: Products & Dynamic Attributes (`JSONB` Catalog)](#4-module-1-products--dynamic-attributes-jsonb-catalog)
5. [Module 2: Supplier Capabilities & Machine Exclusions](#5-module-2-supplier-capabilities--machine-exclusions)
6. [Module 3: Feeding HRJ Historical Jobs (Vendor Settlement Model V3)](#6-module-3-feeding-hrj-historical-jobs-vendor-settlement-model-v3)
7. [Module 4: Feeding DNP Selling Observations (Customer Price Model V1)](#7-module-4-feeding-dnp-selling-observations-customer-price-model-v1)
8. [Module 5: Managing Route1 Standard Tariffs ($\ge 72\text{h}$ Matrix)](#8-module-5-managing-route1-standard-tariffs-ge-72texth-matrix)
9. [Module 6: Couriers, Distance Bands & Verified Postcode Distances](#9-module-6-couriers-distance-bands--verified-postcode-distances)
10. [Module 7: Global Business Rules & Cutoff Configuration](#10-module-7-global-business-rules--cutoff-configuration)
11. [REST API Reference for Automated Data Feeds](#11-rest-api-reference-for-automated-data-feeds)
12. [Troubleshooting & FAQ](#12-troubleshooting--faq)

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

## 4. Module 1: Products & Dynamic Attributes (`JSONB` Catalog)

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

## 5. Module 2: Supplier Capabilities & Machine Exclusions

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

## 6. Module 3: Feeding HRJ Historical Jobs (Vendor Settlement Model V3)

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

## 7. Module 4: Feeding DNP Selling Observations (Customer Price Model V1)

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

## 8. Module 5: Managing Route1 Standard Tariffs ($\ge 72\text{h}$ Matrix)

Navigate to **Route1 Standard Tariff** to manage the lookup table used when a customer's deadline is $\ge 72$ hours away:
- Use the **Filter** box to search across the 478+ tariff rows by size, quantity, or pages (e.g. `A4 100 20`).
- Use the **Add / Update Standard Price Row** form to insert a new `(Product, Size, Quantity, Pages, Supplier Price)` combination or update an existing row's supplier price.

---

## 9. Module 6: Couriers, Distance Bands & Verified Postcode Distances

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

## 10. Module 7: Global Business Rules & Cutoff Configuration

Navigate to **Global Business Rules** to adjust operational cutoffs and surcharges:
- **PE Customer Payment Cutoff**: Minutes from midnight on weekdays (default `930` = `15:30`).
- **PE Supplier Order Cutoff**: Minutes from midnight (default `960` = `16:00`).
- **HRJ Safe Next-Day Delivery Hour**: Hour of day (`13` = `13:00`) before which a next-day deadline requires tonight's collection + overnight hold.
- **HRJ Min Hours (Early Tomorrow / Direct)**: Minimum hours required for HRJ eligibility.
- **DNP Out-of-Hours (OOH) Surcharge (£)**: Flat surcharge (default `£20`) added when collection is between `21:00` and `07:00` or held overnight.
- **Gophr Compressed Window Threshold (Hours)**: Conservative courier window below which Gophr is treated as compressed/high-risk (default `6h`).
- **Urban Planning Travel Speed (MPH)**: Speed used to estimate urban pickup/drop travel time (default `18 mph`).

---

## 11. REST API Reference for Automated Data Feeds

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

## 12. Troubleshooting & FAQ

- **Why is a customer quote held ("We're checking this deadline")?**
  Open the **Staging diagnostics** accordion at the bottom of the right-hand quote card on the storefront. Section **8. FINAL AUTOMATION DECISION** shows the exact Production and Delivery traffic-light scores (`GREEN`, `AMBER`, or `RED`) and why automatic payment was held (e.g. Conservative RFC runs past the deadline, no courier passes the post-RFC buffer, or an HRJ machine exclusion was triggered).
- **Why does the bot ask for approximate mileage?**
  If the customer's UK postcode is not yet in the **Verified Postcode Road Distances** table (and no developer override mileage was provided), PrintPilot asks for an approximate mileage to select the courier distance band. Add the postcode under **Couriers & Postcodes** in the Admin Dashboard to resolve it automatically.
- **How do I persist embedded PostgreSQL changes to disk?**
  Set the environment variable `PGDATA_DIR=./pgdata` when starting the server (`PGDATA_DIR=./pgdata npm start`), or connect to an external PostgreSQL server via `DATABASE_URL`.
