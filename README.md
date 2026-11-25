# codex-daily-lab

AI 駆動開発を検証するための TypeScript / Node.js プロジェクトです。初期実装、テスト、CI の設定、ドキュメントは OpenAI Codex（AI）を使用して開発しました。タスク管理 API を題材に、変更の実装から自動検証、GitHub での PR レビューまでを試せます。

API は Node.js 標準の HTTP モジュールで動作します。有料 API、有料サービス、認証キー、データベースは不要です。タスクはメモリに保存され、サーバーを再起動すると消えます。

## ローカルで実行

Node.js 24.x と npm が必要です。nvm を使う場合は `nvm use` でリポジトリの指定バージョンに切り替えられます。

```sh
npm ci
npm run build
npm start
```

API は `http://127.0.0.1:3000` で待ち受けます。ポートを変更する場合は `PORT=4000 npm start` のように指定します。

| メソッド | パス | 応答 |
| --- | --- | --- |
| GET | `/health` | `200` と `{"status":"ok"}` |
| GET | `/tasks` | `200` とタスクの一覧（初期状態は `{"tasks":[]}`） |
| POST | `/tasks` | `201` と登録したタスクの `id`、`title` |
| GET | `/tasks/:id` | `200` と指定したタスク |
| PATCH | `/tasks/:id` | `200` とタイトルを更新したタスク |
| DELETE | `/tasks/:id` | `204`（本文なし） |

`POST /tasks` と `PATCH /tasks/:id` は `Content-Type: application/json` を指定し、`title` に前後の空白を除いて 1〜120 文字の文字列を渡します。本文の上限は 4 KiB です。登録時は `Location` ヘッダーで個別取得用のパスを返します。個別取得・更新・削除でタスクが存在しない場合は `404` です。サーバー稼働中、削除したタスクの ID は再利用しません。

```sh
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"CI の実行を確認する"}'
curl http://127.0.0.1:3000/tasks
curl http://127.0.0.1:3000/tasks/1
curl -X PATCH http://127.0.0.1:3000/tasks/1 \
  -H 'Content-Type: application/json' \
  -d '{"title":"CI の結果をレビューする"}'
curl -i -X DELETE http://127.0.0.1:3000/tasks/1
```

## タスクを一括登録

`POST /tasks/batch` に `Content-Type: application/json` を指定し、`{"tasks":[{"title":"…"}]}` を送ります。
1回に1〜50件、リクエスト本文は32 KiBまでです。すべてのタイトルを検証してから登録し、
成功時は `201` と、入力順にIDを割り当てた `{"tasks":[...]}` を返します。
タイトルに不備がある場合は `400` と該当項目の0始まりの `index` を返し、登録は行いません。

`Idempotency-Key` は一括登録専用の範囲で有効です。同じキーと同じ順序のタイトルで再試行すると、
最初の結果を返します。キーの保持は10分間、上限は1,000件です。

```sh
curl -X POST http://127.0.0.1:3000/tasks/batch \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: batch-1' \
  -d '{"tasks":[{"title":"差分を確認する"},{"title":"テスト結果を確認する"}]}'
```

## タスク登録の再試行

`POST /tasks` に任意の `Idempotency-Key` ヘッダーを送ると、同じキーとタイトルで再試行した場合に
最初の登録結果を再利用します。キーは1〜128文字の英数字・`.`・`_`・`:`・`-` を使用できます。
成功時は `201`、再試行時には `Idempotency-Replayed: true` を返します。
同じキーに異なるタイトルを指定すると `409` です。

キーは登録から10分間、サーバーのメモリに保持します。有効なキーが1,000件に達すると新しいキーには
`503` を返し、保持済みのキーによる再試行は可能です。

```sh
curl -X POST http://127.0.0.1:3000/tasks \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: task-registration-1' \
  -d '{"title":"重複登録を防ぐ"}'
```

## サーバーを停止

サーバープロセスは `SIGINT`（Ctrl+C）または `SIGTERM` を受けると新規接続を止め、
処理中のリクエストが終わるのを待ちます。待機時間は既定で10秒です。
`SHUTDOWN_TIMEOUT_MS` に1〜60,000ミリ秒を指定できます。
時間内に処理が終わらない場合は残りの接続を切断し、終了コード1を返します。
検証では `PORT=0` を指定すると空いているポートを自動選択し、起動ログで番号を確認できます。

## タスクをファイルに出力

`GET /tasks/export` は、リクエスト時点のタスクを ID 昇順で `tasks.ndjson` として出力します。
1 行につき 1 件の JSON で、各行の末尾は改行です。タスクがない場合は空ファイルを返します。
`HEAD /tasks/export` ではダウンロード用のヘッダーを確認できます。

```sh
curl -f -o tasks.ndjson http://127.0.0.1:3000/tasks/export
```

## リクエストをログから追跡

API が処理するリクエストにはサーバーが UUID を割り当て、応答の
`X-Request-ID` ヘッダーで返します。標準出力の JSON ログでは、同じ ID で
HTTP メソッド、ステータス、所要時間（ミリ秒）、完了または切断を確認できます。
応答ヘッダーの送信前に切断された場合、ログのステータスは `null` です。
ログにパス、クエリ、リクエストヘッダー、本文は含まれません。

## 変更を検証

```sh
npm run lint
npm test
```

`npm test` は TypeScript を型検査・ビルドした後、Node.js 標準のテストランナーで HTTP 統合テストを実行します。GitHub Actions はブランチへの push と `main` 宛てのプルリクエストで、`npm ci`、Lint、テストを実行します。変更は作業ブランチに push し、`main` 宛てのプルリクエストを作成してレビューします。

## Codex の毎日開発 PR

毎日午前3時（日本時間）の Codex 実行は、同じリポジトリの
`codex/auto/<変更名>` ブランチから `main` 宛ての PR を作成します。
自動マージを許可する場合だけ、PR 作成時に本文へ
`Codex-Auto-Merge: <40桁の実際のheadコミットSHA>` を独立した行で記載します。
Codex の接続はリポジトリ所有者名義で PR を作成するため、専用ブランチ名と
SHA の明示を組み合わせて、通常の手動 PR と区別します。手動 PR にはこの指定を使いません。
更新された PR を再度自動マージ対象にする場合は、新しい SHA を明示して CI を通します。

既存の `CI` を変更せず、PR の CI が完了してから `Codex auto-merge` を起動します。
当該 PR の現在のコミットと `main` の SHA、`verify` の Lint・テスト（型チェックを含む）、
マージ可否を確認して、標準の `GITHUB_TOKEN` で Squash Merge します。
結果は PR のタイムラインおよび Actions の実行サマリーで確認できます。
`.github/` 配下を変更する PR、下書き PR、フォークからの PR は手動レビューの対象です。
CI の失敗、競合、設定・権限による拒否がある場合、PR は自動マージされません。

ワークフローは `main` へ導入した後に発生する CI 完了イベントから動作します。
リポジトリでは Squash Merge を許可し、Actions がジョブに指定した `contents: write` を
使用できる必要があります。GitHub の「Allow auto-merge」は不要です。
`main` に保護ルールを設定する場合、GitHub Actions の `verify` を必須チェックに指定し、
マージ前のブランチ最新化を必須にすると、マージ時にも GitHub 側で競合や古いベースを検査できます。
必須承認やマージキューなどのルールは GitHub が適用します。
