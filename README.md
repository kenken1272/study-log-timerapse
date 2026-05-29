# Study Timelapse

個人用の勉強タイムラプス記録Webアプリです。ログイン機能はありません。勉強開始時に目標時間を入力し、ブラウザのMediaRecorderで録画し、chunkを署名付きURLでprivate GCS bucketへ直接PUTします。終了後に実勉強時間からタイムラプス速度を自動決定し、Cloud Run内のFFmpegでタイムラプスMP4を生成します。

## 機能一覧

- ダッシュボード: 今日、今週、週間目標、達成率、総勉強時間、総休憩時間、総セッション数、平均品質、最近のセッションを表示
- 週間目標設定: `settings/weeklyGoal` に目標分数を保存
- 録画セッション: カメラ録画、1分chunk upload、休憩開始/終了、停止、終了後入力、実勉強時間に応じたタイムラプス生成
- セッション詳細: 勉強時間、休憩履歴、品質、メモ、private GCS動画の短時間signed read URL再生
- オフライン入力: 動画なしの勉強時間をあとから追加

## 使用技術

- Next.js App Router / TypeScript / Tailwind CSS
- Firestore
- Google Cloud Storage
- Cloud Run
- FFmpeg
- Node.js 20以上

## GCPプロジェクト情報

- Project ID: `vla-test1`
- Project number: `116342725707`
- Region: `asia-northeast1`
- Cloud Run service: `study-timelapse`
- GCS bucket: `vla-test1-study-timelapse`
- Service Account: `study-timelapse-sa@vla-test1.iam.gserviceaccount.com`

## 必要API

`run.googleapis.com`, `cloudbuild.googleapis.com`, `artifactregistry.googleapis.com`, `storage.googleapis.com`, `firestore.googleapis.com`, `iamcredentials.googleapis.com`, `billingbudgets.googleapis.com`, `cloudbilling.googleapis.com`

## Firestore設計

`sessions/{sessionId}` は録画/オフライン共通のセッションを保存します。主なフィールドは `type`, `targetStudyMinutes`, `actualStudySec`, `totalBreakSec`, `achievementRate`, `speed`, `status`, `chunks`, `breakLogs`, `studyContent`, `quality`, `reflectionNote`, `timelapsePath` です。

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

- chunks: `users/local/sessions/{sessionId}/chunks/{index}.webm`
- timelapse: `users/local/sessions/{sessionId}/timelapse.mp4`
- bucketはprivate、Uniform bucket-level accessを有効化
- MVPのCORSは `origin: ["*"]`。本番ではCloud Run URLだけに絞ってください。

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
gcloud firestore databases list
gcloud firestore databases create --database="(default)" --location="asia-northeast1" --edition="standard" --type="firestore-native"
gcloud storage buckets create "gs://${BUCKET_NAME}" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets update "gs://${BUCKET_NAME}" --cors-file=cors.json
gcloud iam service-accounts create "$SA_NAME" --display-name="Study Timelapse Cloud Run Service Account"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/datastore.user"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="roles/iam.serviceAccountTokenCreator"

gcloud run deploy "$SERVICE_NAME" --source . --region "$REGION" --service-account="$SA_EMAIL" --allow-unauthenticated --memory=2Gi --cpu=2 --timeout=3600 --min-instances=0 --max-instances=3 --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GCS_BUCKET_NAME=$BUCKET_NAME,NEXT_PUBLIC_APP_NAME=Study Timelapse"
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
- 詳細ページで動画再生できる
- ダッシュボード統計に反映される

## 既知の制限

- PC Chrome / Edge想定
- iPhone SafariはMVP対象外
- 長時間動画はCloud Run service内処理では重くなる可能性があります
- 本格運用ではタイムラプス処理をCloud Run Jobsへ分離推奨
- ログインなし、`--allow-unauthenticated` なのでCloud Run URLの共有に注意
# study-log-timerapse
