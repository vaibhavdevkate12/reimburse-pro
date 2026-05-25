"use server";

import db from "@/lib/db";
import { revalidatePath } from "next/cache";
import fs from "fs";
import path from "path";

export async function getExpenses() {
  const expenses = db.prepare('SELECT * FROM expenses ORDER BY date DESC').all() as any[];
  
  const results = expenses.map(exp => {
    const items = db.prepare('SELECT * FROM expense_items WHERE expense_id = ?').all(String(exp.id));
    return { ...exp, items };
  });
  
  return results;
}

export async function submitExpense(formData: FormData) {
  const name = formData.get('name') as string;
  const department = formData.get('department') as string;
  const itemJSON = formData.get('items') as string;
  const itemsMetadata = JSON.parse(itemJSON);
  const date = new Date().toISOString().split('T')[0];
  
  // Ensure proofs directory exists
  const proofsDir = path.join(process.cwd(), 'public', 'data', 'proofs');
  if (!fs.existsSync(proofsDir)) {
    fs.mkdirSync(proofsDir, { recursive: true });
  }

  let newId: number | bigint = 0;

  const transaction = db.transaction(() => {
    const info = db.prepare('INSERT INTO expenses (date, name, department, status) VALUES (?, ?, ?, ?)')
      .run(date, name, department, 'Pending');
    
    newId = info.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO expense_items (expense_id, category, amount, description, proof_path, payment_method, reference_no) VALUES (?, ?, ?, ?, ?, ?, ?)');

    for (let i = 0; i < itemsMetadata.length; i++) {
      const item = itemsMetadata[i];
      const file = formData.get(`proof_${i}`) as File;
      let proofPath = "";
      
      // We will handle file saving after the transaction if needed, 
      // but for simplicity here we assume synchronous save or path generation
      if (file && file.size > 0) {
        const fileExt = path.extname(file.name) || '.pdf';
        const fileName = `${newId}_${i}${fileExt}`;
        const filePath = path.join(proofsDir, fileName);
        
        // This is a bit risky in a transaction but acceptable for local-first small app
        // Alternatively, use a placeholder path and update later
        proofPath = `/data/proofs/${fileName}`;
      }
      
      insertItem.run(String(newId), item.category, item.amount, item.description, proofPath, item.paymentMethod || null, item.referenceNo || null);
    }
  });

  transaction();

  // Save files after transaction commit to be safe
  for (let i = 0; i < itemsMetadata.length; i++) {
    const file = formData.get(`proof_${i}`) as File;
    if (file && file.size > 0) {
      const fileExt = path.extname(file.name) || '.pdf';
      const fileName = `${newId}_${i}${fileExt}`;
      const filePath = path.join(proofsDir, fileName);
      const arrayBuffer = await file.arrayBuffer();
      fs.writeFileSync(filePath, Buffer.from(arrayBuffer));
    }
  }

  revalidatePath('/');
  revalidatePath('/submit');
  return { success: true, id: newId.toString() };
}

export async function updateExpenseStatus(id: string | number, status: string) {
  db.prepare('UPDATE expenses SET status = ? WHERE id = ?').run(status, id);
  revalidatePath('/');
  return { success: true };
}
