const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const db = require("./database");

const LIVE_DATA_DIR = path.resolve(__dirname, "../../brain/6fa2e2c3-17ba-4732-a0a9-851e3714df84/scratch/live_data");

function parseCSV(filepath) {
  if (!fs.existsSync(filepath)) return [];
  const content = fs.readFileSync(filepath, "utf8");
  const lines = content.trim().split("\n").map(l => l.replace(/\r/g, "")).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h.trim()] = vals[idx] !== undefined ? vals[idx].trim() : "";
    });
    rows.push(obj);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function seed() {
  console.log("🌱 Starting Database Seeding from Google Sheets Data...");

  // 1. Seed Users (Admin & Manager)
  const salt = bcrypt.genSaltSync(10);
  const adminHash = bcrypt.hashSync("admin123", salt);
  const managerHash = bcrypt.hashSync("manager123", salt);

  const insertUser = db.prepare(`
    INSERT OR REPLACE INTO users (id, email, password_hash, name, role)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertUser.run(1, "admin@carehome.com", adminHash, "Admin Director", "admin");
  insertUser.run(2, "manager@carehome.com", managerHash, "Rota Manager", "manager");
  console.log("✅ Seeded default users: admin@carehome.com (pwd: admin123), manager@carehome.com (pwd: manager123)");

  // 2. Seed Employees from Employees.csv
  const empPath = path.join(LIVE_DATA_DIR, "Employees.csv");
  const empRows = parseCSV(empPath);

  const insertEmp = db.prepare(`
    INSERT OR REPLACE INTO employees (id, name, designation, contract_hours, shift_hours, staff_type, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  empRows.forEach(r => {
    const id = r["Employee ID"] || r["Employee_ID"];
    const name = r["Employee Name"] || r["Employee_Name"];
    const desig = r["Designation"] || "Carer";
    const hours = parseFloat(r["Contract Hours"] || "0") || 0;
    const shiftHours = 11.0; // Default 11 hours
    const staffType = String(r["Staff Type (Day/Night)"] || "D").toUpperCase().includes("N") ? "N" : "D";
    const active = String(r["Active"] || "Yes").toLowerCase() === "yes" ? 1 : 0;

    if (id && name) {
      insertEmp.run(id, name, desig, hours, shiftHours, staffType, active);
    }
  });
  console.log(`✅ Seeded ${empRows.length} employees from live sheets`);

  // 3. Seed Requirements from Staff_Requirements.csv
  const reqPath = path.join(LIVE_DATA_DIR, "Staff_Requirements.csv");
  const reqRows = parseCSV(reqPath);

  const insertReq = db.prepare(`
    INSERT OR REPLACE INTO requirements (role_name, day_required, night_required)
    VALUES (?, ?, ?)
  `);

  reqRows.forEach(r => {
    // Find designation from row (first non-day/night key)
    let desig = r["Designation"] || r["Role"] || r[""] || "";
    if (!desig) {
      const keys = Object.keys(r);
      for (const k of keys) {
        if (!k.toLowerCase().includes("day") && !k.toLowerCase().includes("night")) {
          if (r[k]) {
            desig = r[k];
            break;
          }
        }
      }
    }

    let day = 0;
    let night = 0;
    Object.keys(r).forEach(col => {
      const lower = col.toLowerCase();
      if (lower.includes("day")) day = parseInt(r[col], 10) || 0;
      if (lower.includes("night")) night = parseInt(r[col], 10) || 0;
    });

    if (desig && (day > 0 || night > 0)) {
      insertReq.run(desig, day, night);
    }
  });
  console.log(`✅ Seeded requirements`);

  // 4. Seed Role Hierarchy from Role_Hierarchy.csv
  const hierPath = path.join(LIVE_DATA_DIR, "Role_Hierarchy.csv");
  const hierRows = parseCSV(hierPath);

  const insertHier = db.prepare(`
    INSERT OR REPLACE INTO role_hierarchy (priority, required_role, substitute_1, substitute_2, substitute_3, substitute_4)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  hierRows.forEach(r => {
    const pri = parseInt(r["Priority"] || "99", 10);
    const reqRole = r["Required_Role"] || r["Required Role"] || r["Role"];
    const sub1 = r["Substitute_1"] || r["Substitute 1"] || "";
    const sub2 = r["Substitute_2"] || r["Substitute 2"] || "";
    const sub3 = r["Substitute_3"] || r["Substitute 3"] || "";
    const sub4 = r["Substitute_4"] || r["Substitute 4"] || "";

    if (reqRole) {
      insertHier.run(pri, reqRole, sub1, sub2, sub3, sub4);
    }
  });
  console.log(`✅ Seeded role hierarchy & substitutions`);

  // 5. Seed Preferences from Date_Preferences.csv and sample pattern
  const datePrefPath = path.join(LIVE_DATA_DIR, "Date_Preferences.csv");
  const datePrefRows = parseCSV(datePrefPath);

  const insertPref = db.prepare(`
    INSERT INTO preferences (employee_id, type, target_date, target_day, pattern_work_days, pattern_off_days, pattern_start_date, preference, remarks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  datePrefRows.forEach(r => {
    const empId = r["Employee_ID"] || r["Employee ID"];
    const d = r["Date"];
    const pref = String(r["Preference"] || "").toLowerCase().includes("prefer") ? "prefer" : "unavailable";
    const rem = r["Remarks"] || r["Preference"] || "";
    if (empId && d) {
      insertPref.run(empId, "date", d, null, null, null, null, pref, rem);
    }
  });

  // Seed sample pattern preference: 4 on / 2 off for EMP004 (Antu Abraham)
  insertPref.run("EMP004", "pattern", null, null, 4, 2, "2026-09-28", "prefer", "4 Days Work, 2 Days Off Pattern");
  console.log(`✅ Seeded staff preferences & repeating pattern example`);

  console.log("🎉 Database initialization and seeding complete!");
}

if (require.main === module) {
  seed();
}

module.exports = { seed };
