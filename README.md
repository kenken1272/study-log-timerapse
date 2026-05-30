# Study Timelapse

個人用の勉強タイムラプス記録Webアプリです。ログイン機能はありません。勉強開始時に目標時間を入力し、ブラウザのMediaRecorderで録画し、chunkを署名付きURLでprivate GCS bucketへ直接PUTします。終了後に実勉強時間からタイムラプス速度を自動決定し、Cloud Run内のFFmpegでタイムラプスMP4を生成します。

タイムラプス作成後は元動画chunkをGCSから削除し、Firestoreにはchunkメタデータだけ残します。ネット切断時はchunkをIndexedDBへ一時保存し、オンライン復帰後に再送します。タブを閉じた場合、録画自体は止まりますが、セッション情報は残り、次回起動時に新しいrecording segmentとして再開できます。Gemini分析は自動実行されず、ユーザーが「分析実行」ボタンを押したときだけVertex AI Gemini 2.5 Proへ動画を送ります。

## 機能一覧

- ダッシュボード: 今日、今週、週間目標、達成率、総勉強時間、総休憩時間、総セッション数、平均品質、最近のセッションを表示
- 週間目標設定: `settings/weeklyGoal` に目標分数を保存
- 録画セッション: カメラ録画、30秒chunk upload、IndexedDB一時保存、オンライン復帰再送、休憩開始/終了、停止、終了後入力、実勉強時間に応じたタイムラプス生成
- セッション再開: localStorageにactive sessionを保存し、タブ再オープン時に「前回のセッションを再開しますか？」を表示
- セッション詳細: 勉強時間、休憩履歴、品質、メモ、private GCS動画の短時間signed read URL再生、Gemini分析結果、ローカル分析結果
- Gemini分析: タイムラプス完成後、手動ボタンで集中度、離席、スマホ操作、読み書き推定を分析
- ローカル分析: Qwen2.5-VLを使った外部GPU Worker分析（手動ボタン）
- オフライン入力: 動画なしの勉強時間をあとから追加

## 使用技術

- Next.js App Router / TypeScript / Tailwind CSS
- Firestore
- Google Cloud Storage
- Cloud Run
- FFmpeg
- Vertex AI Gemini 2.5 Pro
- Node.js 20以上

## GCPプロジェクト情報

- Project ID: `vla-test1`
- Project number: `116342725707`
- Region: `asia-northeast1`
- Cloud Run service: `study-timelapse`
- GCS bucket: `vla-test1-study-timelapse`
- Service Account: `study-timelapse-sa@vla-test1.iam.gserviceaccount.com`

## 必要API

`run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`, `storage.googleapis.com`, `firestore.googleapis.com`, `iamcredentials.googleapis.com`, `billingbudgets.googleapis.com`, `cloudbilling.googleapis.com`, `aiplatform.googleapis.com`, `secretmanager.googleapis.com`

## Firestore設計

`sessions/{sessionId}` は録画/オフライン共通のセッションを保存します。主なフィールドは `type`, `targetStudyMinutes`, `actualStudySec`, `totalBreakSec`, `achievementRate`, `speed`, `status`, `uploadStatus`, `cleanupStatus`, `chunks`, `recordingSegments`, `breakLogs`, `studyContent`, `quality`, `reflectionNote`, `timelapsePath`, `timelapseSizeBytes`, `analysisStatus`, `analysisResult` です。

`status`: `recording`, `paused`, `interrupted`, `uploaded`, `processing`, `ready`, `failed`

`uploadStatus`: `idle`, `uploading`, `offline_pending`, `uploaded`, `failed`

`cleanupStatus`: `not_started`, `deleting`, `done`, `failed`

`analysisStatus`: `none`, `pending`, `processing`, `done`, `failed`

新しいchunkメタデータ:

```json
{
  "segmentIndex": 0,
  "index": 0,
  "objectPath": "users/local/sessions/{sessionId}/segments/0/chunks/0.webm",
  "sizeBytes": 123456,
  "uploadedAt": "Timestamp",
  "deletedAt": null
}
```

既存データに新フィールドがない場合、API側でデフォルト値を補完します。古いchunkに `segmentIndex` がない場合は `0` として扱います。

