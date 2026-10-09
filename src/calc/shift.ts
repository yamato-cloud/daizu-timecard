/**
 * 退勤時の勤務計算（給与の根拠）。引継書 04章 §1〜§6 を実装する純粋関数。
 * サーバーだけがこれを呼んで保存値を決める。画面はサーバーの結果を表示するだけ。
 *
 * 時刻は「出勤日の 0:00 からの分」。日跨ぎは退勤に +1440。
 */
import { toMin } from './time.js';

export const NIGHT_START = 22 * 60;          // 22:00
export const NIGHT_END_SAME_DAY = 29 * 60;   // 翌5:00（日跨ぎなし）
export const NIGHT_END_OVERNIGHT = 30 * 60;  // 翌6:00（日跨ぎあり）※法定と異なるが現行踏襲（大和さん既決 2026-08）
export const BREAK_TOLERANCE_MIN = 15;       // GH休憩ルール・休憩過多の許容幅
export const DEFAULT_TRAVEL_FEE_PER_KM = 20;
export const DEFAULT_MEAL_UNIT_PRICE = 250;
export const DEFAULT_ALLOWANCE_NOTE = '手作り料理手当';

/** 異常検知の閾値（04章 §13） */
export const ANOMALY = {
  MIN_WORK_MINUTES: 30,            // 実働これ未満は「極端に短い」
  MAX_WORK_MINUTES: 1080,          // 実働これ超は「極端に長い」（GH休憩ルール対象は除外）
  MIN_INTERVAL_HOURS: 11,          // 勤務間インターバル
  MAX_CONSECUTIVE_DAYS: 6,         // 連続勤務
  MANDATORY_BREAK_WORK_MIN: 480,   // 実働これ超で休憩なしは要確認
} as const;

export interface Span {
  start: number;      // 出勤（分）
  end: number;        // 退勤（分、日跨ぎなら +1440 済み）
  overnight: boolean;
  total: number;      // 拘束（分）
}

/**
 * 拘束時間帯。
 * @param overnight 退勤日 > 出勤日 が分かっているとき true。未指定なら「退勤 < 出勤」で自動判定
 */
export function span(clockIn: string, clockOut: string, overnight?: boolean): Span | null {
  const s = toMin(clockIn);
  const e = toMin(clockOut);
  if (s === null || e === null) return null;
  const ov = overnight === undefined ? e < s : overnight;
  const end = ov ? e + 1440 : e;
  return { start: s, end, overnight: ov, total: end - s };
}

/** 深夜帯との重なり（休憩控除前） */
export function nightRaw(sp: Span): number {
  const nightEnd = sp.overnight ? NIGHT_END_OVERNIGHT : NIGHT_END_SAME_DAY;
  return Math.max(0, Math.min(sp.end, nightEnd) - Math.max(sp.start, NIGHT_START));
}

/** 通常帯／深夜帯の内訳（休憩控除前） */
export function workBreakdown(sp: Span): { normalRaw: number; nightRaw: number; total: number } {
  const n = nightRaw(sp);
  return { normalRaw: Math.max(0, sp.total - n), nightRaw: n, total: sp.total };
}

/** 法定休憩（労基法34条）：実働 6時間超→45分、8時間超→60分。実働＝拘束−休憩 */
export function statutoryBreak(totalMin: number, breakMin: number): { actualWork: number; required: number; shortage: number } {
  const actualWork = Math.max(0, totalMin - breakMin);
  const required = actualWork > 480 ? 60 : actualWork > 360 ? 45 : 0;
  return { actualWork, required, shortage: Math.max(0, required - breakMin) };
}

export interface GhExpected {
  applicable: boolean;
  min: number;
  max: number;
  pattern: string;
  buckets: { evening: number; night: number; early: number };
}

/**
 * GH休憩ルール（04章 §6）。帯は出勤日 0:00 基点：夕方16-22／深夜22-翌6／早朝 翌6-9。
 * 日跨ぎなしなら同日 6-9 も早朝。各帯 30分以上で「該当」。
 */
