# だいずスマイルファクトリー タイムカード（再構築版）

- 現在の版：**0.1.0**（2026-10-09）
- 構成：**B-1 ConoHa VPS に自前サーバー**（Node.js 22 ＋ PostgreSQL 16 ＋ Caddy）。大和さん決定 2026-10-09
- 状態：**フェーズ1・2 完了（計算／API／画面3種／給与CSV／定期処理）。フェーズ3（実データ移行と検算）以降は大和さんの作業待ち**
- 元資料：引継書 `README_再構築ブリーフ.md`（§4 業務ルール・§9 設計原則 14項目・§12 受入テスト）

---

## 1. いま何ができているか

| フェーズ | 内容 | 状態 |
|---|---|---|
| 0 合意 | §11 の未決事項を確認。**B-1（VPS）／退勤はPINなし／管理者は Google ログイン／LINE WORKS 鍵は当面そのまま** | 済 |
| 1 計算 | §4 の業務ルールを純粋関数で実装（`src/calc/`）。受入テスト **C1〜C21 全 PASS**、旧テスト相当・CSV 形式固定テスト含め **73件** | 済 |
| 2 必須機能 | 打刻端末（M1〜M3, M12）／マイページ（M4〜M6）／管理（M7〜M9）／給与CSV 3種＋自動送信（M10）／バックアップ・退勤忘れ判定（M11）。API 統合テスト 33件（F2〜F4, F8〜F16, S1〜S3, N4, P4〜P7）。**390px と 1280px で全画面を確認済み** | 済 |
| 3 移行・検算 | 旧 CSV の取り込みコマンド（`npm run import:legacy`）とテストは済。**実データでの取り込みと、過去3か月の給与CSV 全列一致の確認は未実施** | 大和さんの作業待ち |
| 4〜5 並行運用・切替 | 手順は §5 に記載 | 未 |
| 6 早めの機能 | PINリセット／退勤忘れリマインド／出勤報告メール／大吉 LINE WORKS／お知らせ／従業員リスト連携 | **未実装**（テーブルと設定項目だけ用意） |

自動テスト：**115件 全 PASS**（`npm test`）。実装後に別のレビュー担当（この作業を見ていない AI）に全コードを点検させ、指摘 11件（管理画面から退勤忘れを締められない／翌月の有給を本人が取り消せない／起動PINロックの抜け道／導入直後の給与メール誤送信 など）をすべて修正し、再発防止のテストを追加済み。

---

## 2. 未検証・未実装のこと（正直に）

### 未検証（私の環境では実行できない。大和さんの環境で確認が必要）
- **実データの移行**：旧スプレッドシートの CSV を `npm run import:legacy` で取り込むこと。取り込み結果（スキップ・注意）を見て直すこと
- **過去3か月の給与CSV 3種が旧システムと全列一致すること**（P1〜P3）。手順は §5.4
- **メール送信**（Google Workspace の SMTP）。設定するまではサーバーの `outbox/` フォルダにファイルとして書き出されるだけで、メールは届きません
- **Google ログイン**（Google Cloud での設定が必要。手順は §4.6）。設定するまでは「緊急ログイン」を使う
- **Google スプレッドシートへの日次出力**（サービスアカウントの設定が必要。コードはあるが未検証）
- **VPS での `deploy/setup.sh`**（Ubuntu 22.04/24.04 向け。構文確認のみ）
- **実機（iPhone/Android の据え置きタブレット）での表示**。Chromium の 390px / 1280px では確認済み
- 4G 回線での応答時間（N1〜N3）

