/**
 * スタッフ：名簿（公開列のみ）、PIN 認証（段階的遅延・完全ロックなし）、PIN 変更。
 * pin_hash は誰にも返さない。email は管理者のみ。
 */
import { pool, q, one, tx } from '../db.js';
import { hashPin, verifyPin, verifyLegacyPin, isValidPin } from '../auth.js';
import { audit, type Actor } from '../audit.js';
import { badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../errors.js';
import { padEmpId, stripSpaces } from '../../calc/index.js';
import type { StaffRow } from './attendance.js';
import { actorStr, isUniqueViolation } from './attendance.js';

/** 5回失敗ごとに 30秒待たせる（完全ロックはしない：大和さん方針） */
const PIN_FAIL_STEP = 5;
const PIN_DELAY_MS = 30_000;

export interface PublicStaff { id: string; employee_id: string | null; staff_name: string; staff_kana: string; active: boolean; has_pin: boolean }
export const publicStaff = (s: StaffRow): PublicStaff => ({ id: s.id, employee_id: s.employee_id, staff_name: s.staff_name, staff_kana: s.staff_kana, active: s.active, has_pin: !!(s.pin_hash || s.pin_hash_legacy) });

/** 打刻端末・マイページ向け名簿（在籍のみ・かな順、かな無しは後ろ） */
export async function roster(): Promise<PublicStaff[]> {
  const rows = await q<StaffRow>('SELECT * FROM staff WHERE deleted_at IS NULL AND active = true');
  const key = (s: StaffRow) => s.staff_kana || 'んんん' + s.staff_name;
  rows.sort((a, b) => key(a).localeCompare(key(b), 'ja'));
  return rows.map(publicStaff);
}

/** PIN 照合。成功時は旧ハッシュを新方式へ移行。失敗は回数を記録し、5回ごとに30秒待ち */
export async function verifyStaffPin(staffId: string, pin: unknown, ip?: string): Promise<StaffRow> {
  if (!isValidPin(pin)) throw badRequest('暗証番号は4桁の数字です', 'BAD_PIN', 'pin');
  const s = await one<StaffRow>('SELECT * FROM staff WHERE id = $1 AND deleted_at IS NULL', [staffId]);
  if (!s) throw notFound('スタッフが見つかりません', 'BAD_STAFF');
  if (!s.active) throw forbidden('このスタッフは無効になっています。管理者に連絡してください', 'INACTIVE');
  if (!s.pin_hash && !s.pin_hash_legacy) throw unauthorized('暗証番号が未設定です。管理者に設定してもらってください', 'PIN_NOT_SET');
  // 段階的遅延
  if (s.pin_fail_count > 0 && s.pin_fail_count % PIN_FAIL_STEP === 0 && s.pin_fail_last) {
    const wait = s.pin_fail_last.getTime() + PIN_DELAY_MS - Date.now();
    if (wait > 0) throw tooMany(`暗証番号を${s.pin_fail_count}回間違えました。${Math.ceil(wait / 1000)}秒待ってからもう一度お試しください`, 'PIN_DELAY', { retry_after_sec: Math.ceil(wait / 1000) });
  }
  let ok = false;
  if (s.pin_hash) ok = verifyPin(pin, s.pin_hash);
  else if (s.pin_hash_legacy && verifyLegacyPin(pin, s.pin_hash_legacy)) {
    ok = true;
    await q('UPDATE staff SET pin_hash = $2, pin_hash_legacy = NULL, updated_at = now() WHERE id = $1', [s.id, hashPin(pin)]);
  }
  if (!ok) {
    const r = await one<{ pin_fail_count: number }>('UPDATE staff SET pin_fail_count = pin_fail_count + 1, pin_fail_last = now() WHERE id = $1 RETURNING pin_fail_count', [s.id]);
    const n = r?.pin_fail_count ?? 1;
    if (n % 30 === 0) await audit({ kind: 'system', id: 'pin-guard', label: 'pin-guard', ip }, 'staff.pin_fail_warning', s.id, null, { fail_count: n });
    throw unauthorized('暗証番号が違います', 'PIN_MISMATCH');
  }
  if (s.pin_fail_count > 0) await q('UPDATE staff SET pin_fail_count = 0, pin_fail_last = NULL WHERE id = $1', [s.id]);
  return s;
}

export async function changePin(staffId: string, currentPin: unknown, newPin: unknown, actor: Actor): Promise<void> {
  if (!isValidPin(newPin)) throw badRequest('新しい暗証番号は4桁の数字にしてください', 'BAD_PIN', 'new_pin');
  await verifyStaffPin(staffId, currentPin, actor.ip);
  await q('UPDATE staff SET pin_hash = $2, pin_hash_legacy = NULL, pin_fail_count = 0, updated_at = now() WHERE id = $1', [staffId, hashPin(newPin)]);
  await audit(actor, 'staff.pin_change', staffId, null, null);
}

// ---------- 管理 ----------
export interface AdminStaff extends PublicStaff { email: string | null; created_at: string; updated_at: string }
const adminView = (s: StaffRow & { created_at: Date; updated_at: Date }): AdminStaff => ({ ...publicStaff(s), email: s.email, created_at: s.created_at.toISOString(), updated_at: s.updated_at.toISOString() });

export async function listStaffAdmin(includeInactive = true): Promise<AdminStaff[]> {
  const rows = await q<StaffRow & { created_at: Date; updated_at: Date }>(`SELECT * FROM staff WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND active = true'}`);
  const key = (s: StaffRow) => s.staff_kana || 'んんん' + s.staff_name;
  rows.sort((a, b) => key(a).localeCompare(key(b), 'ja'));
  return rows.map(adminView);
}

export interface StaffInput { staff_name?: string; staff_kana?: string; employee_id?: string | null; email?: string | null; active?: boolean; pin?: string | null }

export async function createStaff(input: StaffInput, actor: Actor): Promise<AdminStaff> {
  const name = stripSpaces(input.staff_name);
  if (!name) throw badRequest('氏名を入力してください', 'NAME_REQUIRED', 'staff_name');
  const kana = stripSpaces(input.staff_kana);
  const emp = input.employee_id ? padEmpId(input.employee_id) : await nextEmployeeId();
  if (input.pin !== undefined && input.pin !== null && input.pin !== '' && !isValidPin(input.pin)) throw badRequest('暗証番号は4桁の数字です', 'BAD_PIN', 'pin');
  const dup = await one('SELECT id FROM staff WHERE deleted_at IS NULL AND staff_name = $1', [name]);
  if (dup) throw conflict(`「${name}」はすでに登録されています（同姓同名の場合は名前に区別を付けてください）`, 'NAME_DUPLICATE');
  return tx(async (c) => {
    const row = await one<StaffRow & { created_at: Date; updated_at: Date }>(
      'INSERT INTO staff (staff_name, staff_kana, employee_id, email, active, pin_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, kana, emp || null, input.email?.trim() || null, input.active ?? true, input.pin ? hashPin(input.pin) : null], c);
    await audit(actor, 'staff.create', row!.id, null, adminView(row!), c);
    return adminView(row!);
  });
}

export async function updateStaff(id: string, input: StaffInput, actor: Actor): Promise<AdminStaff> {
  const cur = await one<StaffRow & { created_at: Date; updated_at: Date }>('SELECT * FROM staff WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!cur) throw notFound('スタッフが見つかりません');
  const name = input.staff_name === undefined ? cur.staff_name : stripSpaces(input.staff_name);
  if (!name) throw badRequest('氏名を入力してください', 'NAME_REQUIRED', 'staff_name');
  const kana = input.staff_kana === undefined ? cur.staff_kana : stripSpaces(input.staff_kana);
  const emp = input.employee_id === undefined ? cur.employee_id : (input.employee_id ? padEmpId(input.employee_id) : null);
  if (input.pin && !isValidPin(input.pin)) throw badRequest('暗証番号は4桁の数字です', 'BAD_PIN', 'pin');
  return tx(async (c) => {
    const before = adminView(cur);
    const row = await one<StaffRow & { created_at: Date; updated_at: Date }>(
      `UPDATE staff SET staff_name=$2, staff_kana=$3, employee_id=$4, email=$5, active=$6, pin_hash=COALESCE($7, pin_hash), pin_hash_legacy=CASE WHEN $7::text IS NULL THEN pin_hash_legacy ELSE NULL END, pin_fail_count=CASE WHEN $7::text IS NULL THEN pin_fail_count ELSE 0 END, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, name, kana, emp, input.email === undefined ? cur.email : (input.email?.trim() || null), input.active ?? cur.active, input.pin ? hashPin(input.pin) : null], c);
    // 氏名・従業員IDの変更は今後の打刻に反映（過去の勤怠行の複製値は当時のまま）
    await audit(actor, 'staff.update', id, before, { ...adminView(row!), pin_changed: !!input.pin }, c);
    return adminView(row!);
  });
}

/** 新規登録時の仮番号：既存の最大＋1（正本「従業員リスト」での採番は連携機能で置き換える） */
export async function nextEmployeeId(): Promise<string> {
  const r = await one<{ m: number | null }>(`SELECT max(employee_id::int) AS m FROM staff WHERE deleted_at IS NULL AND employee_id ~ '^[0-9]+$'`);
  return padEmpId(String((r?.m ?? 0) + 1));
}

export { actorStr, isUniqueViolation };
