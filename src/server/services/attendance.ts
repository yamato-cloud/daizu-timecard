/**
 * 勤怠の業務処理。権限・計算・期限はすべてここ（サーバー）で判定する。
 * 画面はこの結果とエラー理由を表示するだけ。
 */
import type { PoolClient } from 'pg';
import { pool, q, one, tx } from '../db.js';
import { audit, type Actor } from '../audit.js';
import { badRequest, conflict, forbidden, notFound, AppError } from '../errors.js';
import { getNumberSetting } from '../settings.js';
import {
  computeShift, composeStaffComment, msToJst, jstToMs, toMin, isValidDate, addDays,
  selfEditable, selfEditDeadline, isOverdueAt, leaveInfo, SELF_CANCELABLE, isOpenStatus, isLeaveStatus,
  type ShiftOk, type Warning, type WarningKey, type ReasonEntry,
} from '../../calc/index.js';

export interface AttendanceRow {
  id: string; legacy_id: string | null; work_date: string; staff_id: string; employee_id: string | null; staff_name: string;
  location_code: string | null; location_name: string | null; department: string | null;
  clock_in_at: Date | null; clock_out_at: Date | null; break_minutes: number; night_break_minutes: number;
  work_minutes: number | null; night_minutes: number | null; travel_km: number; travel_fee: number;
  allowance_amount: number; allowance_note: string | null; meal_count: number; meal_fee: number; alcohol_check: string | null;
  status: string; leave_type: string | null; leave_days: number | null; leave_reason: string | null;
  staff_comment: string | null; correction_reason: string | null;
  break_reason: string | null; gh_break_reason: string | null; stamp_warning_reason: string | null; break_excess_reason: string | null; break_mismatch_reason: string | null;
  warning_labels: Record<string, string>; legacy_comment: string | null;
  stamped_in_at: Date | null; stamped_out_at: Date | null; created_at: Date; updated_at: Date; updated_by: string | null; deleted_at: Date | null;
}
export interface LocationRow { id: string; location_code: string; location_name: string; department: string; sort_order: number; active: boolean; check_alcohol: boolean; gh_extras: boolean; gh_break_rule: boolean; deleted_at: Date | null }
export interface StaffRow { id: string; employee_id: string | null; staff_name: string; staff_kana: string; pin_hash: string | null; pin_hash_legacy: string | null; email: string | null; active: boolean; pin_fail_count: number; pin_fail_last: Date | null; deleted_at: Date | null }

const REASON_COL: Record<WarningKey, keyof AttendanceRow> = {
  statutory: 'break_reason', gh: 'gh_break_reason', anomaly: 'stamp_warning_reason', excess: 'break_excess_reason', mismatch: 'break_mismatch_reason',
};

/** 画面・CSV向けの表現（JST の日付・時刻文字列、理由連結済みコメント） */
export function presentRow(r: AttendanceRow) {
  const ci = r.clock_in_at ? msToJst(r.clock_in_at.getTime()) : null;
  const co = r.clock_out_at ? msToJst(r.clock_out_at.getTime()) : null;
  const reasons: ReasonEntry[] = (Object.keys(REASON_COL) as WarningKey[])
    .map((k) => ({ key: k, auditLabel: r.warning_labels?.[k] ?? '', reason: String(r[REASON_COL[k]] ?? '') }))
    .filter((x) => x.reason.trim());
  const staff_comment_full = r.legacy_comment ?? composeStaffComment(reasons, r.staff_comment);
  return {
    id: r.id, work_date: r.work_date, staff_id: r.staff_id, employee_id: r.employee_id, staff_name: r.staff_name,
    location_code: r.location_code, location_name: r.location_name, department: r.department,
    clock_in: ci?.time ?? null, clock_out: co?.time ?? null, clock_out_date: co?.date ?? null,
    clock_in_at: r.clock_in_at?.toISOString() ?? null, clock_out_at: r.clock_out_at?.toISOString() ?? null,
    overnight: !!(ci && co && co.date > ci.date),
    break_minutes: r.break_minutes, night_break_minutes: r.night_break_minutes, work_minutes: r.work_minutes, night_minutes: r.night_minutes,
    travel_km: Number(r.travel_km), travel_fee: r.travel_fee, allowance_amount: r.allowance_amount, allowance_note: r.allowance_note,
    meal_count: r.meal_count, meal_fee: r.meal_fee, alcohol_check: r.alcohol_check,
    status: r.status, leave_type: r.leave_type, leave_days: r.leave_days === null ? null : Number(r.leave_days), leave_reason: r.leave_reason,
    staff_comment: r.staff_comment, staff_comment_full, correction_reason: r.correction_reason,
    reasons: Object.fromEntries(reasons.map((x) => [x.key, { label: x.auditLabel, reason: x.reason }])),
    legacy_comment: r.legacy_comment,
    stamped_in_at: r.stamped_in_at?.toISOString() ?? null, stamped_out_at: r.stamped_out_at?.toISOString() ?? null,
    created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(), updated_by: r.updated_by, deleted_at: r.deleted_at?.toISOString() ?? null,
  };
}
export type AttendanceView = ReturnType<typeof presentRow>;