### 未実装（§5.2「早めに」以降）
- E1 PINリセット申請（今は管理画面またはサーバーコマンドで管理者が再設定）
- E2 退勤忘れリマインドメール（`checkout_tokens` テーブルは用意済み）
- E3 出勤報告メール（`report_recipients` テーブル・`report_blocked_emails` 設定は用意済み）
- E4 大吉 LINE WORKS 通知（**鍵を再発行してから**。環境変数 `LW_*` を用意済み）
- E6 お知らせ配信（テーブルのみ）
- E7 従業員リスト自動連携（今は新規登録時に「既存の最大＋1」で仮番号。管理画面で正本の番号に直す）
- スタッフ自己登録「はじめての方」（管理者登録に一本化：Q5）、個人情報変更申請（扱わない：Q6）、豆知識・専用リンク（作らない：Q7）

### 大和さんに確認したいこと（仕様の解釈）
1. **日跨ぎなしの深夜休憩**：現行コードは「日跨ぎなし」のとき深夜休憩を深夜時間から引いていませんが、引継書 §4.2 は「深夜 ＝ 重なり − 深夜休憩」と書いてあります。**文書どおり（常に引く）で実装**しました。例：17:00〜23:30 で深夜休憩30分 → 旧 90分／新 60分。該当は稀（日跨ぎなしで深夜休憩を入れた記録）。旧データは保存値をそのまま使うので過去の CSV には影響しません
2. **備考の【理由】連結の順序**：引継書 §4 §8 の順序と、現行コードの実際の順序が違います。CSV は**現行コードの実際の出力に合わせました**（休憩乖離確認 → GH休憩確認 → 打刻時警告確認 → 休憩内訳確認 → 休憩X分（法定…）理由 → 本人の備考）
3. **法定休憩の判定基準**：現行の画面は拘束時間で判定していましたが、引継書 §4.5 と `calc.js` は実働で判定しています。**実働で判定**（労基法どおり）。警告の出方だけが変わり、給与額には影響しません
4. **同日 0:00〜5:00 の深夜**：現行どおり「日跨ぎなし」の深夜帯は「出勤日の 22:00〜翌5:00」なので、たとえば 00:00〜07:00 の同日勤務は深夜 0分です（旧と同じ）。問題があれば社労士確認のうえ変更
5. LINE WORKS の鍵は**当面そのまま（再発行しない）で進める**（大和さん判断 2026-10-09）。現行 `gas/大吉.gs` に平文で入っていた経緯があるので、大吉通知を新システムに移すときに再発行を再検討（手順は §4.8）

---

## 3. 構成と設計のポイント

```
[画面]   src/web/   index.html（打刻端末） my.html（マイページ） admin.html（管理）  ※ vanilla TypeScript、合計 約60KB
          ↓ HTTPS + JSON。エラーは HTTP ステータス＋理由（画面はそのまま表示）
[API]    src/server/  Fastify。権限・計算・期限はすべてここ。既定は拒否
          計算は src/calc/（純粋関数・テスト済み）だけが行う
[DB]     PostgreSQL。attendance 1テーブル・全期間（分割しない）。時刻は timestamptz、ID・PIN・従業員番号は文字列
[定期]   src/server/jobs.ts  毎分 tick → 退勤忘れ判定（毎時）／給与CSV送信（毎月8日7時台）／バックアップ（毎日3時台）
          冪等（job_runs の期間キー）・引数なし・失敗は管理者へメール
[認証]   管理者：Google アカウント（許可メール2名）／スタッフ：氏名＋4桁PIN（scrypt＋ソルト、5回失敗で30秒待ち・完全ロックなし）
          端末：起動PIN（4桁）を通った端末だけに Cookie を発行（その端末だけ5回失敗で5分ロック）。退勤は PIN なし（現行踏襲）
[配信]   Vite ビルド。資産はハッシュ付きファイル名、HTML は no-cache → 更新後は端末操作なしで最新
```

§9 設計原則 14項目との対応：1 正本1か所（attendance 1テーブル）／2 権限・計算・期限はサーバー／3 理由をそのまま表示／4 押したら反応（通信中表示・二重送信防止・自動スクロール）／5 読み込み中・0件・失敗を区別／6 ポーリングなし（5分に1回・非表示中は停止）／7 版数はビルドのハッシュ／8 型／9 冪等／10 テスト／11 390px 確認／12 安全装置は Cookie 拒否でも動く（IP 併用）／13 事業所はフラグ `gh_extras` `gh_break_rule`／14 定期処理は引数なし

