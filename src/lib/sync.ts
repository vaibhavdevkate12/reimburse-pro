import { sheets, drive, GOOGLE_SHEET_ID } from './google';
import db from './db';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

const SHEET_NAME = 'Form Responses 1';
const RECEIPTS_DIR = path.join(process.cwd(), 'public', 'receipts');

// Ensure receipts directory exists
fs.ensureDirSync(RECEIPTS_DIR);

function getFileIdFromUrl(url: string): string | null {
  if (!url) return null;
  // Google Form uploads often have multiple URLs separated by commas
  const firstUrl = url.split(',')[0].trim();
  // Regex to extract ID from various Drive URL formats
  const match = firstUrl.match(/(?:id=|\/d\/|docs\.google\.com\/.*?\/)([-\w]{25,})/);
  return match ? match[1] : null;
}

async function getDriveFileMetadata(fileId: string) {
  const metadata = await drive.files.get({ fileId, fields: 'id, name, mimeType' });
  return metadata.data;
}

async function downloadDriveFile(fileId: string, mimeType: string, destPath: string) {
  let response;
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    // It's a Google Doc/Sheet/etc. - must use export
    console.log(`[Sync] Exporting Google Doc type (${mimeType}) to PDF...`);
    response = await drive.files.export(
      { fileId, mimeType: 'application/pdf' },
      { responseType: 'stream' }
    );
  } else {
    // It's a binary file (JPG, PDF, etc.)
    response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
  }
  
  return new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(destPath);
    response.data
      .on('end', () => resolve(true))
      .on('error', (err) => reject(err))
      .pipe(dest);
  });
}

function formatSheetDate(dateStr: string, timestampStr: string): string {
  const source = dateStr || timestampStr || '';
  if (!source) return new Date().toISOString().split('T')[0];

  // Try to parse DD/MM/YYYY or YYYY-MM-DD
  const datePart = source.split(' ')[0].trim();
  if (datePart.includes('/')) {
    const parts = datePart.split('/');
    if (parts.length === 3) {
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      const month = parts[1].padStart(2, '0');
      const day = parts[0].padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } else if (datePart.includes('-')) {
    const parts = datePart.split('-');
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        return datePart; // already YYYY-MM-DD
      } else {
        const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
        const month = parts[1].padStart(2, '0');
        const day = parts[0].padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }
  }
  return datePart || new Date().toISOString().split('T')[0];
}

