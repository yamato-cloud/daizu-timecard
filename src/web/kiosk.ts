/**
 * 打刻端末（据え置きタブレット／個人スマホ共用）。
 * 原則：押したら必ず目に見える反応／読み込み中・0件・失敗を区別／ポーリングしない（5分に1回の軽量確認、非表示中は停止）／権限・計算はサーバー。
 */
import './style.css';
import { get, post, errorText, isApiFailure, needsGate } from './lib/api.js';
import { ensureGate } from './lib/gate.js';
import { $, el, toast, busy, openModal, pinPad, pad2, fmtDateJa } from './lib/ui.js';
import { shiftForm, type LocationInfo } from './lib/shift-form.js';

interface Staff { id: string; employee_id: string | null; staff_name: string; staff_kana: string; has_pin: boolean }
interface Bootstrap { version: string; server_time: string; locations: LocationInfo[]; staff: Staff[]; settings: Record<string, string> }
interface Rec { id: string; work_date: string; staff_id: string; staff_name: string; location_code: string | null; location_name: string | null; clock_in: string | null; status: string; [k: string]: unknown }

const app = $('#app');
const LS_LOC = 'dsf.kiosk.location';
let boot: Bootstrap;
let location_: LocationInfo | null = null;
let working: Rec[] = [];
let workingState: 'loading' | 'ok' | 'error' = 'loading';
let workingError = '';
let lastFetch = 0;

const settingsNum = (k: string, d: number) => { const v = Number(boot.settings[k]); return Number.isFinite(v) && boot.settings[k] !== '' ? v : d; };
const formSettings = () => ({ travel_fee_per_km: settingsNum('travel_fee_per_km', 20), meal_unit_price: settingsNum('meal_unit_price', 250) });

async function main() {
  try {
    await ensureGate(app);
    boot = await get<Bootstrap>('/api/kiosk/bootstrap');
  } catch (e) {
    if (needsGate(e)) { location.reload(); return; }
    app.innerHTML = '';
    app.append(el('div', { class: 'card' }, el('div', { class: 'state error' }, el('div', { text: errorText(e) }), el('button', { class: 'btn', type: 'button', text: 'もう一度読み込む', onclick: () => location.reload() }))));
    return;
  }
  const saved = localStorage.getItem(LS_LOC);
  location_ = boot.locations.find((l) => l.location_code === saved) ?? null;
  if (!location_) { renderLocationPicker(); return; }
  renderMain();
  await refreshWorking();
}

function renderLocationPicker() {
  app.innerHTML = '';
  const list = el('div', { class: 'list' });
  for (const l of boot.locations) {
    const b = el('button', { type: 'button', class: 'item selectable' }, el('div', { class: 'grow' }, el('div', { class: 'name', text: l.location_name }), el('div', { class: 'sub', text: l.department })));
    b.addEventListener('click', () => { localStorage.setItem(LS_LOC, l.location_code); location_ = l; renderMain(); refreshWorking(); });
    list.append(b);
  }
  app.append(el('div', { class: 'card' }, el('h1', { text: 'この端末の事業所を選んでください' }), el('p', { class: 'muted', text: '一度選ぶとこの端末に記憶されます（あとで変更できます）' }), list));
}