export const todayJst = (nowMs = Date.now()) => msToJst(nowMs).date;

// ---------- 取得 ----------
export async function getAttendance(id: string, client: PoolClient | typeof pool = pool): Promise<AttendanceRow | null> {
  return one<AttendanceRow>('SELECT * FROM attendance WHERE id = $1', [id], client);
}
export async function getLocation(code: string): Promise<LocationRow | null> {
  return one<LocationRow>('SELECT * FROM locations WHERE location_code = $1 AND deleted_at IS NULL', [code]);
}
export async function getStaff(id: string, client: PoolClient | typeof pool = pool): Promise<StaffRow | null> {
  return one<StaffRow>('SELECT * FROM staff WHERE id = $1 AND deleted_at IS NULL', [id], client);
}
/** 未退勤（WORKING/OVERDUE）一覧。何か月前でも全件（末尾N行方式はしない） */
export async function openRecords(locationCode?: string): Promise<AttendanceRow[]> {
  return q<AttendanceRow>(
    `SELECT * FROM attendance WHERE deleted_at IS NULL AND status IN ('WORKING','OVERDUE') ${locationCode ? 'AND location_code = $1' : ''} ORDER BY clock_in_at`,
    locationCode ? [locationCode] : [],
  );
}
export async function openRecordOf(staffId: string, client: PoolClient | typeof pool = pool): Promise<AttendanceRow | null> {
  return one<AttendanceRow>(`SELECT * FROM attendance WHERE deleted_at IS NULL AND staff_id = $1 AND status IN ('WORKING','OVERDUE') ORDER BY clock_in_at DESC LIMIT 1`, [staffId], client);
}

// ---------- 出勤 ----------
export interface ClockInInput {
  staff_id: string; location_code: string; request_id?: string; alcohol_check?: string | null;
  /** 管理者・本人追加用：JST 'YYYY-MM-DD' + 'HH:MM'。打刻端末では使わない（サーバー時刻） */
  at?: { date: string; time: string } | null;
}
export async function clockIn(input: ClockInInput, actor: Actor, nowMs = Date.now()): Promise<{ record: AttendanceView; duplicate: boolean }> {
  const loc = await getLocation(input.location_code);
  if (!loc || !loc.active) throw badRequest('この事業所は使えません。事業所を選び直してください', 'BAD_LOCATION', 'location_code');
  const staff = await getStaff(input.staff_id);
  if (!staff || !staff.active) throw badRequest('このスタッフは登録されていないか、無効になっています', 'BAD_STAFF', 'staff_id');
  if (loc.check_alcohol && !String(input.alcohol_check ?? '').trim()) throw badRequest('この事業所ではアルコールチェックの数値が必要です', 'ALCOHOL_REQUIRED', 'alcohol_check');

  let atMs = nowMs;
  if (input.at) {
    const ms = jstToMs(input.at.date, input.at.time);
    if (ms === null) throw badRequest('出勤日時の形式が不正です', 'BAD_TIME', 'clock_in');
    if (ms > nowMs + 5 * 60e3) throw badRequest('未来の時刻では出勤できません', 'FUTURE', 'clock_in');
    atMs = ms;
  }
  const workDate = msToJst(atMs).date;

  return tx(async (c) => {
    // 二重送信：同じ request_id なら既存を返す
    if (input.request_id) {
      const dup = await one<AttendanceRow>('SELECT * FROM attendance WHERE client_request_id = $1', [input.request_id], c);
      if (dup) return { record: presentRow(dup), duplicate: true };
    }
    const open = await openRecordOf(staff.id, c);
    if (open) {
      const v = presentRow(open);
      if (open.status === 'WORKING' && open.work_date === workDate) {
        throw conflict(`${staff.staff_name} さんはすでにお仕事中です（${v.clock_in} 出勤）`, 'ALREADY_WORKING', { open: v });
      }
      throw conflict(`${staff.staff_name} さんは ${open.work_date} ${v.clock_in} の退勤が済んでいません。先に前回の退勤を入力してください`, 'HAS_OPEN', { open: v });
    }
    let row: AttendanceRow | null;
    try {
      row = await one<AttendanceRow>(
        `INSERT INTO attendance (work_date, staff_id, employee_id, staff_name, location_code, location_name, department, clock_in_at, alcohol_check, status, stamped_in_at, client_request_id, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'WORKING',$10,$11,$12) RETURNING *`,
        [workDate, staff.id, staff.employee_id, staff.staff_name, loc.location_code, loc.location_name, loc.department, new Date(atMs),
          input.alcohol_check ? String(input.alcohol_check).trim() : null, actor.kind === 'kiosk' ? new Date(nowMs) : null, input.request_id ?? null, actorStr(actor)], c);
    } catch (e: unknown) {
      if (isUniqueViolation(e)) throw conflict(`${staff.staff_name} さんはすでに出勤しています（他の端末から打刻された可能性があります）`, 'ALREADY_WORKING');
      throw e;
    }
    await audit(actor, 'attendance.clock_in', row!.id, null, presentRow(row!), c);
    return { record: presentRow(row!), duplicate: false };
  });
}

