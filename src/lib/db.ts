import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';

const dbPath = path.join(process.cwd(), 'expenses.db');
const db = new Database(dbPath);

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    status TEXT DEFAULT 'Pending',
    sync_hash TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_sync_hash ON expenses(sync_hash);

  -- Set auto-increment starting value for both tables
  INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES ('expenses', 300);
  INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES ('reimbursements', 300);

  CREATE TABLE IF NOT EXISTS expense_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    proof_path TEXT,
    payment_method TEXT,
    reference_no TEXT,
    FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reimbursements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_hash TEXT UNIQUE,
    employee_name TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    receipt_url TEXT,
    local_file_path TEXT,
    status TEXT DEFAULT 'NEW',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Set auto-increment starting value to 1000
  INSERT OR IGNORE INTO sqlite_sequence (name, seq) VALUES ('reimbursements', 999);

  CREATE TABLE IF NOT EXISTS sync_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    records_imported INTEGER,
    status TEXT,
    error_message TEXT
  );
`);

// Alter table to add sync_hash if it doesn't exist
try {
  db.exec("ALTER TABLE expenses ADD COLUMN sync_hash TEXT;");
} catch (e) {
  // Column already exists or table doesn't exist yet
}
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_sync_hash ON expenses(sync_hash);");
} catch (e) {
  // Index already exists
}
try {
  db.exec("ALTER TABLE expense_items ADD COLUMN payment_method TEXT;");
} catch (e) {
  // Column already exists
}
try {
  db.exec("ALTER TABLE expense_items ADD COLUMN reference_no TEXT;");
} catch (e) {
  // Column already exists
}

// Run the migration from reimbursements to expenses/expense_items
const migrateOldReimbursements = () => {
  try {
    // Check if reimbursements table exists
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reimbursements'").get();
    if (!tableExists) return;

    // Check if reimbursements table has any rows
    const countRow = db.prepare("SELECT count(*) as count FROM reimbursements").get() as any;
    if (!countRow || countRow.count === 0) return;

    console.log(`[Migration] Found ${countRow.count} old reimbursements. Migrating to expenses table...`);

    const oldRems = db.prepare("SELECT * FROM reimbursements").all() as any[];
    const groups: { [key: string]: any[] } = {};

    for (const rem of oldRems) {
      let timestampKey = '';
      if (rem.local_file_path) {
        const match = rem.local_file_path.match(/_item\d_(.+)\.[^.]+$/);
        if (match) {
          timestampKey = match[1];
        }
      }
      if (!timestampKey) {
        timestampKey = rem.created_at ? rem.created_at.substring(0, 16).replace(/[- :]/g, '_') : 'unknown';
      }
      const groupKey = `${rem.employee_name}-${rem.employee_id}-${timestampKey}`;
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(rem);
    }

    const insertExpense = db.prepare(`
      INSERT INTO expenses (date, name, department, status, sync_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO expense_items (expense_id, category, amount, description, proof_path)
      VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
      for (const [groupKey, items] of Object.entries(groups)) {
        const firstItem = items[0];
        
        let dateVal = firstItem.created_at ? firstItem.created_at.split(' ')[0] : new Date().toISOString().split('T')[0];
        let sheetTimestamp = '';
        
        if (firstItem.local_file_path) {
          const match = firstItem.local_file_path.match(/_item\d_(.+)\.[^.]+$/);
          if (match) {
            const parts = match[1].split('_');
            if (parts.length >= 6) {
              sheetTimestamp = `${parts[0]}/${parts[1]}/${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`;
              dateVal = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }
          }
        }
        
        if (!sheetTimestamp) {
          sheetTimestamp = firstItem.created_at;
        }

        const rowSyncHash = crypto.createHash('md5')
          .update(`${sheetTimestamp}-${firstItem.employee_id}`)
          .digest('hex');

        const statusVal = firstItem.status === 'PROCESSED' ? 'Pending' : firstItem.status;

        // Skip if this row has already been migrated or imported
        const existingRow = db.prepare('SELECT id FROM expenses WHERE sync_hash = ?').get(rowSyncHash);
        if (existingRow) continue;

        const info = insertExpense.run(dateVal, firstItem.employee_name, firstItem.employee_id, statusVal, rowSyncHash);
        const expenseId = info.lastInsertRowid;

        for (const item of items) {
          insertItem.run(expenseId.toString(), 'Reimbursement', item.amount, item.description, item.local_file_path);
        }
      }

      // Clear the reimbursements table so we don't migrate again
      db.prepare("DELETE FROM reimbursements").run();
    });

    transaction();
    console.log('[Migration] Migration completed successfully.');
  } catch (err) {
    console.error('[Migration] Migration failed:', err);
  }
};

migrateOldReimbursements();

import { initCron } from './cron';
if (process.env.NODE_ENV !== 'test') {
  initCron();
}

export default db;
