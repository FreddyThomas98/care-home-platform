const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./database");
const { generateRotaForPeriod } = require("./rotaEngine");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "carehome-super-secret-key-2026";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  }
}));

// JWT Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. Please log in." });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Session expired. Please log in again." });
    req.user = user;
    next();
  });
}

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

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
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
});

app.get("/api/auth/me", authenticateToken, (req, res) => {
  const user = db.prepare("SELECT id, email, name, role, created_at FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ user });
});

// Admin User Management
app.get("/api/users", authenticateToken, requireAdmin, (req, res) => {
  const users = db.prepare("SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC").all();
  res.json(users);
});

app.post("/api/users", authenticateToken, requireAdmin, (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }

  try {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);
    const userRole = role === "admin" ? "admin" : "manager";

    const insert = db.prepare(`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (?, ?, ?, ?)
    `);

    const result = insert.run(email.trim().toLowerCase(), hash, name.trim(), userRole);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE")) {
      return res.status(400).json({ error: "User with this email already exists." });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/users/:id", authenticateToken, requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: "You cannot delete your own admin account." });
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(targetId);
  res.json({ success: true });
});

/* ==========================================================
   2. EMPLOYEES API (Backend-Only ID Hidden from UI)
   ========================================================= */

app.get("/api/employees", authenticateToken, (req, res) => {
  // Return employees sorted by designation & name
  const rows = db.prepare("SELECT * FROM employees ORDER BY staff_type ASC, designation ASC, name ASC").all();
  res.json(rows);
});

app.post("/api/employees", authenticateToken, (req, res) => {
  const { name, designation, contract_hours, shift_hours, staff_type, active } = req.body;
  if (!name || !designation) {
    return res.status(400).json({ error: "Name and designation are required." });
  }

  // Automatically generate backend-only ID (e.g. EMP063)
  const maxRow = db.prepare("SELECT id FROM employees ORDER BY id DESC LIMIT 1").get();
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

  db.prepare(`
    INSERT INTO employees (id, name, designation, contract_hours, shift_hours, staff_type, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(autoId, name.trim(), designation.trim(), cHours, sHours, sType, isActive);

  res.json({ success: true, id: autoId });
});

app.put("/api/employees/:id", authenticateToken, (req, res) => {
  const { name, designation, contract_hours, shift_hours, staff_type, active } = req.body;
  const empId = req.params.id;

  const cHours = parseFloat(contract_hours) || 44.0;
  const sHours = parseFloat(shift_hours) || 11.0;
  const sType = String(staff_type || "D").toUpperCase() === "N" ? "N" : "D";
  const isActive = active !== undefined ? (active ? 1 : 0) : 1;

  db.prepare(`
    UPDATE employees
    SET name = ?, designation = ?, contract_hours = ?, shift_hours = ?, staff_type = ?, active = ?
    WHERE id = ?
  `).run(name.trim(), designation.trim(), cHours, sHours, sType, isActive, empId);

  res.json({ success: true });
});

app.delete("/api/employees/:id", authenticateToken, (req, res) => {
  db.prepare("DELETE FROM employees WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

/* ==========================================================
   3. REQUIREMENTS & HIERARCHY API
   ========================================================= */

app.get("/api/requirements", authenticateToken, (req, res) => {
  const rows = db.prepare("SELECT * FROM requirements ORDER BY id ASC").all();
  res.json(rows);
});

app.put("/api/requirements/:id", authenticateToken, (req, res) => {
  const { day_required, night_required } = req.body;
  db.prepare(`
    UPDATE requirements
    SET day_required = ?, night_required = ?
    WHERE id = ?
  `).run(parseInt(day_required, 10) || 0, parseInt(night_required, 10) || 0, req.params.id);
  res.json({ success: true });
});

app.post("/api/requirements", authenticateToken, (req, res) => {
  const { role_name, day_required, night_required } = req.body;
  db.prepare(`
    INSERT INTO requirements (role_name, day_required, night_required)
    VALUES (?, ?, ?)
  `).run(role_name.trim(), parseInt(day_required, 10) || 0, parseInt(night_required, 10) || 0);
  res.json({ success: true });
});

app.delete("/api/requirements/:id", authenticateToken, (req, res) => {
  db.prepare("DELETE FROM requirements WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.get("/api/hierarchy", authenticateToken, (req, res) => {
  const rows = db.prepare("SELECT * FROM role_hierarchy ORDER BY priority ASC").all();
  res.json(rows);
});

app.post("/api/hierarchy", authenticateToken, (req, res) => {
  const { priority, required_role, substitute_1, substitute_2, substitute_3, substitute_4 } = req.body;
  db.prepare(`
    INSERT INTO role_hierarchy (priority, required_role, substitute_1, substitute_2, substitute_3, substitute_4)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    parseInt(priority, 10) || 99,
    required_role.trim(),
    substitute_1 ? substitute_1.trim() : "",
    substitute_2 ? substitute_2.trim() : "",
    substitute_3 ? substitute_3.trim() : "",
    substitute_4 ? substitute_4.trim() : ""
  );
  res.json({ success: true });
});