// ---------- 退勤 ----------
export interface ClockOutInput {
  attendance_id: string;
  clock_out?: string | null;        // 'HH:MM'（未指定なら現在時刻。OVERDUE は必須）
  clock_out_date?: string | null;   // 'YYYY-MM-DD'（未指定なら日跨ぎ自動判定）
  clock_in_fix?: string | null;     // 出勤時刻の訂正（任意、'HH:MM'）
  break_minutes?: number | null; night_break_minutes?: number | null;
  travel_km?: number | null; comment?: string | null;
  allowance_amount?: number | null; allowance_note?: string | null; meal_count?: number | null;
  reasons?: Partial<Record<WarningKey, string>>;
  correction_reason?: string | null; // 本人・管理者の修正時
}

/** 退勤・修正に共通の計算。警告に理由が無ければ 422 NEEDS_REASON を投げる */
async function computeForSave(p: {
  work_date: string; clock_in: string; clock_out: string; clock_out_date: string; loc: Pick<LocationRow, 'gh_extras' | 'gh_break_rule'> | null;
  input: Omit<ClockOutInput, 'attendance_id'>;
}): Promise<{ calc: ShiftOk; reasons: ReasonEntry[]; warning_labels: Record<string, string> }> {
  if (!isValidDate(p.clock_out_date)) throw badRequest('退勤日の形式が不正です', 'BAD_DATE', 'clock_out_date');
  if (p.clock_out_date < p.work_date) throw badRequest('退勤日は出勤日より前にできません', 'BAD_DATE', 'clock_out_date');
  if (p.clock_out_date > addDays(p.work_date, 1)) throw badRequest('勤務時間が24時間を超えています', 'OVER_24H', 'clock_out_date');
  const overnight = p.clock_out_date > p.work_date;
  const perKm = await getNumberSetting('travel_fee_per_km', 20);
  const mealUnit = await getNumberSetting('meal_unit_price', 250);
  const calc = computeShift({
    clock_in: p.clock_in, clock_out: p.clock_out, overnight,
    break_minutes: p.input.break_minutes, night_break_minutes: p.input.night_break_minutes,
    travel_km: p.input.travel_km, travel_fee_per_km: perKm, comment: p.input.comment,
    gh_extras: !!p.loc?.gh_extras, gh_break_rule: !!p.loc?.gh_break_rule,
    allowance_amount: p.input.allowance_amount, allowance_note: p.input.allowance_note, meal_count: p.input.meal_count, meal_unit_price: mealUnit,
  });
  if (!calc.ok) throw badRequest(calc.error, calc.code, calc.field);
  const missing: Warning[] = calc.warnings.filter((w) => !String(p.input.reasons?.[w.key] ?? '').trim());
  if (missing.length) {
    throw new AppError(422, 'NEEDS_REASON', `確認が必要な点があります：${missing.map((w) => w.title).join('／')}。理由を入力してください`, undefined, { warnings: calc.warnings, missing: missing.map((w) => w.key), preview: pick(calc) });
  }
  const reasons: ReasonEntry[] = calc.warnings.map((w) => ({ key: w.key, auditLabel: w.auditLabel, reason: String(p.input.reasons?.[w.key] ?? '').trim() }));
  const warning_labels = Object.fromEntries(calc.warnings.map((w) => [w.key, w.auditLabel]));
  return { calc, reasons, warning_labels };
}
const pick = (c: ShiftOk) => ({ work_minutes: c.work_minutes, night_minutes: c.night_minutes, travel_fee: c.travel_fee, meal_fee: c.meal_fee, allowance_note: c.allowance_note, overnight: c.overnight });

function reasonCols(reasons: ReasonEntry[]) {
  const g = (k: WarningKey) => reasons.find((r) => r.key === k)?.reason ?? null;
  return { break_reason: g('statutory'), gh_break_reason: g('gh'), stamp_warning_reason: g('anomaly'), break_excess_reason: g('excess'), break_mismatch_reason: g('mismatch') };
}

