/** 起動PIN（サイトゲート）画面。通るまで本体を出さない。ロック中は残り秒数を表示 */
import { get, post, errorText, isApiFailure } from './api.js';
import { el, pinPad } from './ui.js';

export async function ensureGate(container: HTMLElement): Promise<void> {
  const st = await get<{ passed: boolean; configured: boolean }>('/api/kiosk/gate/status').catch(() => ({ passed: false, configured: true }));
  if (st.passed) return;
  await new Promise<void>((resolve) => {
    container.innerHTML = '';
    const msg = el('div', { class: 'notice info', text: st.configured ? 'この端末で初めて開くときは、起動PIN（4桁）を入力してください。' : '起動PINがまだ設定されていません。管理者が管理画面の「設定」で設定してください。' });
    const err = el('div', { class: 'notice danger hidden', role: 'alert' });
    const pad = pinPad(async (pin) => {
      try {
        await post('/api/kiosk/gate', { pin });
        container.innerHTML = '';
        resolve();
      } catch (e) {
        pad.reset();
        err.textContent = errorText(e);
        err.classList.remove('hidden');
        if (isApiFailure(e) && e.info.code === 'GATE_LOCKED') {
          const sec = Number(e.info['retry_after_sec'] ?? 300);
          let left = sec;
          const t = setInterval(() => { left--; err.textContent = `起動PINを5回間違えたため、この端末はあと ${Math.floor(left / 60)}分${left % 60}秒 ロックされています`; if (left <= 0) { clearInterval(t); err.classList.add('hidden'); } }, 1000);
        }
      }
    }, { label: '起動PIN（4桁）' });
    container.append(el('div', { class: 'card' }, el('h1', { text: 'タイムカード' }), msg, err, pad.root));
    pad.focus();
  });
}
