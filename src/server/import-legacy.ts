/**
 * 旧システム（スプレッドシート）からの移行取り込み。
 *   npx tsx src/server/import-legacy.ts --staff staff.csv --locations locations.csv --attendance attendance.csv [--dry-run]
 * - 旧 id は legacy_id に保持。再実行しても重複しない（legacy_id で上書き）
 * - 計算値（work_minutes / night_minutes 等）は旧の保存値をそのまま使う（再計算しない＝CSV検算のため）
 * - pin_hash（ソルトなし SHA-256）は pin_hash_legacy に入れ、初回ログイン成功時に新方式へ移行
 * - 旧 staff_comment は legacy_comment に保持（CSV「スタッフコメント」は旧と同一文字列になる）
 * - 事業所の GH フラグは旧ルールから初期化（名前に GH を含む→手当・まかない、GH で始まる→GH休憩ルール）。移行後に管理画面で確認すること
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { migrate, closeDb, tx, q, one } from './db.js';
import { padEmpId, stripSpaces, toMin, addDays, jstToMs, isValidDate } from '../calc/index.js';

export function parseCsv(text: string): Array<Record<string, string>> {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cur.push(cell); cell = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || cur.length) { cur.push(cell); rows.push(cur); }
  const header = (rows.shift() ?? []).map((h) => h.trim());
  return rows.filter((r) => r.some((v) => v !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** '2026/5/1' '2026-05-01' '2026-05-01T00:00:00.000Z'（JST日付）→ 'YYYY-MM-DD' */
