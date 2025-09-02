#!/bin/bash

# --- Configuration ---
# The directory where this script is located
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
DOWNLOAD_DIR="$SCRIPT_DIR/downloads"
# The Node.js script to run
NODE_SCRIPT="$SCRIPT_DIR/src/index.js"
# Kibana URL
KIBANA_URL='https://kibana.kkday.com/app/dashboards#/view/d768bd60-71cf-11f0-ae80-ef95d33419ab'
# Default start date if no previous downloads are found (e.g., 14 days ago)
DEFAULT_START_DATE=$(date -j -v-14d +"%Y-%m-%d")

# --- Logic ---
echo "🔍 檢查下載目錄: $DOWNLOAD_DIR"

# Find the latest downloaded date
LATEST_DATE=$(ls -1 "$DOWNLOAD_DIR" 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r | head -n 1)

# Determine the start date
if [[ -z "$LATEST_DATE" ]]; then
  START_DATE="$DEFAULT_START_DATE"
  echo "ℹ️ 找不到先前的下載紀錄，將從預設的14天前開始: $START_DATE"
else
  # Start from the day after the latest date
  START_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$LATEST_DATE" +"%Y-%m-%d")
  echo "✅ 找到最新的下載日期是 $LATEST_DATE，將從下一天開始: $START_DATE"
fi

# Set the end date to yesterday
END_DATE=$(date -j -v-1d +"%Y-%m-%d")
echo "🏁 將執行到昨天的日期: $END_DATE"

# Loop from start date to end date
CURRENT_DATE="$START_DATE"

if [[ "$CURRENT_DATE" > "$END_DATE" ]]; then
  echo "🎉 已是最新狀態，不需要執行任何下載。"
  exit 0
fi

while [[ "$CURRENT_DATE" < "$END_DATE" || "$CURRENT_DATE" == "$END_DATE" ]]; do
  echo -e "\n--- 🚀 開始處理日期: $CURRENT_DATE ---"

  node "$NODE_SCRIPT" \
    --url "$KIBANA_URL" \
    --date "$CURRENT_DATE" \
    --outDir "$DOWNLOAD_DIR" \
    --headless=false \
    --slowMo=120

  if [ $? -ne 0 ]; then
    echo "❌ 處理 $CURRENT_DATE 時發生錯誤，腳本終止。"
    exit 1
  fi

  echo "✅ 完成日期: $CURRENT_DATE"

  # Increment to the next day
  CURRENT_DATE=$(date -j -v+1d -f "%Y-%m-%d" "$CURRENT_DATE" +"%Y-%m-%d")
done

echo -e "\n--- ✨ 全部處理完成 ---"
