/**
 * 退勤・修正・追加に共通の入力フォーム。
 * 計算はしない（サーバーが計算する）。サーバーが 422 NEEDS_REASON を返したら、警告ごとに理由欄を出して再送信する。
 */
import { isApiFailure, errorText } from './api.js';
import { el, busy, markInvalid, toast, todayYmd, nowHHMM, fmtDateJa, addDaysYmd } from './ui.js';

export interface LocationInfo { location_code: string; location_name: string; department: string; check_alcohol: boolean; gh_extras: boolean; gh_break_rule: boolean }
export interface ShiftRecord { id?: string; work_date: string; clock_in: string | null; clock_out?: string | null; clock_out_date?: string | null; status?: string; location_code?: string | null; location_name?: string | null;
  break_minutes?: number; night_break_minutes?: number; travel_km?: number; staff_comment?: string | null; allowance_amount?: number; allowance_note?: string | null; meal_count?: number; reasons?: Record<string, { label: string; reason: string }>; alcohol_check?: string | null }
export interface WarningInfo { key: string; title: string; detail: string; auditLabel: string }
export interface ShiftFormOptions {
  mode: 'clockout' | 'edit' | 'add';
  record?: ShiftRecord;
  locations: LocationInfo[];
  settings: { travel_fee_per_km: number; meal_unit_price: number };
  submit: (payload: Record<string, unknown>) => Promise<{ message?: string }>;
  onDone: (result: { message?: string }) => void;
  submitLabel?: string;
  allowDateAndLocation?: boolean; // 管理者編集・追加
}