### 業務ルールの所在（給与に関わる変更はここだけ・テスト必須）
| ルール | ファイル |
|---|---|
| 拘束・実働・深夜・交通費・GH手当・まかない・法定休憩・GH休憩ルール・警告 | `src/calc/shift.ts` |
| 有給・期限（翌月7日）・OVERDUE・主事業部 | `src/calc/rules.ts` |
| 給与CSV 3種（列名・列順・形式）・メール本文 | `src/calc/payroll.ts` |
| テスト | `tests/calc.test.ts`（C1〜C21）、`tests/payroll.test.ts`、`tests/api.test.ts`、`tests/import.test.ts` |

---

## 4. 大和さんの作業手順（初回導入）

> 所要：1〜2時間。順番どおりに。分からないところは止まって聞いてください。

### 4.1 GitHub にプログラム置き場を作る（1回だけ）
1. ブラウザで https://github.com/new を開く（`yamato-cloud` アカウントでログイン）
2. 「Repository name」に `daizu-timecard` と入力
3. **Private** を選ぶ（公開しない）
4. 緑の「Create repository」を押す
5. できたら、私（Claude）に「作りました」と伝える → 私がプログラムを送り込みます

### 4.2 ドメインを VPS に向ける
1. お名前.com 等、`daizu.info` を管理している画面を開く
2. DNS 設定で **A レコード**を追加：ホスト名 `timecard`、値 = ConoHa VPS の IP アドレス（ConoHa コントロールパネル → サーバー → IP アドレス）
3. 反映まで数分〜1時間

### 4.3 VPS にセットアップ
1. ConoHa コントロールパネル → サーバー → 「コンソール」を開く（または Windows の「ターミナル」で `ssh root@（IPアドレス）`）
2. 次を1行ずつ貼り付けて Enter（root で実行。`sudo` が付いていればそのままで可）
   ```bash
   sudo apt-get update && sudo apt-get install -y gh
   gh auth login --hostname github.com --git-protocol https --web
   ```
   → 「Press Enter to open github.com in your browser」と出たら Enter。表示されるコード（XXXX-XXXX）を、スマホかPCのブラウザで https://github.com/login/device を開いて入力 → 「Authorize」
   ```bash
   gh repo clone yamato-cloud/daizu-timecard /opt/daizu-timecard
   sudo bash /opt/daizu-timecard/deploy/setup.sh timecard.daizu.info
   ```
3. 10分ほど待つ（Node.js・PostgreSQL・Caddy を入れてビルドする）
4. 最後に「セットアップ完了」と「緊急ログイン用トークン」が表示される。**トークンをメモ**（管理画面に入る鍵）

### 4.4 起動PIN と送信先を設定（VPS のコンソールで）
```bash
cd /opt/daizu-timecard
sudo -u daizu -H npm run cli -- set-gate-pin 1234
sudo -u daizu -H npm run cli -- set-setting payroll_notify_emails yamato@daizu.info
sudo -u daizu -H npm run cli -- set-setting admin_notify_emails yamato@daizu.info
```
（`1234` は実際の起動PINに置き換え。あとから管理画面の「設定」タブでも変えられます）

### 4.5 管理画面に入る
1. ブラウザで `https://timecard.daizu.info/admin.html` を開く
2. 「Google が使えないときの緊急ログイン」を押して開き、4.3 でメモしたトークンを貼って「緊急ログイン」
3. 「事業所」タブ → 「＋ 事業所を追加」で 13 事業所を登録（**事業部は必須**。「手当・まかない」「GH休憩ルール」のチェックを正しく）
4. 「スタッフ」タブ → 「＋ スタッフを追加」（従業員IDは人事「従業員リスト」の番号）
   ※ 旧データを取り込む場合は §5 の手順で事業所・スタッフごと入るので、3〜4 は不要

