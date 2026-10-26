const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./database");
const { generateRotaForPeriod } = require("./rotaEngine");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "carehome_super_secret_jwt_key_2026_dev";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// JWT Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access token required. Please log in." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Session expired or invalid token." });
    }
    req.user = user;
    next();
  });
}

// Admin Privilege Check Middleware
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === "admin") {
    next();
  } else {
    res.status(403).json({ error: "Admin privilege required." });
  }
}

/* ==========================================================
   1. AUTHENTICATION & USER MANAGEMENT API
   ========================================================= */

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  try {
    const user = await db.queryOne("SELECT * FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token: token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auth/me", authenticateToken, async (req, res) => {
  try {
    const user = await db.queryOne("SELECT id, email, name, role, created_at FROM users WHERE id = ?", [req.user.id]);
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin User Management
app.get("/api/users", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await db.queryAll("SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/users", authenticateToken, requireAdmin, async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }

  try {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);
    const userRole = role === "admin" ? "admin" : "manager";

    const result = await db.execute(`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (?, ?, ?, ?)
    `, [email.trim().toLowerCase(), hash, name.trim(), userRole]);

    res.json({ success: true, id: result.lastID });
  } catch (err) {
    if (err.message && (err.message.includes("UNIQUE") || err.message.includes("unique"))) {
      return res.status(400).json({ error: "User with this email already exists." });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/users/:id", authenticateToken, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: "You cannot delete your own admin account." });
  }

  try {
    await db.execute("DELETE FROM users WHERE id = ?", [targetId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================
   2. EMPLOYEES API (Backend-Only ID Hidden from UI)
   ========================================================= */

app.get("/api/employees", authenticateToken, async (req, res) => {
  try {
    const rows = await db.queryAll("SELECT * FROM employees ORDER BY staff_type ASC, designation ASC, name ASC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/employees", authenticateToken, async (req, res) => {
  const { name, designation, contract_hours, shift_hours, staff_type, active } = req.body;
  if (!name || !designation) {
    return res.status(400).json({ error: "Name and designation are required." });
  }

  try {
    // Automatically generate backend-only ID (e.g. EMP063)
    const maxRow = await db.queryOne("SELECT id FROM employees WHERE id LIKE 'EMP%' ORDER BY id DESC LIMIT 1");
    let nextNum = 1;
    if (maxRow && maxRow.id && maxRow.id.startsWith("EMP")) {
      const numPart = parseInt(maxRow.id.replace("EMP", ""), 10);
      if (!isNaN(numPart)) nextNum = numPart + 1;
    }
    const autoId = `EMP${String(nextNum).padStart(3, "0")}`;

    const cHours = parseFloat(contract_hours) || 44.0;
    const sHours = parseFloat(shift_hours) || 11.0;
    const sType = String(staff_type || "D").toUpperCase() === "N" ? "N" : "D";
    const isActive = active !== undefined ? (active ? 1 : 0) : 1;

    await db.execute(`
      INSERT INTO employees (id, name, designation, contract_hours, shift_hours, staff_type, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [autoId, name.trim(), designation.trim(), cHours, sHours, sType, isActive]);

    res.json({ success: true, id: autoId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/employees/:id", authenticateToken, async (req, res) => {
  const { name, designation, contract_hours, shift_hours, staff_type, active } = req.body;
  const empId = req.params.id;

  const cHours = parseFloat(contract_hours) || 44.0;
  const sHours = parseFloat(shift_hours) || 11.0;
  const sType = String(staff_type || "D").toUpperCase() === "N" ? "N" : "D";
  const isActive = active !== undefined ? (active ? 1 : 0) : 1;

  try {
    await db.execute(`
      UPDATE employees
      SET name = ?, designation = ?, contract_hours = ?, shift_hours = ?, staff_type = ?, active = ?
      WHERE id = ?
    `, [name.trim(), designation.trim(), cHours, sHours, sType, isActive, empId]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/employees/:id", authenticateToken, async (req, res) => {
  try {
    await db.execute("DELETE FROM employees WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================
   3. REQUIREMENTS & HIERARCHY API
   ========================================================= */

app.get("/api/requirements", authenticateToken, async (req, res) => {
  try {
    const rows = await db.queryAll("SELECT * FROM requirements ORDER BY id ASC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/requirements/:id", authenticateToken, async (req, res) => {
  const { day_required, night_required } = req.body;
  try {
    await db.execute(`
      UPDATE requirements
      SET day_required = ?, night_required = ?
      WHERE id = ?
    `, [parseInt(day_required, 10) || 0, parseInt(night_required, 10) || 0, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/requirements", authenticateToken, async (req, res) => {
  const { role_name, day_required, night_required } = req.body;
  try {
    await db.execute(`
      INSERT INTO requirements (role_name, day_required, night_required)
      VALUES (?, ?, ?)
    `, [role_name.trim(), parseInt(day_required, 10) || 0, parseInt(night_required, 10) || 0]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/requirements/:id", authenticateToken, async (req, res) => {
  try {
    await db.execute("DELETE FROM requirements WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/hierarchy", authenticateToken, async (req, res) => {
  try {
    const rows = await db.queryAll("SELECT * FROM role_hierarchy ORDER BY priority ASC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/hierarchy", authenticateToken, async (req, res) => {
  const { priority, required_role, substitute_1, substitute_2, substitute_3, substitute_4, days_per_week } = req.body;
  if (!required_role || !required_role.trim()) {
    return res.status(400).json({ error: "Required role name cannot be empty" });
  }
  const roleName = required_role.trim();
  const days = parseInt(days_per_week, 10) || 7;
  try {
    await db.execute(`
      INSERT INTO role_hierarchy (priority, required_role, substitute_1, substitute_2, substitute_3, substitute_4, days_per_week)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      parseInt(priority, 10) || 99,
      roleName,
      substitute_1 ? substitute_1.trim() : "",
      substitute_2 ? substitute_2.trim() : "",
      substitute_3 ? substitute_3.trim() : "",
      substitute_4 ? substitute_4.trim() : "",
      days
    ]);

    // Dynamic Role Sync: Automatically register in requirements if not present
    const existingReq = await db.queryOne("SELECT id FROM requirements WHERE LOWER(role_name) = LOWER(?)", [roleName]);
    if (!existingReq) {
      await db.execute("INSERT INTO requirements (role_name, day_required, night_required) VALUES (?, 0, 0)", [roleName]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/hierarchy/:id", authenticateToken, async (req, res) => {
  const { priority, required_role, substitute_1, substitute_2, substitute_3, substitute_4, days_per_week } = req.body;
  if (!required_role || !required_role.trim()) {
    return res.status(400).json({ error: "Required role name cannot be empty" });
  }
  const roleName = required_role.trim();
  const days = parseInt(days_per_week, 10) || 7;
  try {
    await db.execute(`
      UPDATE role_hierarchy
      SET priority = ?, required_role = ?, substitute_1 = ?, substitute_2 = ?, substitute_3 = ?, substitute_4 = ?, days_per_week = ?
      WHERE id = ?
    `, [
      parseInt(priority, 10) || 99,
      roleName,
      substitute_1 ? substitute_1.trim() : "",
      substitute_2 ? substitute_2.trim() : "",
      substitute_3 ? substitute_3.trim() : "",
      substitute_4 ? substitute_4.trim() : "",
      days,
      req.params.id
    ]);

    // Dynamic Role Sync: Automatically register in requirements if not present
    const existingReq = await db.queryOne("SELECT id FROM requirements WHERE LOWER(role_name) = LOWER(?)", [roleName]);
    if (!existingReq) {
      await db.execute("INSERT INTO requirements (role_name, day_required, night_required) VALUES (?, 0, 0)", [roleName]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/hierarchy/:id", authenticateToken, async (req, res) => {
  try {
    await db.execute("DELETE FROM role_hierarchy WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================
   4. LEAVE, PREFERENCES & TRAINING API
   ========================================================= */

app.get("/api/leave", authenticateToken, async (req, res) => {
  try {
    const rows = await db.queryAll(`
      SELECT l.*, e.name as employee_name, e.designation
      FROM leave_records l
      JOIN employees e ON l.employee_id = e.id
      ORDER BY l.start_date DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/leave", authenticateToken, async (req, res) => {
  const { employee_id, start_date, end_date, leave_type, notes } = req.body;
  try {
    await db.execute(`
      INSERT INTO leave_records (employee_id, start_date, end_date, leave_type, notes)
      VALUES (?, ?, ?, ?, ?)
    `, [employee_id, start_date, end_date, leave_type || "Annual Leave", notes || ""]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/leave/:id", authenticateToken, async (req, res) => {
  try {
    await db.execute("DELETE FROM leave_records WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/preferences", authenticateToken, async (req, res) => {
  try {
    const rows = await db.queryAll(`
      SELECT p.*, e.name as employee_name, e.designation
      FROM preferences p
      JOIN employees e ON p.employee_id = e.id
      ORDER BY p.id DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/preferences", authenticateToken, async (req, res) => {
  const {
    employee_id,
    type,
    target_date,
    target_dates,
    target_day,
    pattern_work_days,
    pattern_off_days,
    pattern_start_date,
    preference,
    remarks
  } = req.body;

  try {
    // Support batch multi-date preferences
    if (type === "date" && (Array.isArray(target_dates) || (typeof target_date === "string" && target_date.includes(",")))) {
      const rawDates = Array.isArray(target_dates) ? target_dates : target_date.split(",");
      const dates = [...new Set(rawDates.map(d => String(d).trim()).filter(Boolean))];

      if (dates.length > 0) {
        for (const d of dates) {
          await db.execute(`
            INSERT INTO preferences (
              employee_id, type, target_date, target_day,
              pattern_work_days, pattern_off_days, pattern_start_date,
              preference, remarks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            employee_id,
            "date",
            d,
            null,
            null,
            null,
            null,
            preference || "prefer",
            remarks || ""
          ]);
        }
        return res.json({ success: true, count: dates.length });
      }
    }

    // Support batch multi-day preferences for recurring days
    if (type === "day" && (Array.isArray(req.body.target_days) || (typeof target_day === "string" && target_day.includes(",")))) {
      const rawDays = Array.isArray(req.body.target_days) ? req.body.target_days : target_day.split(",");
      const days = [...new Set(rawDays.map(d => String(d).trim()).filter(Boolean))];

      if (days.length > 0) {
        for (const day of days) {
          await db.execute(`
            INSERT INTO preferences (
              employee_id, type, target_date, target_day,
              pattern_work_days, pattern_off_days, pattern_start_date,
              preference, remarks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            employee_id,
            "day",
            null,
            day,
            null,
            null,
            null,
            preference || "prefer",
            remarks || ""
          ]);
        }
        return res.json({ success: true, count: days.length });
      }
    }

    await db.execute(`
      INSERT INTO preferences (
        employee_id, type, target_date, target_day,
        pattern_work_days, pattern_off_days, pattern_start_date,
        preference, remarks
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      employee_id,
      type || "date",
      target_date || null,
      target_day || null,
      pattern_work_days ? parseInt(pattern_work_days, 10) : null,
      pattern_off_days ? parseInt(pattern_off_days, 10) : null,
      pattern_start_date || null,
      preference || "prefer",
      remarks || ""
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/preferences/:id", authenticateToken, async (req, res) => {
  try {
    await db.execute("DELETE FROM preferences WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/training", authenticateToken, async (req, res) => {
  try {
    const rows = await db.queryAll(`
      SELECT t.*, e.name as employee_name, e.designation
      FROM training_records t
      JOIN employees e ON t.employee_id = e.id
      ORDER BY t.training_date DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/training", authenticateToken, async (req, res) => {
  const { employee_id, training_name, training_date, notes } = req.body;
  try {
    await db.execute(`
      INSERT INTO training_records (employee_id, training_name, training_date, notes)
      VALUES (?, ?, ?, ?)
    `, [employee_id, training_name || "Mandatory Training", training_date || null, notes || ""]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/training/:id", authenticateToken, async (req, res) => {
  try {
    await db.execute("DELETE FROM training_records WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================================
   5. ROTA GENERATION & SAVED ROTAS API
   ========================================================= */

app.post("/api/rota/generate", authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, periodLabel } = req.body;
    const sDate = startDate || "2026-09-28";
    const eDate = endDate || "2026-10-25";
    const pLabel = periodLabel || `Period 10 (28 Sep 2026 – 25 Oct 2026)`;

    const result = await generateRotaForPeriod(sDate, eDate, pLabel);

    await db.execute(`
      INSERT INTO saved_rotas (period_id, period_label, start_date, end_date, rota_json)
      VALUES (?, ?, ?, ?, ?)
    `, [
      `P_${sDate}_${eDate}`,
      pLabel,
      sDate,
      eDate,
      JSON.stringify(result)
    ]);

    res.json(result);
  } catch (err) {
    console.error("Rota generation error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/rota/latest", authenticateToken, async (req, res) => {
  try {
    const saved = await db.queryOne("SELECT * FROM saved_rotas ORDER BY id DESC LIMIT 1");
    if (!saved) {
      // If none saved, generate default Period 10 automatically
      const result = await generateRotaForPeriod("2026-09-28", "2026-10-25", "Period 10 (28 Sep 2026 – 25 Oct 2026)");
      await db.execute(`
        INSERT INTO saved_rotas (period_id, period_label, start_date, end_date, rota_json)
        VALUES (?, ?, ?, ?, ?)
      `, [
        "P_2026-09-28_2026-10-25",
        "Period 10 (28 Sep 2026 – 25 Oct 2026)",
        "2026-09-28",
        "2026-10-25",
        JSON.stringify(result)
      ]);
      return res.json(result);
    }
    res.json(JSON.parse(saved.rota_json));
  } catch (err) {
    console.error("Fetch latest rota error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Fallback to index.html for single-page routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function startServer() {
  try {
    await db.init();
    app.listen(PORT, () => {
      console.log(`🚀 Care Home Rota Platform running on port ${PORT} [DB: ${db.isPostgres ? "PostgreSQL" : "SQLite"}]`);
    });
  } catch (err) {
    console.error("Fatal startup error:", err);
    process.exit(1);
  }
}

startServer();
