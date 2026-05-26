import { createClient } from "@libsql/client";
import dotenv from "dotenv";
dotenv.config();

const url = process.env.TURSO_DB_URL;
const authToken = process.env.TURSO_DB_TOKEN;

const db = createClient({
  url,
  authToken,
});

async function run() {
  try {
    await db.execute("ALTER TABLE expenses ADD COLUMN receipt_no INTEGER");
    console.log("Column added successfully");
  } catch (e) {
    if (e.message.includes("duplicate column name")) {
      console.log("Column already exists");
    } else {
      console.error(e);
    }
  }
}
run();
