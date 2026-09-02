// db.js — إعداد قاعدة بيانات SQLite الحقيقية (ملف فعلي على القرص)
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'dakka.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    system TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blocked (
    phone TEXT PRIMARY KEY,
    blocked_at INTEGER NOT NULL
  );

  -- نقاط البيع + المخزون (منتجات مشتركة بين النظامين)
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    low_stock_at INTEGER NOT NULL DEFAULT 5,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    total REAL NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invoice_items (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    price REAL NOT NULL,
    qty INTEGER NOT NULL
  );

  -- الحضور والانصراف
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    type TEXT NOT NULL,
    ts INTEGER NOT NULL
  );

  -- إدارة العملاء CRM
  CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL
  );

  -- الأمن والمراقبة (سجل أحداث/دخول)
  CREATE TABLE IF NOT EXISTS security_logs (
    id TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    created_at INTEGER NOT NULL
  );

  -- تخطيط الموارد ERP (حركات مالية مبسطة)
  CREATE TABLE IF NOT EXISTS finance_entries (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

module.exports = db;