export function normDate(v: string): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    // タイムゾーン付きの日時（JS の toISOString 等）→ JST の日付
    const t = Date.parse(s);
    if (!Number.isNaN(t)) { const j = new Date(t + 9 * 3600e3); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}`; }
  }
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) { const d = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`; return isValidDate(d) ? d : null; }
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) { const d = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`; return isValidDate(d) ? d : null; }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) { const j = new Date(t + 9 * 3600e3); return `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}`; }
  return null;
}
/** '9:00' '09:00:00' '1899-12-30T00:00:00.000Z'（シートが Date 化した時刻）→ 'HH:MM' */
export function normTime(v: string): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) { const h = Number(m[1]); const mi = Number(m[2]); return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null; }
  m = s.match(/T(\d{2}):(\d{2})/);
  if (m) {
    // Sheets の Date 化（1899-12-30 基点・JST）。UTC 表記なら +9h
    const t = Date.parse(s);
    if (!Number.isNaN(t)) { const j = new Date(t + 9 * 3600e3); return `${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}`; }
    return `${m[1]}:${m[2]}`;
  }
  return null;
}
const numOrNull = (v: string) => { const s = String(v ?? '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const boolOf = (v: string) => /^(true|1|yes|はい)$/i.test(String(v ?? '').trim());
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const tsOrNull = (v: string) => { const s = String(v ?? '').trim(); if (!s) return null; const n = Number(s); const t = Number.isFinite(n) && s.length >= 12 ? n : Date.parse(s); return Number.isNaN(t) ? null : new Date(t); };

export interface ImportReport { staff: number; locations: number; attendance: number; skipped: Array<{ id: string; reason: string }>; warnings: string[] }

export async function importLegacy(files: { staff?: string; locations?: string; attendance?: string }, dryRun = false): Promise<ImportReport> {
  const report: ImportReport = { staff: 0, locations: 0, attendance: 0, skipped: [], warnings: [] };
  const staffRows = files.staff ? parseCsv(await readFile(files.staff, 'utf8')) : [];
  const locRows = files.locations ? parseCsv(await readFile(files.locations, 'utf8')) : [];
  const attRows = files.attendance ? parseCsv(await readFile(files.attendance, 'utf8')) : [];

  await tx(async (c) => {
    // ---- locations ----
    for (const r of locRows) {
      const code = r['location_code'];
      const name = r['location_name'];
      if (!code || !name) { report.skipped.push({ id: r['id'] ?? '', reason: '事業所コードまたは名前が空' }); continue; }
      const dep = r['department'] || '（未設定）';
      if (!r['department']) report.warnings.push(`事業所 ${name}：事業部が空のため「（未設定）」にしました。管理画面で直してください`);
      await c.query(
        `INSERT INTO locations (location_code, location_name, department, sort_order, active, check_alcohol, gh_extras, gh_break_rule, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (location_code) DO UPDATE SET location_name = EXCLUDED.location_name, department = EXCLUDED.department, sort_order = EXCLUDED.sort_order, active = EXCLUDED.active, check_alcohol = EXCLUDED.check_alcohol, deleted_at = EXCLUDED.deleted_at, updated_at = now()`,
        [code, name, dep, numOrNull(r['sort_order'] ?? '') ?? 0, r['active'] === '' ? true : boolOf(r['active'] ?? ''), boolOf(r['check_alcohol'] ?? ''), name.includes('GH'), name.trim().startsWith('GH'), boolOf(r['_deleted'] ?? '') ? new Date() : null]);
      report.locations++;
    }
    // ---- staff ----
    const staffIdMap: Record<string, string> = {};
    for (const r of staffRows) {
      const legacyId = r['id'] ?? '';
      const name = stripSpaces(r['staff_name']);
      if (!legacyId || !name) { report.skipped.push({ id: legacyId, reason: 'スタッフ id または氏名が空' }); continue; }
      const existing = await one<{ id: string }>('SELECT id FROM staff WHERE legacy_id = $1', [legacyId], c);
      const newId = existing?.id ?? (isUuid(legacyId) ? legacyId : randomUUID());
      const pin = (r['pin_hash'] ?? '').trim();
      await c.query(
        `INSERT INTO staff (id, legacy_id, employee_id, staff_name, staff_kana, pin_hash_legacy, email, active, deleted_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, now()))
         ON CONFLICT (legacy_id) DO UPDATE SET employee_id = EXCLUDED.employee_id, staff_name = EXCLUDED.staff_name, staff_kana = EXCLUDED.staff_kana, email = EXCLUDED.email, active = EXCLUDED.active, deleted_at = EXCLUDED.deleted_at,
           pin_hash_legacy = CASE WHEN staff.pin_hash IS NULL THEN EXCLUDED.pin_hash_legacy ELSE staff.pin_hash_legacy END, updated_at = now()`,
        [newId, legacyId, padEmpId(r['employee_id']) || null, name, stripSpaces(r['staff_kana']), /^[0-9a-f]{64}$/i.test(pin) ? pin.toLowerCase() : null, r['email'] || null,
          r['active'] === '' ? true : boolOf(r['active'] ?? ''), boolOf(r['_deleted'] ?? '') ? new Date() : null, tsOrNull(r['created_at'] ?? '')]);
      staffIdMap[legacyId] = newId;
      report.staff++;
    }
    // 既存（以前の取り込み）の対応表も読む
    for (const s of await q<{ id: string; legacy_id: string }>('SELECT id, legacy_id FROM staff WHERE legacy_id IS NOT NULL', [], c)) staffIdMap[s.legacy_id] = s.id;
    const locMap: Record<string, { location_name: string; department: string }> = {};
    for (const l of await q<{ location_code: string; location_name: string; department: string }>('SELECT location_code, location_name, department FROM locations', [], c)) locMap[l.location_code] = l;

    // ---- attendance ----
    const statusOk = new Set(['WORKING', 'OVERDUE', 'DONE', 'PAID_LEAVE', 'PAID_LEAVE_AM', 'PAID_LEAVE_PM']);
    for (const r of attRows) {
      const legacyId = r['id'] ?? '';
      if (!legacyId) { report.skipped.push({ id: '', reason: 'id が空' }); continue; }
      const workDate = normDate(r['work_date'] ?? '');
      if (!workDate) { report.skipped.push({ id: legacyId, reason: `work_date を読めない: ${r['work_date']}` }); continue; }
      const status = (r['status'] ?? '').trim().toUpperCase();
      if (!statusOk.has(status)) { report.skipped.push({ id: legacyId, reason: `status が不明: ${r['status']}` }); continue; }
      const staffName = stripSpaces(r['staff_name']) || '不明';
      let staffId = staffIdMap[r['staff_id'] ?? ''];
      if (!staffId) {
        // 名簿に無い staff_id：氏名で探し、無ければ無効スタッフとして作る
        const byName = await one<{ id: string }>('SELECT id FROM staff WHERE staff_name = $1 ORDER BY (deleted_at IS NULL) DESC LIMIT 1', [staffName], c);
        if (byName) staffId = byName.id;
        else {
          const created = await one<{ id: string }>('INSERT INTO staff (legacy_id, employee_id, staff_name, staff_kana, active) VALUES ($1,$2,$3,$4,false) RETURNING id', [r['staff_id'] ? `missing:${r['staff_id']}` : `missing:${legacyId}`, padEmpId(r['employee_id']) || null, staffName, ''], c);
          staffId = created!.id;
          report.warnings.push(`勤怠 ${legacyId}：staff_id ${r['staff_id']} が名簿に無いため、無効スタッフ「${staffName}」を作成しました`);
        }
        if (r['staff_id']) staffIdMap[r['staff_id']] = staffId;
      }
      const isLeave = status.startsWith('PAID_LEAVE');
      let clockInAt: Date | null = null;
      let clockOutAt: Date | null = null;
      if (!isLeave) {
        const ci = normTime(r['clock_in'] ?? '');
        if (!ci) { report.skipped.push({ id: legacyId, reason: `clock_in を読めない: ${r['clock_in']}` }); continue; }
        clockInAt = new Date(jstToMs(workDate, ci)!);
        const co = normTime(r['clock_out'] ?? '');
        if (co) {
          let coDate = normDate(r['clock_out_date'] ?? '');
          if (!coDate) coDate = toMin(co)! < toMin(ci)! ? addDays(workDate, 1) : workDate;
          clockOutAt = new Date(jstToMs(coDate, co)!);
        } else if (status === 'DONE') {
          report.warnings.push(`勤怠 ${legacyId}（${staffName} ${workDate}）：DONE なのに退勤時刻が空です`);
        }
      }
      const loc = r['location_code'] ? locMap[r['location_code']] : undefined;
      const leaveType = status === 'PAID_LEAVE_AM' ? 'am' : status === 'PAID_LEAVE_PM' ? 'pm' : isLeave ? 'full' : null;
      const comment = (r['staff_comment'] ?? '').trim() || null;
      const deleted = boolOf(r['_deleted'] ?? '');
      await c.query('SAVEPOINT row_sp');
      try {
      await c.query(
        `INSERT INTO attendance (legacy_id, work_date, staff_id, employee_id, staff_name, location_code, location_name, department, clock_in_at, clock_out_at,
           break_minutes, night_break_minutes, work_minutes, night_minutes, travel_km, travel_fee, allowance_amount, allowance_note, meal_count, meal_fee, alcohol_check,
           status, leave_type, leave_days, leave_reason, staff_comment, legacy_comment, correction_reason, stamped_in_at, stamped_out_at, created_at, updated_at, updated_by, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,COALESCE($31, now()),COALESCE($32, now()),'import',$33)
         ON CONFLICT (legacy_id) DO UPDATE SET work_date = EXCLUDED.work_date, staff_id = EXCLUDED.staff_id, employee_id = EXCLUDED.employee_id, staff_name = EXCLUDED.staff_name,
           location_code = EXCLUDED.location_code, location_name = EXCLUDED.location_name, department = EXCLUDED.department, clock_in_at = EXCLUDED.clock_in_at, clock_out_at = EXCLUDED.clock_out_at,
           break_minutes = EXCLUDED.break_minutes, night_break_minutes = EXCLUDED.night_break_minutes, work_minutes = EXCLUDED.work_minutes, night_minutes = EXCLUDED.night_minutes,
           travel_km = EXCLUDED.travel_km, travel_fee = EXCLUDED.travel_fee, allowance_amount = EXCLUDED.allowance_amount, allowance_note = EXCLUDED.allowance_note, meal_count = EXCLUDED.meal_count, meal_fee = EXCLUDED.meal_fee,
           alcohol_check = EXCLUDED.alcohol_check, status = EXCLUDED.status, leave_type = EXCLUDED.leave_type, leave_days = EXCLUDED.leave_days, leave_reason = EXCLUDED.leave_reason,
           staff_comment = EXCLUDED.staff_comment, legacy_comment = EXCLUDED.legacy_comment, correction_reason = EXCLUDED.correction_reason, deleted_at = EXCLUDED.deleted_at, updated_at = now(), updated_by = 'import'`,
        [legacyId, workDate, staffId, padEmpId(r['employee_id']) || null, staffName, r['location_code'] || null, r['location_name'] || loc?.location_name || null, r['department'] || loc?.department || null, clockInAt, clockOutAt,
          Math.round(numOrNull(r['break_minutes'] ?? '') ?? 0), Math.round(numOrNull(r['night_break_minutes'] ?? '') ?? 0), isLeave ? null : numOrNull(r['work_minutes'] ?? ''), isLeave ? null : numOrNull(r['night_minutes'] ?? ''),
          numOrNull(r['travel_km'] ?? '') ?? 0, Math.round(numOrNull(r['travel_fee'] ?? '') ?? 0), Math.round(numOrNull(r['allowance_amount'] ?? '') ?? 0), r['allowance_note'] || null,
          Math.round((numOrNull(r['meal_fee'] ?? '') ?? 0) / 250), Math.round(numOrNull(r['meal_fee'] ?? '') ?? 0), r['alcohol_check'] || r['photo_url'] || null,
          status, leaveType, isLeave ? (numOrNull(r['leave_days'] ?? '') ?? (status === 'PAID_LEAVE' ? 1 : 0.5)) : null, r['leave_reason'] || null, comment, comment, r['correction_reason'] || null,
          tsOrNull(r['stamped_in_at'] ?? ''), tsOrNull(r['stamped_out_at'] ?? ''), tsOrNull(r['created_at'] ?? ''), tsOrNull(r['updated_at'] ?? ''), deleted ? (tsOrNull(r['updated_at'] ?? '') ?? new Date()) : null]);
      await c.query('RELEASE SAVEPOINT row_sp');
      report.attendance++;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT row_sp');
        const code = (e as { code?: string }).code;
        const why = code === '23505'
          ? `同じスタッフの未退勤（勤務中・退勤忘れ）が2件以上、または同じ日の有給が2件以上あります（${staffName} ${workDate}）。旧データを直してから再実行してください`
          : `DB エラー: ${String((e as Error).message).slice(0, 160)}`;
        report.skipped.push({ id: legacyId, reason: why });
      }
    }
    if (dryRun) throw new DryRun();
  }).catch((e) => { if (!(e instanceof DryRun)) throw e; });
  return report;
}
class DryRun extends Error {}

// ---- CLI ----
if (process.argv[1] && /import-legacy\.(ts|js)$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const dry = args.includes('--dry-run');
  await migrate();
  const rep = await importLegacy({ staff: opt('staff'), locations: opt('locations'), attendance: opt('attendance') }, dry);
  console.log(`${dry ? '【確認のみ・保存していません】' : '【取り込み完了】'} 事業所 ${rep.locations} / スタッフ ${rep.staff} / 勤怠 ${rep.attendance}`);
  if (rep.skipped.length) { console.log(`スキップ ${rep.skipped.length}件：`); for (const s of rep.skipped.slice(0, 50)) console.log(`  ${s.id}: ${s.reason}`); }
  if (rep.warnings.length) { console.log(`注意 ${rep.warnings.length}件：`); for (const w of rep.warnings.slice(0, 50)) console.log(`  ${w}`); }
  await closeDb();
}
