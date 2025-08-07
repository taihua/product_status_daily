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
  .help()
  .parse();

function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
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

  // 點 Inspect
  try {
    // 有些是 menu，有些是 dialog，先不限定容器
    await page.getByRole('button', { name: /^Inspect$/ }).first().click({ timeout: Math.min(8000, argv.timeout) });
  } catch (e) {
    console.warn(`[WARN] 找不到 Inspect，跳過：${panelName}`);
    return;
  }

  // 等待 Inspector
  const inspector = page.getByRole('dialog');
  try {
    await inspector.getByRole('button', { name: /Download CSV/i }).waitFor({ timeout: argv.timeout });
  } catch (_) {
    console.warn(`[WARN] Inspector 未出現或缺少 Download CSV，跳過：${panelName}`);
    // 嘗試關閉側欄（點擊右上角 X）
    await closeInspector(page, 3000).catch(() => null);
    return;
  }

  // 下載 CSV（Formatted）
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
  console.log(`[OK] 已下載：${targetPath}`);

  // 關閉 Inspector（按右上角 X 優先）
  await closeInspector(page, 8000);

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
  await ensureDir(argv.outDir);
  const browser = await chromium.launch({ headless: argv.headless, slowMo: argv.slowMo });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1600, height: 1200 },
  });
  const page = await context.newPage();

  console.log(`[INFO] 開啟 URL: ${argv.url}`);
  await page.goto(argv.url, { waitUntil: 'load', timeout: argv.timeout });
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
