# 遠藤歯科クリニック - シフト同期ワーカー

アプリの「🔄 シフト最新化」ボタンが押されると、Supabase の `shift_sync_requests` テーブルに依頼が記録される。このワーカーは5分ごとに依頼をチェックし、DENTIS をスクレイピングして `shifts` テーブルを更新する。

## セットアップ手順

### 1. GitHub Secrets を登録

リポジトリの **Settings → Secrets and variables → Actions → New repository secret** から、以下5つを登録する。

| 名前 | 値 |
|---|---|
| `DENTIS_USERNAME` | DENTIS のログインID |
| `DENTIS_PASSWORD` | DENTIS のパスワード |
| `DENTIS_SLUG` | `JvbrMX` (医療機関ID) |
| `SUPABASE_URL` | `https://ysfqtjffnzbhoejbiiax.supabase.co` |
| `SUPABASE_KEY` | Supabase の publishable / anon key |

### 2. GitHub Actions を有効化

リポジトリの **Actions** タブで「I understand my workflows, go ahead and enable them」をクリック。

### 3. 動作確認

**Actions** タブ → 左メニューの「Shift Sync」 → 右上「Run workflow」で手動実行できる。ログを見て成功すれば設定完了。

## 仕様

### スクレイピングロジック

1. DENTIS の予定画面 (`/dental/schedule?date=YYYY-MM-DD`) を1日ずつ巡回し、右サイドバーの「出勤者」を取得 (同名は1人にカウント)
2. 訪問画面 (`/dental/visiting_schedule?date=YYYY-MM-DD`) で訪問スロットを取得
3. 訪問スロットごとに次のルールを適用:
   - 担当者 **4人以上** → 全員を「往」に
   - 担当者 **3人以下 (0〜3人)** → 院長のみ「往」、他は通常出勤のまま
4. Supabase の `shifts` テーブルに UPSERT

### トリガー

- **`schedule`**: 5分ごとに `pending` な依頼をチェック
- **`workflow_dispatch`**: Actions タブから手動実行
- **`repository_dispatch`** (type: `shift_sync`): 外部からの即時トリガー (将来の Supabase Webhook 用)

### 同時実行制御

`concurrency: shift-sync` で複数のジョブが重ならないようにしている。

## ローカルテスト

```bash
npm install
npx playwright install chromium
DENTIS_USERNAME='...' DENTIS_PASSWORD='...' DENTIS_SLUG='JvbrMX' \
  SUPABASE_URL='https://...supabase.co' SUPABASE_KEY='sb_publishable_...' \
  node worker.js
```
