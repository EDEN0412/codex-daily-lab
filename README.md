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

## 変更を検証

```sh
npm run lint
npm test
```

`npm test` は TypeScript を型検査・ビルドした後、Node.js 標準のテストランナーで HTTP 統合テストを実行します。GitHub Actions はブランチへの push と `main` 宛てのプルリクエストで、`npm ci`、Lint、テストを実行します。変更は作業ブランチに push し、`main` 宛てのプルリクエストを作成してレビューします。
