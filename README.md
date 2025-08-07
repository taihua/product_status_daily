# Kibana CSV 自動下載（Node.js + Playwright）

自動化在 Kibana 儀表板中，逐一開啟各個面板的 Inspect → Download CSV → Formatted CSV，並將檔案下載到本機指定資料夾。

## 安裝

```bash
npm i
npm run pw:install
```

## 使用方式

```bash
node src/index.js \
  --url "https://kibana.kkday.com/app/dashboards#/view/d768bd60-71cf-11f0-ae80-ef95d33419ab?_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'2025-07-31T16:00:00.000Z',to:'2025-08-01T16:00:00.000Z'))" \
  --outDir ./downloads \
  --headless=true
```

或是直接指定台灣時區日期（GMT+8），由程式自動計算該日的 UTC 範圍並注入 `_g.time`：

```bash
node src/index.js \
  --url "https://kibana.kkday.com/app/dashboards#/view/d768bd60-71cf-11f0-ae80-ef95d33419ab" \
  --date 2025-08-01 \
  --outDir ./downloads \
  --headless=false --slowMo=120
```

參數說明：
- `--url`：Kibana 儀表板 URL。建議直接把 `_g.time` 的 from/to 帶在 URL（UTC 時間）。
- `--outDir`：CSV 輸出資料夾，預設為專案內的 `downloads/`。
- `--headless`：是否在背景模式執行，除錯時可設為 `false`。
- `--slowMo`：除錯時可加入，例如 `--slowMo=100`。
- `--timeout`：逾時毫秒數，預設 45000。
- `--date`：台灣時區（GMT+8）的單一日期，格式 `YYYY-MM-DD`。若提供此參數，會以該日的 00:00:00+08:00 到 23:59:59+08:00 轉為 UTC，並覆蓋/插入 URL 的 `_g.time` 區間。

說明：
- 若 `--date` 與 URL 內已包含的 `_g` 同時存在，程式會以 `--date` 計算出的時間區間（to 為 23:59:59）覆蓋 URL 內的 `_g.time`。
- 台灣不採夏令時間，時間偏移固定為 `+08:00`，因此以 `--date` 計算區間時可直接使用固定偏移。

## 注意事項
- 會自動點擊登入頁的「Continue as Guest」。
- 只針對有「Inspect」→「Download CSV」的面板，沒有的會自動略過並繼續。
- 下載後檔名格式為：`<面板標題> - <Kibana 建議檔名>.csv`，若重複會自動在檔名後加 `(n)`。
- 若有需要下載 Raw CSV，可在程式內將 `Formatted CSV` 改為 `Raw CSV`。

## 開發建議
- 可改 `--headless=false --slowMo=100` 觀察流程與選擇器是否正確。
- 若 Kibana UI 有差異，可調整 button 名稱或增加更精確的 locator（例如 data-test-subj）。
