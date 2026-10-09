/**
 * 打刻端末 API。起動PIN（端末登録）を通った端末だけが使える。
 * 出勤は PIN 必須、退勤は PIN なし（大和さん判断・現行踏襲）、出勤取消は PIN 必須（危険操作）。
 */
import type { FastifyInstance } from 'fastify';
import { APP_VERSION } from '../config.js';
import { q } from '../db.js';
import { requireKiosk, deviceKey, checkGateLock, recordFailure, clearFailures, verifyGatePin, createSession, isValidPin, GATE_MAX_FAILS } from '../auth.js';
import { badRequest, unauthorized } from '../errors.js';
import { allSettings, getSetting, PUBLIC_SETTING_KEYS } from '../settings.js';
import { audit, type Actor } from '../audit.js';
import { roster, verifyStaffPin } from '../services/staff.js';
import { clockIn, clockOut, cancelRecord, openRecords, presentRow, getAttendance, type LocationRow } from '../services/attendance.js';
import type { WarningKey } from '../../calc/index.js';

const kioskActor = (deviceId: string, ip: string): Actor => ({ kind: 'kiosk', id: deviceId, label: `kiosk:${deviceId.slice(0, 8)}`, ip });

export async function locationsPublic(): Promise<Array<Pick<LocationRow, 'location_code' | 'location_name' | 'department' | 'sort_order' | 'check_alcohol' | 'gh_extras' | 'gh_break_rule'>>> {
  return q('SELECT location_code, location_name, department, sort_order, check_alcohol, gh_extras, gh_break_rule FROM locations WHERE deleted_at IS NULL AND active = true ORDER BY sort_order, location_name');
}

export async function kioskRoutes(app: FastifyInstance): Promise<void> {
  /** 起動PIN：その端末だけ・5回失敗で5分ロック */
  app.post<{ Body: { pin?: string } }>('/gate', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const key = deviceKey(req, reply);
    await checkGateLock('gate', key);
    const pin = String(req.body?.pin ?? '');
    if (!isValidPin(pin)) throw badRequest('起動PINは4桁の数字です', 'BAD_PIN', 'pin');
    const configured = await getSetting('site_gate_pin_hash', '');
    if (!configured) throw unauthorized('起動PINがまだ設定されていません。管理者が管理画面の「設定」で設定してください', 'GATE_NOT_SET');
    if (!(await verifyGatePin(pin))) {
      const n = await recordFailure('gate', key);
      const left = GATE_MAX_FAILS - n;
      throw unauthorized(left > 0 ? `起動PINが違います（あと${left}回間違えると5分間ロックされます）` : '起動PINを5回間違えたため、この端末は5分間ロックされます', 'GATE_MISMATCH');
    }
    await clearFailures('gate', key);
    const ver = await getSetting('site_gate_version', '1');
    const deviceId = key.split('@')[0]!;
    await createSession('kiosk', deviceId, null, { gate_version: ver, ua: String(req.headers['user-agent'] ?? '').slice(0, 200) }, reply);
    await audit(kioskActor(deviceId, req.ip), 'gate.pass', null, null, null);
    return { ok: true };
  });

  app.get('/gate/status', async (req, reply) => {
    const configured = !!(await getSetting('site_gate_pin_hash', ''));
    try { await requireKiosk(req, reply); return { passed: true, configured }; } catch { return { passed: false, configured }; }
  });

  /** 起動時に必要なもの一式（事業所・名簿・公開設定・サーバー時刻） */
  app.get('/bootstrap', async (req, reply) => {
    await requireKiosk(req, reply);
    const s = await allSettings();
    return {
      version: APP_VERSION,
      server_time: new Date().toISOString(),
      locations: await locationsPublic(),
      staff: await roster(),
      settings: Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, s[k] ?? ''])),
    };
  });

  /** 勤務中（未退勤）一覧。事業所を指定すればその事業所のみ。全件返す（何か月前の OVERDUE も） */
  app.get<{ Querystring: { location_code?: string } }>('/working', async (req, reply) => {
    await requireKiosk(req, reply);
    const rows = await openRecords(req.query.location_code || undefined);
    return { records: rows.map(presentRow), server_time: new Date().toISOString() };
  });

  app.post<{ Body: { staff_id?: string; pin?: string; location_code?: string; request_id?: string; alcohol_check?: string } }>('/clock-in', async (req, reply) => {
    const sess = await requireKiosk(req, reply);
    const b = req.body ?? {};
    if (!b.staff_id) throw badRequest('スタッフを選んでください', 'STAFF_REQUIRED', 'staff_id');
    const staff = await verifyStaffPin(b.staff_id, b.pin, req.ip);
    const r = await clockIn({ staff_id: staff.id, location_code: String(b.location_code ?? ''), request_id: b.request_id, alcohol_check: b.alcohol_check ?? null }, kioskActor(sess.subject, req.ip));
    return { ok: true, record: r.record, duplicate: r.duplicate, message: r.duplicate ? `${staff.staff_name} さんの出勤はすでに記録されています` : `${staff.staff_name} さん、出勤を記録しました` };
  });

  app.post<{ Body: Record<string, unknown> }>('/clock-out', async (req, reply) => {
    const sess = await requireKiosk(req, reply);
    const b = req.body ?? {};
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));
    const r = await clockOut({
      attendance_id: String(b.attendance_id ?? ''),
      clock_out: b.clock_out ? String(b.clock_out) : null,
      clock_out_date: b.clock_out_date ? String(b.clock_out_date) : null,
      clock_in_fix: b.clock_in_fix ? String(b.clock_in_fix) : null,
      break_minutes: num(b.break_minutes), night_break_minutes: num(b.night_break_minutes), travel_km: num(b.travel_km),
      comment: b.comment == null ? null : String(b.comment),
      allowance_amount: num(b.allowance_amount), allowance_note: b.allowance_note == null ? null : String(b.allowance_note), meal_count: num(b.meal_count),
      reasons: (b.reasons && typeof b.reasons === 'object' ? b.reasons : {}) as Partial<Record<WarningKey, string>>,
    }, kioskActor(sess.subject, req.ip));
    return { ok: true, record: r, message: `${r.staff_name} さん、退勤を記録しました（実働 ${Math.floor((r.work_minutes ?? 0) / 60)}時間${(r.work_minutes ?? 0) % 60}分）` };
  });

  /** 出勤取消（誤って出勤した場合）。本人の PIN 必須 */
  app.post<{ Body: { attendance_id?: string; pin?: string; reason?: string } }>('/cancel-open', async (req, reply) => {
    const sess = await requireKiosk(req, reply);
    const b = req.body ?? {};
    const rec = await getAttendance(String(b.attendance_id ?? ''));
    if (!rec || rec.deleted_at) throw badRequest('この記録は見つかりません（すでに取り消された可能性があります）', 'NOT_FOUND');
    if (rec.status !== 'WORKING' && rec.status !== 'OVERDUE') throw badRequest('勤務中の記録だけ取り消せます', 'NOT_OPEN');
    const staff = await verifyStaffPin(rec.staff_id, b.pin, req.ip);
    const r = await cancelRecord(rec.id, { kind: 'staff', id: staff.id, label: `${staff.staff_name}(kiosk ${sess.subject.slice(0, 8)})`, ip: req.ip }, b.reason ?? '出勤取消（打刻端末）');
    return { ok: true, record: r, message: `${staff.staff_name} さんの出勤を取り消しました` };
  });
}
