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
| `SIGNUP_CODE` | 任意。2人目以降がアカウントを作るときの招待コード。未設定なら最初の1人しか作れない |
| `MCP_SECRET` | 任意。アカウント機能より前に登録したコネクタURLを、最初のアカウントにつなぐための古い設定 |
| `AI_PROVIDER` | 任意。未設定（`none`）ならAIの利用料ゼロ。サーバー側でも自動分類したいときだけ `gemini` / `openai` / `deepseek` / `anthropic` |
| 選んだAIのキー | `AI_PROVIDER` を設定した場合のみ。`GEMINI_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` のどれか1つ |
| `AI_MODEL` | 任意。空なら各社の安いモデル（gemini-2.5-flash / gpt-4.1-mini / deepseek-chat / claude-haiku-4-5） |
| `GEMINI_API_KEY` | 任意。「記憶する」で録音・ボイスメモを文字起こし＋要約する場合に必要（`AUDIO_MODEL` で既定の gemini-2.5-flash を変更可） |
| `OPENAI_API_KEY` | 任意。Geminiを使わず文字起こしだけしたい場合 |

ランダム文字列は `openssl rand -hex 24` などで作ってください。

5. Settings → Networking で Generate Domain を押し、URLを発行する
6. `https://<発行されたURL>/` を開き、アカウントを作ってログインできれば完了

テーブルは起動時に自動で作られます。

## アカウント

Web画面でアカウント（メールアドレスとパスワード）を作ってログインします。

- 最初のアカウントは誰でも作れます。これまでに残した記憶は、最初のアカウントに引き継がれます
- 2人目以降は、`SIGNUP_CODE` を設定したうえで、その招待コードを入力した人だけが作れます
- 記憶はアカウントごとに分かれ、ほかの人からは見えません
- コネクタURLとiPhoneショートカット用の連携キーは、画面右下の名前のマグネット（アカウント）から確認・作り直しができます

## 写真

「記憶」の画面から、ホワイトボードや手書きメモの写真を残せます。写真は長辺1600pxのJPEGに縮めて保存し、Claudeが整理するときに画像を見て、要約と5つの層への分類を行います。

## kinbot・kincallからの取り込み

Claude Codeのルーティンで、kinbot・kincall・knowkinの3つのコネクタを使い、毎日の商談や架電の結果をknowkinに取り込みます。`add_memo` に `ref`（例 `kinbot:event:<id>`）を付けると、同じものは二重に保存されません。

## Gmail・Googleチャット

アカウント画面の「Googleと連携する」から、読み取り専用の権限で連携します。1時間ごと（毎時30分）に新しいメールと、参加しているGoogleチャットのやり取りを未整理メモとして取り込み、整理のときにClaudeが相手との関係性・依頼・決定事項を読み取ります。

必要な設定（Google Cloud）：
- OAuth同意画面を「内部（Internal）」で作る
- Gmail API・Google Chat API・People API を有効にする（Chat APIは「構成」ページでアプリ名などの設定も必要）
- 認証情報で「OAuthクライアントID（ウェブアプリケーション）」を作り、リダイレクトURIに `https://<発行されたURL>/api/google/callback` を登録
- Railwayに `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`（任意で `TOKEN_ENC_KEY`）を設定

## 目的と現在地

仕事・プライベートで成し遂げたいことを「目的」として持ちます。Claudeが整理のときに、話したことや記録から目的の候補を出し（`propose_goal`）、本人が「見直し」または「目的」の画面で承認すると目的になります。

- 目的には、叶えたい未来・なぜ・達成の基準・期限・道のり（中間地点）を持つ
- タスクや判断などの記憶は、近づける目的につながる（`goal_id`）
- 進み具合は、済んだ道のりの数と、つながったタスクの完了率から計算。14日動きがないと「止まっている」印が付く
- Claudeが現在地の一言を書く（`update_goal_position`）。毎日23:50に進み具合の足あとを記録
- ネットワーク画面では、進行中の目的の最大3つが脳の上に星として光る（ピン留め → 期限の近い順）

## AIなしモード（既定・無料）

`AI_PROVIDER` を設定しなければ、サーバーはAIのAPIを一切使いません。分類と核づくりは、Claude.aiとの会話の中でClaudeが行います（Claude.aiのプランの範囲内なので追加料金なし）。

- 「記憶」の録音は、ブラウザの音声認識で話しながら文字にします（iPhoneのボイスメモの文字起こしを貼り付けることもできます）
- Web画面やボイスメモで記録すると、原本だけが「未整理」として保存されます
- Claudeとの会話で「knowkinの未整理メモを整理して」と頼むと、Claudeが分類して保存します（録音はタイトルと要約も作ります）
- 「knowkinの核を育てて」と頼むと、Claudeが記憶を読み直して核を更新します
- 会話中に「これ覚えておいて」と頼んだ内容は、Claudeがその場で分類して保存します

## Claude.aiにコネクタとして登録

Claude.aiのコネクタ設定から、カスタムコネクタを追加します。

- URL：`https://<発行されたURL>/mcp`
- 追加したあと「Connect」を押すとknowkinのログイン画面が開くので、ログインして「許可する」を押す（OAuthの設定は空のままでよい）
- ログインなしでつなぎたい場合は、アカウント画面にある連携キー入りのURL（`/mcp/<連携キー>`）も使えます

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
   - ヘッダ：`Authorization` に `Bearer <連携キー>`（アカウント画面でコピーできます）
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

ログイン中のクッキー、または `Authorization: Bearer <連携キー>` が必要です。

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