// ---------- メイン ----------
let clockEl: HTMLElement;
let workingBtn: HTMLButtonElement;
let workingListEl: HTMLElement;
function renderMain() {
  app.innerHTML = '';
  clockEl = el('div', { class: 'clock', 'aria-label': '現在時刻' });
  const changeLoc = el('button', { type: 'button', class: 'btn ghost', text: '事業所を変える', style: 'width:auto;min-height:36px;padding:4px 8px;font-size:.85rem' });
  changeLoc.addEventListener('click', () => { if (confirm('この端末の事業所を変更しますか？')) renderLocationPicker(); });
  const top = el('div', { class: 'topbar' }, el('div', {}, el('div', { class: 'title', text: location_!.location_name }), el('div', { class: 'muted small', text: boot.settings['company_name'] ?? '' })), clockEl);
  const inBtn = el('button', { type: 'button', class: 'btn primary big', text: '出勤する' }) as HTMLButtonElement;
  inBtn.addEventListener('click', () => openClockIn());
  workingBtn = el('button', { type: 'button', class: 'btn out big' }, '退勤する', el('span', { class: 'badge', text: '…' })) as HTMLButtonElement;
  workingBtn.addEventListener('click', () => {
    const card = $('#working-card');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
    if (workingState === 'ok' && working.length === 0) toast('この事業所で勤務中の人はいません。出勤を押していない場合は「出勤する」から', 'info');
    else toast('下の一覧から自分の名前を押してください', 'info', 2500);
  });
  workingListEl = el('div', { id: 'working-list' });
  const reloadBtn = el('button', { type: 'button', class: 'btn ghost', text: '更新', style: 'width:auto;min-height:36px' });
  reloadBtn.addEventListener('click', () => refreshWorking(true));
  const links = el('div', { class: 'links' },
    el('a', { class: 'btn', href: '/my.html', text: '自分の記録' }),
    el('a', { class: 'btn', href: '/my.html#leave', text: '有給申請' }),
    el('a', { class: 'btn', href: '/my.html#pin', text: '暗証番号の変更' }),
    el('a', { class: 'btn', href: '/admin.html', text: '管理' }),
  );
  app.append(
    top,
    el('div', { class: 'card' }, el('div', { class: 'row' }, inBtn, workingBtn)),
    el('div', { class: 'card', id: 'working-card' }, el('div', { class: 'sheet-head' }, el('h2', { text: `勤務中（${location_!.location_name}）` }), reloadBtn), workingListEl),
    el('div', { class: 'card' }, el('h3', { text: 'その他' }), links, el('div', { class: 'muted small mt' }, `版 ${boot.version} `, changeLoc)),
  );
  tickClock();
}
function tickClock() {
  const d = new Date();
  if (clockEl) clockEl.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  setTimeout(tickClock, 1000 * (60 - d.getSeconds()));
}

