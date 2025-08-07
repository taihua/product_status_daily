# Kibana CSV 自動下載（Node.js + Playwright）

自動化在 Kibana 儀表板中，逐一開啟各個面板的 Inspect → Download CSV → Formatted CSV，並將檔案下載到本機指定資料夾。

## 需求

- Node.js 18+（建議使用 LTS）
- 已安裝 Playwright 瀏覽器（第一次使用請執行 `npm run pw:install`）
- 可連線至 Kibana，首頁出現「Continue as Guest」按鈕（程式會自動點擊）
- macOS/Linux/Windows 皆可；本文示例以 macOS zsh 為主

## 安裝

```bash
npm i
npm run pw:install
```

## 使用方式

```bash
node src/index.js \
  --url 'https://kibana.kkday.com/app/dashboards#/view/d768bd60-71cf-11f0-ae80-ef95d33419ab?_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:\'2025-07-31T16:00:00.000Z\',to:\'2025-08-01T16:00:00.000Z\'))' \
  --outDir ./downloads \
  --headless=true
```

或是直接指定台灣時區日期（GMT+8），由程式自動計算該日的 UTC 範圍並注入 `_g.time`：

```bash
node src/index.js \
  --url 'https://kibana.kkday.com/app/dashboards#/view/d768bd60-71cf-11f0-ae80-ef95d33419ab' \
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
- `--date`：台灣時區（GMT+8）的單一日期，格式 `YYYY-MM-DD`。若提供此參數，會以該日的 00:00:00+08:00 到 23:59:59+08:00 轉為 UTC，並覆蓋/插入 URL 的 `_g.time` 區間；同時下載路徑會建立日期子資料夾：`<outDir>/<date>/...`。

說明：
- 若 `--date` 與 URL 內已包含的 `_g` 同時存在，程式會以 `--date` 計算出的時間區間（to 為 23:59:59）覆蓋 URL 內的 `_g.time`。
- 台灣不採夏令時間，時間偏移固定為 `+08:00`，因此以 `--date` 計算區間時可直接使用固定偏移。

## 注意事項
- 會自動點擊登入頁的「Continue as Guest」。
- 只針對有「Inspect」→「Download CSV」的面板，沒有的會自動略過並繼續。
- 下載後檔名格式為：`<面板標題> - <Kibana 建議檔名>.csv`，若重複會自動在檔名後加 `(n)`。
- 若有需要下載 Raw CSV，可在程式內將 `Formatted CSV` 改為 `Raw CSV`。

## 輸出路徑與命名

- 預設輸出到執行目錄下的 `downloads/`（可用 `--outDir` 覆蓋）
- 指定 `--date YYYY-MM-DD` 時，會建立日期子資料夾：`<outDir>/<date>/`
- 檔名格式：`<面板標題> - <Kibana 建議檔名>.csv`；若重複會自動加上 `(n)` 以避免覆蓋

## 切換為 Raw CSV

預設下載「Formatted CSV」。若要改為「Raw CSV」，請在 `src/index.js` 將以下兩處的按鈕名稱由 `Formatted CSV` 改成 `Raw CSV`：

```js
await csvDialog.getByRole('button', { name: /^Formatted CSV$/i }).waitFor({ timeout: argv.timeout });
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: argv.timeout }),
  csvDialog.getByRole('button', { name: /^Formatted CSV$/i }).click(),
]);
```

改成：

```js
await csvDialog.getByRole('button', { name: /^Raw CSV$/i }).waitFor({ timeout: argv.timeout });
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: argv.timeout }),
  csvDialog.getByRole('button', { name: /^Raw CSV$/i }).click(),
]);
```

## Shell 使用注意與排解
- 建議用「單引號」包住 URL（特別是在 zsh）：Kibana 的 `_g` 參數包含 `!`，在 zsh 中會觸發歷史展開，造成 `zsh: event not found`。
  - 正確範例（zsh/bash 皆可）：
    ```bash
    node src/index.js \
      --url 'https://...#...?_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:\'2025-07-31T16:00:00.000Z\',to:\'2025-08-01T16:00:00.000Z\'))' \
      --date 2025-08-01 \
      --outDir ./downloads \
      --headless=false --slowMo=120
    ```
  - 若不得不用雙引號，請將 `!` 轉義成 `\!`，或先停用 zsh 歷史展開：`setopt no_hist_expand` 或 `set +H`。
- 多行指令換行符 `\` 必須放在每一行結尾，後面不能有多餘字元。
- 若 URL 內本來就含 `_g`，搭配 `--date` 會自動覆蓋成指定日期範圍，不需手動修改 URL。

## 批次範例：多日下載（macOS / Linux）

以 macOS 的 `date` 增減日期為例，將 2025-08-01 ~ 2025-08-03 的每日 CSV 下載到對應日期資料夾：

```zsh
URL='https://kibana.kkday.com/app/dashboards#/view/d768bd60-71cf-11f0-ae80-ef95d33419ab'
OUT='./downloads'
start='2025-08-01'
end='2025-08-03'

cur="$start"
while :; do
  node src/index.js --url "$URL" --date "$cur" --outDir "$OUT" --headless=true
  [[ "$cur" == "$end" ]] && break
  cur=$(date -j -f "%Y-%m-%d" "$cur" -v+1d "+%Y-%m-%d")
done
```

若使用 GNU date（Linux），將最後一行改為：

```bash
cur=$(date -d "$cur +1 day" "+%Y-%m-%d")
```

## 開發建議
- 可改 `--headless=false --slowMo=100` 觀察流程與選擇器是否正確。
- 若 Kibana UI 有差異，可調整 button 名稱或增加更精確的 locator（例如 data-test-subj）。