export async function clockOut(input: ClockOutInput, actor: Actor, nowMs = Date.now()): Promise<AttendanceView> {
  return tx(async (c) => {
    const row = await one<AttendanceRow>('SELECT * FROM attendance WHERE id = $1 FOR UPDATE', [input.attendance_id], c);
    if (!row || row.deleted_at) throw notFound('この勤務記録は見つかりません（取り消されたか、他の端末で処理済みの可能性があります）');
    if (!isOpenStatus(row.status)) throw conflict(`${row.staff_name} さんの ${row.work_date} 分はすでに退勤済みです`, 'ALREADY_DONE', { record: presentRow(row) });
    if (!row.clock_in_at) throw conflict('出勤時刻がありません', 'NO_CLOCK_IN');
    if (actor.kind === 'staff' && actor.id !== row.staff_id) throw forbidden('他の人の記録は操作できません', 'NOT_OWNER');

    const ciJ = msToJst(row.clock_in_at.getTime());
    let clockIn = ciJ.time;
    if (input.clock_in_fix) {
      if (toMin(input.clock_in_fix) === null) throw badRequest('出勤時刻の形式が不正です', 'BAD_TIME', 'clock_in_fix');
      clockIn = input.clock_in_fix;
    }
    let clockOut = String(input.clock_out ?? '').trim();
    let clockOutDate = String(input.clock_out_date ?? '').trim();
    if (!clockOut) {
      if (row.status === 'OVERDUE') throw badRequest('退勤忘れのため、退勤した時刻を入力してください', 'CLOCK_OUT_REQUIRED', 'clock_out');
      const nowJ = msToJst(nowMs);
      clockOut = nowJ.time;
      clockOutDate = nowJ.date;
    }
    if (toMin(clockOut) === null) throw badRequest('退勤時刻の形式が不正です', 'BAD_TIME', 'clock_out');
    if (!clockOutDate) {
      const ov = toMin(clockOut)! < toMin(clockIn)!;
      clockOutDate = ov ? addDays(row.work_date, 1) : row.work_date;
    }
    const loc = row.location_code ? await getLocation(row.location_code) : null;
    const { calc, reasons, warning_labels } = await computeForSave({ work_date: row.work_date, clock_in: clockIn, clock_out: clockOut, clock_out_date: clockOutDate, loc, input });
    const clockInAt = new Date(jstToMs(row.work_date, clockIn)!);
    const clockOutAt = new Date(jstToMs(clockOutDate, clockOut)!);
    if (clockOutAt.getTime() > nowMs + 5 * 60e3) throw badRequest('未来の時刻では退勤できません', 'FUTURE', 'clock_out');
    const rc = reasonCols(reasons);
    const before = presentRow(row);
    const updated = await one<AttendanceRow>(
      `UPDATE attendance SET clock_in_at=$2, clock_out_at=$3, break_minutes=$4, night_break_minutes=$5, work_minutes=$6, night_minutes=$7,
         travel_km=$8, travel_fee=$9, allowance_amount=$10, allowance_note=$11, meal_count=$12, meal_fee=$13, status='DONE',
         staff_comment=$14, break_reason=$15, gh_break_reason=$16, stamp_warning_reason=$17, break_excess_reason=$18, break_mismatch_reason=$19,
         warning_labels=$20, stamped_out_at=COALESCE(stamped_out_at, $21), correction_reason=COALESCE($22, correction_reason), updated_at=now(), updated_by=$23
       WHERE id=$1 RETURNING *`,
      [row.id, clockInAt, clockOutAt, calc.break_minutes, calc.night_break_minutes, calc.work_minutes, calc.night_minutes,
        calc.travel_km, calc.travel_fee, calc.allowance_amount, calc.allowance_note || null, calc.meal_count, calc.meal_fee,
        String(input.comment ?? '').trim() || null, rc.break_reason, rc.gh_break_reason, rc.stamp_warning_reason, rc.break_excess_reason, rc.break_mismatch_reason,
        JSON.stringify(warning_labels), actor.kind === 'kiosk' ? new Date(nowMs) : null, input.correction_reason?.trim() || null, actorStr(actor)], c);
    const after = presentRow(updated!);
    await audit(actor, 'attendance.clock_out', row.id, before, after, c);
    return after;
  });
}

// ---------- 退勤忘れ判定（定期処理・冪等） ----------
export async function markOverdue(nowMs = Date.now()): Promise<number> {
  const rows = await q<AttendanceRow>(`SELECT * FROM attendance WHERE deleted_at IS NULL AND status = 'WORKING' AND clock_in_at < $1`, [new Date(nowMs - 24 * 3600e3)]);
  let n = 0;
  for (const r of rows) {
    if (!r.clock_in_at || !isOverdueAt(r.clock_in_at.getTime(), nowMs)) continue;
    await q(`UPDATE attendance SET status = 'OVERDUE', updated_at = now(), updated_by = 'system' WHERE id = $1 AND status = 'WORKING'`, [r.id]);
    await audit({ kind: 'system', id: 'overdue-job', label: 'overdue-job' }, 'attendance.overdue', r.id, { status: 'WORKING' }, { status: 'OVERDUE' });
    n++;
  }
  return n;
}

// ---------- 本人の記録（マイページ） ----------
export async function myRecords(staffId: string, ym: string): Promise<AttendanceView[]> {
  const rows = await q<AttendanceRow>(`SELECT * FROM attendance WHERE deleted_at IS NULL AND staff_id = $1 AND to_char(work_date, 'YYYY-MM') = $2 ORDER BY work_date, clock_in_at NULLS FIRST, created_at`, [staffId, ym]);
  return rows.map(presentRow);
}