export function ghExpectedBreak(sp: Span): GhExpected {
  const ov = (a: number, b: number) => Math.max(0, Math.min(sp.end, b) - Math.max(sp.start, a));
  const evening = ov(16 * 60, 22 * 60);
  const night = ov(22 * 60, 30 * 60);
  let early = ov(30 * 60, 33 * 60);
  if (!sp.overnight) early = Math.max(early, ov(6 * 60, 9 * 60));
  const r: GhExpected = { applicable: false, min: 0, max: 0, pattern: '', buckets: { evening, night, early } };
  const e = evening >= 30;
  const n = night >= 30;
  const a = early >= 30;
  const set = (min: number, max: number, pattern: string) => { r.applicable = true; r.min = min; r.max = max; r.pattern = pattern; return r; };
  if (e && n && a) return set(180, 210, '通し勤務（夕方＋夜勤＋朝）');
  if (e && n && !a) return set(120, 120, '夕方＋夜勤');
  if (!e && n && a) return set(120, 120, '夜勤＋朝');
  if (!e && n && !a) return set(60, 60, '夜勤のみ');
  if (e && !n && !a) return set(30, 30, '夕方のみ');
  if (!e && !n && a) return set(0, 0, '朝のみ');
  r.pattern = e && !n && a ? '想定外パターン（夕方＋朝で深夜なし）' : 'GH勤務時間帯外';
  return r;
}

/** 退勤前の警告。理由（reason）が必要なもの。打刻は止めない */
export type WarningKey = 'statutory' | 'gh' | 'excess' | 'mismatch' | 'anomaly';
export interface Warning {
  key: WarningKey;
  /** 利用者向けの短い見出し */
  title: string;
  /** 利用者向けの説明 */
  detail: string;
  /** 監査証跡ラベル（CSV「スタッフコメント」の【…】内に入る文言） */
  auditLabel: string;
}

export interface ShiftInput {
  clock_in: string;              // 'HH:MM'
  clock_out: string;             // 'HH:MM'
  overnight?: boolean;           // 退勤日 > 出勤日 が分かっているとき。未指定なら自動判定
  break_minutes?: number | null;
  night_break_minutes?: number | null;
  travel_km?: number | null;
  travel_fee_per_km?: number | null;   // 設定値。未指定なら 20
  comment?: string | null;             // 備考（移動km>0 なら必須）
  gh_extras?: boolean;                 // 事業所フラグ：手当・まかない入力あり
  gh_break_rule?: boolean;             // 事業所フラグ：GH休憩ルール対象
  allowance_amount?: number | null;
  allowance_note?: string | null;
  meal_count?: number | null;
  meal_unit_price?: number | null;     // 設定値。未指定なら 250
}

export interface ShiftOk {
  ok: true;
  overnight: boolean;
  total_minutes: number;
  work_minutes: number;
  night_minutes: number;
  night_raw_minutes: number;
  normal_raw_minutes: number;
  break_minutes: number;
  night_break_minutes: number;
  travel_km: number;
  travel_fee: number;
  allowance_amount: number;
  allowance_note: string;
  meal_count: number;
  meal_fee: number;
  /** 理由が必要な警告（空なら理由不要） */
  warnings: Warning[];
  gh: GhExpected | null;
}
export interface ShiftNg { ok: false; error: string; code: string; field?: string }
export type ShiftResult = ShiftOk | ShiftNg;

