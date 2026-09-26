import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DATE型を 'YYYY-MM-DD' の文字列のまま扱う
pg.types.setTypeParser(1082, (v) => v);

const url = process.env.DATABASE_URL || '';
const useSSL = process.env.PGSSL === 'false' || url.includes('.railway.internal') || url.includes('localhost')
  ? false
  : { rejectUnauthorized: false };

export const pool = new pg.Pool({ connectionString: url, ssl: useSSL });

export async function migrate() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  await pool.query(sql);
}
