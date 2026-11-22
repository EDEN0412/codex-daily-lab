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

`POST /tasks` は `Content-Type: application/json` を指定し、`title` に前後の空白を除いて 1〜120 文字の文字列を渡します。本文の上限は 4 KiB です。

```sh
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"CI の実行を確認する"}'
curl http://127.0.0.1:3000/tasks
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
