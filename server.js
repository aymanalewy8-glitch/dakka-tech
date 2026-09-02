// server.js — سيرفر دكة للتقنية
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dakka2026';

// جلسات بسيطة في الذاكرة (تُمسح عند إعادة تشغيل السيرفر)
const sessions = new Set();

function normalizePhone(p) {
  return (p || '').replace(/[^0-9]/g, '');
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: 'غير مصرح - سجّل دخول من جديد' });
  }
  next();
}

// ===== نقاط الوصول العامة =====

// إرسال طلب جديد (من نموذج الموقع)
app.post('/api/requests', (req, res) => {
  const { name, phone, system, details } = req.body || {};
  if (!name || !phone || !system) {
    return res.status(400).json({ error: 'الاسم والجوال والنظام مطلوبة' });
  }

  const normPhone = normalizePhone(phone);
  const isBlocked = db.prepare('SELECT 1 FROM blocked WHERE phone = ?').get(normPhone);
  if (isBlocked) {
    return res.status(403).json({ error: 'blocked' });
  }

  const id = 'req_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  db.prepare(
    `INSERT INTO requests (id, name, phone, system, details, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'new', ?)`
  ).run(id, name, phone, system, details || '', Date.now());

  res.json({ ok: true, id });
});

// ===== تسجيل دخول الأدمن =====
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'كلمة مرور غير صحيحة' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.add(token);
  res.json({ token });
});

app.post('/api/admin/logout', requireAuth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  sessions.delete(token);
  res.json({ ok: true });
});

// ===== نقاط الوصول المحمية (لوحة التحكم) =====

app.get('/api/requests', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all();
  res.json(rows);
});

app.patch('/api/requests/:id', requireAuth, (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'contacted', 'blocked'].includes(status)) {
    return res.status(400).json({ error: 'حالة غير صحيحة' });
  }
  db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/requests/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM requests WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/block', requireAuth, (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'رقم الجوال مطلوب' });
  const norm = normalizePhone(phone);
  db.prepare('INSERT OR REPLACE INTO blocked (phone, blocked_at) VALUES (?, ?)').run(norm, Date.now());
  db.prepare("UPDATE requests SET status = 'blocked' WHERE phone = ?").run(phone);
  res.json({ ok: true });
});

app.delete('/api/block/:phone', requireAuth, (req, res) => {
  db.prepare('DELETE FROM blocked WHERE phone = ?').run(normalizePhone(req.params.phone));
  res.json({ ok: true });
});

app.get('/api/blocked', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM blocked ORDER BY blocked_at DESC').all());
});

function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
}

// ===================== نظام نقاط البيع + المخزون (منتجات مشتركة) =====================

app.get('/api/products', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY created_at DESC').all());
});

