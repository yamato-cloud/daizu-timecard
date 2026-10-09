/**
 * API 統合テスト（PostgreSQL 必須：DATABASE_URL_TEST、既定 postgres://daizu:daizu@localhost/daizu_timecard_test）。
 * 12章 §2 業務フロー F2〜F4, F8〜F11, F13, F14, F16 と §4 権限 S1〜S3 をサーバー API で検証する。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/server/app.js';
import { pool, migrate, closeDb, q } from '../src/server/db.js';
import { markOverdue } from '../src/server/services/attendance.js';
import { tick } from '../src/server/jobs.js';

let app: FastifyInstance;

/** Cookie を保持する簡易クライアント */
class Client {
  jar: Record<string, string> = {};
  constructor(private app: FastifyInstance) {}
  async call(method: InjectOptions['method'], url: string, body?: unknown) {
    const res = await this.app.inject({ method, url, payload: body as object, headers: { cookie: Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' } });
    for (const c of res.cookies) { if (c.value === '' || (c.expires && c.expires.getTime() < Date.now())) delete this.jar[c.name]; else this.jar[c.name] = c.value; }
    return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) : null, headers: res.headers };
  }
  get(url: string) { return this.call('GET', url); }
  post(url: string, body?: unknown) { return this.call('POST', url, body ?? {}); }
  put(url: string, body?: unknown) { return this.call('PUT', url, body ?? {}); }
  del(url: string, body?: unknown) { return this.call('DELETE', url, body ?? {}); }
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  app = await buildApp({ logger: false });
  // シード：事業所
  const locs = [
    ['GH01', 'GH行田', 'グループホーム', false, true, true],
    ['GH02', 'うさぎハウスGH 鴻巣', 'うさぎハウス', false, true, false],
    ['DK01', '大吉 川越南大塚店', '飲食', true, false, false],
  ];
  for (const [code, name, dep, alc, extras, rule] of locs) {
    await q('INSERT INTO locations (location_code, location_name, department, check_alcohol, gh_extras, gh_break_rule) VALUES ($1,$2,$3,$4,$5,$6)', [code, name, dep, alc, extras, rule]);
  }
  // シード：スタッフ（PIN 0000 / 0123 / 旧方式ハッシュ 1234 / PIN未設定）
  const { hashPin } = await import('../src/server/auth.js');
  const s1 = await q<{ id: string }>("INSERT INTO staff (employee_id, staff_name, staff_kana, pin_hash) VALUES ('001','山田太郎','やまだたろう',$1) RETURNING id", [hashPin('0000')]);
  const s2 = await q<{ id: string }>("INSERT INTO staff (employee_id, staff_name, staff_kana, pin_hash) VALUES ('002','佐藤花子','さとうはなこ',$1) RETURNING id", [hashPin('0123')]);
  const s3 = await q<{ id: string }>("INSERT INTO staff (employee_id, staff_name, staff_kana, pin_hash_legacy) VALUES ('003','鈴木一郎','すずきいちろう',$1) RETURNING id", [createHash('sha256').update('1234').digest('hex')]);
  const s4 = await q<{ id: string }>("INSERT INTO staff (employee_id, staff_name, staff_kana) VALUES ('004','高橋未設定','たかはしみせってい') RETURNING id");
  ids['yamada'] = s1[0]!.id; ids['sato'] = s2[0]!.id; ids['suzuki'] = s3[0]!.id; ids['takahashi'] = s4[0]!.id;
});
afterAll(async () => { await app.close(); await closeDb(); });

async function adminClient(): Promise<Client> {
  const c = new Client(app);
  const r = await c.post('/api/auth/emergency', { token: 'test-emergency-token', email: 'yamato@daizu.info' });
  expect(r.status).toBe(200);
  return c;
}
async function kioskClient(pin = '7777'): Promise<Client> {
  const c = new Client(app);
  const r = await c.post('/api/kiosk/gate', { pin });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return c;
}