app.delete("/api/hierarchy/:id", authenticateToken, (req, res) => {
  db.prepare("DELETE FROM role_hierarchy WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

/* ==========================================================
   4. LEAVE, PREFERENCES & TRAINING API
   ========================================================= */

app.get("/api/leave", authenticateToken, (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, e.name as employee_name, e.designation
    FROM leave_records l
    JOIN employees e ON l.employee_id = e.id
    ORDER BY l.start_date DESC
  `).all();
  res.json(rows);
});

app.post("/api/leave", authenticateToken, (req, res) => {
  const { employee_id, start_date, end_date, leave_type, notes } = req.body;
  db.prepare(`
    INSERT INTO leave_records (employee_id, start_date, end_date, leave_type, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(employee_id, start_date, end_date, leave_type || "Annual Leave", notes || "");
  res.json({ success: true });
});

app.delete("/api/leave/:id", authenticateToken, (req, res) => {
  db.prepare("DELETE FROM leave_records WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.get("/api/preferences", authenticateToken, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, e.name as employee_name, e.designation
    FROM preferences p
    JOIN employees e ON p.employee_id = e.id
    ORDER BY p.id DESC
  `).all();
  res.json(rows);
});

app.post("/api/preferences", authenticateToken, (req, res) => {
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

  // Support batch multi-date preferences in a single transaction
  if (type === "date" && (Array.isArray(target_dates) || (typeof target_date === "string" && target_date.includes(",")))) {
    const rawDates = Array.isArray(target_dates) ? target_dates : target_date.split(",");
    const dates = [...new Set(rawDates.map(d => String(d).trim()).filter(Boolean))];

    if (dates.length > 0) {
      const insertStmt = db.prepare(`
        INSERT INTO preferences (
          employee_id, type, target_date, target_day,
          pattern_work_days, pattern_off_days, pattern_start_date,
          preference, remarks
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      db.exec("BEGIN TRANSACTION;");
      try {
        for (const d of dates) {
          insertStmt.run(
            employee_id,
            "date",
            d,
            null,
            null,
            null,
            null,
            preference || "prefer",
            remarks || ""
          );
        }
        db.exec("COMMIT;");
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }
      return res.json({ success: true, count: dates.length });
    }
  }

  db.prepare(`
    INSERT INTO preferences (
      employee_id, type, target_date, target_day,
      pattern_work_days, pattern_off_days, pattern_start_date,
      preference, remarks
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employee_id,
    type || "date",
    target_date || null,
    target_day || null,
    pattern_work_days ? parseInt(pattern_work_days, 10) : null,
    pattern_off_days ? parseInt(pattern_off_days, 10) : null,
    pattern_start_date || null,
    preference || "prefer",
    remarks || ""
  );
  res.json({ success: true });
});

app.delete("/api/preferences/:id", authenticateToken, (req, res) => {
  db.prepare("DELETE FROM preferences WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

app.get("/api/training", authenticateToken, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, e.name as employee_name, e.designation
    FROM training_records t
    JOIN employees e ON t.employee_id = e.id
    ORDER BY t.training_date DESC
  `).all();
  res.json(rows);
});

app.post("/api/training", authenticateToken, (req, res) => {
  const { employee_id, training_name, training_date, notes } = req.body;
  db.prepare(`
    INSERT INTO training_records (employee_id, training_name, training_date, notes)
    VALUES (?, ?, ?, ?)
  `).run(employee_id, training_name || "Mandatory Training", training_date || null, notes || "");
  res.json({ success: true });
});

app.delete("/api/training/:id", authenticateToken, (req, res) => {
  db.prepare("DELETE FROM training_records WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

/* ==========================================================
   5. ROTA GENERATION & SAVED ROTAS API
   ========================================================= */

app.post("/api/rota/generate", authenticateToken, (req, res) => {
  try {
    const { startDate, endDate, periodLabel } = req.body;
    const sDate = startDate || "2026-09-28";
    const eDate = endDate || "2026-10-25";
    const pLabel = periodLabel || `Period 10 (28 Sep 2026 – 25 Oct 2026)`;

    const result = generateRotaForPeriod(sDate, eDate, pLabel);

    // Save generated rota into database
    const insertSaved = db.prepare(`
      INSERT INTO saved_rotas (period_id, period_label, start_date, end_date, rota_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertSaved.run(
      `P_${sDate}_${eDate}`,
      pLabel,
      sDate,
      eDate,
      JSON.stringify(result)
    );

    res.json(result);
  } catch (err) {
    console.error("Rota generation error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/rota/latest", authenticateToken, (req, res) => {
  const saved = db.prepare("SELECT * FROM saved_rotas ORDER BY id DESC LIMIT 1").get();
  if (!saved) {
    // If none saved, generate default Period 10 automatically
    const result = generateRotaForPeriod("2026-09-28", "2026-10-25", "Period 10 (28 Sep 2026 – 25 Oct 2026)");
    const insertSaved = db.prepare(`
      INSERT INTO saved_rotas (period_id, period_label, start_date, end_date, rota_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertSaved.run(
      "P_2026-09-28_2026-10-25",
      "Period 10 (28 Sep 2026 – 25 Oct 2026)",
      "2026-09-28",
      "2026-10-25",
      JSON.stringify(result)
    );
    return res.json(result);
  }
  res.json(JSON.parse(saved.rota_json));
});

// Fallback to index.html for single-page routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Care Home Rota Platform running on http://localhost:${PORT}`);
});
