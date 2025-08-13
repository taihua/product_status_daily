const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('url', {
    type: 'string',
    describe: 'Kibana 儀表板 URL（可含 _g.time 參數指定日期區間）',
    demandOption: true,
  })
  .option('outDir', {
    type: 'string',
    describe: 'CSV 輸出資料夾',
    default: path.resolve(process.cwd(), 'downloads'),
  })
  .option('headless', {
    type: 'boolean',
    describe: '是否使用 headless 模式',
    default: true,
  })
  .option('slowMo', {
    type: 'number',
    describe: '動作放慢毫秒數（便於除錯觀察）',
    default: 0,
  })
  .option('timeout', {
    type: 'number',
    describe: '等待逾時（毫秒）',
    default: 45000,
  })
  .option('date', {
    type: 'string',
    describe: '台灣時區 (GMT+8) 的單日日期，格式 YYYY-MM-DD；若提供則以此日為時間區間產生 _g.time',
    demandOption: false,
  })
  .help()
  .parse();

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function isValidYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function nextDayYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const next = new Date(base.getTime() + 24 * 60 * 60 * 1000);
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

function computeTaipeiDayRangeUtc(ymd) {
  if (!isValidYmd(ymd)) throw new Error(`無效日期格式，需為 YYYY-MM-DD：${ymd}`);
  // 以固定偏移 +08:00 計算該日在台灣時區的起迄，轉為 UTC ISO
  const fromIso = new Date(`${ymd}T00:00:00.000+08:00`).toISOString();
  const toIso = new Date(`${ymd}T23:59:59+08:00`).toISOString();
  return { fromIso, toIso };
}

function buildGTime(fromIso, toIso) {
  return `_g=(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'${fromIso}',to:'${toIso}'))`;
}

function upsertGInHash(hash, gStr) {
  const qIndex = hash.indexOf('?');
  if (qIndex === -1) {
    return `${hash}?${gStr}`;
  }
  const path = hash.slice(0, qIndex);
  let query = hash.slice(qIndex + 1);
  const gIdx = query.indexOf('_g=');
  if (gIdx === -1) {
    if (query.length === 0) return `${path}?${gStr}`;
    return `${path}?${query}&${gStr}`;
  }
  const amp = query.indexOf('&', gIdx);
  if (amp === -1) {
    query = query.slice(0, gIdx) + gStr;
  } else {
    query = query.slice(0, gIdx) + gStr + query.slice(amp);
  }
  return `${path}?${query}`;
}

function upsertGInUrl(url, gStr) {
  const hashPos = url.indexOf('#');
  if (hashPos === -1) {
    // 少見情況：沒有 hash，就直接用一般 query upsert
    const qPos = url.indexOf('?');
    if (qPos === -1) return `${url}?${gStr}`;
    const path = url.slice(0, qPos);
    let query = url.slice(qPos + 1);
    const gIdx = query.indexOf('_g=');
    if (gIdx === -1) return `${path}?${query}&${gStr}`;
    const amp = query.indexOf('&', gIdx);
    if (amp === -1) query = query.slice(0, gIdx) + gStr; else query = query.slice(0, gIdx) + gStr + query.slice(amp);
    return `${path}?${query}`;
  }
  const base = url.slice(0, hashPos);
  const hash = url.slice(hashPos + 1);
  const newHash = upsertGInHash(hash, gStr);
  return `${base}#${newHash}`;
}