export async function syncReimbursements() {
  if (!GOOGLE_SHEET_ID) {
    throw new Error('GOOGLE_SHEET_ID is not defined');
  }

  let importedCount = 0;
  const errors: string[] = [];

  try {
    // 1. Fetch data from Google Sheets (Expanding range to A:Z to catch all items)
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${SHEET_NAME}!A:Z`, 
    });

    const rows = response.data.values;
    console.log('[Sync] Fetched rows count:', rows?.length || 0);
    
    if (!rows || rows.length <= 1) {
      console.log('[Sync] No data or only headers found.');
      return { importedCount: 0, errors: ['No data found or only header row exists'] };
    }

    const headers = rows[0];
    console.log('[Sync] Sheet Headers:', headers);

    const getCol = (name: string) => headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));

    const globalCols = {
      timestamp: getCol('Timestamp'),
      name: getCol('Employee Name'),
      id: getCol('Employee ID'),
      dateOfPayment: getCol('Date of Payment'),
      purpose: getCol('Payment For'),
    };

    console.log('[Sync] Global Column Mapping:', globalCols);
    
    // Debug: Print indices for all items
    for (let j = 1; j <= 3; j++) {
      console.log(`[Sync] Item ${j} Mapping:`, {
        amount: getCol(`Amount (Item ${j})`),
        description: getCol(`Description (Item ${j})`),
        receipt: getCol(`Upload Receipt (Item ${j})`)
      });
    }

    const dataRows = rows.slice(1);

    for (let i = 0; i < dataRows.length; i++) {
      const rowIndex = i + 2;
      const row = dataRows[i];

      console.log(`\n--- [DEBUG] RAW DATA FOR ROW ${rowIndex} ---`);
      console.log(JSON.stringify(row, null, 2));
      console.log('-------------------------------------------\n');
      
      const timestamp = row[globalCols.timestamp] || '';
      const employeeName = row[globalCols.name] || 'Unknown';
      const employeeId = row[globalCols.id] || 'no-id';

      // Unique ID for row-level idempotency: hash of timestamp + employeeId
      const rowSyncHash = crypto.createHash('md5')
        .update(`${timestamp}-${employeeId}`)
        .digest('hex');

      const categoryVal = row[globalCols.purpose] || 'Reimbursement';

      // Check if already exists in local DB
      const existing = db.prepare('SELECT id FROM expenses WHERE sync_hash = ?').get(rowSyncHash) as { id: number } | undefined;
      if (existing) {
        db.prepare('UPDATE expense_items SET category = ? WHERE expense_id = ?').run(categoryVal, String(existing.id));
        continue;
      }

      const itemsToInsert: { category: string; amount: number; description: string; localFilePath: string; paymentMethod: string; referenceNo: string }[] = [];

      // Process up to 3 items per row
      for (let itemIdx = 1; itemIdx <= 3; itemIdx++) {
        const amtCol = getCol(`Amount (Item ${itemIdx})`);
        const descCol = getCol(`Description (Item ${itemIdx})`);
        const receiptCol = getCol(`Upload Receipt (Item ${itemIdx})`);
        const paymentMethodCol = getCol(`Payment Method (Item ${itemIdx})`);
        const referenceNoCol = getCol(`Reference No (Item ${itemIdx})`);
        // Try alternate column name with leading dot (some sheets have '. Description')
        const altDescCol = getCol(`. Description (Item ${itemIdx})`);

        if (amtCol === -1 || !row[amtCol]) continue;

        const amount = parseFloat(row[amtCol].toString().replace(/[^0-9.]/g, ''));
        if (isNaN(amount) || amount <= 0) continue;

        const description = row[descCol] || row[altDescCol] || row[globalCols.purpose] || 'Reimbursement';
        const paymentMethod = (paymentMethodCol !== -1 ? row[paymentMethodCol] : '') || '';
        const referenceNo = (referenceNoCol !== -1 ? row[referenceNoCol] : '') || '';
        const receiptUrl = row[receiptCol] || '';

        console.log(`[Sync] Row ${rowIndex} Item ${itemIdx} Raw Receipt URL: "${receiptUrl}"`);

        let localFilePath = '';
        const fileId = getFileIdFromUrl(receiptUrl);

        if (fileId) {
          try {
            const metadata = await getDriveFileMetadata(fileId);
            const mimeType = metadata.mimeType || '';
            
            let extension = '.jpg'; // default
            if (mimeType === 'application/pdf' || mimeType.startsWith('application/vnd.google-apps.')) {
              extension = '.pdf';
            } else if (mimeType === 'image/png') {
              extension = '.png';
            } else if (mimeType === 'image/webp') {
              extension = '.webp';
            }

            const safeTimestamp = timestamp.replace(/[:/ ]/g, '_') || Date.now().toString();
            const fileName = `${employeeId}_item${itemIdx}_${safeTimestamp}${extension}`;
            localFilePath = `/receipts/${fileName}`;
            const fullPath = path.join(RECEIPTS_DIR, fileName);
            
            console.log(`[Sync] Attempting download for File ID: ${fileId} (Mime: ${mimeType})`);
            await downloadDriveFile(fileId, mimeType, fullPath);
            console.log(`[Sync] Successfully saved: ${localFilePath}`);
          } catch (err: unknown) {
            console.error(`[Sync] Failed download for Row ${rowIndex} Item ${itemIdx}:`, err instanceof Error ? err.message : String(err));
          }
        } else if (receiptUrl) {
          console.warn(`[Sync] Could not extract File ID from URL: ${receiptUrl}`);
        }

        itemsToInsert.push({
          category: categoryVal,
          amount,
          description,
          localFilePath,
          paymentMethod,
          referenceNo
        });
      }

      // If there are valid items, insert them together in a transaction
      if (itemsToInsert.length > 0) {
        try {
          const dateVal = formatSheetDate(row[globalCols.dateOfPayment], timestamp);

          const transaction = db.transaction(() => {
            const info = db.prepare(`
              INSERT INTO expenses (date, name, department, status, sync_hash)
              VALUES (?, ?, ?, ?, ?)
            `).run(dateVal, employeeName, employeeId, 'Pending', rowSyncHash);

            const expenseId = info.lastInsertRowid;

            const insertItem = db.prepare(`
              INSERT INTO expense_items (expense_id, category, amount, description, proof_path, payment_method, reference_no)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);

            for (const item of itemsToInsert) {
              insertItem.run(expenseId.toString(), item.category, item.amount, item.description, item.localFilePath, item.paymentMethod, item.referenceNo);
            }
          });

          transaction();
          importedCount++;
          console.log(`[Sync] Imported ${itemsToInsert.length} items for ${employeeName} (Row ${rowIndex})`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[Sync] Database error for Row ${rowIndex}:`, msg);
          errors.push(`Row ${rowIndex}: ${msg}`);
        }
      }
    }

    // Log the sync
    db.prepare('INSERT INTO sync_logs (records_imported, status) VALUES (?, ?)').run(importedCount, errors.length > 0 ? 'PARTIAL' : 'SUCCESS');

    return { importedCount, errors };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Sync failed:', err);
    db.prepare('INSERT INTO sync_logs (records_imported, status, error_message) VALUES (?, ?, ?)')
      .run(0, 'FAILED', msg);
    throw err;
  }
}