`settings/weeklyGoal`:

```json
{
  "targetWeeklyStudyMinutes": 600,
  "updatedAt": "Timestamp"
}
```

タイムラプス速度は終了時の実勉強時間で自動決定します。

- 45分未満: `30x`
- 45分以上2時間未満: `60x`
- 2時間以上: `120x`

## GCS設計

- chunks: `users/local/sessions/{sessionId}/segments/{segmentIndex}/chunks/{chunkIndex}.webm`
- legacy chunks: `users/local/sessions/{sessionId}/chunks/{index}.webm` もタイムラプス生成時に読み取れます
- timelapse: `users/local/sessions/{sessionId}/timelapse.mp4`
- thumbnail: `users/local/sessions/{sessionId}/thumbnail.jpg`
- bucketはprivate、Uniform bucket-level accessを有効化
- MVPのCORSは `origin: ["*"]`。本番ではCloud Run URLだけに絞ってください。
- タイムラプスMP4のGCSアップロード成功後、元動画chunkはGCSから削除されます
- Firestoreにはchunkメタデータ、削除件数、削減容量、削除エラーだけを残します

## 再開とオフライン保存

- localStorageにactive session ID、segmentIndex、chunkIndex、目標時間、休憩状態を保存します
- IndexedDBに未アップロードchunk Blobを保存します
- chunkはGCSへPUTする前に必ずIndexedDBへ保存します
- オフライン時は `uploadStatus=offline_pending` として、オンライン復帰イベントで順番に再送します
- タブを閉じた場合、録画自体は止まります。閉じる直前の最後のBlobは失われる可能性があります
- chunk間隔は30秒なので、最悪でも失われる動画を30秒程度に抑える設計です
- 再開後は新しい `recordingSegments[]` として記録され、閉じていた間の映像は存在しません

## Gemini分析

- 分析は自動実行しません
- `status=ready` かつ `timelapsePath` がある場合だけ、画面に「Geminiで集中度分析」ボタンを表示します
- ボタン押下時のみ `/api/sessions/{id}/analyze` がVertex AI Gemini 2.5 Proを呼びます
- 分析結果は `analysisResult` に保存されます
- Gemini 2.5 Pro分析は費用が発生します。長時間動画や高頻度利用では費用が増えます
- サービスアカウントJSONキーは使いません。Cloud RunのApplication Default Credentialsを使います

## ローカル分析 (Qwen2.5-VL)

- Geminiとは別の外部GPU Workerを呼び出します
- Cloud RunからGCSのsigned read URLを渡し、動画ファイルは再アップロードしません
- ローカル分析ボタンを押した時だけ実行されます
- 結果は `localAnalysisResult` に保存されます
- Secret ManagerでGPU Worker tokenを管理します

## ローカル起動

```bash
npm install
cp .env.example .env.local
npm run dev
```

検証:

```bash
npm run lint
npm run typecheck
npm run build
```

## Cloud Runデプロイ手順

```bash
export PROJECT_ID="vla-test1"
export PROJECT_NUMBER="116342725707"
export REGION="asia-northeast1"
export SERVICE_NAME="study-timelapse"
export BUCKET_NAME="vla-test1-study-timelapse"
export SA_NAME="study-timelapse-sa"
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export BUDGET_AMOUNT="1000"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com firestore.googleapis.com iamcredentials.googleapis.com billingbudgets.googleapis.com cloudbilling.googleapis.com
gcloud services enable aiplatform.googleapis.com --project="$PROJECT_ID"
gcloud firestore databases list
gcloud firestore databases create --database="(default)" --location="asia-northeast1" --edition="standard" --type="firestore-native"
gcloud storage buckets create "gs://${BUCKET_NAME}" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets update "gs://${BUCKET_NAME}" --cors-file=cors.json
gcloud iam service-accounts create "$SA_NAME" --display-name="Study Timelapse Cloud Run Service Account"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/iam.serviceAccountTokenCreator"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/aiplatform.user"

gcloud run deploy "$SERVICE_NAME" --source . --region "$REGION" --service-account="$SA_EMAIL" --allow-unauthenticated --memory=2Gi --cpu=2 --timeout=3600 --min-instances=0 --max-instances=3 --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GCS_BUCKET_NAME=$BUCKET_NAME,NEXT_PUBLIC_APP_NAME=Study Timelapse,VERTEX_LOCATION=us-central1,VERTEX_MODEL=gemini-2.5-pro,ANALYSIS_MAX_OUTPUT_TOKENS=2048"
```