export function shiftForm(o: ShiftFormOptions): HTMLElement {
  const r = o.record ?? { work_date: todayYmd(), clock_in: null };
  const isOverdue = r.status === 'OVERDUE';
  const form = el('form', { class: 'shift-form', novalidate: true });
  const field = (label: string, input: HTMLElement, hint?: string) => el('label', { class: 'field' }, el('span', { text: label }), input, hint ? el('div', { class: 'muted small', text: hint }) : null);
  const num = (name: string, value: number | undefined, step = '1', min = '0', inputmode = 'numeric') => el('input', { type: 'number', name, value: value ?? 0, step, min, inputmode }) as HTMLInputElement;

  // 日付・事業所（追加・管理者編集）
  const dateIn = el('input', { type: 'date', name: 'work_date', value: r.work_date, max: todayYmd() }) as HTMLInputElement;
  const locSel = el('select', { name: 'location_code' }) as HTMLSelectElement;
  locSel.append(el('option', { value: '', text: '事業所を選ぶ' }));
  for (const l of o.locations) locSel.append(el('option', { value: l.location_code, text: l.location_name, selected: l.location_code === r.location_code }));
  const showDateLoc = o.mode === 'add' || !!o.allowDateAndLocation;
  if (showDateLoc) form.append(field('勤務日（出勤した日）', dateIn), field('事業所', locSel));
  else form.append(el('div', { class: 'kv mb' }, el('dt', { text: '勤務日' }), el('dd', { text: `${r.work_date}（${fmtDateJa(r.work_date)}）` }), el('dt', { text: '事業所' }), el('dd', { text: r.location_name ?? '' })));

  // 出勤時刻
  const ciIn = el('input', { type: 'time', name: o.mode === 'clockout' ? 'clock_in_fix' : 'clock_in', value: r.clock_in ?? '', required: true }) as HTMLInputElement;
  if (o.mode === 'clockout') {
    const fixWrap = el('div', { class: 'hidden' }, field('出勤時刻（訂正後）', ciIn, '出勤の押し忘れなどで実際の出勤時刻と違うときだけ直してください'));
    const fixBtn = el('button', { type: 'button', class: 'btn ghost', text: `出勤 ${r.clock_in ?? ''} を訂正する`, style: 'width:auto' });
    fixBtn.addEventListener('click', () => { fixWrap.classList.toggle('hidden'); if (fixWrap.classList.contains('hidden')) ciIn.value = r.clock_in ?? ''; });
    form.append(el('div', { class: 'mb' }, el('div', {}, el('strong', { text: `出勤 ${r.clock_in ?? ''}` }), ' ', fixBtn), fixWrap));
  } else {
    form.append(field('出勤時刻', ciIn));
  }

  // 退勤時刻（＋日跨ぎ表示）
  const coIn = el('input', { type: 'time', name: 'clock_out', value: isOverdue ? '' : (r.clock_out ?? (o.mode === 'clockout' ? nowHHMM() : '')), required: true }) as HTMLInputElement;
  const coDateIn = el('input', { type: 'date', name: 'clock_out_date', value: r.clock_out_date ?? '', max: todayYmd() }) as HTMLInputElement;
  const coHint = el('div', { class: 'muted small' });
  const updateCoHint = () => {
    const wd = showDateLoc ? dateIn.value : r.work_date;
    const ci = ciIn.value || r.clock_in || '';
    const co = coIn.value;
    if (!wd || !ci || !co) { coHint.textContent = ''; return; }
    const overnight = co < ci;
    coDateIn.value = overnight ? addDaysYmd(wd, 1) : wd;
    coHint.textContent = overnight ? `退勤は翌日 ${fmtDateJa(coDateIn.value)} として記録します（日跨ぎ）` : `退勤は同じ日 ${fmtDateJa(wd)} として記録します`;
  };
  [ciIn, coIn, dateIn].forEach((i) => i.addEventListener('input', updateCoHint));
  form.append(field(isOverdue ? '退勤時刻（退勤忘れのため必ず入力）' : '退勤時刻', coIn), coHint, el('div', { class: 'mb' }));
  updateCoHint();

  // 休憩・移動・備考
  const brIn = num('break_minutes', r.break_minutes, '5');
  const nbrIn = num('night_break_minutes', r.night_break_minutes, '5');
  const kmIn = num('travel_km', r.travel_km, '0.5', '0', 'decimal');
  const feeHint = el('div', { class: 'muted small' });
  const updateFee = () => { const km = Number(kmIn.value) || 0; feeHint.textContent = km > 0 ? `交通費 ${Math.round(km * o.settings.travel_fee_per_km)}円（${o.settings.travel_fee_per_km}円/km）。備考に移動の内容を書いてください` : ''; };
  kmIn.addEventListener('input', updateFee); updateFee();
  const commentIn = el('textarea', { name: 'comment', placeholder: '連絡事項・移動の内容など' }) as HTMLTextAreaElement;
  commentIn.value = r.staff_comment ?? '';
  form.append(
    el('div', { class: 'grid2' }, field('通常休憩（分）', brIn), field('深夜休憩（分）', nbrIn, '22時〜翌朝の休憩')),
    field('業務内の移動（km）', kmIn), feeHint,
    field('備考', commentIn),
  );

  // GH系：手当・まかない（事業所フラグで表示）
  const extras = el('div', { class: 'card hidden' }, el('h3', { text: '🐰 手当・まかない' }));
  const allowIn = num('allowance_amount', r.allowance_amount);
  const noteIn = el('input', { type: 'text', name: 'allowance_note', value: r.allowance_note ?? '', placeholder: '手作り料理手当', maxlength: '100' }) as HTMLInputElement;
  const mealIn = num('meal_count', r.meal_count);
  const mealHint = el('div', { class: 'muted small' });
  const updateMeal = () => { const n = Number(mealIn.value) || 0; mealHint.textContent = n > 0 ? `まかない ${n * o.settings.meal_unit_price}円（${o.settings.meal_unit_price}円×${n}食）` : ''; };
  mealIn.addEventListener('input', updateMeal); updateMeal();
  extras.append(el('div', { class: 'grid2' }, field('手当（円）', allowIn), field('手当の内容', noteIn, '空欄なら「手作り料理手当」')), field('まかない（食数）', mealIn), mealHint);
  form.append(extras);
  const updateExtras = () => {
    const code = showDateLoc ? locSel.value : r.location_code;
    const loc = o.locations.find((l) => l.location_code === code);
    extras.classList.toggle('hidden', !loc?.gh_extras);
  };
  locSel.addEventListener('change', updateExtras); updateExtras();

  // 修正理由（修正・追加）
  const reasonIn = el('textarea', { name: 'correction_reason', placeholder: o.mode === 'add' ? '例：退勤の打刻を忘れたため' : '例：退勤時刻の入力ミス' }) as HTMLTextAreaElement;
  if (o.mode !== 'clockout') form.append(field(o.mode === 'add' ? '追加の理由（必須）' : '修正理由（必須）', reasonIn));

  // 警告と理由欄（サーバーの 422 で表示）
  const warnBox = el('div', { class: 'hidden' });
  form.append(warnBox);
  const reasonInputs: Record<string, HTMLTextAreaElement> = {};
  const existing = r.reasons ?? {};
  const renderWarnings = (ws: WarningInfo[], missing: string[]) => {
    warnBox.innerHTML = '';
    warnBox.classList.remove('hidden');
    warnBox.append(el('div', { class: 'notice warn', text: '確認が必要な点があります。理由を書けばこのまま登録できます（実際の時間を書き換えないでください）' }));
    for (const w of ws) {
      const ta = reasonInputs[w.key] ?? (el('textarea', { name: `reason_${w.key}`, placeholder: '理由を入力' }) as HTMLTextAreaElement);
      if (!reasonInputs[w.key]) { ta.value = existing[w.key]?.reason ?? ''; reasonInputs[w.key] = ta; }
      warnBox.append(el('div', { class: 'warning-box' }, el('h3', { text: w.title }), el('p', { class: 'small', text: w.detail }), field('理由（必須）', ta)));
    }
    const first = missing[0];
    if (first && reasonInputs[first]) { reasonInputs[first]!.focus(); reasonInputs[first]!.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  };

  // 今日の分の確認（追加）
  const confirmBox = el('div', { class: 'hidden' });
  form.append(confirmBox);
  let confirmToday = false;

  // 確定ボタン
  const submitBtn = el('button', { type: 'submit', class: `btn big ${o.mode === 'clockout' ? 'out' : 'primary'}`, text: o.submitLabel ?? (o.mode === 'clockout' ? '退勤する' : o.mode === 'add' ? '追加する' : '修正を保存する') }) as HTMLButtonElement;
  form.append(el('div', { class: 'sticky-actions' }, submitBtn));

  const payload = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {
      clock_out: coIn.value, clock_out_date: coDateIn.value || null,
      break_minutes: Number(brIn.value) || 0, night_break_minutes: Number(nbrIn.value) || 0,
      travel_km: Number(kmIn.value) || 0, comment: commentIn.value,
      reasons: Object.fromEntries(Object.entries(reasonInputs).map(([k, ta]) => [k, ta.value])),
    };
    for (const [k, v] of Object.entries(existing)) if (!(k in (p['reasons'] as Record<string, string>))) (p['reasons'] as Record<string, string>)[k] = v.reason;
    if (!extras.classList.contains('hidden')) { p['allowance_amount'] = Number(allowIn.value) || 0; p['allowance_note'] = noteIn.value; p['meal_count'] = Number(mealIn.value) || 0; }
    if (o.mode === 'clockout') { if (ciIn.value && ciIn.value !== r.clock_in) p['clock_in_fix'] = ciIn.value; }
    else { p['clock_in'] = ciIn.value; p['correction_reason'] = reasonIn.value; }
    if (showDateLoc) { p['work_date'] = dateIn.value; p['location_code'] = locSel.value; }
    if (o.mode === 'add') p['confirm_today'] = confirmToday;
    return p;
  };

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    markInvalid(form, undefined);
    if (!coIn.value) { markInvalid(form, 'clock_out', '退勤時刻を入力してください'); return; }
    try {
      const res = await busy(submitBtn, '送信中…', () => o.submit(payload()));
      o.onDone(res);
    } catch (e) {
      if (isApiFailure(e) && e.info.code === 'NEEDS_REASON') {
        renderWarnings((e.info['warnings'] as WarningInfo[]) ?? [], (e.info['missing'] as string[]) ?? []);
        toast('理由を入力してからもう一度ボタンを押してください', 'info');
        return;
      }
      if (isApiFailure(e) && e.info.code === 'CONFIRM_TODAY') {
        confirmBox.classList.remove('hidden');
        confirmBox.innerHTML = '';
        const ok = el('button', { type: 'button', class: 'btn', text: '今日の分で間違いないので登録する' });
        ok.addEventListener('click', () => { confirmToday = true; form.requestSubmit(); });
        confirmBox.append(el('div', { class: 'notice warn', text: e.info.error }), ok);
        dateIn.focus(); dateIn.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      markInvalid(form, isApiFailure(e) ? e.info.field : undefined);
      toast(errorText(e), 'error');
    }
  });
  return form;
}
