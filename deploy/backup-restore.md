# バックアップからの復元（非常時）

毎日 `BACKUP_DIR`（既定 `/var/lib/daizu-timecard/backups/<日付_時刻>/`）に次が作られます。

- `db.dump` … PostgreSQL の完全なバックアップ
- `csv/*.csv` … attendance / staff / locations / settings / report_recipients を Excel で開ける CSV

## DB を丸ごと戻す

```bash
sudo systemctl stop daizu-timecard
sudo -u postgres dropdb daizu_timecard
sudo -u postgres createdb -O daizu daizu_timecard
sudo -u postgres pg_restore --no-owner -d daizu_timecard /var/lib/daizu-timecard/backups/<戻したい日付>/db.dump
sudo systemctl start daizu-timecard
```

## 手動でバックアップを取る

管理画面 → 定期処理・ログ → 「バックアップ」の「今すぐ実行」。
