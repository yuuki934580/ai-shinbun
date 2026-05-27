/**
 * AI新聞 - メインCronスクリプト
 * 毎朝 04:00 JST (UTC 19:00) に GitHub Actions から起動
 *
 * 処理フロー:
 *  1. Notion から過去5日分のタイトルを取得（重複防止）
 *  2. Jina Reader API で各ソースを取得
 *  3. Gemini 1.5 Flash でリライト・スコアリング
 *  4. Discord Webhook へ配信
 *  5. Notion DB へ下書き格納（スタンプ承認待ち）
 */

import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Client as NotionClient } from "@notionhq/client";

// ──────────────────────────────────────────
// 環境変数
// ──────────────────────────────────────────
const {
  GEMINI_API_KEY,
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
  DISCORD_WEBHOOK_URL,
} = process.env;

const DRY_RUN = process.argv.includes("--dry-run");

// ──────────────────────────────────────────
// 監視ソース定義
// ──────────────────────────────────────────
const SOURCES = {
  reddit: [
    "https://www.reddit.com/r/singularity/rising/.rss",
    "https://www.reddit.com/r/LocalLLaMA/rising/.rss",
    "https://www.reddit.com/r/AI_Agents/rising/.rss",
  ],
  blog: [
    "https://www.latent.space/feed",                    // Latent Space
    "https://simonwillison.net/atom/everything/",       // Simon Willison
    "https://www.oneusefulthing.org/feed",              // One Useful Thing
  ],
  github: [
    "https://github.com/trending?since=daily&spoken_language_code=",
  ],
};

// ──────────────────────────────────────────
// ユーティリティ
// ──────────────────────────────────────────

/** Jina Reader API 経由でノイズレス Markdown を取得 */
async function fetchWithJina(url, timeoutMs = 20000) {
  const jinaUrl = `https://r.jina.ai/${url}`;
  console.log(`  📥 Fetching: ${jinaUrl.slice(0, 80)}...`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(jinaUrl, {
      headers: {
        "Accept": "text/markdown, text/plain, */*",
        "User-Agent": "AI-Shinbun-Bot/1.0",
        // Jina API Key があれば高レートへ昇格（任意）
        ...(process.env.JINA_API_KEY
          ? { Authorization: `Bearer ${process.env.JINA_API_KEY}` }
          : {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text.slice(0, 8000); // 1ソースあたり最大 8k chars
  } catch (e) {
    console.warn(`  ⚠️  Skip (${url.slice(0, 60)}): ${e.message}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** 全ソースを並列取得し、カテゴリ別にまとめる */
async function fetchAllSources() {
  const results = {};

  for (const [category, urls] of Object.entries(SOURCES)) {
    console.log(`\n🔍 [${category.toUpperCase()}] fetching ${urls.length} sources...`);
    const texts = await Promise.all(urls.map(fetchWithJina));
    results[category] = texts.filter(Boolean).join("\n\n---\n\n");
  }

  return results;
}

// ──────────────────────────────────────────
// Notion: 過去5日分タイトル取得
// ──────────────────────────────────────────
async function getRecentTitles(notion) {
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    console.warn("⚠️  Notion env not set, skipping duplicate check");
    return [];
  }

  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  try {
    const res = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      filter: {
        property: "Date",
        date: { on_or_after: fiveDaysAgo },
      },
      page_size: 50,
    });

    return res.results
      .map((p) => {
        const title = p.properties?.Title?.title?.[0]?.plain_text ?? "";
        return title;
      })
      .filter(Boolean);
  } catch (e) {
    console.warn(`⚠️  Notion query failed: ${e.message}`);
    return [];
  }
}

// ──────────────────────────────────────────
// Gemini: 朝刊生成
// ──────────────────────────────────────────
async function generateNewspaper(sources, recentTitles) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const today = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const duplicateGuard =
    recentTitles.length > 0
      ? `## ⛔ 重複禁止リスト（過去5日以内に既報のトピック）\n${recentTitles
          .map((t) => `- ${t}`)
          .join("\n")}\n上記と同一・類似のネタは絶対に朝刊の主題にしないこと。\n\n`
      : "";

  const prompt = `あなたは「AI新聞」の敏腕編集長です。
以下の海外AIコミュニティの生データ（Reddit・ブログ・GitHub）を分析し、
日本のスタートアップ創業者・エンジニア向けの朝刊を生成してください。

${duplicateGuard}## 入力データ

### Reddit (r/singularity, r/LocalLLaMA, r/AI_Agents)
${sources.reddit || "（データなし）"}

### 長文ブログ (Latent Space / Simon Willison / One Useful Thing)
${sources.blog || "（データなし）"}

### GitHub Trending (agent / mcp / automation / workflow)
${sources.github || "（データなし）"}

---

## 出力フォーマット（厳守・Markdownで出力）

# 【AI新聞】 ${today}号

### 📊 今朝のAI気象台
* 🔥 Reddit熱狂度：X/10
* ⚙ 実装成熟度：X/10
* 💰 日本市場収益化期待値：X/10

---

### ①【超速報】今朝世界で起きた最大のアップデート/バズ
（最も重要な1〜2トピックを400字程度で解説）

### ②【構造翻訳】なぜ今この潮流が世界で急加速しているのか？
（背景・構造的理由を300字程度で）

### ③【実装視点】具体的なコードイメージ・Next.js等への応用案
（具体的な実装アイデアを300字程度で。コードスニペット可）

### ④【現実の罠】海外コミュニティで指摘されているバグ・デメリット
（批判・懸念点を200字程度で。ポジショントーク厳禁）

### ⑤【情報裁定】なぜ日本ではまだ弱いのか？
（英語障壁/導入コスト/文化差/UI問題など 200字程度）

---

### 💡 今日の一言圧縮
「（ニュースを1枚の概念に凝縮した、読者の脳に残るワンフレーズ）」

---
<!-- SCORE_JSON
{
  "excitement": <海外熱狂度 1-5の整数>,
  "universality": <技術の普遍性 1-5の整数>,
  "japan_potential": <日本市場ポテンシャル 1-5の整数>,
  "headline": "<朝刊の主題を30字以内で>",
  "master_score": <(excitement + universality + japan_potential) / 1.5 を小数点1桁で>
}
-->

## 厳守事項
- 出力は上記フォーマットのみ。前置き・後書き不要。
- SCORE_JSON は HTML コメントとして末尾に必ず含める。
- 英語の固有名詞はカタカナ化せず英語のまま残す。
- 「〜です、〜ます」調ではなく、新聞社説調の簡潔な文体で。
- 情報源が薄い場合でも各セクションを必ず埋めること（推論・補完可）。
`;

  console.log("\n🤖 Gemini generating newspaper...");
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return text;
}

// ──────────────────────────────────────────
// スコア抽出
// ──────────────────────────────────────────
function extractScore(markdownText) {
  const match = markdownText.match(/<!--\s*SCORE_JSON\s*([\s\S]*?)-->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────
// Discord: Webhook 配信
// ──────────────────────────────────────────
async function sendToDiscord(markdown) {
  if (!DISCORD_WEBHOOK_URL) {
    console.warn("⚠️  DISCORD_WEBHOOK_URL not set, skipping");
    return;
  }

  // Discord は 2000字制限があるため分割送信
  const CHUNK = 1900;
  const clean = markdown.replace(/<!--[\s\S]*?-->/g, "").trim(); // JSONコメント除去
  const chunks = [];

  for (let i = 0; i < clean.length; i += CHUNK) {
    chunks.push(clean.slice(i, i + CHUNK));
  }

  console.log(`\n📨 Sending to Discord (${chunks.length} chunks)...`);

  for (let i = 0; i < chunks.length; i++) {
    const payload = {
      content: chunks[i],
      username: "AI新聞",
      avatar_url: "https://em-content.zobj.net/source/twitter/376/newspaper_1f4f0.png",
    };

    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Discord webhook failed: ${res.status} ${err}`);
    }

    // レート制限対策: チャンク間に少し待機
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // リアクション案内メッセージ
  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content:
        "---\n👆 記事に ⭐ スタンプを押すと Notion DB へ自動格納されます\n（Discord Bot 連携後に有効）",
      username: "AI新聞",
    }),
  });

  console.log("✅ Discord delivery complete");
}

