const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "carehome.db");
const db = new DatabaseSync(dbPath);

// Enable WAL mode and foreign keys for optimal performance
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'manager',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      designation TEXT NOT NULL,
      contract_hours REAL NOT NULL DEFAULT 44.0,
      shift_hours REAL NOT NULL DEFAULT 11.0,
      staff_type TEXT NOT NULL DEFAULT 'D',
      active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_name TEXT UNIQUE NOT NULL,
      day_required INTEGER NOT NULL DEFAULT 0,
      night_required INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS role_hierarchy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority INTEGER NOT NULL,
      required_role TEXT UNIQUE NOT NULL,
      substitute_1 TEXT,
      substitute_2 TEXT,
      substitute_3 TEXT,
      substitute_4 TEXT
    );

    CREATE TABLE IF NOT EXISTS leave_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      leave_type TEXT NOT NULL DEFAULT 'Annual Leave',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Approved',
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      type TEXT NOT NULL DEFAULT 'date', -- 'date', 'day', 'pattern'
      target_date TEXT,
      target_day TEXT,
      pattern_work_days INTEGER,
      pattern_off_days INTEGER,
      pattern_start_date TEXT,
      preference TEXT NOT NULL DEFAULT 'prefer', -- 'prefer', 'unavailable'
      remarks TEXT
    );

    CREATE TABLE IF NOT EXISTS training_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      training_name TEXT NOT NULL DEFAULT 'Mandatory Training',
      training_date TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS saved_rotas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_id TEXT NOT NULL,
      period_label TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      rota_json TEXT NOT NULL
    );
  `);
}

initSchema();

module.exports = db;