const ng = (code: string, error: string, field?: string): ShiftNg => ({ ok: false, code, error, field });
const hm = (m: number) => { const h = Math.floor(m / 60); const mm = m % 60; return ((h > 0 ? `${h}時間` : '') + (mm > 0 ? `${mm}分` : '')) || '0分'; };
const num = (v: number | null | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** 退勤時の計算の唯一の入口 */
export function computeShift(p: ShiftInput): ShiftResult {
  const sp = span(p.clock_in, p.clock_out, p.overnight);
  if (!sp) return ng('BAD_TIME', '出勤・退勤時刻の形式が不正です');
  if (toMin(p.clock_in) === toMin(p.clock_out)) {
    return ng('CI_EQ_CO', `出勤時刻と退勤時刻が同じです（${p.clock_out}）。打刻ミスの可能性が高いため登録できません`, 'clock_out');
  }
  if (sp.total <= 0) return ng('NOT_AFTER', '退勤時刻は出勤時刻より後にしてください', 'clock_out');
  if (sp.total > 1440) return ng('OVER_24H', '勤務時間が24時間を超えています', 'clock_out');

  const br = Math.max(0, Math.round(num(p.break_minutes)));
  const nbr = Math.max(0, Math.round(num(p.night_break_minutes)));
  const totalBreak = br + nbr;
  if (totalBreak >= sp.total) return ng('BREAK_GE_TOTAL', '休憩時間が勤務時間を超えています', 'break_minutes');

  const bd = workBreakdown(sp);
  if (br > 0 && bd.normalRaw === 0) {
    return ng('BREAK_NO_NORMAL', '深夜帯のみの勤務のため、通常休憩は入力できません。深夜休憩に入力してください', 'break_minutes');
  }
  if (nbr > 0 && bd.nightRaw === 0) {
    return ng('NBREAK_NO_NIGHT', '深夜帯の勤務がないため、深夜休憩は入力できません。通常休憩に入力してください', 'night_break_minutes');
  }
  if (br > bd.normalRaw) {
    return ng('BREAK_GT_NORMAL', `通常休憩(${br}分)が通常帯の勤務時間(${hm(bd.normalRaw)})を超えています`, 'break_minutes');
  }
  if (nbr > bd.nightRaw) {
    return ng('NBREAK_GT_NIGHT', `深夜休憩(${nbr}分)が深夜帯の勤務時間(${hm(bd.nightRaw)})を超えています`, 'night_break_minutes');
  }

  const work = sp.total - totalBreak;
  // 深夜 = 深夜帯との重なり − 深夜休憩。さらに実働を超えない（逆転防止）
  const night = Math.min(Math.max(0, bd.nightRaw - nbr), work);

  // 交通費
  const km = Math.max(0, num(p.travel_km));
  const perKm = p.travel_fee_per_km === null || p.travel_fee_per_km === undefined ? DEFAULT_TRAVEL_FEE_PER_KM : num(p.travel_fee_per_km);
  const travelFee = Math.round(km * perKm);
  const comment = String(p.comment ?? '').trim();
  if (km > 0 && !comment) return ng('TRAVEL_NEEDS_COMMENT', '業務内移動がある場合は備考にコメントを入力してください', 'comment');

  // GH系の追加入力
  let allowanceAmount = 0;
  let allowanceNote = '';
  let mealCount = 0;
  let mealFee = 0;
  if (p.gh_extras) {
    allowanceAmount = Math.max(0, Math.round(num(p.allowance_amount)));
    allowanceNote = String(p.allowance_note ?? '').trim();
    mealCount = Math.max(0, Math.round(num(p.meal_count)));
    const unit = p.meal_unit_price === null || p.meal_unit_price === undefined ? DEFAULT_MEAL_UNIT_PRICE : num(p.meal_unit_price);
    mealFee = mealCount * unit;
    if (allowanceAmount > 0 && !allowanceNote) allowanceNote = DEFAULT_ALLOWANCE_NOTE;
    if (allowanceNote && allowanceNote !== DEFAULT_ALLOWANCE_NOTE && allowanceAmount <= 0) {
      return ng('ALLOWANCE_NEEDS_AMOUNT', '手当の金額を入力してください', 'allowance_amount');
    }
    if (allowanceAmount <= 0) allowanceNote = '';
  }

  // ---- 警告（理由必須・打刻は止めない）----
  const warnings: Warning[] = [];

  // 休憩内訳の主従逆転（通常帯が主なのに深夜休憩が多い、またはその逆）
  if (totalBreak > 0) {
    const normalDominant = bd.normalRaw >= bd.nightRaw * 2;
    const nightDominant = bd.nightRaw >= bd.normalRaw * 2;
    let label = '';
    if (normalDominant && nbr > br) {
      label = `通常勤務が主(深夜${bd.nightRaw}分/通常${bd.normalRaw}分)なのに、深夜休憩(${nbr}分)が通常休憩(${br}分)より多い`;
    } else if (nightDominant && br > nbr) {
      label = `深夜勤務が主(深夜${bd.nightRaw}分/通常${bd.normalRaw}分)なのに、通常休憩(${br}分)が深夜休憩(${nbr}分)より多い`;
    }
    if (label) {
      warnings.push({
        key: 'mismatch', title: '休憩の内訳を確認してください', auditLabel: label,
        detail: `勤務時間帯の内訳：通常帯 ${hm(bd.normalRaw)} ／ 深夜帯 ${hm(bd.nightRaw)}。休憩の入力：通常休憩 ${br}分 ／ 深夜休憩 ${nbr}分。勤務時間帯と休憩の内訳がアンバランスです。入力ミスの可能性があります`,
      });
    }
  }

  // 法定休憩不足
  const st = statutoryBreak(sp.total, totalBreak);
  if (st.shortage > 0) {
    warnings.push({
      key: 'statutory', title: `休憩が法定基準（${st.required}分）に足りません`,
      auditLabel: `休憩${totalBreak}分（法定${st.required}分未満）`,
      detail: `実働 ${hm(st.actualWork)}（${st.required === 60 ? '8時間' : '6時間'}を超える勤務）に対して休憩 ${totalBreak === 0 ? 'なし' : `${totalBreak}分`}。法定では ${st.required}分以上必要です。休憩を直せる場合は休憩欄を修正し、直せない場合は理由を書いてください`,
    });
  }

  // 打刻異常（極短・極長・8h超で休憩0）
  {
    const tags: string[] = [];
    const descs: string[] = [];
    if (work > 0 && work < ANOMALY.MIN_WORK_MINUTES) {
      tags.push(`勤務極短(${work}分)`);
      descs.push(`実働 ${work}分（${ANOMALY.MIN_WORK_MINUTES}分未満と極端に短い）`);
    }
    if (work > ANOMALY.MAX_WORK_MINUTES && !p.gh_break_rule) {
      const h = Math.floor(work / 60); const m = work % 60;
      tags.push(`勤務極長(${h}h${m > 0 ? `${m}m` : ''})`);
      descs.push(`実働 ${hm(work)}（${Math.floor(ANOMALY.MAX_WORK_MINUTES / 60)}時間超）。退勤打刻忘れの可能性`);
    }
    if (work > ANOMALY.MANDATORY_BREAK_WORK_MIN && totalBreak === 0) {
      tags.push('8h超休憩0');
      descs.push(`実働 ${hm(work)} に対して休憩 0分（労基法§34）`);
    }
    if (tags.length) {
      warnings.push({ key: 'anomaly', title: '打刻内容の確認が必要です', auditLabel: tags.join('/'), detail: descs.join('。') });
    }
  }

  // GH休憩ルール（フラグで判定。名前では判定しない）
  let gh: GhExpected | null = null;
  let ghRuleApplied = false;
  if (p.gh_break_rule) {
    gh = ghExpectedBreak(sp);
    if (gh.applicable) {
      ghRuleApplied = true;
      let diff = 0;
      if (totalBreak < gh.min) diff = totalBreak - gh.min;
      else if (totalBreak > gh.max) diff = totalBreak - gh.max;
      if (Math.abs(diff) >= BREAK_TOLERANCE_MIN) {
        const setting = gh.min === gh.max ? `${gh.min}分` : `${gh.min}〜${gh.max}分`;
        warnings.push({
          key: 'gh', title: 'GHの休憩ルールと違います',
          auditLabel: `設定${setting}/入力${totalBreak}分・${diff > 0 ? '+' : ''}${diff}分(${gh.pattern})`,
          detail: `勤務時間帯：${gh.pattern}（夕方帯 ${hm(gh.buckets.evening)} ／ 深夜帯 ${hm(gh.buckets.night)} ／ 早朝帯 ${hm(gh.buckets.early)}）。GHルールの休憩 ${setting} に対して入力 ${totalBreak}分（${Math.abs(diff)}分${diff > 0 ? '多い' : '少ない'}）。理由を書けばこのまま退勤できます（実際の休憩時間を書き換えないでください）`,
        });
      }
    }
  }

  // 休憩過多（GHルールで判定しなかった勤務のみ）。規定＝拘束時間に対する法定休憩、許容 +15分。6時間以内は昼休憩を考慮し45分まで
  if (!ghRuleApplied && totalBreak > 0) {
    const wh = sp.total / 60;
    const legalBase = wh > 8 ? 60 : wh > 6 ? 45 : 0;
    const allowedMax = legalBase > 0 ? legalBase + BREAK_TOLERANCE_MIN : 45;
    if (totalBreak > allowedMax) {
      const over = totalBreak - allowedMax;
      warnings.push({
        key: 'excess', title: `休憩が規定より ${over}分 多く入力されています`,
        auditLabel: `休憩${totalBreak}分（規定${legalBase > 0 ? `${legalBase}分±${BREAK_TOLERANCE_MIN}` : '不要'}・目安上限${allowedMax}分・+${over}分）`,
        detail: `勤務時間（拘束）${hm(sp.total)}。${legalBase > 0 ? `労基法の必要休憩 ${legalBase}分（許容 ±${BREAK_TOLERANCE_MIN}分）` : '6時間以内の勤務（労基法では休憩は不要）'}。入力された休憩 ${totalBreak}分／規定の目安 ${allowedMax}分まで（${over}分多い）。理由を書けばこのまま退勤できます`,
      });
    }
  }

  return {
    ok: true,
    overnight: sp.overnight,
    total_minutes: sp.total,
    work_minutes: work,
    night_minutes: night,
    night_raw_minutes: bd.nightRaw,
    normal_raw_minutes: bd.normalRaw,
    break_minutes: br,
    night_break_minutes: nbr,
    travel_km: Math.round(km * 10) / 10,
    travel_fee: travelFee,
    allowance_amount: allowanceAmount,
    allowance_note: allowanceNote,
    meal_count: mealCount,
    meal_fee: mealFee,
    warnings,
    gh,
  };
}

/**
 * 警告ごとの理由を、現行システムと同じ形式で備考の先頭に連結する（CSV「スタッフコメント」互換）。
 * 現行コードの実際の並び：休憩乖離確認 → GH休憩確認 → 打刻時警告確認 → 休憩内訳確認 → 休憩X分（法定…）理由 → 本人の備考
 * 区切りは「 ／ 」。
 */
export interface ReasonEntry { key: WarningKey; auditLabel: string; reason: string }
export function composeStaffComment(reasons: ReasonEntry[], comment: string | null | undefined): string {
  const by = (k: WarningKey) => reasons.find((r) => r.key === k && String(r.reason ?? '').trim());
  const parts: string[] = [];
  const ex = by('excess'); if (ex) parts.push(`【休憩乖離確認：${ex.auditLabel}】${ex.reason.trim()}`);
  const gh = by('gh'); if (gh) parts.push(`【GH休憩確認：${gh.auditLabel}】${gh.reason.trim()}`);
  const an = by('anomaly'); if (an) parts.push(`【打刻時警告確認：${an.auditLabel}】${an.reason.trim()}`);
  const mm = by('mismatch'); if (mm) parts.push(`【休憩内訳確認】${mm.auditLabel} → ${mm.reason.trim()}`);
  const st = by('statutory'); if (st) parts.push(`【${st.auditLabel}理由】${st.reason.trim()}`);
  const c = String(comment ?? '').trim();
  if (c) parts.push(c);
  return parts.join(' ／ ');
}