async function waitPanelStable(page, panelEl, timeout = 12000) {
  const start = Date.now();
  const hasLoadingFn = `(el) => {
    const selectors = [
      '.euiLoadingSpinner',
      '.euiLoadingContent',
      '.euiProgress',
      '[role="progressbar"]',
      '[aria-busy="true"]',
      '[data-test-subj*="loading"]',
    ];
    return selectors.some(sel => el.querySelector(sel));
  }`;
  while (Date.now() - start < timeout) {
    try {
      const done = await panelEl.getAttribute('data-render-complete').catch(() => null);
      if (done === 'true') return true;
    } catch (_) {}
    let hasLoading = false;
    try {
      hasLoading = await panelEl.evaluate(new Function('el', `return (${hasLoadingFn})(el);`));
    } catch (_) {}
    if (!hasLoading) {
      // 再確認一次穩定
      await page.waitForTimeout(250);
      try {
        const again = await panelEl.evaluate(new Function('el', `return (${hasLoadingFn})(el);`));
        if (!again) return true;
      } catch (_) {}
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function waitInspectorReady(page, inspector, timeout = 12000) {
  const start = Date.now();
  const btn = inspector.getByRole('button', { name: /Download CSV/i }).first();
  while (Date.now() - start < timeout) {
    try {
      const enabled = await btn.isEnabled().catch(() => false);
      const loadingCount = await inspector
        .locator('.euiLoadingSpinner, .euiLoadingContent, .euiProgress, [role="progressbar"], [aria-busy="true"]')
        .count()
        .catch(() => 0);
      if (enabled && loadingCount === 0) {
        // 穩定二次確認
        await page.waitForTimeout(250);
        const enabled2 = await btn.isEnabled().catch(() => false);
        const loadingCount2 = await inspector
          .locator('.euiLoadingSpinner, .euiLoadingContent, .euiProgress, [role="progressbar"], [aria-busy="true"]')
          .count()
          .catch(() => 0);
        if (enabled2 && loadingCount2 === 0) return true;
      }
    } catch (_) {}
    await page.waitForTimeout(250);
  }
  return false;
}

async function closeInspector(page, timeout = 8000) {
  let closed = false;
  try {
    const dialogs = page.getByRole('dialog');
    const dialogCount = await dialogs.count().catch(() => 0);
    for (let i = 0; i < dialogCount; i++) {
      const dlg = dialogs.nth(i);
      const candidates = [
        dlg.locator('[data-test-subj="euiFlyoutCloseButton"]').first(),
        dlg.locator('[data-test-subj="modalCloseButton"]').first(),
        dlg.locator('button[aria-label="Close"]').first(),
        dlg.locator('button[aria-label*="Close"]').first(),
        dlg.getByRole('button', { name: /^Close$/i }).first(),
        dlg.getByRole('button', { name: /Close Inspector/i }).first(),
      ];
      for (const cand of candidates) {
        try {
          if (await cand.count()) {
            await cand.click({ timeout: 1500 });
            closed = true;
            break;
          }
        } catch (_) {}
      }
      if (closed) break;
    }
    if (!closed) {
      // 全域嘗試一次
      const globalCandidates = [
        page.locator('[data-test-subj="euiFlyoutCloseButton"]').first(),
        page.locator('[data-test-subj="modalCloseButton"]').first(),
        page.locator('button[aria-label="Close"]').first(),
        page.locator('button[aria-label*="Close"]').first(),
        page.getByRole('button', { name: /^Close$/i }).first(),
        page.getByRole('button', { name: /Close Inspector/i }).first(),
      ];
      for (const cand of globalCandidates) {
        try {
          if (await cand.count()) {
            await cand.click({ timeout: 1500 });
            closed = true;
            break;
          }
        } catch (_) {}
      }
    }
    if (!closed) {
      // 嘗試按下 ESC 作為最後手段
      try { await page.keyboard.press('Escape'); closed = true; } catch (_) {}
    }
    // 等待 Inspector 消失或 Download CSV 按鈕不存在
    await page.getByRole('button', { name: /Download CSV/i }).waitFor({ state: 'detached', timeout }).catch(() => {});
  } catch (_) {}
  return closed;
}

async function getVisiblePanelHandles(panelLocator) {
  const handles = [];
  const count = await panelLocator.count();
  for (let j = 0; j < count; j++) {
    const h = await panelLocator.nth(j).elementHandle().catch(() => null);
    if (h) handles.push(h);
  }
  return handles;
}

async function getPanelKey(panelEl) {
  try {
    const aria = await panelEl.getAttribute('aria-label');
    if (aria) return aria;
  } catch (_) {}
  try {
    const title = await panelEl.evaluate(el => el.getAttribute('data-title'));
    if (title) return `title:${title}`;
  } catch (_) {}
  try {
    const h2 = await panelEl.$('h2, [role="heading"]');
    if (h2) {
      const text = await h2.innerText();
      if (text) return `h2:${text}`;
    }
  } catch (_) {}
  // 回退用 DOM 唯一性
  try {
    const id = await panelEl.evaluate(el => el.id || el.dataset?.testSubj || el.outerHTML?.slice(0, 80));
    if (id) return `id:${id}`;
  } catch (_) {}
  return `panel:${Date.now()}-${Math.random()}`;
}

async function processPanelElement(page, panelEl, argv, defaultName = 'panel') {
  // 命名
  let panelName = defaultName;
  try {
    const aria = await panelEl.getAttribute('aria-label');
    if (aria) {
      const m = aria.match(/Dashboard panel:\s*(.+)/i);
      panelName = sanitizeFilename(m ? m[1] : aria);
    } else {
      const h2 = await panelEl.$('h2, [role="heading"]');
      if (h2) {
        const text = await h2.innerText().catch(() => '');
        if (text) panelName = sanitizeFilename(text.replace(/Dashboard panel:\s*/i, ''));
      }
    }
  } catch (_) {}

  console.log(`\n[INFO] 處理面板：${panelName}`);

  // 滾到可見並 hover
  try { await panelEl.scrollIntoViewIfNeeded(); } catch (_) {}
  try { await panelEl.hover(); } catch (_) {}
  // 等待面板穩定（避免資料尚未載入完成就開 Inspector）
  await waitPanelStable(page, panelEl, Math.min(argv.timeout, 15000)).catch(() => {});

  // 嘗試點擊 Panel options（多種 selector）
  const optionSelectors = [
    'button[aria-label="Panel options"]',
    'button[aria-label*="Panel options"]',
    '[data-test-subj="embeddablePanelToggleMenuIcon"]',
    '[data-test-subj^="embeddablePanelOptions"]',
  ];
  let clickedOptions = false;
  for (const sel of optionSelectors) {
    try {
      const btn = await panelEl.$(sel);
      if (btn) {
        await btn.click();
        clickedOptions = true;
        break;
      }
    } catch (_) {}
  }
  if (!clickedOptions) {
    // 回退使用全域角色名稱搜尋（可能已經可見）
    try {
      await page.getByRole('button', { name: /Panel options/i }).first().click({ timeout: 2000 });
      clickedOptions = true;
    } catch (_) {}
  }
  if (!clickedOptions) {
    console.warn(`[WARN] 找不到 Panel options，跳過：${panelName}`);
      return;
  }

    // 等待 Panel options 選單出現
  await page.waitForTimeout(500);

  // 除錯：檢查選單是否出現
  try {
    const menuExists = await page.locator('[role="menu"], .euiContextMenu, .euiPopover').count();
    console.log(`[DEBUG] 選單容器數量：${menuExists}`);
  } catch (_) {}

  // 優先嘗試 Inspect 流程
  console.log(`[INFO] 優先使用 Inspect 流程處理：${panelName}`);

  let inspectSuccess = false;
  try {
    // 尋找 Inspect 按鈕
    const inspectSelectors = [
      '[role="menuitem"]:has-text("Inspect")',
      'button:has-text("Inspect")',
      'button[aria-label="Inspect"]',
      'button[title="Inspect"]',
      'menuitem:has-text("Inspect")',
      'a:has-text("Inspect")',
      '[data-test-subj*="inspect"]',
    ];

    let foundInspect = false;
    for (const sel of inspectSelectors) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) {
          console.log(`[DEBUG] 找到 Inspect 按鈕，使用選擇器: ${sel}`);
          await page.locator(sel).first().click({ timeout: Math.min(8000, argv.timeout) });
          foundInspect = true;
          break;
        }
      } catch (_) {}
    }

    if (!foundInspect) {
      // 如果找不到，嘗試原本的方法
      await page.getByRole('button', { name: /^Inspect$/ }).first().click({ timeout: Math.min(8000, argv.timeout) });
      foundInspect = true;
    }

    if (foundInspect) {
      // 等待 Inspector
      const inspector = page.getByRole('dialog');
      try {
        await inspector.getByRole('button', { name: /Download CSV/i }).waitFor({ timeout: Math.min(argv.timeout, 10000) });

        // 找到了 Download CSV，執行 Inspect 下載流程
        console.log(`[INFO] 在 Inspector 中找到 Download CSV`);

        // 先等 Inspector 內資料與按鈕就緒
        await waitInspectorReady(page, inspector, Math.min(argv.timeout, 15000)).catch(() => {});
        await inspector.getByRole('button', { name: /Download CSV/i }).click({ timeout: argv.timeout });
        const csvDialog = page.getByRole('dialog');
        await csvDialog.getByRole('button', { name: /^Formatted CSV$/i }).waitFor({ timeout: argv.timeout });
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: argv.timeout }),
          csvDialog.getByRole('button', { name: /^Formatted CSV$/i }).click(),
        ]);

        const suggested = await download.suggestedFilename();
        const finalName = sanitizeFilename(`${panelName} - ${suggested || 'data.csv'}`);
        const targetPath = await ensureUniquePath(path.join(argv.outDir, finalName));
        await download.saveAs(targetPath);
        console.log(`[OK] 已下載（透過 Inspect）：${targetPath}`);

        // 關閉 Inspector（按右上角 X 優先）
        await closeInspector(page, 8000);
        inspectSuccess = true;

      } catch (inspectorError) {
        console.warn(`[WARN] Inspector 中沒有找到 Download CSV，關閉 Inspector 並嘗試 More 流程：${panelName}`);
        console.warn(`[DEBUG] Inspector 錯誤：`, inspectorError.message);
        // 確保關閉 Inspector
        await closeInspector(page, 3000).catch(() => null);
        inspectSuccess = false;
      }
    }

  } catch (e) {
    console.warn(`[WARN] 無法開啟 Inspect，嘗試 More 流程：${panelName}`);
    console.warn(`[DEBUG] Inspect 開啟錯誤：`, e.message);
    inspectSuccess = false;
  }

  // 如果 Inspect 流程失敗，嘗試 More -> Download CSV 流程
  if (!inspectSuccess) {
    console.log(`[INFO] 回退到 More -> Download CSV 流程：${panelName}`);

    // 重新點擊 Panel options（因為可能已經關閉）
    let reopenedOptions = false;
    for (const sel of optionSelectors) {
      try {
        const btn = await panelEl.$(sel);
        if (btn) {
          await btn.click();
          reopenedOptions = true;
          break;
        }
      } catch (_) {}
    }
    if (!reopenedOptions) {
      try {
        await page.getByRole('button', { name: /Panel options/i }).first().click({ timeout: 2000 });
        reopenedOptions = true;
      } catch (_) {}
    }

    if (reopenedOptions) {
      await page.waitForTimeout(500); // 給選單時間載入

      // 尋找 More -> Download CSV
      const downloadMenuSelectors = [
        // 直接尋找 Download CSV
        '[role="menuitem"]:has-text("Download CSV")',
        'button:has-text("Download CSV")',
        'a:has-text("Download CSV")',
        // 尋找 More 然後 Download CSV
        '[role="menuitem"]:has-text("More")',
        'button:has-text("More")',
        // 尋找一般的 Download
        '[role="menuitem"]:has-text("Download")',
        'button:has-text("Download")',
      ];

      let foundDownloadInMenu = false;
      for (const sel of downloadMenuSelectors) {
        try {
          const count = await page.locator(sel).count();
          if (count > 0) {
            const text = await page.locator(sel).first().textContent();
            console.log(`[DEBUG] 找到選單項目: "${text}" (選擇器: ${sel})`);

            if (text?.includes('Download CSV') || text?.includes('Download as CSV')) {
              await page.locator(sel).first().click({ timeout: 5000 });
              foundDownloadInMenu = true;
              console.log(`[INFO] 直接點擊 ${text}`);
              break;
            } else if (text?.includes('More')) {
              // 點擊 More 然後尋找 Download CSV
              await page.locator(sel).first().click({ timeout: 5000 });
              await page.waitForTimeout(500);

              const csvInMore = await page.locator('[role="menuitem"]:has-text("Download CSV"), button:has-text("Download CSV")').count();
              if (csvInMore > 0) {
                await page.locator('[role="menuitem"]:has-text("Download CSV"), button:has-text("Download CSV")').first().click({ timeout: 5000 });
                foundDownloadInMenu = true;
                console.log(`[INFO] 透過 More 選單找到並點擊 Download CSV`);
                break;
              }
            }
          }
        } catch (_) {}
      }

      // 如果在 More 選單中找到了下載功能，處理下載流程
      if (foundDownloadInMenu) {
        try {
          console.log(`[INFO] 等待 More 選單下載開始...`);

          // 縮短等待時間，避免長時間等待
          const downloadPromise = page.waitForEvent('download', { timeout: Math.min(argv.timeout, 15000) });

          // 檢查是否有格式選擇對話框
          let hasFormatDialog = false;
          try {
            const csvDialog = page.getByRole('dialog');
            await csvDialog.getByRole('button', { name: /^Formatted CSV$/i }).waitFor({ timeout: 2000 });
            hasFormatDialog = true;
            console.log(`[DEBUG] 找到格式選擇對話框`);
          } catch (_) {
            console.log(`[DEBUG] 沒有格式選擇對話框，可能直接下載`);
          }

          let download;
          if (hasFormatDialog) {
            // 有對話框，點擊 Formatted CSV
            const csvDialog = page.getByRole('dialog');
            const [downloadEvent] = await Promise.all([
              downloadPromise,
              csvDialog.getByRole('button', { name: /^Formatted CSV$/i }).click(),
            ]);
            download = downloadEvent;
          } else {
            // 沒有對話框，直接等待下載
            download = await downloadPromise;
          }

          const suggested = await download.suggestedFilename();
          const finalName = sanitizeFilename(`${panelName} - ${suggested || 'data.csv'}`);
          const targetPath = await ensureUniquePath(path.join(argv.outDir, finalName));
          await download.saveAs(targetPath);
          console.log(`[OK] 已下載（透過 More 選單）：${targetPath}`);

          // 關閉可能的對話框
          try {
            await page.keyboard.press('Escape');
          } catch (_) {}

        } catch (e) {
          console.warn(`[WARN] More 選單下載失敗：${panelName}`);
          console.warn(`[DEBUG] More 下載錯誤：`, e.message);
        }
      } else {
        console.warn(`[WARN] 在 More 選單中也找不到下載選項，跳過：${panelName}`);
      }
    } else {
      console.warn(`[WARN] 無法重新開啟 Panel options，跳過：${panelName}`);
    }
  }



  // 關閉可能被觸發的新分頁（例如下載時彈出的空白/暫存頁），避免影響下一個面板
  try {
    const ctx = page.context();
    for (const p of ctx.pages()) {
      if (p !== page) {
        try { await p.close({ runBeforeUnload: true }); } catch (_) {}
      }
    }
    // 將主頁帶回前景
    try { await page.bringToFront(); } catch (_) {}
  } catch (_) {}
}

