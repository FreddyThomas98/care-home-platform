const path = require("path");
const fs = require("fs");

let pgPool = null;
let sqliteDb = null;
const isPostgres = Boolean(process.env.DATABASE_URL);

if (isPostgres) {
  const { Pool } = require("pg");
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
  });
} else {
  let Database;
  try {
    const { DatabaseSync } = require("node:sqlite");
    Database = DatabaseSync;
  } catch (e1) {
    try {
      Database = require("better-sqlite3");
    } catch (e2) {
      throw new Error("SQLite engine not found.");
    }
  }

  const dataDir = path.join(__dirname, "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, "carehome.db");
  sqliteDb = new Database(dbPath);
  try {
    sqliteDb.exec("PRAGMA journal_mode = WAL;");
    sqliteDb.exec("PRAGMA foreign_keys = ON;");
    try {
      const empCols = sqliteDb.prepare("PRAGMA table_info(employees)").all();
      if (empCols.length > 0 && !empCols.some(c => c.name === "floor")) {
        sqliteDb.exec("ALTER TABLE employees ADD COLUMN floor TEXT DEFAULT '';");
      }
    } catch (err) {}
  } catch (e) {
    // Ignore pragma errors if in memory or unsupported
  }
}

function formatSqlForPg(sql) {
  let paramIndex = 1;
  return sql.replace(/\?/g, () => `$${paramIndex++}`);
}

async function query(sql, params = []) {
  if (isPostgres) {
    const pgSql = formatSqlForPg(sql);
    const res = await pgPool.query(pgSql, params);
    const lastID = res.rows && res.rows[0] && res.rows[0].id !== undefined ? res.rows[0].id : null;
    return {
      rows: res.rows || [],
      rowCount: res.rowCount || 0,
      lastID
    };
  } else {
    const stmt = sqliteDb.prepare(sql);
    const isSelect = /^\s*(SELECT|PRAGMA)/i.test(sql);
    if (isSelect) {
      const rows = stmt.all(...params);
      return { rows: rows || [], rowCount: (rows && rows.length) || 0 };
    } else {
      const info = stmt.run(...params);
      return {
        rows: [],
        rowCount: (info && info.changes) || 0,
        lastID: (info && info.lastInsertRowid) || null
      };
    }
  }
}

async function queryAll(sql, params = []) {
  const res = await query(sql, params);
  return res.rows;
}

async function queryOne(sql, params = []) {
  const res = await query(sql, params);
  return (res.rows && res.rows[0]) || null;
}

async function execute(sql, params = []) {
  return await query(sql, params);
}

async function exec(sql) {
  if (isPostgres) {
    await pgPool.query(sql);
  } else {
    sqliteDb.exec(sql);
  }
}

async function init() {
  if (isPostgres) {
    console.log("🐘 Initializing PostgreSQL database schema...");
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'manager',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS employees (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        designation VARCHAR(100) NOT NULL,
        floor VARCHAR(100) DEFAULT '',
        contract_hours NUMERIC NOT NULL DEFAULT 44.0,
        shift_hours NUMERIC NOT NULL DEFAULT 11.0,
        staff_type VARCHAR(10) NOT NULL DEFAULT 'D',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS requirements (
        id SERIAL PRIMARY KEY,
        role_name VARCHAR(100) UNIQUE NOT NULL,
        day_required INTEGER NOT NULL DEFAULT 0,
        night_required INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS role_hierarchy (
        id SERIAL PRIMARY KEY,
        priority INTEGER NOT NULL,
        required_role VARCHAR(100) UNIQUE NOT NULL,
        substitute_1 VARCHAR(100),
        substitute_2 VARCHAR(100),
        substitute_3 VARCHAR(100),
        substitute_4 VARCHAR(100),
        days_per_week INTEGER NOT NULL DEFAULT 7
      );

      ALTER TABLE role_hierarchy ADD COLUMN IF NOT EXISTS days_per_week INTEGER NOT NULL DEFAULT 7;
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS floor VARCHAR(100) DEFAULT '';
      ALTER TABLE preferences ALTER COLUMN target_day TYPE VARCHAR(100);

      CREATE TABLE IF NOT EXISTS leave_records (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        leave_type VARCHAR(100) NOT NULL DEFAULT 'Annual Leave',
        start_date VARCHAR(20) NOT NULL,
        end_date VARCHAR(20) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Approved',
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS preferences (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL DEFAULT 'date',
        target_date VARCHAR(20),
        target_day VARCHAR(20),
        pattern_work_days INTEGER,
        pattern_off_days INTEGER,
        pattern_start_date VARCHAR(20),
        preference VARCHAR(50) NOT NULL DEFAULT 'prefer',
        remarks TEXT
      );

      CREATE TABLE IF NOT EXISTS training_records (
        id SERIAL PRIMARY KEY,
        employee_id VARCHAR(50) NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        training_name VARCHAR(255) NOT NULL DEFAULT 'Mandatory Training',
        training_date VARCHAR(20),
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS saved_rotas (
        id SERIAL PRIMARY KEY,
        period_id VARCHAR(100) NOT NULL,
        period_label VARCHAR(255) NOT NULL,
        start_date VARCHAR(20) NOT NULL,
        end_date VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rota_json TEXT NOT NULL
      );
    `);

    // Auto-seed baseline data if the database is freshly created and empty
    const checkEmp = await pgPool.query("SELECT COUNT(*) as cnt FROM employees");
    const count = parseInt(checkEmp.rows[0].cnt, 10);
    if (count === 0) {
      console.log("🌱 PostgreSQL database is empty. Auto-seeding initial baseline records...");
      const seedPath = path.join(__dirname, "data", "initial_seed.json");
      if (fs.existsSync(seedPath)) {
        const seedData = JSON.parse(fs.readFileSync(seedPath, "utf8"));

        for (const u of (seedData.users || [])) {
          await pgPool.query(
            "INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING",
            [u.id, u.email, u.password_hash, u.name, u.role]
          );
        }

        for (const e of (seedData.employees || [])) {
          await pgPool.query(
            "INSERT INTO employees (id, name, designation, contract_hours, shift_hours, staff_type, active, floor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING",
            [e.id, e.name, e.designation, e.contract_hours, e.shift_hours, e.staff_type, e.active, e.floor || '']
          );
        }

        for (const r of (seedData.requirements || [])) {
          await pgPool.query(
            "INSERT INTO requirements (role_name, day_required, night_required) VALUES ($1, $2, $3) ON CONFLICT (role_name) DO NOTHING",
            [r.role_name, r.day_required, r.night_required]
          );
        }

        for (const h of (seedData.role_hierarchy || [])) {
          await pgPool.query(
            "INSERT INTO role_hierarchy (priority, required_role, substitute_1, substitute_2, substitute_3, substitute_4, days_per_week) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (required_role) DO NOTHING",
            [h.priority, h.required_role, h.substitute_1 || '', h.substitute_2 || '', h.substitute_3 || '', h.substitute_4 || '', h.days_per_week || 7]
          );
        }

        for (const p of (seedData.preferences || [])) {
          await pgPool.query(
            "INSERT INTO preferences (employee_id, type, target_date, target_day, pattern_work_days, pattern_off_days, pattern_start_date, preference, remarks) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [p.employee_id, p.type || 'date', p.target_date || null, p.target_day || null, p.pattern_work_days || null, p.pattern_off_days || null, p.pattern_start_date || null, p.preference || 'prefer', p.remarks || '']
          );
        }

        console.log(`✅ Auto-seeding complete! ${seedData.employees.length} employees and configuration loaded.`);
      }
    } else {
      console.log(`✅ PostgreSQL ready (${count} employees loaded).`);
    }
  } else {
    console.log("📁 Using local SQLite database.");
    try {
      sqliteDb.exec(`
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
          floor TEXT DEFAULT '',
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
          substitute_4 TEXT,
          days_per_week INTEGER NOT NULL DEFAULT 7
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
          type TEXT NOT NULL DEFAULT 'date',
          target_date TEXT,
          target_day TEXT,
          pattern_work_days INTEGER,
          pattern_off_days INTEGER,
          pattern_start_date TEXT,
          preference TEXT NOT NULL DEFAULT 'prefer',
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

      const cols = sqliteDb.prepare("PRAGMA table_info(role_hierarchy)").all();
      if (!cols.some(c => c.name === "days_per_week")) {
        sqliteDb.exec("ALTER TABLE role_hierarchy ADD COLUMN days_per_week INTEGER NOT NULL DEFAULT 7;");
      }

      const empCols = sqliteDb.prepare("PRAGMA table_info(employees)").all();
      if (!empCols.some(c => c.name === "floor")) {
        sqliteDb.exec("ALTER TABLE employees ADD COLUMN floor TEXT DEFAULT '';");
      }
    } catch (e) {
      console.warn("SQLite schema / migration check:", e.message);
    }
  }
}

// Backwards compatibility layer for legacy code calling db.prepare
function prepare(sql) {
  if (isPostgres) {
    return {
      all: async (...params) => await queryAll(sql, params),
      get: async (...params) => await queryOne(sql, params),
      run: async (...params) => await execute(sql, params)
    };
  } else {
    return sqliteDb.prepare(sql);
  }
}

module.exports = {
  isPostgres,
  init,
  query,
  queryAll,
  queryOne,
  execute,
  exec,
  prepare,
  getSqliteDb: () => sqliteDb,
  getPgPool: () => pgPool
};
