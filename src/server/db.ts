/**
 * PostgreSQL 接続とマイグレーション。
 * 型の原則：date → 'YYYY-MM-DD' 文字列、numeric → number、timestamptz → Date。
 */
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// date 型はタイムゾーンで日付がずれないよう文字列のまま受け取る
pg.types.setTypeParser(1082, (v: string) => v);
// numeric → number（金額・km は小さい値なので安全）
pg.types.setTypeParser(1700, (v: string) => Number(v));
// int8 → number
pg.types.setTypeParser(20, (v: string) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Queryable = pg.Pool | pg.PoolClient;

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], client: Queryable = pool): Promise<T[]> {
  const r = await client.query<T>(text, params);
  return r.rows;
}
export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], client: Queryable = pool): Promise<T | null> {
  const rows = await q<T>(text, params, client);
  return rows[0] ?? null;
}

/** トランザクション。コールバックが投げたらロールバック */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

/** migrations/*.sql を名前順に1回ずつ適用する */
export async function migrate(dir = path.resolve('migrations')): Promise<string[]> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await q<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