既存Cloud Run serviceの環境変数だけ更新する例:

```bash
gcloud run services update study-timelapse --region=asia-northeast1 --project=vla-test1 --set-env-vars="VERTEX_LOCATION=us-central1,VERTEX_MODEL=gemini-2.5-pro,ANALYSIS_MAX_OUTPUT_TOKENS=2048"
```

## Secret Manager / GPU Worker設定

```bash
gcloud services enable secretmanager.googleapis.com --project=vla-test1

printf "GPU_WORKER_TOKEN_VALUE" | \
gcloud secrets create gpu-worker-token \
  --data-file=- \
  --project=vla-test1

printf "GPU_WORKER_TOKEN_VALUE" | \
gcloud secrets versions add gpu-worker-token \
  --data-file=- \
  --project=vla-test1

gcloud run services update study-timelapse \
  --region asia-northeast1 \
  --project vla-test1 \
  --update-env-vars GPU_WORKER_URL="https://slabpcx.tailabcf98.ts.net",LOCAL_ANALYSIS_FPS="2",LOCAL_ANALYSIS_MAX_PIXELS="151200" \
  --update-secrets GPU_WORKER_TOKEN=gpu-worker-token:latest
```

ローカル分析の動画分割設定だけ更新する例:

```bash
gcloud run services update study-timelapse \
  --region asia-northeast1 \
  --project vla-test1 \
  --update-env-vars LOCAL_ANALYSIS_SEGMENT_SECONDS="1",LOCAL_ANALYSIS_MAX_SEGMENTS="60",LOCAL_ANALYSIS_FPS="30",LOCAL_ANALYSIS_MAX_PIXELS="151200"
```

## バジェット作成

Google Cloud Budgetは通知用で、支出を自動停止するものではありません。`BUDGET_AMOUNT` は請求先アカウントの通貨で解釈されます。

```bash
export BILLING_ACCOUNT_ID="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
gcloud billing budgets list --billing-account="$BILLING_ACCOUNT_ID"
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT_ID" --display-name="vla-test1 monthly budget" --budget-amount="$BUDGET_AMOUNT" --filter-projects="projects/$PROJECT_ID" --threshold-rule=percent=0.50 --threshold-rule=percent=0.80 --threshold-rule=percent=1.00 --threshold-rule=percent=1.00,basis=forecasted-spend --calendar-period=month
```

## 動作確認

- ダッシュボードが表示される
- 週間目標を保存できる
- オフライン勉強時間を保存できる
- 勉強セッションを開始し、カメラ録画できる
- 休憩開始/終了、停止、終了後入力ができる
- GCSにchunkが保存される
- FFmpegでタイムラプスが生成される
- タイムラプス作成後、GCS上の元動画chunkが削除され、`cleanupStatus=done` になる
- 詳細ページで動画再生できる
- 分析は自動実行されず、分析実行ボタンを押したときだけ `analysisStatus=processing` になる
- 成功後 `analysisStatus=done` になり、集中度スコアが表示される
- 録画中にネットを切ると、chunkがIndexedDBに残り、オンライン復帰後に再送される
- 録画中にタブを閉じて再度開くと、前回セッション再開UIが表示される
- ダッシュボード統計に反映される

## 既知の制限

- PC Chrome / Edge想定
- iPhone SafariはMVP対象外
- 長時間動画はCloud Run service内処理では重くなる可能性があります
- 本格運用ではタイムラプス処理をCloud Run Jobsへ分離推奨
- ログインなし、`--allow-unauthenticated` なのでCloud Run URLの共有に注意
- Cloud RunのURLはログインなしで公開されているため、個人用でもURL管理に注意してください
- Budgetは通知用であり、支出を自動停止しません
# study-log-timerapse