### 4.6 Google ログインを設定する（任意だが推奨。15分）
1. https://console.cloud.google.com/ を開く（`yamato@daizu.info` でログイン）
2. 上部のプロジェクト選択 → 「新しいプロジェクト」→ 名前 `daizu-timecard` → 作成
3. 左メニュー「API とサービス」→「OAuth 同意画面」→ ユーザーの種類「内部」→ アプリ名 `タイムカード` → サポートメールを選ぶ → 保存
4. 「認証情報」→「＋ 認証情報を作成」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」
5. 「承認済みのリダイレクト URI」に `https://timecard.daizu.info/api/auth/google/callback` を追加 → 作成
6. 表示された「クライアント ID」と「クライアント シークレット」をコピー
7. VPS のコンソールで `sudo nano /opt/daizu-timecard/.env` を開き、`GOOGLE_CLIENT_ID=` と `GOOGLE_CLIENT_SECRET=` の右に貼る → Ctrl+O, Enter, Ctrl+X で保存
8. `ADMIN_EMAILS=yamato@daizu.info,（新井さんのメール）` も同じファイルで
9. `sudo systemctl restart daizu-timecard`
10. 管理画面を開き直すと「Google アカウントでログイン」が使える

### 4.7 メール送信を設定する（給与CSV の自動送信に必須）
Google Workspace（daizu.info の Gmail）を使う場合：
1. https://myaccount.google.com/apppasswords を開く（送信元にしたいアカウントで。2段階認証が有効であること）
2. アプリ名 `タイムカード` → 作成 → 16文字のパスワードをコピー
3. VPS の `.env` で `SMTP_HOST=smtp.gmail.com`、`SMTP_PORT=587`、`SMTP_USER=（そのメール）`、`SMTP_PASS=（16文字）`、`MAIL_FROM=だいずタイムカード <（そのメール）>`
4. `sudo systemctl restart daizu-timecard`
5. 管理画面 →「給与データ」→ 対象月を選んで「メールで送信（手動送信）」で届くか確認（送信先は「設定」タブ）

### 4.8 LINE WORKS の鍵を再発行する（当面は保留。大吉通知を新システムへ移すときに）
1. https://dev.worksmobile.com/ → Developer Console → 「API 2.0」→ 該当アプリ
2. 「Service Account」の秘密鍵を**再発行**（古い鍵は無効に）。Client Secret も再発行
3. 新しい値は、通知機能を作るときに `.env` の `LW_*` に入れる（今は未実装）

---

## 5. 旧データの移行と検算（フェーズ3）

### 5.1 旧スプレッドシートから CSV を出す
1. 勤怠スプレッドシートを開く
2. シート `staff` を表示 → メニュー「ファイル」→「ダウンロード」→「カンマ区切り形式（.csv）」→ `staff.csv`
3. 同じく `locations` → `locations.csv`、`attendance` → `attendance.csv`
4. `attendance_archive*` シートが残っていれば中身を確認（引継書 13章 T1）。残っている行は `attendance.csv` に手で足す（列は同じ）

### 5.2 VPS に送る
- Windows：「ターミナル」で `scp staff.csv locations.csv attendance.csv root@（IP）:/tmp/`
- または ConoHa のファイルマネージャー等で `/tmp/` に置く

### 5.3 取り込む（まず確認だけ → 本番）
```bash
cd /opt/daizu-timecard
sudo -u daizu -H npm run import:legacy -- --staff /tmp/staff.csv --locations /tmp/locations.csv --attendance /tmp/attendance.csv --dry-run
```
「スキップ」「注意」を読んで、必要なら CSV を直して再実行。問題なければ `--dry-run` を外して実行（何度実行しても重複しません）。
その後、管理画面「事業所」で **事業部・GHフラグ**を確認してください（名前から自動で初期化しています）。

