/** CLI: npm run migrate */
import { migrate, closeDb } from './db.js';

const applied = await migrate();
console.log(applied.length ? `適用: ${applied.join(', ')}` : '適用するマイグレーションはありません');
await closeDb();