function assertSelfDeadline(workDate: string, nowMs: number) {
  const today = todayJst(nowMs);
  if (!selfEditable(workDate, today)) {
    throw forbidden(`${workDate} 分は本人による修正・取消の期限（${selfEditDeadline(workDate)} まで）を過ぎています。管理者に連絡してください`, 'DEADLINE_PASSED', { deadline: selfEditDeadline(workDate) });
  }
}

/** 本人の取消（論理削除）。他人・期限外・対象外 status は拒否 */
export async function cancelRecord(id: string, actor: Actor, reason: string | null, nowMs = Date.now()): Promise<AttendanceView> {
  return tx(async (c) => {
    const row = await one<AttendanceRow>('SELECT * FROM attendance WHERE id = $1 FOR UPDATE', [id], c);
    if (!row || row.deleted_at) throw notFound('この記録は見つかりません（すでに取り消されている可能性があります）');
    if (actor.kind === 'staff') {
      if (row.staff_id !== actor.id) throw forbidden('他の人の記録は取り消せません', 'NOT_OWNER');
      if (!(SELF_CANCELABLE as readonly string[]).includes(row.status)) throw forbidden(`状態「${row.status}」の記録は取り消せません`, 'STATUS_NOT_CANCELABLE');
      assertSelfDeadline(row.work_date, nowMs);
    } else if (actor.kind !== 'admin') {
      throw forbidden('取消は本人または管理者だけができます', 'FORBIDDEN');
    }
    const before = presentRow(row);
    const updated = await one<AttendanceRow>('UPDATE attendance SET deleted_at = now(), deleted_by = $2, correction_reason = COALESCE($3, correction_reason), updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *', [id, actorStr(actor), reason?.trim() || null], c);
    await audit(actor, 'attendance.cancel', id, before, { deleted: true, reason }, c);
    return presentRow(updated!);
  });
}

export interface SelfEditInput extends Omit<ClockOutInput, 'attendance_id' | 'clock_in_fix'> {
  clock_in: string; work_date?: string; location_code?: string; correction_reason: string;
}

/** 本人の修正（DONE の内容を直す）。理由必須・期限内・本人のみ */
export async function selfEditRecord(id: string, input: SelfEditInput, actor: Actor, nowMs = Date.now()): Promise<AttendanceView> {
  if (!String(input.correction_reason ?? '').trim()) throw badRequest('修正理由を入力してください', 'REASON_REQUIRED', 'correction_reason');
  return tx(async (c) => {
    const row = await one<AttendanceRow>('SELECT * FROM attendance WHERE id = $1 FOR UPDATE', [id], c);
    if (!row || row.deleted_at) throw notFound('この記録は見つかりません');
    if (actor.kind === 'staff') {
      if (row.staff_id !== actor.id) throw forbidden('他の人の記録は修正できません', 'NOT_OWNER');
      assertSelfDeadline(row.work_date, nowMs);
    } else if (actor.kind !== 'admin') throw forbidden('修正は本人または管理者だけができます');
    if (row.status !== 'DONE') throw conflict('退勤済みの記録だけ修正できます（勤務中・有給は対象外）', 'STATUS_NOT_EDITABLE');
    const workDate = input.work_date && actor.kind === 'admin' ? input.work_date : row.work_date;
    if (!isValidDate(workDate)) throw badRequest('日付の形式が不正です', 'BAD_DATE', 'work_date');
    if (toMin(input.clock_in) === null) throw badRequest('出勤時刻の形式が不正です', 'BAD_TIME', 'clock_in');
    const clockOut = String(input.clock_out ?? '').trim();
    if (toMin(clockOut) === null) throw badRequest('退勤時刻の形式が不正です', 'BAD_TIME', 'clock_out');
    let clockOutDate = String(input.clock_out_date ?? '').trim();
    if (!clockOutDate) clockOutDate = toMin(clockOut)! < toMin(input.clock_in)! ? addDays(workDate, 1) : workDate;
    let loc = row.location_code ? await getLocation(row.location_code) : null;
    let locCols = { location_code: row.location_code, location_name: row.location_name, department: row.department };
    if (input.location_code && actor.kind === 'admin' && input.location_code !== row.location_code) {
      loc = await getLocation(input.location_code);
      if (!loc) throw badRequest('事業所が見つかりません', 'BAD_LOCATION', 'location_code');
      locCols = { location_code: loc.location_code, location_name: loc.location_name, department: loc.department };
    }
    const { calc, reasons, warning_labels } = await computeForSave({ work_date: workDate, clock_in: input.clock_in, clock_out: clockOut, clock_out_date: clockOutDate, loc, input });
    const clockInAt = new Date(jstToMs(workDate, input.clock_in)!);
    const clockOutAt = new Date(jstToMs(clockOutDate, clockOut)!);
    if (clockOutAt.getTime() > nowMs + 5 * 60e3) throw badRequest('未来の時刻は登録できません', 'FUTURE', 'clock_out');
    const rc = reasonCols(reasons);
    const before = presentRow(row);
    const updated = await one<AttendanceRow>(
      `UPDATE attendance SET work_date=$2, clock_in_at=$3, clock_out_at=$4, break_minutes=$5, night_break_minutes=$6, work_minutes=$7, night_minutes=$8,
         travel_km=$9, travel_fee=$10, allowance_amount=$11, allowance_note=$12, meal_count=$13, meal_fee=$14,
         staff_comment=$15, break_reason=$16, gh_break_reason=$17, stamp_warning_reason=$18, break_excess_reason=$19, break_mismatch_reason=$20,
         warning_labels=$21, correction_reason=$22, legacy_comment=NULL, location_code=$23, location_name=$24, department=$25, updated_at=now(), updated_by=$26
       WHERE id=$1 RETURNING *`,
      [row.id, workDate, clockInAt, clockOutAt, calc.break_minutes, calc.night_break_minutes, calc.work_minutes, calc.night_minutes,
        calc.travel_km, calc.travel_fee, calc.allowance_amount, calc.allowance_note || null, calc.meal_count, calc.meal_fee,
        String(input.comment ?? '').trim() || null, rc.break_reason, rc.gh_break_reason, rc.stamp_warning_reason, rc.break_excess_reason, rc.break_mismatch_reason,
        JSON.stringify(warning_labels), input.correction_reason.trim(), locCols.location_code, locCols.location_name, locCols.department, actorStr(actor)], c);
    const after = presentRow(updated!);
    await audit(actor, 'attendance.edit', row.id, before, after, c);
    return after;
  });
}

