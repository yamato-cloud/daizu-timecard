/**
 * 受入テスト 12章 §1「計算」C1〜C21 ＋ 現行 tests/calc-test.js・v2 calc-test.html 相当。
 * 給与に直結するため全件一致が必須。期待値は引継書 12_受入テスト.md の表のとおり。
 */
import { describe, it, expect } from 'vitest';
import {
  computeShift, span, ghExpectedBreak, statutoryBreak, composeStaffComment,
  leaveInfo, selfEditable, selfEditDeadline, isOverdue, isOverdueAt, mainDepartment, leaveDaysOf,
  toMin, toHHMM, addDays, isValidDate, minToDecimalHours, padEmpId, stripSpaces, jstToMs, msToJst, prevYm, ymRange,
} from '../src/calc/index.js';

type Row = { id: string; in: string; out: string; br: number; nbr: number; ov: boolean; work: number; night: number };
const C: Row[] = [
  { id: 'C1', in: '09:00', out: '18:00', br: 60, nbr: 0, ov: false, work: 480, night: 0 },
  { id: 'C2', in: '17:00', out: '23:00', br: 0, nbr: 0, ov: false, work: 360, night: 60 },
  { id: 'C3', in: '22:00', out: '05:00', br: 0, nbr: 0, ov: true, work: 420, night: 420 },
  { id: 'C4', in: '22:00', out: '06:00', br: 0, nbr: 60, ov: true, work: 420, night: 420 },
  { id: 'C5', in: '16:00', out: '09:00', br: 0, nbr: 180, ov: true, work: 840, night: 300 },
  { id: 'C6', in: '20:00', out: '04:00', br: 0, nbr: 0, ov: true, work: 480, night: 360 },
  { id: 'C7', in: '23:00', out: '23:30', br: 0, nbr: 0, ov: false, work: 30, night: 30 },
];

describe('12章 C1〜C7 実働・深夜', () => {
  for (const c of C) {
    it(`${c.id} ${c.in}→${c.out} 休憩${c.br}/${c.nbr} 日跨ぎ${c.ov ? 'あり' : 'なし'} → 実働${c.work} 深夜${c.night}`, () => {
      const r = computeShift({ clock_in: c.in, clock_out: c.out, break_minutes: c.br, night_break_minutes: c.nbr });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.overnight).toBe(c.ov);
      expect(r.work_minutes).toBe(c.work);
      expect(r.night_minutes).toBe(c.night);
    });
  }
  it('日跨ぎを明示（退勤日 > 出勤日）しても同じ結果', () => {
    const r = computeShift({ clock_in: '22:00', clock_out: '05:00', overnight: true });
    expect(r.ok && r.work_minutes === 420 && r.night_minutes === 420).toBe(true);
  });
  it('深夜帯：日跨ぎなしは翌5:00まで、日跨ぎありは翌6:00まで', () => {
    // 日跨ぎあり：翌5:00〜6:00 も深夜（23:00→翌7:00 = 420分）
    const b = computeShift({ clock_in: '23:00', clock_out: '07:00' });
    expect(b.ok && b.night_minutes).toBe(420);
    // 日跨ぎなし：深夜帯は「出勤日の 22:00〜翌5:00」。21:00→23:59 は 119分
    const c = computeShift({ clock_in: '21:00', clock_out: '23:59' });
    expect(c.ok && c.night_minutes).toBe(119);
    // ※現行踏襲の仕様：出勤日の 0:00〜5:00 は（日跨ぎなしでは）深夜帯に含まれない。
    //   00:00→07:00 の同日勤務は深夜 0 分になる（旧システムと同じ出力。README「確認事項」参照）
    const a = computeShift({ clock_in: '00:00', clock_out: '07:00' });
    expect(a.ok && a.night_minutes).toBe(0);
  });
  it('深夜は実働を超えない（逆転防止）', () => {
    // 22:00→05:00、通常休憩は入れられない（深夜帯のみ）ので 深夜休憩で検証
    const r = computeShift({ clock_in: '22:00', clock_out: '05:00', night_break_minutes: 120 });
    expect(r.ok && r.work_minutes).toBe(300);
    expect(r.ok && r.night_minutes).toBe(300);
    // 20:00→02:00（日跨ぎ・深夜240分）通常休憩60＋深夜休憩60 → 実働240、深夜 min(180,240)=180
    const s = computeShift({ clock_in: '20:00', clock_out: '02:00', break_minutes: 60, night_break_minutes: 60 });
    expect(s.ok && s.work_minutes).toBe(240);
    expect(s.ok && s.night_minutes).toBe(180);
  });
});