describe('権限：起動PIN・管理ログイン', () => {
  it('S2 未ログインで管理API は 401、起動PIN未通過で打刻API は 401', async () => {
    const c = new Client(app);
    expect((await c.get('/api/admin/staff')).status).toBe(401);
    expect((await c.get('/api/kiosk/bootstrap')).status).toBe(401);
    expect((await c.get('/api/my/bootstrap')).status).toBe(401);
  });
  it('起動PIN未設定の間は端末を通さない（理由を返す）', async () => {
    const c = new Client(app);
    const r = await c.post('/api/kiosk/gate', { pin: '7777' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('GATE_NOT_SET');
  });
  it('管理者が起動PINを設定できる', async () => {
    const a = await adminClient();
    const r = await a.put('/api/admin/settings/gate-pin', { pin: '7777' });
    expect(r.status).toBe(200);
    const s = await a.put('/api/admin/settings', { payroll_notify_emails: 'kyuyo@example.com', admin_notify_emails: 'yamato@daizu.info' });
    expect(s.status).toBe(200);
  });
  it('M12 起動PIN：5回失敗でその端末だけ5分ロック。正しいPINなら通る', async () => {
    const c = new Client(app);
    for (let i = 1; i <= 5; i++) {
      const r = await c.post('/api/kiosk/gate', { pin: '0001' });
      expect(r.status).toBe(401);
    }
    const locked = await c.post('/api/kiosk/gate', { pin: '7777' });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('GATE_LOCKED');
    // 別の端末は影響なし
    const other = new Client(app);
    expect((await other.post('/api/kiosk/gate', { pin: '7777' })).status).toBe(200);
  });
  it('S1 名簿に pin_hash・email が含まれない', async () => {
    const k = await kioskClient();
    const r = await k.get('/api/kiosk/bootstrap');
    expect(r.status).toBe(200);
    expect(r.body.staff.length).toBe(4);
    for (const s of r.body.staff) { expect(s.pin_hash).toBeUndefined(); expect(s.pin_hash_legacy).toBeUndefined(); expect(s.email).toBeUndefined(); }
    expect(r.body.staff.map((s: { staff_name: string }) => s.staff_name)).toEqual(['佐藤花子', '鈴木一郎', '高橋未設定', '山田太郎']);
  });
  it('S3 緊急ログインを10回失敗で一時ロック', async () => {
    const c = new Client(app);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.post('/api/auth/emergency', { token: 'wrong' })).status;
    expect(last).toBe(429);
    await q("DELETE FROM auth_failures WHERE scope = 'admin'");
  });
});

describe('打刻フロー', () => {
  it('F14 PIN 0000 / 0123 で出勤できる。旧ハッシュ(1234)も通り新方式へ移行', async () => {
    const k = await kioskClient();
    const r1 = await k.post('/api/kiosk/clock-in', { staff_id: ids['yamada'], pin: '0000', location_code: 'GH01', request_id: 'req-1' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.record.status).toBe('WORKING');
    expect(r1.body.record.location_name).toBe('GH行田');
    ids['att_yamada'] = r1.body.record.id;
    const r2 = await k.post('/api/kiosk/clock-in', { staff_id: ids['sato'], pin: '0123', location_code: 'GH02', request_id: 'req-2' });
    expect(r2.status).toBe(200);
    ids['att_sato'] = r2.body.record.id;
    const r3 = await k.post('/api/kiosk/clock-in', { staff_id: ids['suzuki'], pin: '1234', location_code: 'DK01', request_id: 'req-3', alcohol_check: '0.00' });
    expect(r3.status, JSON.stringify(r3.body)).toBe(200);
    ids['att_suzuki'] = r3.body.record.id;
    const st = await q<{ pin_hash: string | null; pin_hash_legacy: string | null }>('SELECT pin_hash, pin_hash_legacy FROM staff WHERE id = $1', [ids['suzuki']]);
    expect(st[0]!.pin_hash).toMatch(/^s1\$/);
    expect(st[0]!.pin_hash_legacy).toBeNull();
  });
  it('PIN違い・PIN未設定・アルコール未入力は理由付きで拒否', async () => {
    const k = await kioskClient();
    const bad = await k.post('/api/kiosk/clock-in', { staff_id: ids['takahashi'], pin: '0000', location_code: 'GH01' });
    expect(bad.status).toBe(401); expect(bad.body.code).toBe('PIN_NOT_SET');
    await q('UPDATE staff SET pin_hash = $2 WHERE id = $1', [ids['takahashi'], (await import('../src/server/auth.js')).hashPin('5555')]);
    const wrong = await k.post('/api/kiosk/clock-in', { staff_id: ids['takahashi'], pin: '0000', location_code: 'GH01' });
    expect(wrong.status).toBe(401); expect(wrong.body.error).toBe('暗証番号が違います');
    const alc = await k.post('/api/kiosk/clock-in', { staff_id: ids['takahashi'], pin: '5555', location_code: 'DK01' });
    expect(alc.status).toBe(400); expect(alc.body.code).toBe('ALCOHOL_REQUIRED');
  });
  it('F16 二重タップ（同じ request_id）は1件だけ', async () => {
    const k = await kioskClient();
    const r = await k.post('/api/kiosk/clock-in', { staff_id: ids['yamada'], pin: '0000', location_code: 'GH01', request_id: 'req-1' });
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.record.id).toBe(ids['att_yamada']);
    const n = await q<{ c: number }>('SELECT count(*)::int AS c FROM attendance WHERE staff_id = $1', [ids['yamada']]);
    expect(n[0]!.c).toBe(1);
  });
  it('F2 同じ人が再度出勤 → 「すでにお仕事中」拒否', async () => {
    const k = await kioskClient();
    const r = await k.post('/api/kiosk/clock-in', { staff_id: ids['yamada'], pin: '0000', location_code: 'GH02', request_id: 'req-9' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('ALREADY_WORKING');
    expect(r.body.error).toContain('すでにお仕事中');
  });
  it('N4 5人同時出勤：全員成功・取りこぼしなし（DB の一意制約で二重も防ぐ）', async () => {
    const { hashPin } = await import('../src/server/auth.js');
    const five: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await q<{ id: string }>(`INSERT INTO staff (employee_id, staff_name, staff_kana, pin_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [`1${i}0`, `同時${i}`, `どうじ${i}`, hashPin('1111')]);
      five.push(s[0]!.id);
    }
    const k = await kioskClient();
    const results = await Promise.all(five.map((id, i) => k.post('/api/kiosk/clock-in', { staff_id: id, pin: '1111', location_code: 'GH01', request_id: `same-${i}` })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    // 同じ人が同時に2回（request_id 違い）→ 1件だけ成功
    const dup = await Promise.all([0, 1, 2].map((i) => k.post('/api/kiosk/clock-in', { staff_id: five[0], pin: '1111', location_code: 'GH02', request_id: `dup-${i}` })));
    expect(dup.filter((r) => r.status === 200).length).toBe(0);
    const n = await q<{ c: number }>(`SELECT count(*)::int AS c FROM attendance WHERE staff_id = $1 AND status IN ('WORKING','OVERDUE')`, [five[0]]);
    expect(n[0]!.c).toBe(1);
    for (const id of five) await q("UPDATE attendance SET deleted_at = now() WHERE staff_id = $1", [id]);
  });
  it('勤務中一覧（事業所別）に出る', async () => {
    const k = await kioskClient();
    const r = await k.get('/api/kiosk/working?location_code=GH01');
    expect(r.status).toBe(200);
    expect(r.body.records.map((x: { staff_name: string }) => x.staff_name)).toEqual(['山田太郎']);
  });
  it('退勤：警告があれば理由必須（422 NEEDS_REASON）、理由を付ければ DONE。計算はサーバー', async () => {
    const k = await kioskClient();
    // 出勤を「昨日 09:00」に固定（テストのため直接書き換え。未来時刻の退勤を避ける）
    await q("UPDATE attendance SET work_date = (now() AT TIME ZONE 'Asia/Tokyo')::date - 1, clock_in_at = (((now() AT TIME ZONE 'Asia/Tokyo')::date - 1)::text || ' 09:00+09')::timestamptz WHERE id = $1", [ids['att_yamada']]);
    const row = await q<{ work_date: string }>('SELECT work_date FROM attendance WHERE id = $1', [ids['att_yamada']]);
    const wd = row[0]!.work_date;
    // 18:30 退勤・休憩0 → 法定不足＋8h超休憩0 の警告
    const r1 = await k.post('/api/kiosk/clock-out', { attendance_id: ids['att_yamada'], clock_out: '18:30', clock_out_date: wd, break_minutes: 0 });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('NEEDS_REASON');
    // GH行田は GH休憩ルール対象：16:00〜18:30 の夕方帯 150分 → 「夕方のみ」想定30分 → 入力0 で相違
    expect(r1.body.missing.sort()).toEqual(['anomaly', 'gh', 'statutory']);
    expect(r1.body.preview.work_minutes).toBe(570);
    const r2 = await k.post('/api/kiosk/clock-out', { attendance_id: ids['att_yamada'], clock_out: '18:30', clock_out_date: wd, break_minutes: 0, reasons: { statutory: '利用者対応で休めず', anomaly: '同上', gh: '夕方の対応' }, comment: '備考です', travel_km: 2.5 });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    const rec = r2.body.record;
    expect(rec.status).toBe('DONE');
    expect(rec.work_minutes).toBe(570);
    expect(rec.night_minutes).toBe(0);
    expect(rec.travel_fee).toBe(50);
    expect(rec.staff_comment).toBe('備考です');
    expect(rec.staff_comment_full).toBe('【GH休憩確認：設定30分/入力0分・-30分(夕方のみ)】夕方の対応 ／ 【打刻時警告確認：8h超休憩0】同上 ／ 【休憩0分（法定60分未満）理由】利用者対応で休めず ／ 備考です');
    // 二重タップ：すでに退勤済み
    const r3 = await k.post('/api/kiosk/clock-out', { attendance_id: ids['att_yamada'], clock_out: '18:30', clock_out_date: wd });
    expect(r3.status).toBe(409);
    expect(r3.body.code).toBe('ALREADY_DONE');
  });
  it('GH系（gh_extras）の手当・まかない、GH休憩ルール（gh_break_rule）はフラグで判定', async () => {
    const k = await kioskClient();
    // 佐藤：うさぎハウスGH 鴻巣（gh_extras のみ・GH休憩ルール対象外）。16:00→翌9:00 休憩180 → GH警告は出ず、非GHの「休憩過多」警告（理由必須）になる
    await q("UPDATE attendance SET work_date = (now() AT TIME ZONE 'Asia/Tokyo')::date - 2, clock_in_at = (((now() AT TIME ZONE 'Asia/Tokyo')::date - 2)::text || ' 16:00+09')::timestamptz WHERE id = $1", [ids['att_sato']]);
    const wd = (await q<{ work_date: string }>('SELECT work_date FROM attendance WHERE id = $1', [ids['att_sato']]))[0]!.work_date;
    const { addDays } = await import('../src/calc/index.js');
    const w = await k.post('/api/kiosk/clock-out', { attendance_id: ids['att_sato'], clock_out: '09:00', clock_out_date: addDays(wd, 1), break_minutes: 60, night_break_minutes: 120, allowance_amount: 1000, meal_count: 2 });
    expect(w.status).toBe(422);
    expect(w.body.missing).toEqual(['excess']);
    const r = await k.post('/api/kiosk/clock-out', { attendance_id: ids['att_sato'], clock_out: '09:00', clock_out_date: addDays(wd, 1), break_minutes: 60, night_break_minutes: 120, allowance_amount: 1000, meal_count: 2, reasons: { excess: '夜間の仮眠' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.record.staff_comment_full).toBe('【休憩乖離確認：休憩180分（規定60分±15・目安上限75分・+105分）】夜間の仮眠');
    expect(r.body.record.allowance_note).toBe('手作り料理手当');
    expect(r.body.record.meal_fee).toBe(500);
    expect(r.body.record.work_minutes).toBe(840);
    expect(r.body.record.night_minutes).toBe(360);
    expect(r.body.record.overnight).toBe(true);
  });
  it('出勤取消は PIN 必須', async () => {
    const k = await kioskClient();
    const r = await k.post('/api/kiosk/cancel-open', { attendance_id: ids['att_suzuki'], pin: '0000' });
    expect(r.status).toBe(401);
    const ok = await k.post('/api/kiosk/cancel-open', { attendance_id: ids['att_suzuki'], pin: '1234' });
    expect(ok.status).toBe(200);
    expect(ok.body.record.deleted_at).toBeTruthy();
  });
});

describe('退勤忘れ（OVERDUE）', () => {
  it('F3 24時間超で OVERDUE（サーバー定期処理）。退勤は時刻の手入力必須', async () => {
    const k = await kioskClient();
    const r = await k.post('/api/kiosk/clock-in', { staff_id: ids['suzuki'], pin: '1234', location_code: 'DK01', request_id: 'req-od', alcohol_check: '0.00' });
    expect(r.status).toBe(200);
    ids['att_od'] = r.body.record.id;
    await q("UPDATE attendance SET clock_in_at = now() - interval '26 hours', work_date = (now() - interval '26 hours')::date WHERE id = $1", [ids['att_od']]);
    expect(await markOverdue()).toBe(1);
    expect(await markOverdue()).toBe(0); // 冪等
    const w = await k.get('/api/kiosk/working');
    expect(w.body.records.find((x: { id: string }) => x.id === ids['att_od']).status).toBe('OVERDUE');
    const noTime = await k.post('/api/kiosk/clock-out', { attendance_id: ids['att_od'] });
    expect(noTime.status).toBe(400);
    expect(noTime.body.code).toBe('CLOCK_OUT_REQUIRED');
  });
  it('F4 OVERDUE の人が出勤 → HAS_OPEN（先に締める）。締めた後は出勤できる', async () => {
    const k = await kioskClient();
    const r = await k.post('/api/kiosk/clock-in', { staff_id: ids['suzuki'], pin: '1234', location_code: 'DK01', request_id: 'req-od2', alcohol_check: '0.00' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('HAS_OPEN');
    expect(r.body.open.id).toBe(ids['att_od']);
    const rec = r.body.open;
    // 退勤 = 出勤の 8 時間後（出勤と同じ日付）
    const { toMin, toHHMM } = await import('../src/calc/index.js');
    const outTime = toHHMM(toMin(rec.clock_in)! + 480);
    const overnight = toMin(rec.clock_in)! + 480 >= 1440;
    const { addDays } = await import('../src/calc/index.js');
    const close = await k.post('/api/kiosk/clock-out', { attendance_id: ids['att_od'], clock_out: outTime, clock_out_date: overnight ? addDays(rec.work_date, 1) : rec.work_date, break_minutes: 60 });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(close.body.record.status).toBe('DONE');
    expect(close.body.record.work_minutes).toBe(420);
    const again = await k.post('/api/kiosk/clock-in', { staff_id: ids['suzuki'], pin: '1234', location_code: 'DK01', request_id: 'req-od3', alcohol_check: '0.00' });
    expect(again.status).toBe(200);
    ids['att_suzuki2'] = again.body.record.id;
  });
});

describe('マイページ（本人の記録）', () => {
  async function staffClient(staffId: string, pin: string): Promise<Client> {
    const c = await kioskClient();
    const r = await c.post('/api/my/login', { staff_id: staffId, pin });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return c;
  }
  it('ログイン後に当月の記録が見える', async () => {
    const c = await staffClient(ids['yamada']!, '0000');
    const me = await c.get('/api/my/me');
    expect(me.body.staff.staff_name).toBe('山田太郎');
    const r = await c.get(`/api/my/records?ym=${me.body.today.slice(0, 7)}`);
    expect(r.status).toBe(200);
    expect(r.body.records.length).toBeGreaterThanOrEqual(1);
    expect(r.body.records[0].self_editable).toBe(true);
  });
  it('F10 他人の記録は取消・修正できない（API 直叩き）', async () => {
    const c = await staffClient(ids['sato']!, '0123');
    const d = await c.del(`/api/my/records/${ids['att_yamada']}`);
    expect(d.status).toBe(403);
    expect(d.body.code).toBe('NOT_OWNER');
    const e = await c.put(`/api/my/records/${ids['att_yamada']}`, { clock_in: '09:00', clock_out: '18:00', break_minutes: 60, correction_reason: 'x' });
    expect(e.status).toBe(403);
  });
  it('本人の修正：理由必須・サーバーで再計算', async () => {
    const c = await staffClient(ids['yamada']!, '0000');
    const noReason = await c.put(`/api/my/records/${ids['att_yamada']}`, { clock_in: '09:00', clock_out: '18:00', break_minutes: 60 });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('REASON_REQUIRED');
    // GH行田は GH休憩ルール対象：09:00〜18:00 は「夕方のみ」想定30分 → 60分は +30 で理由必須
    const needs = await c.put(`/api/my/records/${ids['att_yamada']}`, { clock_in: '09:00', clock_out: '18:00', break_minutes: 60, correction_reason: '退勤時刻の入力ミス' });
    expect(needs.status).toBe(422);
    expect(needs.body.missing).toEqual(['gh']);
    const ok = await c.put(`/api/my/records/${ids['att_yamada']}`, { clock_in: '09:00', clock_out: '18:00', break_minutes: 60, correction_reason: '退勤時刻の入力ミス', reasons: { gh: '昼休憩' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.record.work_minutes).toBe(480);
    expect(ok.body.record.staff_comment_full).toBe('【GH休憩確認：設定30分/入力60分・+30分(夕方のみ)】昼休憩');
    expect(ok.body.record.correction_reason).toBe('退勤時刻の入力ミス');
  });
  it('F12 記録追加で日付が今日のまま → 確認（CONFIRM_TODAY）、confirm_today で登録', async () => {
    const c = await staffClient(ids['sato']!, '0123');
    const today = (await c.get('/api/my/me')).body.today;
    const r = await c.post('/api/my/records', { work_date: today, location_code: 'GH02', clock_in: '10:00', clock_out: '12:00', correction_reason: '打刻忘れ' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('CONFIRM_TODAY');
    const ok = await c.post('/api/my/records', { work_date: today, location_code: 'GH02', clock_in: '10:00', clock_out: '12:00', correction_reason: '打刻忘れ', confirm_today: true });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.record.status).toBe('DONE');
    expect(ok.body.record.work_minutes).toBe(120);
    ids['att_sato_add'] = ok.body.record.id;
  });
  it('F8 当月分の取消は成功、F9 前月分は翌月7日まで（期限後は理由表示）', async () => {
    const c = await staffClient(ids['sato']!, '0123');
    const d = await c.del(`/api/my/records/${ids['att_sato_add']}`);
    expect(d.status).toBe(200);
    // 前々月の記録を作り、期限切れを確認
    const { addDays } = await import('../src/calc/index.js');
    const today = (await c.get('/api/my/me')).body.today;
    const old = addDays(today, -70);
    const a = await adminClient();
    const made = await a.post('/api/admin/attendance', { staff_id: ids['sato'], work_date: old, location_code: 'GH02', clock_in: '09:00', clock_out: '12:00', correction_reason: 'テスト' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const late = await c.del(`/api/my/records/${made.body.record.id}`);
    expect(late.status).toBe(403);
    expect(late.body.code).toBe('DEADLINE_PASSED');
    expect(late.body.error).toContain('期限');
    // 管理者なら消せる
    expect((await a.del(`/api/admin/attendance/${made.body.record.id}`)).status).toBe(200);
  });
  it('F11 WORKING の誤出勤を本人が取り消せる', async () => {
    const c = await staffClient(ids['suzuki']!, '1234');
    const d = await c.del(`/api/my/records/${ids['att_suzuki2']}`);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
  });
  it('F13 有給：同日重複は拒否。全休1.0・半休0.5', async () => {
    const c = await staffClient(ids['yamada']!, '0000');
    const today = (await c.get('/api/my/me')).body.today;
    const { addDays } = await import('../src/calc/index.js');
    const d = addDays(today, 3);
    const r1 = await c.post('/api/my/leave', { work_date: d, type: 'am', reason: '通院' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.record.status).toBe('PAID_LEAVE_AM');
    expect(r1.body.record.leave_days).toBe(0.5);
    const r2 = await c.post('/api/my/leave', { work_date: d, type: 'full' });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('LEAVE_DUPLICATE');
  });
  it('M6 暗証番号変更：現在のPINで本人確認', async () => {
    const k = await kioskClient();
    const bad = await k.post('/api/my/pin', { staff_id: ids['yamada'], current_pin: '9999', new_pin: '0001' });
    expect(bad.status).toBe(401);
    const ok = await k.post('/api/my/pin', { staff_id: ids['yamada'], current_pin: '0000', new_pin: '0001' });
    expect(ok.status).toBe(200);
    expect((await k.post('/api/my/login', { staff_id: ids['yamada'], pin: '0001' })).status).toBe(200);
    await k.post('/api/my/pin', { staff_id: ids['yamada'], current_pin: '0001', new_pin: '0000' });
  });
  it('PIN 5回失敗で30秒待ち（完全ロックはしない）', async () => {
    const k = await kioskClient();
    for (let i = 0; i < 5; i++) expect((await k.post('/api/my/login', { staff_id: ids['yamada'], pin: '9999' })).status).toBe(401);
    const r = await k.post('/api/my/login', { staff_id: ids['yamada'], pin: '0000' });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('PIN_DELAY');
    await q('UPDATE staff SET pin_fail_count = 0, pin_fail_last = NULL WHERE id = $1', [ids['yamada']]);
  });
});

describe('管理：スタッフ・事業所・勤怠・給与', () => {
  it('スタッフ追加（空白除去・3桁ID）と更新・無効化', async () => {
    const a = await adminClient();
    const r = await a.post('/api/admin/staff', { staff_name: '新井 大和', staff_kana: 'あらい　やまと', employee_id: '7', pin: '2468' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.staff.staff_name).toBe('新井大和');
    expect(r.body.staff.staff_kana).toBe('あらいやまと');
    expect(r.body.staff.employee_id).toBe('007');
    const u = await a.put(`/api/admin/staff/${r.body.staff.id}`, { active: false, email: 'arai@example.com' });
    expect(u.status).toBe(200);
    expect(u.body.staff.active).toBe(false);
    const list = await a.get('/api/admin/staff');
    expect(list.body.staff.find((s: { id: string }) => s.id === r.body.staff.id).email).toBe('arai@example.com');
    expect(list.body.staff.find((s: { id: string }) => s.id === ids['yamada']).main_department).toBe('グループホーム');
  });
  it('事業所：事業部必須、GHフラグ2種', async () => {
    const a = await adminClient();
    const bad = await a.post('/api/admin/locations', { location_code: 'GH03', location_name: 'GH門井町' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('DEPARTMENT_REQUIRED');
    const ok = await a.post('/api/admin/locations', { location_code: 'GH03', location_name: 'GH門井町', department: 'グループホーム', gh_extras: true, gh_break_rule: true });
    expect(ok.status).toBe(200);
    expect(ok.body.location.gh_break_rule).toBe(true);
  });
  it('勤怠一覧・管理者編集（理由必須）・削除・復元・期限後の有給追加', async () => {
    const a = await adminClient();
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const list = await a.get(`/api/admin/attendance?ym=${today.slice(0, 7)}`);
    expect(list.status).toBe(200);
    expect(list.body.records.length).toBeGreaterThan(0);
    const noReason = await a.put(`/api/admin/attendance/${ids['att_yamada']}`, { break_minutes: 45 });
    expect(noReason.status).toBe(400);
    // 実働495分 > 8h なので法定60分が必要 → 理由必須（既存の GH 理由は引き継がれる）
    const needs = await a.put(`/api/admin/attendance/${ids['att_yamada']}`, { break_minutes: 45, correction_reason: '休憩の訂正' });
    expect(needs.status).toBe(422);
    expect(needs.body.missing).toEqual(['statutory']);
    const edit = await a.put(`/api/admin/attendance/${ids['att_yamada']}`, { break_minutes: 45, correction_reason: '休憩の訂正', reasons: { statutory: '業務都合' } });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.record.work_minutes).toBe(495);
    const { addDays } = await import('../src/calc/index.js');
    const lv = await a.post('/api/admin/leave', { staff_id: ids['yamada'], work_date: addDays(today, -80), type: 'full', reason: '期限後の追加' });
    expect(lv.status, JSON.stringify(lv.body)).toBe(200);
    const del = await a.del(`/api/admin/attendance/${lv.body.record.id}`, { reason: '誤登録' });
    expect(del.status).toBe(200);
    const res = await a.post(`/api/admin/attendance/${lv.body.record.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.record.deleted_at).toBeNull();
    await a.del(`/api/admin/attendance/${lv.body.record.id}`);
  });
  it('給与CSV：プレビュー・ダウンロード（BOM/CRLF/引用符）・P7 論理削除は含まない・手動送信', async () => {
    const a = await adminClient();
    const ym = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7);
    const pv = await a.get(`/api/admin/payroll/preview?ym=${ym}`);
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    const yamada = pv.body.staff.find((s: { employee_id: string }) => s.employee_id === '001');
    expect(yamada.work_minutes).toBe(495);
    expect(yamada.leave_count).toBe(1);
    // 削除済み（att_sato_add、同時テストの5人）は含まれない
    expect(pv.body.staff.find((s: { staff_name: string }) => s.staff_name.startsWith('同時'))).toBeUndefined();
    const csv = await a.get(`/api/admin/payroll/csv?ym=${ym}&file=summary`);
    expect(csv.status).toBe(200);
    const text = String(csv.body);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('"対象月","従業員ID","スタッフ名","出勤日数","勤務回数","実働(時間)","深夜実働(時間)","通常休憩(時間)","深夜休憩(時間)","移動km","移動交通費(円)","手当合計(円)","手当内訳","まかない(円)","有給日数","有給件数","未退勤(要確認)"');
    const detail = await a.get(`/api/admin/payroll/csv?ym=${ym}&file=detail`);
    // 管理者が休憩45に直した後：GH理由は引き継がれラベルは再計算、修正理由は別列
    expect(String(detail.body)).toContain('"退勤済み","","","【GH休憩確認：設定30分/入力45分・+15分(夕方のみ)】昼休憩 ／ 【休憩45分（法定60分未満）理由】業務都合","休憩の訂正"');
    const send = await a.post('/api/admin/payroll/send', { ym });
    expect(send.status, JSON.stringify(send.body)).toBe(200);
    expect(send.body.sent_to).toEqual(['kyuyo@example.com']);
    const log = await a.get('/api/mail-log'.replace('/api/', '/api/admin/'));
    expect(log.body.items[0].subject).toBe(`💰 給与計算用データ ${ym} 分（手動送信）`);
  });
  it('P6 定期処理の給与送信は期間キーで1回だけ（冪等）', async () => {
    const { prevYm } = await import('../src/calc/index.js');
    const ym = prevYm(new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 7));
    // 8日 7:05 JST を仮定して2回 tick
    const [y, m] = ym.split('-').map(Number) as [number, number];
    const sendDayMs = Date.UTC(y, m, 8, 7 - 9, 5); // 翌月8日 07:05 JST
    const before = (await q<{ c: number }>("SELECT count(*)::int AS c FROM mail_log WHERE kind = 'payroll' AND subject LIKE '%自動送信%'"))[0]!.c;
    await tick(sendDayMs);
    await tick(sendDayMs + 60e3);
    await tick(sendDayMs + 3600e3);
    const after = (await q<{ c: number }>("SELECT count(*)::int AS c FROM mail_log WHERE kind = 'payroll' AND subject LIKE '%自動送信%'"))[0]!.c;
    expect(after - before).toBe(1);
    const run = await q<{ ok: boolean; period_key: string }>("SELECT ok, period_key FROM job_runs WHERE job_name = 'payroll'");
    expect(run[0]).toEqual({ ok: true, period_key: ym });
    // 7日ならまだ送らない
    const earlier = Date.UTC(y, m, 7, 7 - 9, 5);
    await q("DELETE FROM job_runs WHERE job_name = 'payroll'");
    await tick(earlier);
    expect((await q("SELECT 1 FROM job_runs WHERE job_name = 'payroll'")).length).toBe(0);
  });
  it('バックアップ（CSV 書き出し）が動く', async () => {
    const a = await adminClient();
    const r = await a.post('/api/admin/jobs/backup/run');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result.ok).toBe(true);
    expect(r.body.result.detail).toContain('CSV 5表');
  });
  it('監査ログに操作が残る', async () => {
    const a = await adminClient();
    const r = await a.get('/api/admin/audit?limit=300');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(5);
    expect(r.body.items.some((x: { action: string }) => x.action === 'attendance.clock_out')).toBe(true);
  });
});