export interface AddRecordInput extends Omit<ClockOutInput, 'attendance_id' | 'clock_in_fix'> {
  staff_id: string; work_date: string; location_code: string; clock_in: string; correction_reason: string; confirm_today?: boolean; alcohol_check?: string | null;
}
/** 打刻忘れの記録追加（DONE で作る）。本人は期限内のみ。日付が今日のままなら confirm_today が必要 */
export async function addRecord(input: AddRecordInput, actor: Actor, nowMs = Date.now()): Promise<AttendanceView> {
  if (!String(input.correction_reason ?? '').trim()) throw badRequest('追加の理由を入力してください', 'REASON_REQUIRED', 'correction_reason');
  if (!isValidDate(input.work_date)) throw badRequest('日付の形式が不正です', 'BAD_DATE', 'work_date');
  const today = todayJst(nowMs);
  if (input.work_date > today) throw badRequest('未来の日付は登録できません', 'FUTURE', 'work_date');
  if (input.work_date === today && !input.confirm_today) {
    throw new AppError(422, 'CONFIRM_TODAY', '日付が「今日」のままです。過去の分を追加する場合は日付を直してください。今日の分で間違いなければ「今日の分で登録」を押してください', 'work_date');
  }
  const staff = await getStaff(input.staff_id);
  if (!staff) throw badRequest('スタッフが見つかりません', 'BAD_STAFF', 'staff_id');
  if (actor.kind === 'staff') {
    if (staff.id !== actor.id) throw forbidden('他の人の記録は追加できません', 'NOT_OWNER');
    assertSelfDeadline(input.work_date, nowMs);
  } else if (actor.kind !== 'admin') throw forbidden('記録の追加は本人または管理者だけができます');
  const loc = await getLocation(input.location_code);
  if (!loc) throw badRequest('事業所を選んでください', 'BAD_LOCATION', 'location_code');
  if (toMin(input.clock_in) === null) throw badRequest('出勤時刻の形式が不正です', 'BAD_TIME', 'clock_in');
  const clockOut = String(input.clock_out ?? '').trim();
  if (toMin(clockOut) === null) throw badRequest('退勤時刻を入力してください', 'BAD_TIME', 'clock_out');
  let clockOutDate = String(input.clock_out_date ?? '').trim();
  if (!clockOutDate) clockOutDate = toMin(clockOut)! < toMin(input.clock_in)! ? addDays(input.work_date, 1) : input.work_date;
  const { calc, reasons, warning_labels } = await computeForSave({ work_date: input.work_date, clock_in: input.clock_in, clock_out: clockOut, clock_out_date: clockOutDate, loc, input });
  const clockInAt = new Date(jstToMs(input.work_date, input.clock_in)!);
  const clockOutAt = new Date(jstToMs(clockOutDate, clockOut)!);
  if (clockOutAt.getTime() > nowMs + 5 * 60e3) throw badRequest('未来の時刻は登録できません', 'FUTURE', 'clock_out');
  const rc = reasonCols(reasons);
  return tx(async (c) => {
    const row = await one<AttendanceRow>(
      `INSERT INTO attendance (work_date, staff_id, employee_id, staff_name, location_code, location_name, department, clock_in_at, clock_out_at,
         break_minutes, night_break_minutes, work_minutes, night_minutes, travel_km, travel_fee, allowance_amount, allowance_note, meal_count, meal_fee, alcohol_check,
         status, staff_comment, break_reason, gh_break_reason, stamp_warning_reason, break_excess_reason, break_mismatch_reason, warning_labels, correction_reason, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'DONE',$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING *`,
      [input.work_date, staff.id, staff.employee_id, staff.staff_name, loc.location_code, loc.location_name, loc.department, clockInAt, clockOutAt,
        calc.break_minutes, calc.night_break_minutes, calc.work_minutes, calc.night_minutes, calc.travel_km, calc.travel_fee, calc.allowance_amount, calc.allowance_note || null, calc.meal_count, calc.meal_fee,
        input.alcohol_check ? String(input.alcohol_check).trim() : null,
        String(input.comment ?? '').trim() || null, rc.break_reason, rc.gh_break_reason, rc.stamp_warning_reason, rc.break_excess_reason, rc.break_mismatch_reason,
        JSON.stringify(warning_labels), input.correction_reason.trim(), actorStr(actor)], c);
    const after = presentRow(row!);
    await audit(actor, 'attendance.add', row!.id, null, after, c);
    return after;
  });
}