describe('12章 C10〜C11 拒否', () => {
  it('C10 休憩 ≧ 拘束 → 拒否', () => {
    const r = computeShift({ clock_in: '09:00', clock_out: '12:00', break_minutes: 180 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BREAK_GE_TOTAL');
  });
  it('C11 拘束 24時間超 → 拒否', () => {
    // 09:00 出勤 → 翌日 10:00 退勤（退勤日 > 出勤日を明示）＝25時間
    const r = computeShift({ clock_in: '09:00', clock_out: '10:00', overnight: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('OVER_24H');
  });
  it('出勤＝退勤は拒否（24時間勤務とはみなさない）', () => {
    expect(computeShift({ clock_in: '09:00', clock_out: '09:00' }).ok).toBe(false);
    expect(computeShift({ clock_in: '09:00', clock_out: '09:00', overnight: true }).ok).toBe(false);
  });
  it('形式不正は拒否', () => {
    expect(computeShift({ clock_in: '9時', clock_out: '18:00' }).ok).toBe(false);
    expect(computeShift({ clock_in: '25:00', clock_out: '18:00' }).ok).toBe(false);
  });
  it('深夜休憩 > 深夜帯、通常休憩 > 通常帯 は拒否', () => {
    expect(computeShift({ clock_in: '17:00', clock_out: '23:00', night_break_minutes: 90 }).ok).toBe(false);
    expect(computeShift({ clock_in: '22:00', clock_out: '05:00', break_minutes: 30 }).ok).toBe(false);
    expect(computeShift({ clock_in: '09:00', clock_out: '18:00', night_break_minutes: 10 }).ok).toBe(false);
  });
});

describe('12章 C12〜C13 法定休憩', () => {
  it('C12 実働 6h30m・休憩30分 → 法定45分不足 → 理由必須', () => {
    // 拘束 7h（09:00→16:00）・休憩30 → 実働 390
    const r = computeShift({ clock_in: '09:00', clock_out: '16:00', break_minutes: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.work_minutes).toBe(390);
    const w = r.warnings.find((x) => x.key === 'statutory');
    expect(w?.auditLabel).toBe('休憩30分（法定45分未満）');
  });
  it('C13 実働 8h30m・休憩45分 → 法定60分不足 → 理由必須', () => {
    // 拘束 9h15m（09:00→18:15）・休憩45 → 実働 510
    const r = computeShift({ clock_in: '09:00', clock_out: '18:15', break_minutes: 45 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.work_minutes).toBe(510);
    expect(r.warnings.find((x) => x.key === 'statutory')?.auditLabel).toBe('休憩45分（法定60分未満）');
  });
  it('実働ちょうど6時間は休憩不要、6時間超で45分、8時間超で60分', () => {
    expect(statutoryBreak(360, 0).required).toBe(0);
    expect(statutoryBreak(361, 0).required).toBe(45);
    expect(statutoryBreak(480 + 45, 45).required).toBe(45);
    expect(statutoryBreak(481 + 45, 45).required).toBe(60);
  });
  it('法定を満たせば警告なし', () => {
    const r = computeShift({ clock_in: '09:00', clock_out: '18:00', break_minutes: 60 });
    expect(r.ok && r.warnings.length).toBe(0);
  });
});

describe('12章 C14 交通費', () => {
  it('C14 移動 12.5km・単価20円 → 交通費 250円、備考必須', () => {
    const no = computeShift({ clock_in: '09:00', clock_out: '18:00', break_minutes: 60, travel_km: 12.5, travel_fee_per_km: 20 });
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.code).toBe('TRAVEL_NEEDS_COMMENT');
    const ok = computeShift({ clock_in: '09:00', clock_out: '18:00', break_minutes: 60, travel_km: 12.5, travel_fee_per_km: 20, comment: '行田→門井町 移動' });
    expect(ok.ok && ok.travel_fee).toBe(250);
    expect(ok.ok && ok.travel_km).toBe(12.5);
  });
  it('単価未指定は 20円/km、端数は四捨五入', () => {
    const r = computeShift({ clock_in: '09:00', clock_out: '18:00', break_minutes: 60, travel_km: 3.3, comment: 'x' });
    expect(r.ok && r.travel_fee).toBe(66);
    const s = computeShift({ clock_in: '09:00', clock_out: '18:00', break_minutes: 60, travel_km: 1.25, travel_fee_per_km: 30, comment: 'x' });
    expect(s.ok && s.travel_fee).toBe(38); // 37.5 → 38
  });
});

describe('12章 C15〜C16 GH系の追加入力', () => {
  const base = { clock_in: '09:00', clock_out: '18:00', break_minutes: 60, gh_extras: true } as const;
  it('C15 手当1000円・内容空 → 内容「手作り料理手当」', () => {
    const r = computeShift({ ...base, allowance_amount: 1000, allowance_note: '' });
    expect(r.ok && r.allowance_amount).toBe(1000);
    expect(r.ok && r.allowance_note).toBe('手作り料理手当');
  });
  it('C16 まかない 2食 → meal_fee 500', () => {
    const r = computeShift({ ...base, meal_count: 2 });
    expect(r.ok && r.meal_fee).toBe(500);
    expect(r.ok && r.meal_count).toBe(2);
  });
  it('内容だけで金額0は拒否', () => {
    const r = computeShift({ ...base, allowance_amount: 0, allowance_note: '買い出し手当' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ALLOWANCE_NEEDS_AMOUNT');
  });
  it('GH系でない事業所では手当・まかないを無視', () => {
    const r = computeShift({ clock_in: '09:00', clock_out: '18:00', break_minutes: 60, allowance_amount: 1000, meal_count: 2 });
    expect(r.ok && r.allowance_amount).toBe(0);
    expect(r.ok && r.meal_fee).toBe(0);
  });
});

describe('12章 C17〜C20 GH休憩ルール', () => {
  const gh = (ci: string, co: string, br: number, nbr = 0) => computeShift({ clock_in: ci, clock_out: co, break_minutes: br, night_break_minutes: nbr, gh_break_rule: true });
  it('C17 GH 16:00→翌9:00 → 通し勤務・想定180〜210分', () => {
    const e = ghExpectedBreak(span('16:00', '09:00')!);
    expect(e.applicable).toBe(true);
    expect([e.min, e.max]).toEqual([180, 210]);
    expect(e.pattern).toContain('通し勤務');
  });
  it('C18 GH 22:00→翌6:00 → 夜勤のみ・想定60分', () => {
    const e = ghExpectedBreak(span('22:00', '06:00')!);
    expect([e.min, e.max, e.pattern]).toEqual([60, 60, '夜勤のみ']);
  });
  it('C19 GH 06:00→09:00（同日） → 朝のみ・想定0分', () => {
    const e = ghExpectedBreak(span('06:00', '09:00')!);
    expect(e.applicable).toBe(true);
    expect([e.min, e.max, e.pattern]).toEqual([0, 0, '朝のみ']);
  });
  it('夕方＋夜勤 / 夜勤＋朝 / 夕方のみ / 想定外 / 時間帯外', () => {
    expect(ghExpectedBreak(span('16:00', '06:00')!).pattern).toBe('夕方＋夜勤');
    expect(ghExpectedBreak(span('22:00', '09:00')!).pattern).toBe('夜勤＋朝');
    expect(ghExpectedBreak(span('16:00', '21:00')!).pattern).toBe('夕方のみ');
    const odd = ghExpectedBreak(span('17:00', '21:00')!);
    expect(odd.applicable).toBe(true);
    const out = ghExpectedBreak(span('10:00', '15:00')!);
    expect(out.applicable).toBe(false);
    expect(out.pattern).toBe('GH勤務時間帯外');
  });
  it('各帯 30分以上で該当（29分は該当しない）', () => {
    // 21:31→翌6:00：夕方帯 29分 → 夜勤のみ
    expect(ghExpectedBreak(span('21:31', '06:00')!).pattern).toBe('夜勤のみ');
    expect(ghExpectedBreak(span('21:30', '06:00')!).pattern).toBe('夕方＋夜勤');
  });
  it('C20 休憩が想定±15分以上ずれ → 理由必須（14分なら不要）', () => {
    // 夜勤のみ 想定60：休憩45 → 15分不足 → 警告
    const a = gh('22:00', '06:00', 0, 45);
    expect(a.ok && a.warnings.some((w) => w.key === 'gh')).toBe(true);
    // 休憩46 → 14分 → 警告なし（法定も満たす：実働 434 → 45分必要）
    const b = gh('22:00', '06:00', 0, 46);
    expect(b.ok && b.warnings.some((w) => w.key === 'gh')).toBe(false);
    // 通し勤務 180〜210：120 → 60分不足 → 警告、180・210 → なし、226 → +16 → 警告
    expect(gh('16:00', '09:00', 60, 60).ok && (gh('16:00', '09:00', 60, 60) as any).warnings.some((w: any) => w.key === 'gh')).toBe(true);
    expect((gh('16:00', '09:00', 60, 120) as any).warnings.some((w: any) => w.key === 'gh')).toBe(false);
    expect((gh('16:00', '09:00', 90, 120) as any).warnings.some((w: any) => w.key === 'gh')).toBe(false);
    expect((gh('16:00', '09:00', 106, 120) as any).warnings.some((w: any) => w.key === 'gh')).toBe(true);
  });
  it('GH警告の監査ラベルは現行と同じ形式', () => {
    const a = gh('22:00', '06:00', 0, 45);
    expect(a.ok && a.warnings.find((w) => w.key === 'gh')?.auditLabel).toBe('設定60分/入力45分・-15分(夜勤のみ)');
    const b = gh('16:00', '09:00', 60, 60);
    expect(b.ok && b.warnings.find((w) => w.key === 'gh')?.auditLabel).toBe('設定180〜210分/入力120分・-60分(通し勤務（夕方＋夜勤＋朝）)');
  });
  it('GHルール対象なら休憩過多・極長の警告は出ない', () => {
    const r = gh('16:00', '09:00', 90, 120); // 拘束17h 実働 810
    expect(r.ok && r.warnings.map((w) => w.key)).toEqual([]);
  });
});

describe('休憩過多・打刻異常・休憩内訳（理由必須の警告）', () => {
  it('非GH 8h超で休憩90 → 過多警告、75 → 許容', () => {
    const a = computeShift({ clock_in: '09:00', clock_out: '19:00', break_minutes: 90 });
    expect(a.ok && a.warnings.find((w) => w.key === 'excess')?.auditLabel).toBe('休憩90分（規定60分±15・目安上限75分・+15分）');
    const b = computeShift({ clock_in: '09:00', clock_out: '19:00', break_minutes: 75 });
    expect(b.ok && b.warnings.some((w) => w.key === 'excess')).toBe(false);
  });
  it('6時間以内で休憩46 → 過多警告、45 → 許容', () => {
    const a = computeShift({ clock_in: '09:00', clock_out: '14:00', break_minutes: 46 });
    expect(a.ok && a.warnings.find((w) => w.key === 'excess')?.auditLabel).toBe('休憩46分（規定不要・目安上限45分・+1分）');
    const b = computeShift({ clock_in: '09:00', clock_out: '14:00', break_minutes: 45 });
    expect(b.ok && b.warnings.some((w) => w.key === 'excess')).toBe(false);
  });
  it('実働30分未満 → 勤務極短', () => {
    const r = computeShift({ clock_in: '09:00', clock_out: '09:20' });
    expect(r.ok && r.warnings.find((w) => w.key === 'anomaly')?.auditLabel).toBe('勤務極短(20分)');
  });
  it('実働18h超 → 勤務極長（GHルール対象は除外）', () => {
    const r = computeShift({ clock_in: '05:00', clock_out: '00:30', break_minutes: 60 }); // 拘束 19.5h 実働 1110
    expect(r.ok && r.warnings.find((w) => w.key === 'anomaly')?.auditLabel).toBe('勤務極長(18h30m)');
    const g = computeShift({ clock_in: '05:00', clock_out: '00:30', break_minutes: 60, gh_break_rule: true });
    expect(g.ok && g.warnings.some((w) => w.key === 'anomaly')).toBe(false);
  });
  it('8h超で休憩0 → 法定不足と「8h超休憩0」の両方', () => {
    const r = computeShift({ clock_in: '09:00', clock_out: '18:30' });
    expect(r.ok && r.warnings.map((w) => w.key).sort()).toEqual(['anomaly', 'statutory']);
    expect(r.ok && r.warnings.find((w) => w.key === 'anomaly')?.auditLabel).toBe('8h超休憩0');
  });
  it('通常帯が主なのに深夜休憩が多い → 休憩内訳確認', () => {
    // 14:00→23:00：通常 480・深夜 60。通常休憩 10・深夜休憩 30
    const r = computeShift({ clock_in: '14:00', clock_out: '23:00', break_minutes: 10, night_break_minutes: 30 });
    expect(r.ok && r.warnings.find((w) => w.key === 'mismatch')?.auditLabel)
      .toBe('通常勤務が主(深夜60分/通常480分)なのに、深夜休憩(30分)が通常休憩(10分)より多い');
  });
});

describe('備考への理由連結（CSV「スタッフコメント」互換）', () => {
  it('現行コードと同じ順序・区切り', () => {
    const s = composeStaffComment([
      { key: 'statutory', auditLabel: '休憩30分（法定45分未満）', reason: '忙しかった' },
      { key: 'gh', auditLabel: '設定60分/入力45分・-15分(夜勤のみ)', reason: '利用者対応' },
      { key: 'anomaly', auditLabel: '勤務極短(20分)', reason: '早退' },
      { key: 'mismatch', auditLabel: 'L', reason: 'R' },
      { key: 'excess', auditLabel: 'E', reason: 'X' },
    ], '通常の備考');
    expect(s).toBe('【休憩乖離確認：E】X ／ 【GH休憩確認：設定60分/入力45分・-15分(夜勤のみ)】利用者対応 ／ 【打刻時警告確認：勤務極短(20分)】早退 ／ 【休憩内訳確認】L → R ／ 【休憩30分（法定45分未満）理由】忙しかった ／ 通常の備考');
  });
  it('理由なし・備考のみ／理由のみ', () => {
    expect(composeStaffComment([], ' 備考 ')).toBe('備考');
    expect(composeStaffComment([{ key: 'statutory', auditLabel: '休憩0分（法定45分未満）', reason: 'r' }], '')).toBe('【休憩0分（法定45分未満）理由】r');
    expect(composeStaffComment([], null)).toBe('');
  });
});

describe('12章 C21 有給', () => {
  it('C21 全休 1.0 / 午前 0.5 / 午後 0.5', () => {
    expect(leaveInfo('full')).toEqual({ status: 'PAID_LEAVE', days: 1, label: '全休' });
    expect(leaveInfo('am')).toEqual({ status: 'PAID_LEAVE_AM', days: 0.5, label: '午前半休' });
    expect(leaveInfo('pm')).toEqual({ status: 'PAID_LEAVE_PM', days: 0.5, label: '午後半休' });
  });
  it('leave_days が空なら status から補完', () => {
    expect(leaveDaysOf('PAID_LEAVE', null)).toBe(1);
    expect(leaveDaysOf('PAID_LEAVE_AM', null)).toBe(0.5);
    expect(leaveDaysOf('PAID_LEAVE_PM', 0.5)).toBe(0.5);
    expect(leaveDaysOf('DONE', null)).toBe(0);
  });
});

describe('本人修正の期限（当月、および翌月7日までの前月分）', () => {
  it('当月は修正可', () => expect(selfEditable('2026-10-01', '2026-10-31')).toBe(true));
  it('前月・7日以内は可', () => expect(selfEditable('2026-09-30', '2026-10-07')).toBe(true));
  it('前月・8日は不可', () => expect(selfEditable('2026-09-30', '2026-10-08')).toBe(false));
  it('前々月は不可', () => expect(selfEditable('2026-08-31', '2026-10-01')).toBe(false));
  it('年跨ぎ：12月分を 1/5 は可、1/8 は不可', () => {
    expect(selfEditable('2025-12-15', '2026-01-05')).toBe(true);
    expect(selfEditable('2025-12-15', '2026-01-08')).toBe(false);
  });
  it('未来月は可（先に出した有給の取消）、日付不正は不可', () => {
    expect(selfEditable('2026-11-01', '2026-10-09')).toBe(true);
    expect(selfEditable('2026-02-30', '2026-03-01')).toBe(false);
  });
  it('期限日は翌月7日', () => {
    expect(selfEditDeadline('2026-09-15')).toBe('2026-10-07');
    expect(selfEditDeadline('2025-12-01')).toBe('2026-01-07');
  });
});

describe('退勤忘れ（OVERDUE）判定：出勤から 24時間超', () => {
  const start = Date.UTC(2026, 9, 1, 0, 0); // 2026-10-01 09:00 JST
  it('23時間はまだ', () => expect(isOverdue('2026-10-01', '09:00', start + 23 * 3600e3)).toBe(false));
  it('ちょうど24時間はまだ', () => expect(isOverdue('2026-10-01', '09:00', start + 24 * 3600e3)).toBe(false));
  it('25時間で超過', () => expect(isOverdue('2026-10-01', '09:00', start + 25 * 3600e3)).toBe(true));
  it('日時版', () => expect(isOverdueAt(start, start + 24 * 3600e3 + 1)).toBe(true));
});

describe('主事業部', () => {
  it('最大の事業部、同率、実績なし', () => {
    expect(mainDepartment([{ department: 'GH', work_minutes: 600 }, { department: '飲食', work_minutes: 300 }]).label).toBe('GH');
    expect(mainDepartment([{ department: 'GH', work_minutes: 300 }, { department: '飲食', work_minutes: 300 }]).label).toBe('同率：GH・飲食');
    expect(mainDepartment([]).label).toBe('勤務実績なし');
    expect(mainDepartment([{ department: '', work_minutes: 100 }]).label).toBe('勤務実績なし');
  });
});

describe('時刻・文字列ヘルパー', () => {
  it('toMin / toHHMM', () => {
    expect(toMin('09:05')).toBe(545);
    expect(toMin('9:05')).toBe(545);
    expect(toMin('24:00')).toBeNull();
    expect(toMin('ab')).toBeNull();
    expect(toHHMM(545)).toBe('09:05');
    expect(toHHMM(1500)).toBe('01:00');
  });
  it('addDays / isValidDate / prevYm / ymRange', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(prevYm('2026-01')).toBe('2025-12');
    expect(ymRange('2026-02')).toEqual(['2026-02-01', '2026-02-28']);
    expect(ymRange('2026-13')).toBeNull();
  });
  it('小数時間（切り捨て）', () => {
    expect(minToDecimalHours(480)).toBe('8.00');
    expect(minToDecimalHours(485)).toBe('8.08');
    expect(minToDecimalHours(90)).toBe('1.50');
    expect(minToDecimalHours(59)).toBe('0.98');
    expect(minToDecimalHours(0)).toBe('0.00');
    expect(minToDecimalHours(null)).toBe('');
  });
  it('従業員番号は3桁ゼロ埋めの文字列、0000 は 000', () => {
    expect(padEmpId('58')).toBe('058');
    expect(padEmpId(58)).toBe('058');
    expect(padEmpId('0058')).toBe('058');
    expect(padEmpId('1234')).toBe('1234');
    expect(padEmpId('A12')).toBe('A12');
    expect(padEmpId('')).toBe('');
  });
  it('氏名・かなは全種類の空白を除去', () => {
    expect(stripSpaces(' 新井　大和 ')).toBe('新井大和');
  });
  it('JST ⇔ UTC', () => {
    const ms = jstToMs('2026-10-01', '09:00')!;
    expect(new Date(ms).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(msToJst(ms)).toEqual({ date: '2026-10-01', time: '09:00' });
    expect(msToJst(jstToMs('2026-10-01', '23:30')! + 3600e3)).toEqual({ date: '2026-10-02', time: '00:30' });
  });
});