### 5.4 給与CSV の検算（旧と全列一致）
```bash
sudo -u daizu -H npm run cli -- payroll 2026-07 /tmp/check/2026-07
sudo -u daizu -H npm run cli -- payroll 2026-08 /tmp/check/2026-08
sudo -u daizu -H npm run cli -- payroll 2026-09 /tmp/check/2026-09
```
旧システムが送った `給与集計_YYYY-MM.csv` 等（メールの添付）と、上で出た 3 ファイルを Excel で開いて比べる。**全スタッフ・全列が一致**すれば合格。違いがあれば私に 2 つのファイルを送ってください（原因を調べます）。

### 5.5 並行運用 → 切替
1. 1 事業所の端末で 1〜2 週間、新システム（`https://timecard.daizu.info`）でも打刻（旧でも打刻）
2. 月末〜翌 7 日：新旧両方で給与CSV を出し一致確認
3. 全事業所の端末のホーム画面アイコンを新 URL に貼り替え（Safari/Chrome で開いて「ホーム画面に追加」）。初回だけ起動PIN
4. **旧 GAS のトリガーを止める**（給与メールが二重に届くため）：Apps Script → 時計アイコン「トリガー」→ 各行の︙ → 削除
5. 旧スプレッドシートは読み取り専用で保管

---

## 6. 日常の操作（どこを開いて何を押すか）

| やりたいこと | 操作 |
|---|---|
| 更新を出す（私が GitHub に入れた後） | VPS コンソールで `sudo bash /opt/daizu-timecard/deploy/update.sh` |
| 起動PINを変える | 管理画面 → 設定 → 起動PIN → 入力 →「起動PINを設定する」（全端末で再入力） |
| スタッフの暗証番号を忘れた | 管理画面 → スタッフ → 本人を押す → 「暗証番号を再設定」に4桁 → 保存 |
| 勤怠を直す・消す・足す | 管理画面 → 勤怠 → 月で絞る → 行を押す →「編集する」「削除」／「＋ 記録を追加」「＋ 有給を追加」 |
| 給与CSVを今すぐ出す | 管理画面 → 給与データ → 対象月 → ①②③ を押す（ダウンロード）／「メールで送信」 |
| 送信先・単価を変える | 管理画面 → 設定 |
| 定期処理が動いたか見る | 管理画面 → 定期処理・ログ（失敗はメールでも通知） |
| 給与の自動送信 | 毎月8日 7時台（8〜10日の間にサーバーが止まっていても復帰後に1回だけ）。**導入直後の最初の月は自動送信しない**（旧システムと二重になるため）ので、並行運用中は「給与データ」から手動送信 |
| バックアップから戻す | `deploy/backup-restore.md` |
| サーバーの状態 | `sudo systemctl status daizu-timecard` ／ ログ `sudo journalctl -u daizu-timecard -n 100` |

---

## 7. 開発者向け

```bash
npm ci
cp .env.example .env    # DATABASE_URL 等を編集
npm run migrate          # DB 作成
npm run seed:dev         # 開発用サンプル（起動PIN 7777・スタッフPIN 0000 等）
npm run dev:server       # http://localhost:3000（dist/web をビルド済みなら画面も出る）
npm run build            # 画面＋サーバー
npm test                 # 115件（PostgreSQL が必要：DATABASE_URL_TEST）
npm run shots            # Playwright で 390px/1280px のスクリーンショット（/tmp/shots）
```
- `src/calc/` は I/O なし。給与に関わる変更は必ずテストを足し、旧→新で同じ出力になる証跡を残す
- API の権限は `src/server/routes/*.ts` の冒頭ガード（`requireAdmin` / `requireStaff` / `requireKiosk`）と `services/attendance.ts` の本人判定・期限判定
- 秘密情報は `.env` だけ（`.gitignore` 済み）。ソースには書かない

## 8. 更新履歴
- 0.1.0（2026-10-09）初版：フェーズ1・2 完了、移行コマンド、VPS 導入スクリプト
