# knowkin 🧠

自分専用の脳AI。対面での会話、上司からのフィードバック、学んだこと、判断とその理由、タスクなどを記録し、
Claudeが5つの層（出来事・知識・思考・行動・関係）に分類して蓄積します。
Claude.aiにコネクタとして登録すると、会話中にClaudeが自動で記憶を取りにいきます。

## 構成

```
記録（Web画面 / iPhoneショートカット / Claudeとの会話）
  → 取り込みAPI（Express）
  → 文字起こし（音声のみ・OpenAI）
  → 記憶ユニットに分類（既定：Claude.aiとの会話の中で / 任意：サーバー側のAI）
  → PostgreSQL
  → 夜間バッチ（サーバー側のAIを使う場合のみ、毎日3時に「核」を育て直す）
  → MCPサーバー → Claude.ai
```

```
src/
  server.js      Express・REST API・MCPエンドポイント・夜間バッチ
  brain.js       分類・検索・核の生成など本体ロジック
  ai.js          分類に使うAIの切り替え
  mcp.js         Claudeに公開するツール
  db.js          DB接続とテーブル作成
  schema.sql     テーブル定義（起動時に自動で作成）
  transcribe.js  音声の文字起こし
public/index.html  Web画面
```

## Railwayへのデプロイ

1. このフォルダをGitHubのリポジトリにpushする
2. Railwayで New Project → Deploy from GitHub repo でリポジトリを選ぶ
3. 同じプロジェクトに PostgreSQL を追加する
4. knowkinサービスの Variables に次を設定する

| 変数 | 内容 |
|---|---|
| `DATABASE_URL` | PostgreSQLの `DATABASE_URL` を参照（`${{Postgres.DATABASE_URL}}`） |
| `APP_TOKEN` | Web画面とAPIのログイン用。長いランダム文字列 |
| `MCP_SECRET` | コネクタURLに入れる秘密の文字列。長いランダム文字列 |
| `AI_PROVIDER` | 任意。未設定（`none`）ならAIの利用料ゼロ。サーバー側でも自動分類したいときだけ `gemini` / `openai` / `deepseek` / `anthropic` |
| 選んだAIのキー | `AI_PROVIDER` を設定した場合のみ。`GEMINI_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` のどれか1つ |
| `AI_MODEL` | 任意。空なら各社の安いモデル（gemini-2.5-flash / gpt-4.1-mini / deepseek-chat / claude-haiku-4-5） |
| `OPENAI_API_KEY` | 任意。ボイスメモを文字起こしする場合のみ |

ランダム文字列は `openssl rand -hex 24` などで作ってください。

5. Settings → Networking で Generate Domain を押し、URLを発行する
6. `https://<発行されたURL>/` を開き、`APP_TOKEN` でログインできれば完了

テーブルは起動時に自動で作られます。

## AIなしモード（既定・無料）

`AI_PROVIDER` を設定しなければ、サーバーはAIのAPIを一切使いません。分類と核づくりは、Claude.aiとの会話の中でClaudeが行います（Claude.aiのプランの範囲内なので追加料金なし）。

- Web画面やボイスメモで記録すると、原本だけが「未整理」として保存されます
- Claudeとの会話で「knowkinの未整理メモを整理して」と頼むと、Claudeが分類して保存します
- 「knowkinの核を育てて」と頼むと、Claudeが記憶を読み直して核を更新します
- 会話中に「これ覚えておいて」と頼んだ内容は、Claudeがその場で分類して保存します

## Claude.aiにコネクタとして登録

Claude.aiのコネクタ設定から、カスタムコネクタを追加します。

- 名前：knowkin
- URL：`https://<発行されたURL>/mcp/<MCP_SECRET>`

登録後、会話で仕事の相談や文章のレビューを頼むと、Claudeが次のツールを使って記憶を取りにいきます。

| ツール | 役割 |
|---|---|
| `get_core` | 本人の考え方の核（価値観・判断のしかた・教訓・よく関わる人）と未完了タスク |
| `get_current_tasks` | 未完了のタスクと目標を期限順に |
| `search_memory` | キーワード・種類・人物で過去の記憶を検索 |
| `get_person` | 上司などの判断基準と関連する記憶 |
| `add_memo` | 「これ覚えておいて」と頼んだ内容を、Claudeが分類して記憶に残す |
| `get_unclassified_memos` | 未整理のメモと、重複判定用の既存の記憶 |
| `save_units` | Claudeが分類した結果を保存 |
| `get_core_material` | 核を育てるための材料 |
| `save_core` | Claudeがまとめた核を保存 |
| `update_task` | タスクの完了・期限変更 |

会話の最初に「knowkinを見てから答えて」と一言添えると、より確実に呼ばれます。

## iPhoneショートカットでボイスメモ（任意・`OPENAI_API_KEY` が必要）

ショートカットアプリで新規作成し、次の順にアクションを並べます。

1. 「オーディオを録音」
2. 「URLの内容を取得」
   - URL：`https://<発行されたURL>/api/voice`
   - 方法：POST
   - ヘッダ：`Authorization` に `Bearer <APP_TOKEN>`
   - 本文を要求：フォーム → キー `file`、種類「ファイル」、値に録音したオーディオ
3. 「通知を表示」（結果の確認用、任意）

ホーム画面やアクションボタンに置くと、会話の直後にワンタップで残せます。

## 自動デプロイ

```
GITHUB_TOKEN=xxxx python3 dev/deploy.py "変更内容"
```

1. `dev/smoke.mjs` で構文・画面のスクリプト・タグの対応・MCPツールの登録をチェック（失敗したらpushしない）
2. `src/build.js` の BUILD_TAG を日時に更新
3. GitHub の main に1コミットでpush
4. Railway が自動でデプロイ。`/health` の `build` が新しい値になれば反映完了

`GITHUB_TOKEN` は、knowkinリポジトリだけに Contents の読み書き権限を付けた Fine-grained token を使ってください。pushせずに対象を確認するときは `--dry-run` を付けます。

## REST API（Web画面が使うもの）

すべて `Authorization: Bearer <APP_TOKEN>` が必要です。

- `GET  /api/state` 記憶・未分類メモ・核
- `POST /api/memos` `{ "text": "..." }` 記録して分類
- `POST /api/memos/:id/classify` 分類し直す
- `PATCH /api/units/:id` `{ done, reviewed, type, content, due }`
- `DELETE /api/units/:id`
- `POST /api/core/grow` 核を育てる
- `GET  /api/handoff` Claudeに貼る用のテキスト
- `POST /api/voice` 音声ファイル（`file`）を文字起こしして記録

## 注意

- `MCP_SECRET` を含むURLは、それ自体がパスワードです。他の人に共有しないでください。漏れたら `MCP_SECRET` を変えて、コネクタを登録し直してください。
- 記録の分類と核の生成には `AI_PROVIDER` で選んだAIのAPIを、文字起こしにはOpenAI APIを使うので、それぞれ利用料がかかります。モデル名は各社で変わることがあるので、動かないときは `AI_MODEL` で最新の名前を指定してください。
- 常駐先の情報を記録する場合は、客先の情報管理のルールで問題がないか確認してから使ってください。