app.post('/api/products', requireAuth, (req, res) => {
  const { name, price, stock, low_stock_at } = req.body || {};
  if (!name || price === undefined) return res.status(400).json({ error: 'الاسم والسعر مطلوبان' });
  const id = newId('prod');
  db.prepare(
    `INSERT INTO products (id, name, price, stock, low_stock_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, Number(price), Number(stock) || 0, Number(low_stock_at) || 5, Date.now());
  res.json({ ok: true, id });
});

app.patch('/api/products/:id', requireAuth, (req, res) => {
  const { name, price, stock, low_stock_at } = req.body || {};
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'غير موجود' });
  db.prepare(
    `UPDATE products SET name=?, price=?, stock=?, low_stock_at=? WHERE id=?`
  ).run(
    name ?? existing.name,
    price !== undefined ? Number(price) : existing.price,
    stock !== undefined ? Number(stock) : existing.stock,
    low_stock_at !== undefined ? Number(low_stock_at) : existing.low_stock_at,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// فاتورة بيع: تخصم من المخزون تلقائياً
app.post('/api/invoices', requireAuth, (req, res) => {
  const { items } = req.body || {}; // [{product_id, qty}]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'الفاتورة فارغة' });
  }

  const tx = db.transaction((items) => {
    let total = 0;
    const invoiceId = newId('inv');
    const lineItems = [];

    for (const it of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
      if (!product) throw new Error('منتج غير موجود');
      const qty = Number(it.qty) || 1;
      if (product.stock < qty) throw new Error(`الكمية غير كافية لـ ${product.name}`);

      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, product.id);
      total += product.price * qty;

      lineItems.push({ product_name: product.name, price: product.price, qty });
    }

    db.prepare('INSERT INTO invoices (id, total, created_at) VALUES (?, ?, ?)').run(invoiceId, total, Date.now());
    for (const li of lineItems) {
      db.prepare(
        'INSERT INTO invoice_items (id, invoice_id, product_name, price, qty) VALUES (?, ?, ?, ?, ?)'
      ).run(newId('item'), invoiceId, li.product_name, li.price, li.qty);
    }

    return { invoiceId, total };
  });

  try {
    const result = tx(items);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/invoices', requireAuth, (req, res) => {
  const invoices = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 100').all();
  const withItems = invoices.map(inv => ({
    ...inv,
    items: db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ?').all(inv.id)
  }));
  res.json(withItems);
});

// ===================== نظام الحضور والانصراف =====================

app.get('/api/employees', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM employees ORDER BY created_at DESC').all());
});

app.post('/api/employees', requireAuth, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });
  const id = newId('emp');
  db.prepare('INSERT INTO employees (id, name, created_at) VALUES (?, ?, ?)').run(id, name, Date.now());
  res.json({ ok: true, id });
});

app.delete('/api/employees/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM employees WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/attendance', requireAuth, (req, res) => {
  const { employee_id, type } = req.body || {};
  if (!employee_id || !['in', 'out'].includes(type)) {
    return res.status(400).json({ error: 'بيانات غير صحيحة' });
  }
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
  if (!emp) return res.status(404).json({ error: 'الموظف غير موجود' });

  const id = newId('att');
  db.prepare(
    'INSERT INTO attendance (id, employee_id, employee_name, type, ts) VALUES (?, ?, ?, ?, ?)'
  ).run(id, employee_id, emp.name, type, Date.now());
  res.json({ ok: true, id });
});

app.get('/api/attendance', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM attendance ORDER BY ts DESC LIMIT 200').all());
});

// ===================== نظام إدارة العملاء CRM =====================

app.get('/api/customers', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all());
});

app.post('/api/customers', requireAuth, (req, res) => {
  const { name, phone, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'اسم العميل مطلوب' });
  const id = newId('cust');
  db.prepare(
    'INSERT INTO customers (id, name, phone, notes, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, phone || '', notes || '', Date.now());
  res.json({ ok: true, id });
});

app.patch('/api/customers/:id', requireAuth, (req, res) => {
  const { notes } = req.body || {};
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'غير موجود' });
  db.prepare('UPDATE customers SET notes = ? WHERE id = ?').run(notes ?? existing.notes, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/customers/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ===================== نظام الأمن والمراقبة (سجل أحداث) =====================

app.get('/api/security-logs', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM security_logs ORDER BY created_at DESC LIMIT 200').all());
});

app.post('/api/security-logs', requireAuth, (req, res) => {
  const { note, severity } = req.body || {};
  if (!note) return res.status(400).json({ error: 'الملاحظة مطلوبة' });
  const id = newId('sec');
  db.prepare(
    'INSERT INTO security_logs (id, note, severity, created_at) VALUES (?, ?, ?, ?)'
  ).run(id, note, severity || 'info', Date.now());
  res.json({ ok: true, id });
});

app.delete('/api/security-logs/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM security_logs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ===================== تخطيط الموارد ERP (حركات مالية مبسطة) =====================

app.get('/api/finance', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM finance_entries ORDER BY created_at DESC LIMIT 200').all();
  const income = rows.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
  const expense = rows.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
  res.json({ entries: rows, summary: { income, expense, net: income - expense } });
});

app.post('/api/finance', requireAuth, (req, res) => {
  const { type, description, amount } = req.body || {};
  if (!['income', 'expense'].includes(type) || !description || amount === undefined) {
    return res.status(400).json({ error: 'بيانات غير مكتملة' });
  }
  const id = newId('fin');
  db.prepare(
    'INSERT INTO finance_entries (id, type, description, amount, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, type, description, Number(amount), Date.now());
  res.json({ ok: true, id });
});

app.delete('/api/finance/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM finance_entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ سيرفر دكة للتقنية شغّال على المنفذ ${PORT}`);
  console.log(`   افتح: http://localhost:${PORT}`);
});
