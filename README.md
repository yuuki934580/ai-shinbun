# 🗞️ AI新聞 バックエンド

海外AI情報を毎朝自動収集・編集・配信する**完全自律バックエンドシステム**。

```
Reddit + ブログ + GitHub → Jina Reader → Gemini 1.5 Flash → Discord / Notion
```

---

## セットアップ手順

### 1. リポジトリ作成 & プッシュ

```bash
git init
git add .
git commit -m "init: AI新聞バックエンド"
git remote add origin https://github.com/YOUR_NAME/ai-shinbun.git
git push -u origin main
```

### 2. 環境変数を GitHub Secrets に登録

GitHub → Settings → Secrets and variables → Actions → New repository secret

| Secret 名 | 取得元 |
|---|---|
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `NOTION_API_KEY` | [Notion My Integrations](https://www.notion.so/my-integrations) |
| `NOTION_DATABASE_ID` | Notion DB URLの32桁ID |
| `DISCORD_WEBHOOK_URL` | Discord → サーバー設定 → ウェブフック |
| `JINA_API_KEY` | [Jina AI](https://jina.ai/)（任意） |

### 3. Notion DB の準備

以下のプロパティを持つ DB を作成し、作成した Integration を連携させる：

| プロパティ名 | 型 |
|---|---|
| `Title` | タイトル |
| `Date` | 日付 |
| `Importance_Score` | 数値 |
| `Status` | セレクト（Draft / Published） |

### 4. ローカルテスト

```bash
cp .env.example .env
# .env に各キーを記入

npm install
node src/cron.js --dry-run   # Discord/Notion には送らず出力確認
node src/cron.js             # 本番送信
```

### 5. 自動実行の確認

GitHub Actions → AI新聞 - 毎朝配信 → Run workflow でテスト実行

---

## アーキテクチャ

```
GitHub Actions (Cron 毎朝 UTC 19:00)
    │
    ▼
src/cron.js
    ├── Notion API      ← 過去5日タイトル取得（重複防止）
    ├── Jina Reader API ← Reddit/Blog/GitHub を Markdown で取得
    ├── Gemini 1.5 Flash← 朝刊リライト + スコアリング
    ├── Discord Webhook → 配信
    └── Notion API      → 下書き格納（Importance_Score付き）
```

## スコアリング

```
マスタースコア = (海外熱狂度[1-5] + 技術の普遍性[1-5] + 日本市場ポテンシャル[1-5]) / 1.5
```

Gemini が自動計算し Notion の `Importance_Score` へ格納。
Discord でスタンプ承認 → Notion 格納のフローは Bot 連携後に有効。

---

## 運用コスト

| サービス | 料金 |
|---|---|
| GitHub Actions | 無料枠内（月2000分） |
| Gemini 1.5 Flash | 無料枠あり（月15回/分） |
| Jina Reader API | 無料枠あり |
| Notion API | 無料 |
| Discord Webhook | 無料 |

**原価：$0/月（無料枠内運用）** ✅