// ---------- 有給 ----------
export async function requestLeave(input: { staff_id: string; work_date: string; type: 'full' | 'am' | 'pm'; reason?: string | null }, actor: Actor, nowMs = Date.now()): Promise<AttendanceView> {
  if (!isValidDate(input.work_date)) throw badRequest('日付の形式が不正です', 'BAD_DATE', 'work_date');
  if (!['full', 'am', 'pm'].includes(input.type)) throw badRequest('種別は 全休／午前半休／午後半休 から選んでください', 'BAD_TYPE', 'type');
  const staff = await getStaff(input.staff_id);
  if (!staff || !staff.active) throw badRequest('スタッフが見つかりません', 'BAD_STAFF');
  if (actor.kind === 'staff') {
    if (staff.id !== actor.id) throw forbidden('他の人の有給は申請できません', 'NOT_OWNER');
    // 本人は当月〜未来、および期限内（翌月7日まで）の前月分のみ
    if (input.work_date.slice(0, 7) < todayJst(nowMs).slice(0, 7)) assertSelfDeadline(input.work_date, nowMs);
  } else if (actor.kind !== 'admin') throw forbidden('有給の登録は本人または管理者だけができます');
  const info = leaveInfo(input.type);
  return tx(async (c) => {
    const dupLeave = await one<AttendanceRow>(`SELECT * FROM attendance WHERE deleted_at IS NULL AND staff_id = $1 AND work_date = $2 AND status IN ('PAID_LEAVE','PAID_LEAVE_AM','PAID_LEAVE_PM')`, [staff.id, input.work_date], c);
    if (dupLeave) throw conflict(`${input.work_date} はすでに有給（${leaveInfo(dupLeave.leave_type ?? 'full').label}）が登録されています`, 'LEAVE_DUPLICATE');
    let row: AttendanceRow | null;
    try {
      row = await one<AttendanceRow>(
        `INSERT INTO attendance (work_date, staff_id, employee_id, staff_name, status, leave_type, leave_days, leave_reason, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [input.work_date, staff.id, staff.employee_id, staff.staff_name, info.status, input.type, info.days, String(input.reason ?? '').trim() || null, actorStr(actor)], c);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict(`${input.work_date} はすでに有給が登録されています`, 'LEAVE_DUPLICATE');
      throw e;
    }
    const after = presentRow(row!);
    await audit(actor, 'attendance.leave', row!.id, null, after, c);
    return after;
  });
}

// ---------- 管理者の直接更新（列ホワイトリスト） ----------
export interface AdminUpdateInput {
  work_date?: string; location_code?: string; clock_in?: string | null; clock_out?: string | null; clock_out_date?: string | null;
  break_minutes?: number; night_break_minutes?: number; travel_km?: number; comment?: string | null;
  allowance_amount?: number; allowance_note?: string | null; meal_count?: number; alcohol_check?: string | null;
  status?: string; leave_type?: 'full' | 'am' | 'pm'; leave_reason?: string | null; correction_reason: string;
  reasons?: Partial<Record<WarningKey, string>>;
}
/** 管理者の編集。DONE は再計算、WORKING/OVERDUE は出勤時刻等のみ、有給は種別・理由 */
export async function adminUpdate(id: string, input: AdminUpdateInput, actor: Actor, nowMs = Date.now()): Promise<AttendanceView> {
  if (actor.kind !== 'admin') throw forbidden();
  if (!String(input.correction_reason ?? '').trim()) throw badRequest('修正理由を入力してください', 'REASON_REQUIRED', 'correction_reason');
  const row = await getAttendance(id);
  if (!row || row.deleted_at) throw notFound('この記録は見つかりません');
  const targetStatus = input.status ?? row.status;
  if (isLeaveStatus(targetStatus) || (input.leave_type && isLeaveStatus(row.status))) {
    const type = input.leave_type ?? (row.leave_type as 'full' | 'am' | 'pm' | null) ?? 'full';
    const info = leaveInfo(type);
    const workDate = input.work_date ?? row.work_date;
    if (!isValidDate(workDate)) throw badRequest('日付の形式が不正です', 'BAD_DATE', 'work_date');
    return tx(async (c) => {
      const before = presentRow(row);
      let updated: AttendanceRow | null;
      try {
        updated = await one<AttendanceRow>(
          `UPDATE attendance SET work_date=$2, status=$3, leave_type=$4, leave_days=$5, leave_reason=$6, correction_reason=$7, clock_in_at=NULL, clock_out_at=NULL, work_minutes=NULL, night_minutes=NULL, updated_at=now(), updated_by=$8 WHERE id=$1 RETURNING *`,
          [id, workDate, info.status, type, info.days, (input.leave_reason ?? row.leave_reason) || null, input.correction_reason.trim(), actorStr(actor)], c);
      } catch (e) { if (isUniqueViolation(e)) throw conflict('その日はすでに有給が登録されています', 'LEAVE_DUPLICATE'); throw e; }
      const after = presentRow(updated!);
      await audit(actor, 'attendance.admin_update', id, before, after, c);
      return after;
    });
  }
  if (isOpenStatus(targetStatus)) {
    // 勤務中・退勤忘れ：出勤日時・事業所の訂正のみ
    const workDate = input.work_date ?? row.work_date;
    const ci = input.clock_in ?? (row.clock_in_at ? msToJst(row.clock_in_at.getTime()).time : null);
    if (!isValidDate(workDate) || !ci || toMin(ci) === null) throw badRequest('出勤日時の形式が不正です', 'BAD_TIME', 'clock_in');
    const loc = input.location_code ? await getLocation(input.location_code) : null;
    if (input.location_code && !loc) throw badRequest('事業所が見つかりません', 'BAD_LOCATION');
    return tx(async (c) => {
      const before = presentRow(row);
      const updated = await one<AttendanceRow>(
        `UPDATE attendance SET work_date=$2, clock_in_at=$3, status=$4, location_code=COALESCE($5, location_code), location_name=COALESCE($6, location_name), department=COALESCE($7, department), alcohol_check=COALESCE($8, alcohol_check), correction_reason=$9, updated_at=now(), updated_by=$10 WHERE id=$1 RETURNING *`,
        [id, workDate, new Date(jstToMs(workDate, ci)!), targetStatus, loc?.location_code ?? null, loc?.location_name ?? null, loc?.department ?? null, input.alcohol_check ?? null, input.correction_reason.trim(), actorStr(actor)], c);
      const after = presentRow(updated!);
      await audit(actor, 'attendance.admin_update', id, before, after, c);
      return after;
    });
  }
  // DONE（または有給→DONE への変更）：フルに再計算
  const ci = input.clock_in ?? (row.clock_in_at ? msToJst(row.clock_in_at.getTime()).time : null);
  if (!ci) throw badRequest('出勤時刻を入力してください', 'BAD_TIME', 'clock_in');
  const co = input.clock_out ?? (row.clock_out_at ? msToJst(row.clock_out_at.getTime()).time : null);
  if (!co) throw badRequest('退勤時刻を入力してください', 'BAD_TIME', 'clock_out');
  if (row.status === 'DONE') {
    return selfEditRecord(id, {
      // 拘束は24時間未満なので「退勤 < 出勤 ⇔ 日跨ぎ」。日付未指定なら自動判定で正しい
      clock_in: ci, clock_out: co, clock_out_date: input.clock_out_date ?? null,
      work_date: input.work_date, location_code: input.location_code,
      break_minutes: input.break_minutes ?? row.break_minutes, night_break_minutes: input.night_break_minutes ?? row.night_break_minutes,
      travel_km: input.travel_km ?? Number(row.travel_km), comment: input.comment === undefined ? row.staff_comment : input.comment,
      allowance_amount: input.allowance_amount ?? row.allowance_amount, allowance_note: input.allowance_note === undefined ? row.allowance_note : input.allowance_note,
      meal_count: input.meal_count ?? row.meal_count, reasons: { ...existingReasons(row), ...(input.reasons ?? {}) }, correction_reason: input.correction_reason,
    }, actor, nowMs);
  }
  throw badRequest(`状態「${row.status}」から「${targetStatus}」への変更はできません。取り消して登録し直してください`, 'BAD_STATUS_CHANGE');
}
function existingReasons(r: AttendanceRow): Partial<Record<WarningKey, string>> {
  const o: Partial<Record<WarningKey, string>> = {};
  (Object.keys(REASON_COL) as WarningKey[]).forEach((k) => { const v = r[REASON_COL[k]]; if (v) o[k] = String(v); });
  return o;
}

// ---------- 共通 ----------
export function actorStr(a: Actor): string { return `${a.kind}:${a.label || a.id}`; }
export function isUniqueViolation(e: unknown): boolean { return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505'; }
