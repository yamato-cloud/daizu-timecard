/**
 * 日次バックアップ：pg_dump（カスタム形式）＋ 主要テーブルの CSV（Excel で開ける BOM付き）。
 * 保持日数を超えた古いバックアップは削除。Google スプレッドシートへの出力は sheets-export.ts（任意）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { q } from '../db.js';
import { getNumberSetting } from '../settings.js';
import { toCsvString, msToJst } from '../../calc/index.js';
import { exportToSheets, sheetsConfigured } from './sheets-export.js';

const run = promisify(execFile);

const CSV_TABLES: Record<string, string> = {
  attendance: `SELECT id, legacy_id, work_date::text, staff_id, employee_id, staff_name, location_code, location_name, department,
      to_char(clock_in_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS clock_in, to_char(clock_out_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') AS clock_out,
      break_minutes, night_break_minutes, work_minutes, night_minutes, travel_km, travel_fee, allowance_amount, allowance_note, meal_count, meal_fee, alcohol_check,
      status, leave_type, leave_days, leave_reason, staff_comment, correction_reason, break_reason, gh_break_reason, stamp_warning_reason, break_excess_reason, break_mismatch_reason, legacy_comment,
      to_char(created_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') AS created_at, to_char(updated_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') AS updated_at, updated_by,
      to_char(deleted_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI:SS') AS deleted_at
     FROM attendance ORDER BY work_date, clock_in_at`,
  staff: `SELECT id, legacy_id, employee_id, staff_name, staff_kana, active, (pin_hash IS NOT NULL OR pin_hash_legacy IS NOT NULL) AS has_pin, email, created_at, updated_at, deleted_at FROM staff ORDER BY staff_kana, staff_name`,
  locations: `SELECT id, location_code, location_name, department, sort_order, active, check_alcohol, gh_extras, gh_break_rule, created_at, updated_at, deleted_at FROM locations ORDER BY sort_order`,
  settings: `SELECT key, CASE WHEN key LIKE '%hash%' THEN '(非公開)' ELSE value END AS value, updated_at, updated_by FROM settings ORDER BY key`,
  report_recipients: `SELECT * FROM report_recipients ORDER BY email`,
};

export async function exportTablesCsv(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const [table, sql] of Object.entries(CSV_TABLES)) {
    const rows = await q<Record<string, unknown>>(sql);
    const cols = rows.length ? Object.keys(rows[0]!) : [];
    const csv = toCsvString([cols, ...rows.map((r) => cols.map((c) => { const v = r[c]; return v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v); }))]);
    const f = path.join(dir, `${table}.csv`);
    await writeFile(f, csv, 'utf8');
    files.push(f);
  }
  return files;
}

export async function runBackup(): Promise<string> {
  const keepDays = await getNumberSetting('backup_keep_days', 30);
  const stamp = msToJst(Date.now());
  const dir = path.resolve(config.backupDir, `${stamp.date}_${stamp.time.replace(':', '')}`);
  await mkdir(dir, { recursive: true });
  const parts: string[] = [];
  // pg_dump（無ければ CSV のみ）
  try {
    await run('pg_dump', ['--format=custom', '--no-owner', '--file', path.join(dir, 'db.dump'), config.databaseUrl], { timeout: 10 * 60e3 });
    parts.push('pg_dump');
  } catch (e) {
    parts.push(`pg_dump失敗(${String((e as Error).message).slice(0, 80)})`);
  }
  const files = await exportTablesCsv(path.join(dir, 'csv'));
  parts.push(`CSV ${files.length}表`);
  if (sheetsConfigured()) {
    try { parts.push(await exportToSheets()); } catch (e) { parts.push(`スプレッドシート出力失敗(${String((e as Error).message).slice(0, 120)})`); }
  }
  // 古いバックアップの削除
  const root = path.resolve(config.backupDir);
  let removed = 0;
  for (const name of await readdir(root)) {
    const p = path.join(root, name);
    const st = await stat(p).catch(() => null);
    if (!st?.isDirectory()) continue;
    if (Date.now() - st.mtimeMs > keepDays * 24 * 3600e3) { await rm(p, { recursive: true, force: true }); removed++; }
  }
  if (removed) parts.push(`古いバックアップ${removed}件削除`);
  return `${dir} に保存（${parts.join('・')}）`;
}