async function iteratePanels(page, panelLocator, scrollers, argv) {
  const processed = new Set();
  let noNewCount = 0;
  const maxNoNew = 5;
  const maxPasses = 40;
  for (let pass = 0; pass < maxPasses; pass++) {
    let newInThisPass = 0;
    const handles = await getVisiblePanelHandles(panelLocator);
    for (const h of handles) {
      const key = await getPanelKey(h);
      if (processed.has(key)) continue;
      processed.add(key);
      newInThisPass++;
      try {
        await processPanelElement(page, h, argv, `panel-${processed.size}`);
      } catch (e) {
        console.error(`[ERROR] 面板處理失敗 ->`, e.message || e);
        // 嘗試關閉檢視器回到列表
        await closeInspector(page, 2000).catch(() => null);
      }
    }

    if (newInThisPass === 0) noNewCount++; else noNewCount = 0;
    if (noNewCount >= maxNoNew) {
      // 連續多次沒有新面板，視為到底
      break;
    }

    // 往下捲動
    let scrolled = false;
    for (const sc of scrollers) {
      try {
        const atBottom = await sc.evaluate(el => {
          const prev = el.scrollTop;
          el.scrollBy(0, el.clientHeight - 200);
          return prev === el.scrollTop || el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
        });
        scrolled = true;
        if (atBottom) {
          // 若到底，再嘗試一次全頁捲動以保險
          await page.mouse.wheel(0, 900).catch(() => {});
        }
      } catch (_) {}
    }
    if (!scrollers.length || !scrolled) {
      await page.mouse.wheel(0, 1200).catch(() => {});
    }
    await page.waitForTimeout(400);
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function ensureUniquePath(filePath) {
  if (!existsSync(filePath)) return filePath;
  const { dir, name, ext } = path.parse(filePath);
  let i = 1;
  // Avoid very long names
  const base = name.slice(0, 160);
  while (true) {
    const cand = path.join(dir, `${base} (${i})${ext}`);
    if (!existsSync(cand)) return cand;
    i += 1;
  }
}

async function clickIfVisible(locator) {
  if (await locator.count()) {
    try {
      await locator.first().click({ timeout: 2000 });
      return true;
    } catch (_) {}
  }
  return false;
}

async function continueAsGuestIfPresent(page, timeout = 10000) {
  try {
    // 等候任一候選 selector 可見
    const candidates = [
      page.locator('[data-test-subj="loginAsGuestButton"]').first(),
      page.getByRole('button', { name: /Continue as Guest/i }).first(),
      page.getByRole('link', { name: /Continue as Guest/i }).first(),
      page.getByText(/Continue as Guest/i).first(),
    ];
    await Promise.race(
      candidates.map(c => c.waitFor({ state: 'visible', timeout }).catch(() => null))
    );

    // 先嘗試在 main frame 點擊
    for (const cand of candidates) {
      if (await cand.count().catch(() => 0)) {
        try {
          await cand.click({ timeout: 3000 });
          console.log('[INFO] 已點擊 Continue as Guest');
          return true;
        } catch (_) {}
      }
    }

    // 掃描所有 iframe
    for (const frame of page.frames()) {
      try {
        const fCandidates = [
          frame.locator('[data-test-subj="loginAsGuestButton"]').first(),
          frame.getByRole('button', { name: /Continue as Guest/i }).first(),
          frame.getByRole('link', { name: /Continue as Guest/i }).first(),
          frame.getByText(/Continue as Guest/i).first(),
        ];
        for (const cand of fCandidates) {
          if (await cand.count().catch(() => 0)) {
            try {
              await cand.click({ timeout: 3000 });
              console.log('[INFO] 已在 iframe 內點擊 Continue as Guest');
              return true;
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return false;
}

async function getDashboardScrollers(page) {
  const selectors = [
    '[data-test-subj="dashboardViewport"]',
    '[data-test-subj="dashboardViewport__scroll"]',
    '[data-test-subj*="dashboard"]',
    'main[role="main"]',
    '[role="main"]',
  ];
  const scrollers = [];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      scrollers.push(loc);
    }
  }
  return scrollers;
}

async function ensurePanelVisible(page, panelLocator, index, scrollers = [], attempts = 14) {
  // 逐步滾動直到 nth(index) 能成功 scrollIntoView 或達到嘗試上限
  for (let i = 0; i < attempts; i++) {
    try {
      await panelLocator.nth(index).scrollIntoViewIfNeeded({ timeout: 800 });
      await page.waitForTimeout(150);
      return true;
    } catch (_) {
      // 優先在可捲動容器內滾動
      let didScroll = false;
      for (const sc of scrollers) {
        try {
          await sc.evaluate(el => el.scrollBy(0, 900));
          didScroll = true;
        } catch (_) {}
      }
      if (!didScroll) {
        // 回退使用頁面滾輪
        await page.mouse.wheel(0, 900).catch(() => {});
      }
      await page.waitForTimeout(200);
    }
  }
  // 最後使用鍵盤 PageDown 幾次
  for (let k = 0; k < 3; k++) {
    try { await page.keyboard.press('PageDown'); } catch (_) {}
    await page.waitForTimeout(150);
    try {
      await panelLocator.nth(index).scrollIntoViewIfNeeded({ timeout: 600 });
      await page.waitForTimeout(120);
      return true;
    } catch (_) {}
  }
  return false;
}

(async () => {
  // 依日期使用子資料夾存放下載結果
  if (argv.date && isValidYmd(argv.date)) {
    argv.outDir = path.join(argv.outDir, argv.date);
  }
  await ensureDir(argv.outDir);
  console.log(`[INFO] 輸出資料夾: ${argv.outDir}`);
  const browser = await chromium.launch({ headless: argv.headless, slowMo: argv.slowMo });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1600, height: 1200 },
  });
  const page = await context.newPage();

  let targetUrl = argv.url;
  if (argv.date) {
    try {
      const { fromIso, toIso } = computeTaipeiDayRangeUtc(argv.date);
      const g = buildGTime(fromIso, toIso);
      targetUrl = upsertGInUrl(argv.url, g);
      console.log(`[INFO] 使用台灣日期 ${argv.date} 對應 UTC 範圍`);
      console.log(`[INFO] from: ${fromIso} | to: ${toIso}`);
    } catch (e) {
      console.warn(`[WARN] 日期解析失敗，改用原始 URL：${e.message || e}`);
    }
  }
  console.log(`[INFO] 開啟 URL: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'load', timeout: argv.timeout });
  // 盡量等到資源安定，避免登入按鈕尚未渲染
  await page.waitForLoadState('networkidle', { timeout: argv.timeout }).catch(() => {});

  // 若出現登入頁，嘗試點擊 Continue as Guest
  const didGuest = await continueAsGuestIfPresent(page, Math.min(argv.timeout, 20000));
  if (!didGuest) {
    console.warn('[WARN] 找不到或無法點擊 Continue as Guest，可能已登入或登入頁樣式不同。');
  } else {
    // 點擊後再等一次網路閒置，確保進入儀表板
    await page.waitForLoadState('networkidle', { timeout: argv.timeout }).catch(() => {});
  }

  // 等待儀表板面板載入
  const panelLocator = page.getByRole('figure', { name: /Dashboard panel/i });
  await panelLocator.first().waitFor({ timeout: argv.timeout });

  const panelCount = await panelLocator.count();
  console.log(`[INFO] 偵測到面板數量: ${panelCount}`);
  const scrollers = await getDashboardScrollers(page);
  await iteratePanels(page, panelLocator, scrollers, argv);

  console.log('\n[SUCCESS] 全部處理完成');
  await browser.close();
})().catch(async (e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
