# knowkin 🧠

自分専用の脳AI。対面での会話、上司からのフィードバック、学んだこと、判断とその理由、タスクなどを記録し、
Claudeが5つの層（出来事・知識・思考・行動・関係）に分類して蓄積します。
Claude.aiにコネクタとして登録すると、会話中にClaudeが自動で記憶を取りにいきます。

## 構成

```
記録（Web画面 / iPhoneショートカット / Claudeとの会話）
  → 取り込みAPI（Express）
  → 文字起こし（音声のみ・OpenAI）
  → Claudeで記憶ユニットに分類
  → PostgreSQL
  → 夜間バッチ（毎日3時に「核」を育て直す）
  → MCPサーバー → Claude.ai
```

```
src/
  server.js      Express・REST API・MCPエンドポイント・夜間バッチ
  brain.js       分類・検索・核の生成など本体ロジック
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
| `ANTHROPIC_API_KEY` | Claude APIのキー |
| `APP_TOKEN` | Web画面とAPIのログイン用。長いランダム文字列 |
| `MCP_SECRET` | コネクタURLに入れる秘密の文字列。長いランダム文字列 |
| `CLAUDE_MODEL` | 任意。既定は `claude-sonnet-5` |
| `OPENAI_API_KEY` | 任意。ボイスメモを文字起こしする場合のみ |

ランダム文字列は `openssl rand -hex 24` などで作ってください。

5. Settings → Networking で Generate Domain を押し、URLを発行する
6. `https://<発行されたURL>/` を開き、`APP_TOKEN` でログインできれば完了

テーブルは起動時に自動で作られます。

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
| `add_memo` | 「これ覚えておいて」と頼んだ内容を記憶に残す |
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
- 記録の分類と核の生成にはClaude APIを、文字起こしにはOpenAI APIを使うので、それぞれ利用料がかかります。
- 常駐先の情報を記録する場合は、客先の情報管理のルールで問題がないか確認してから使ってください。
