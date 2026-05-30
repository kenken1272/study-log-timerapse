#!/bin/bash

echo "============================================================"
echo "1. 既存リポジトリのファイル構成"
echo "============================================================"

pwd
echo ""

if command -v tree >/dev/null 2>&1; then
  tree -a \
    -I "node_modules|.next|.git|dist|out|coverage|*.log|tsconfig.tsbuildinfo"
else
  find . \
    -path "./node_modules" -prune -o \
    -path "./.next" -prune -o \
    -path "./.git" -prune -o \
    -path "./dist" -prune -o \
    -path "./out" -prune -o \
    -path "./coverage" -prune -o \
    -print | sort
fi

echo ""
echo "============================================================"
echo "2. Gemini分析APIの現在の実装ファイル"
echo "============================================================"

for file in \
  "src/app/api/sessions/[id]/analyze/route.ts" \
  "src/lib/vertex/analyzeStudyVideo.ts" \
  "src/lib/vertex/types.ts" \
  "src/components/AnalyzeButton.tsx" \
  "src/components/AnalysisResultCard.tsx"
do
  echo ""
  echo "------------------------------------------------------------"
  echo "$file"
  echo "------------------------------------------------------------"
  if [ -f "$file" ]; then
    sed -n '1,260p' "$file"
  else
    echo "NOT FOUND: $file"
  fi
done

echo ""
echo "============================================================"
echo "3. セッション詳細ページの実装ファイル"
echo "============================================================"

for file in \
  "src/app/sessions/[id]/page.tsx" \
  "src/components/VideoPlayer.tsx" \
  "src/components/SessionCard.tsx"
do
  echo ""
  echo "------------------------------------------------------------"
  echo "$file"
  echo "------------------------------------------------------------"
  if [ -f "$file" ]; then
    sed -n '1,340p' "$file"
  else
    echo "NOT FOUND: $file"
  fi
done

echo ""
echo "============================================================"
echo "4. FirestoreのSession型定義・操作ファイル"
echo "============================================================"

for file in \
  "src/lib/sessions/types.ts" \
  "src/lib/sessions/firestore.ts" \
  "src/lib/sessions/stats.ts" \
  "src/lib/firebase/admin.ts" \
  "src/lib/gcs.ts" \
  "src/lib/storage.ts"
do
  echo ""
  echo "------------------------------------------------------------"
  echo "$file"
  echo "------------------------------------------------------------"
  if [ -f "$file" ]; then
    sed -n '1,340p' "$file"
  else
    echo "NOT FOUND: $file"
  fi
done

echo ""
echo "============================================================"
echo "5. API routes一覧"
echo "============================================================"

find src/app/api -type f 2>/dev/null | sort

echo ""
echo "============================================================"
echo "6. package.json"
echo "============================================================"

if [ -f "package.json" ]; then
  cat package.json
else
  echo "NOT FOUND: package.json"
fi

echo ""
echo "============================================================"
echo "7. 環境変数例"
echo "============================================================"

if [ -f ".env.example" ]; then
  cat .env.example
else
  echo "NOT FOUND: .env.example"
fi

echo ""
echo "============================================================"
echo "8. README / デプロイ関連"
echo "============================================================"

for file in \
  "README.md" \
  "DEPLOY.md" \
  "deploy.md" \
  "docs/deploy.md"
do
  echo ""
  echo "------------------------------------------------------------"
  echo "$file"
  echo "------------------------------------------------------------"
  if [ -f "$file" ]; then
    sed -n '1,260p' "$file"
  else
    echo "NOT FOUND: $file"
  fi
done
