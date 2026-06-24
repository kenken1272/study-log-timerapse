# Study Timelapse

Firebase Auth の Google ログインでユーザーごとに学習ログを管理する、個人用の勉強タイムラプス記録 Web アプリです。ブラウザの MediaRecorder で録画した chunk を private GCS bucket にアップロードし、終了後に Cloud Run 内の FFmpeg でタイムラプス MP4 とサムネイルを生成します。

## 主な機能

- Google ログイン / ログアウト
- 今日、今週、週間目標、達成率、総勉強時間、総休憩時間、総セッション数、平均品質を表示
- 学習ログ: ログイン中ユーザーの最近のセッションを 30 件ずつ読み込み
- 週間目標設定: `users/{uid}/profile.json` の `weeklyGoalHours` を更新
- 録画セッション: カメラ録画、30 秒 chunk upload、IndexedDB 一時保存、オンライン復帰再送、休憩開始/終了、停止、終了後入力、タイムラプス生成
- セッション再開: localStorage に active session を保存し、タブ再オープン時に再開 UI を表示
- セッション詳細: 勉強時間、休憩履歴、品質、メモ、private GCS 動画の signed read URL 再生、AI 分析結果
- AI 分析: タイムラプス完成後、手動ボタンで集中度、離席、スマホ操作、読み書き推定を分析
- オフライン入力: 動画なしの勉強時間をあとから追加

## 使用技術

- Next.js App Router / TypeScript / Tailwind CSS
- Firebase Auth / Firebase Admin SDK
- Firestore
- Google Cloud Storage
- Cloud Run
- Cloud Tasks
- FFmpeg
- Vertex AI
- Node.js 20 以上

## 環境変数

`.env.local` をプロジェクト直下に作成してください。`.env.local` は Git にコミットしません。`.env.example` にはキー名だけを置いています。

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
GCS_BUCKET_NAME=

GCP_PROJECT_ID=
GOOGLE_CLOUD_PROJECT=
VERTEX_LOCATION=
VERTEX_MODEL=
ANALYSIS_MAX_OUTPUT_TOKENS=
INTERNAL_PROCESS_SECRET=
CLOUD_RUN_SERVICE_URL=
CLOUD_TASKS_QUEUE=
CLOUD_TASKS_LOCATION=
```

`FIREBASE_PRIVATE_KEY` は `\n` を含む形式で保存できます。サーバー側では `replace(/\\n/g, "\n")` で改行を復元します。

## Firebase Console 設定

1. Firebase project を作成し、Web app を追加します。
2. Authentication の Sign-in method で Google を有効化します。
3. Authorized domains にローカル開発用ドメインと Cloud Run ドメインを追加します。
4. Project settings の Web app config を `NEXT_PUBLIC_FIREBASE_*` に設定します。
5. Firebase Admin 用の service account を用意し、`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` を設定します。

## GCS 構造

新規保存では `users/local` を使いません。既存の `users/local` データは削除しません。

```text
gs://vla-test1-study-timelapse/
└── users/
    └── {uid}/
        ├── profile.json
        └── sessions/
            └── {sessionId}/
                ├── segments/{segmentIndex}/chunks/{chunkIndex}.webm
                ├── thumbnail.jpg
                ├── timelapse.mp4
                └── metadata.json
```

`profile.json`:

```json
{
  "uid": "...",
  "name": "...",
  "email": "...",
  "photoURL": "...",
  "weeklyGoalHours": 10,
  "createdAt": "ISO string",
  "updatedAt": "ISO string"
}
```

`metadata.json`:

```json
{
  "sessionId": "...",
  "title": "...",
  "note": "...",
  "targetMinutes": 30,
  "durationMinutes": 30,
  "thumbnailPath": "users/{uid}/sessions/{sessionId}/thumbnail.jpg",
  "timelapsePath": "users/{uid}/sessions/{sessionId}/timelapse.mp4",
  "createdAt": "ISO string",
  "updatedAt": "ISO string"
}
```

## 認証と API

クライアントは Firebase Web SDK で Google ログインし、API 通信時に `Authorization: Bearer {idToken}` を付けます。サーバー側は Firebase Admin SDK で ID token を検証し、`decodedToken.uid` だけを正式な uid として使います。クライアントから送られた uid は保存先や読み取り先の決定に使いません。

ユーザーデータを扱う API は token がない、または不正な場合に 401 を返します。署名付き URL 発行もログイン中ユーザー本人の session だけを対象にします。

## ローカル起動

```bash
npm install
cp .env.example .env.local
npm run dev
```

検証:

```bash
npm run lint
npm run build
```

## Cloud Run デプロイ

Cloud Run は `.env.local` を自動では読みません。`deploy_cloudrun.sh` は Next の env loader で `.env.local` を読み、runtime env と build env を一時ファイル経由で `gcloud run deploy` に渡します。一時ファイルと `.env.local` はソースに含めません。タイムラプス生成は Cloud Tasks queue に登録され、ブラウザを閉じてもサーバー側で処理が続きます。

```bash
./deploy_cloudrun.sh
```

直接実行する場合の基本形:

```bash
gcloud run deploy study-timelapse \
  --source . \
  --region asia-northeast1 \
  --project vla-test1 \
  --allow-unauthenticated
```

デプロイ先:

```text
https://study-timelapse-116342725707.asia-northeast1.run.app
```

## 動作確認

- Google ログインできる
- ログアウトできる
- 未ログイン時はセッション作成、保存、学習ログ表示が使えない
- セッション保存後、GCS に `users/{uid}/sessions/{sessionId}/thumbnail.jpg` が作られる
- セッション保存後、GCS に `users/{uid}/sessions/{sessionId}/timelapse.mp4` が作られる
- セッション保存後、GCS に `users/{uid}/sessions/{sessionId}/metadata.json` が作られる
- `users/{uid}/profile.json` に `uid`, `name`, `email`, `weeklyGoalHours` が入る
- 学習ログは本人の uid 配下だけを読む
- 学習ログは初期表示最大 30 件で、「さらに読み込む」で追加 30 件ずつ表示される
- `/sessions/new` の目標勉強時間を半角数字で直接入力できる
- 「30分」「1時間」「2時間」「3時間」ボタンで入力欄も更新される
- 不正な目標勉強時間では開始できず、エラーが表示される
- AI 分析は「AI分析を実行」ボタンを押した時だけ実行される
- `/earnings` は通常の 404 になる

## 既知の制限

- PC Chrome / Edge 想定
- iPhone Safari は MVP 対象外
- 長時間動画は Cloud Run service 内処理では重くなる可能性があります
