# Care Home Rota Management Platform

A modern, standalone, full-stack web application for enterprise staff scheduling and care home rota generation.

---

## 🌟 Key Features

1. **Authentication & Access Control**
   - Secure Email & Password login with JWT sessions and bcrypt encryption.
   - **Admin User Management:** Administrators can invite/create user credentials (email & password) and manage roles (`admin` or `manager`).

2. **Backend-Only Employee ID**
   - Employee IDs (e.g., `EMP001`, `EMP002`) are automatically generated and handled internally by the database engine.
   - **Completely hidden in the UI:** Staff members are identified and managed strictly by Name, Designation, and Shift details.

3. **Configurable Shift Duration**
   - Each staff member has a customizable `Shift Duration` column (default: **11.0 hours/shift**).
   - Fully editable per employee to support custom shifts (8h, 12h, etc.).

4. **Round vs. Non-Round Contract Hours & Carry-Forward**
   - **Round Hours (e.g., 44h, 33h, 22h, 11h):** Strictly **cannot carry forward**. Must be 100% fulfilled in each individual week (e.g., 4 shifts every week for 44h staff).
   - **Non-Round / Fractional Hours (e.g., 38.5h = 3.5 shifts/week):** Alternates 4 and 3 shifts across the 4-week cycle ($4 + 3 + 4 + 3 = 14$ shifts = 154 hours = exactly $4 \times 38.5$ hours) with fractional balance carried forward.

5. **Repeating Shift Patterns (New Feature)**
   - Staff can have recurring rotating work/off patterns (e.g., **4 Days ON / 2 Days OFF**, **2 Days ON / 2 Days OFF**).
   - Pattern preferences take priority for employee working days, capped at their weekly contract shifts to avoid overstaffing.

6. **Daily Quotas, Zero Overstaffing & Shortage Alerts**
   - Daily required staff: **28 Day** / **12 Night**.
   - Zero overstaffing: Staff are capped at their contractual target.
   - Any understaffed shifts are highlighted in bold red badges (`-4 ⚠️`) with an interactive **Shortages & Clashes Audit Modal** providing actionable solutions.

7. **Fair Weekend Allocation & Rest Across Week Boundaries**
   - 2 weekends on / 2 weekends off (Cohort A vs Cohort B) with Saturday and Sunday scheduled consecutively.
   - Grouped consecutive weekday blocks with rest days across weekly boundaries to prevent fatigue.

8. **Exports**
   - 1-click **Excel Export** (separate Schedule and Contract Balances sheets).
   - Print & PDF formatted layout.

---

## 🚀 Running Locally

1. **Prerequisites:** Node.js (v18+ or v22/v24).
2. **Install Dependencies:**
   ```bash
   npm install
   ```
3. **Database Setup:**
   The SQLite database (`data/carehome.db`) is automatically initialized. To re-seed from live Google Sheets data:
   ```bash
   npm run seed
   ```
4. **Start Server:**
   ```bash
   npm start
   ```
5. Open your browser at:
   ```
   http://localhost:3000
   ```

### Default Credentials:
- **Admin:** `admin@carehome.com` / `admin123`
- **Manager:** `manager@carehome.com` / `manager123`

---

## ☁️ Free Cloud Deployment (Render / Vercel)

### Deploying to Render (Free Web Service):
1. Push this repository to GitHub or GitLab.
2. In [Render Dashboard](https://dashboard.render.com), click **New +** $\rightarrow$ **Web Service**.
3. Connect your repository.
4. Set:
   - **Environment:** `Node`
   - **Build Command:** `npm install && npm run seed`
   - **Start Command:** `npm start`
5. Click **Create Web Service**. Your platform will be live at `https://your-service.onrender.com`!

### Deploying to Vercel:
1. Connect your repository in Vercel.
2. For persistence on serverless Vercel, attach a free serverless PostgreSQL database from **Neon.tech** or **Supabase** by setting the `DATABASE_URL` environment variable.