async function refreshWorking(manual = false) {
  if (!location_) return;
  workingState = working.length ? workingState : 'loading';
  renderWorking();
  try {
    const r = await get<{ records: Rec[] }>(`/api/kiosk/working?location_code=${encodeURIComponent(location_.location_code)}`);
    working = r.records; workingState = 'ok'; lastFetch = Date.now();
  } catch (e) {
    if (needsGate(e)) { location.reload(); return; }
    workingState = 'error'; workingError = errorText(e);
    if (manual) toast(workingError, 'error');
  }
  renderWorking();
}
function renderWorking() {
  workingListEl.innerHTML = '';
  if (workingBtn) { const b = workingBtn.querySelector('.badge')!; b.textContent = workingState === 'ok' ? String(working.length) : '…'; }
  if (workingState === 'loading') { workingListEl.append(el('div', { class: 'state loading', text: '読み込み中…' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' })); return; }
  if (workingState === 'error') {
    const b = el('button', { type: 'button', class: 'btn', text: 'もう一度読み込む' });
    b.addEventListener('click', () => refreshWorking(true));
    workingListEl.append(el('div', { class: 'state error' }, el('div', { text: `一覧を取得できませんでした：${workingError}` }), b));
    return;
  }
  if (!working.length) { workingListEl.append(el('div', { class: 'state', text: '勤務中の人はいません（0人）' })); return; }
  const list = el('div', { class: 'list' });
  for (const r of working) {
    const od = r.status === 'OVERDUE';
    const b = el('button', { type: 'button', class: 'item selectable', 'aria-label': `${r.staff_name} 退勤する` },
      el('div', { class: 'grow' }, el('div', { class: 'name', text: r.staff_name }), el('div', { class: 'sub', text: `${fmtDateJa(r.work_date)} ${r.clock_in ?? ''} 出勤` })),
      el('span', { class: `tag ${od ? 'overdue' : ''}`, text: od ? '退勤忘れ' : '退勤する ›' }));
    b.addEventListener('click', () => openClockOut(r));
    list.append(b);
  }
  workingListEl.append(list);
}
// 5分に1回の軽量確認（非表示中は停止）
setInterval(() => { if (document.visibilityState === 'visible' && location_ && Date.now() - lastFetch > 5 * 60e3) refreshWorking(); }, 60e3);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && location_ && Date.now() - lastFetch > 60e3) refreshWorking(); });

// ---------- 出勤 ----------
function openClockIn(preselect?: Staff) {
  const body = el('div');
  const m = openModal('出勤する', body);
  const step1 = () => {
    body.innerHTML = '';
    const search = el('input', { type: 'text', placeholder: '名前・よみがなで検索', inputmode: 'search', 'aria-label': '名前で検索' }) as HTMLInputElement;
    const list = el('div', { class: 'list' });
    const render = () => {
      const qv = search.value.trim();
      list.innerHTML = '';
      const hit = boot.staff.filter((s) => !qv || s.staff_name.includes(qv) || s.staff_kana.includes(qv));
      if (!hit.length) { list.append(el('div', { class: 'state', text: '該当する名前がありません。名前が無い場合は管理者に登録を依頼してください' })); return; }
      for (const s of hit) {
        const b = el('button', { type: 'button', class: 'item selectable' }, el('div', { class: 'grow' }, el('div', { class: 'name', text: s.staff_name }), el('div', { class: 'sub', text: s.staff_kana })), el('span', { class: 'tag', text: '選ぶ ›' }));
        b.addEventListener('click', () => step2(s));
        list.append(b);
      }
    };
    search.addEventListener('input', render);
    body.append(el('p', { class: 'muted', text: '自分の名前を選んでください（よみがな順）' }), search, el('div', { class: 'mb' }), list);
    render();
  };
  const step2 = (s: Staff) => {
    body.innerHTML = '';
    const alcoholIn = el('input', { type: 'text', name: 'alcohol_check', inputmode: 'decimal', placeholder: '例：0.00' }) as HTMLInputElement;
    const err = el('div', { class: 'notice danger hidden', role: 'alert' });
    const submitBtn = el('button', { type: 'button', class: 'btn primary big', text: '出勤する', disabled: true }) as HTMLButtonElement;
    let pin = '';
    const pad = pinPad((p) => { pin = p; submitBtn.disabled = false; if (!location_!.check_alcohol) submitBtn.click(); else submitBtn.focus(); }, { label: `${s.staff_name} さんの暗証番号（4桁）` });
    const requestId = crypto.randomUUID();
    submitBtn.addEventListener('click', async () => {
      if (location_!.check_alcohol && !alcoholIn.value.trim()) { alcoholIn.setAttribute('aria-invalid', 'true'); alcoholIn.focus(); toast('アルコールチェックの数値を入力してください', 'error'); return; }
      try {
        const r = await busy(submitBtn, '送信中…', () => post<{ message: string; record: Rec }>('/api/kiosk/clock-in', { staff_id: s.id, pin, location_code: location_!.location_code, request_id: requestId, alcohol_check: alcoholIn.value.trim() || undefined }));
        m.close();
        toast(r.message, 'success', 5000);
        await refreshWorking();
        const card = $('#working-card'); card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
      } catch (e) {
        if (isApiFailure(e) && e.info.code === 'HAS_OPEN') { m.close(); openCloseFirst(e.info['open'] as Rec, s); return; }
        if (isApiFailure(e) && e.info.code === 'ALREADY_WORKING') { m.close(); toast(e.info.error, 'error'); await refreshWorking(); return; }
        pad.reset(); pin = ''; submitBtn.disabled = true;
        err.textContent = errorText(e); err.classList.remove('hidden');
      }
    });
    body.append(
      el('div', { class: 'kv mb' }, el('dt', { text: '名前' }), el('dd', {}, el('strong', { text: s.staff_name })), el('dt', { text: '事業所' }), el('dd', { text: location_!.location_name }), el('dt', { text: '出勤時刻' }), el('dd', { text: '今（サーバーの時刻で記録）' })),
      ...(location_!.check_alcohol ? [el('label', { class: 'field' }, el('span', { text: 'アルコールチェック（数値）' }), alcoholIn)] : []),
      err, pad.root,
      el('div', { class: 'sticky-actions' }, submitBtn),
      el('button', { type: 'button', class: 'btn ghost', text: '← 名前を選び直す', onclick: step1 }),
    );
    pad.focus();
  };
  if (preselect) step2(preselect); else step1();
}

/** 未退勤があるとき：先に前回の退勤を締めてから出勤 */
function openCloseFirst(open: Rec, s: Staff) {
  const body = el('div');
  const m = openModal('先に前回の退勤を入力', body);
  body.append(el('div', { class: 'notice warn', text: `${s.staff_name} さんは ${fmtDateJa(open.work_date)} ${open.clock_in ?? ''} に出勤した分（${open.location_name ?? ''}）の退勤が済んでいません。先にその退勤を入力してから、今日の出勤を記録します。` }));
  body.append(shiftForm({
    mode: 'clockout', record: { ...open, clock_in: open.clock_in, status: open.status === 'WORKING' ? 'OVERDUE' : open.status } as never,
    locations: boot.locations, settings: formSettings(), submitLabel: '前回の退勤を記録して、今日の出勤へ進む',
    submit: (p) => post('/api/kiosk/clock-out', { ...p, attendance_id: open.id }),
    onDone: (r) => { m.close(); toast(r.message ?? '前回の退勤を記録しました', 'success'); refreshWorking(); openClockIn(s); },
  }));
}

// ---------- 退勤 ----------
function openClockOut(r: Rec) {
  const body = el('div');
  const m = openModal(`退勤：${r.staff_name} さん`, body);
  if (r.status === 'OVERDUE') body.append(el('div', { class: 'notice danger', text: '出勤から24時間を超えています（退勤忘れ）。実際に退勤した時刻を入力してください。' }));
  body.append(shiftForm({
    mode: 'clockout', record: r as never, locations: boot.locations, settings: formSettings(),
    submit: (p) => post('/api/kiosk/clock-out', { ...p, attendance_id: r.id }),
    onDone: async (res) => { m.close(); toast(res.message ?? `${r.staff_name} さん、おつかれさまでした`, 'success', 6000); working = working.filter((x) => x.id !== r.id); renderWorking(); await refreshWorking(); },
  }));
  // 出勤取消（危険操作：確定ボタンから離して配置・PIN必須）
  const cancelBtn = el('button', { type: 'button', class: 'btn danger', text: 'この出勤を取り消す（間違えて出勤した場合）' });
  cancelBtn.addEventListener('click', () => openCancelOpen(r, m.close));
  body.append(el('div', { class: 'card mt' }, el('p', { class: 'muted small', text: '間違えて出勤を押した場合は、退勤ではなく取消をしてください（本人の暗証番号が必要）' }), cancelBtn));
}
function openCancelOpen(r: Rec, closeParent: () => void) {
  const body = el('div');
  const m = openModal('出勤を取り消す', body);
  const err = el('div', { class: 'notice danger hidden', role: 'alert' });
  const pad = pinPad(async (pin) => {
    try {
      const res = await post<{ message: string }>('/api/kiosk/cancel-open', { attendance_id: r.id, pin });
      m.close(); closeParent(); toast(res.message, 'success'); await refreshWorking();
    } catch (e) { pad.reset(); err.textContent = errorText(e); err.classList.remove('hidden'); }
  }, { label: `${r.staff_name} さんの暗証番号（4桁）` });
  body.append(el('div', { class: 'notice warn', text: `${fmtDateJa(r.work_date)} ${r.clock_in ?? ''} の出勤記録を取り消します。退勤ではありません。` }), err, pad.root);
  pad.focus();
}

main();
