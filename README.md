# codex-daily-lab

AI 駆動開発を検証するための TypeScript / Node.js プロジェクトです。初期実装、テスト、CI の設定、ドキュメントは OpenAI Codex（AI）を使用して開発しました。タスク管理 API を題材に、変更の実装から自動検証、GitHub での PR レビューまでを試せます。

API は Node.js 標準の HTTP モジュールで動作します。有料 API、有料サービス、認証キー、データベースは不要です。タスクはメモリに保存され、サーバーを再起動すると消えます。

## タスクの検索とページ分割

`GET /tasks/search` でタイトルを部分一致検索し、ID 昇順で結果を取得できます。
`q` は任意で、前後の空白を除いた 1〜120 文字を指定します。英字の大文字・小文字や
Unicode の合成表記の違いを吸収します。`limit` は 1〜100 件（初期値 20）、
`after` は取得済みの最後の ID（初期値 0）です。不正な値や重複指定には `400` を返します。

応答の `nextAfter` が数値の場合は、その値を次のリクエストの `after` に指定します。
次のページがなければ `nextAfter` は `null` です。

```sh
curl 'http://127.0.0.1:3000/tasks/search?q=ci&limit=10'
```

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

## 変更を検証

```sh
npm run lint
npm test
```

`npm test` は TypeScript を型検査・ビルドした後、Node.js 標準のテストランナーで HTTP 統合テストを実行します。GitHub Actions はブランチへの push と `main` 宛てのプルリクエストで、`npm ci`、Lint、テストを実行します。変更は作業ブランチに push し、`main` 宛てのプルリクエストを作成してレビューします。