// ──────────────────────────────────────────
// Notion: 記事を格納
// ──────────────────────────────────────────
async function saveToNotion(notion, markdown, score) {
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    console.warn("⚠️  Notion env not set, skipping save");
    return;
  }

  const todayJST = new Date().toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
  });

  const headline = score?.headline ?? `AI新聞 ${todayJST}`;
  const masterScore = score?.master_score ?? null;

  // 本文は先頭 2000 字を Notion に保存（全文は長すぎる場合あり）
  const bodySnippet = markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim()
    .slice(0, 2000);

  console.log("\n📓 Saving to Notion...");

  try {
    await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        // Notion DB のプロパティ名はご自身の環境に合わせて変更してください
        Title: {
          title: [{ text: { content: headline } }],
        },
        Date: {
          date: {
            start: new Date().toISOString().split("T")[0],
          },
        },
        Importance_Score: {
          number: masterScore,
        },
        Status: {
          // ステータスプロパティ（"Status" 型）がある場合
          select: { name: "Draft" },
        },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: bodySnippet } }],
          },
        },
      ],
    });
    console.log("✅ Notion save complete");
  } catch (e) {
    console.error(`❌ Notion save failed: ${e.message}`);
  }
}

// ──────────────────────────────────────────
// メイン
// ──────────────────────────────────────────
async function main() {
  console.log("🗞️  AI新聞 バックエンド起動");
  console.log(`   DRY_RUN: ${DRY_RUN}`);
  console.log(`   Time: ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`);

  // 環境変数チェック
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY が未設定です");

  const notion = new NotionClient({ auth: NOTION_API_KEY });

  // Step 1: 過去タイトル取得
  console.log("\n📋 Step 1: Notion から過去5日のタイトルを取得...");
  const recentTitles = await getRecentTitles(notion);
  console.log(`   既報タイトル数: ${recentTitles.length}`);

  // Step 2: ソース取得
  console.log("\n📡 Step 2: ソース取得中...");
  const sources = await fetchAllSources();

  // Step 3: Gemini で朝刊生成
  const newspaper = await generateNewspaper(sources, recentTitles);
  const score = extractScore(newspaper);
  console.log("\n📊 Score:", score);

  if (DRY_RUN) {
    console.log("\n========== DRY RUN OUTPUT ==========");
    console.log(newspaper.replace(/<!--[\s\S]*?-->/g, "").trim());
    console.log("=====================================");
    return;
  }

  // Step 4: Discord 配信
  await sendToDiscord(newspaper);

  // Step 5: Notion 格納
  await saveToNotion(notion, newspaper, score);

  console.log("\n🎉 AI新聞 完了！");
}

main().catch((e) => {
  console.error("💥 Fatal error:", e);
  process.exit(1);
});
