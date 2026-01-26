/**
 * 广度优先探索REINS沿线数据
 * 按层级顺序：地方 → 都道府県 → カナ行 → 路線 → 駅
 * 运行30分钟后自动停止
 */

const puppeteer = require('puppeteer');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db, initDatabase } = require('../db/connection');

// 运行时间限制（30分钟）
const MAX_RUNTIME_MS = 30 * 60 * 1000;
const startTime = Date.now();

const delay = ms => new Promise(r => setTimeout(r, ms));

// 检查是否超时
function isTimeout() {
  return Date.now() - startTime >= MAX_RUNTIME_MS;
}

// 获取已运行时间
function getElapsedTime() {
  const elapsed = Date.now() - startTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  return `${minutes}分${seconds}秒`;
}

class BFSLineExplorer {
  constructor() {
    this.browser = null;
    this.page = null;

    // BFS队列和结果
    this.queue = [];
    this.explored = {
      regions: [],      // 地方列表
      prefectures: {},  // { 地方: [都道府県] }
      kanaRows: {},     // { 都道府県: [カナ行] }
      lines: {},        // { 都道府県_カナ行: [路線名] }
      stations: {}      // { 都道府県_路線: [駅] }
    };

    // 统计
    this.stats = {
      regionsExplored: 0,
      prefecturesExplored: 0,
      linesExplored: 0,
      stationsCollected: 0,
      errors: 0
    };
  }

  async initialize() {
    console.log('[BFS] Initializing...');
    await initDatabase();

    const chromePath = process.env.CHROME_PATH ||
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

    this.browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1400, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: chromePath
    });
    this.page = await this.browser.newPage();
    console.log('[BFS] Browser launched');
  }

  async login() {
    console.log('[BFS] Logging in to REINS...');
    const REINS_LOGIN_URL = 'https://system.reins.jp/login/main/KG/GKG001200';
    await this.page.goto(REINS_LOGIN_URL, { waitUntil: 'networkidle0', timeout: 60000 });

    await delay(3000);

    const username = process.env.REINS_USERNAME;
    const password = process.env.REINS_PASSWORD;

    await this.page.evaluate((user, pass) => {
      const inputs = document.querySelectorAll('input');
      inputs.forEach(input => {
        if (input.type === 'text') {
          input.value = user;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (input.type === 'password') {
          input.value = pass;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => { if (!cb.checked) cb.click(); });
    }, username, password);

    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('ログイン')) {
          btn.click();
          break;
        }
      }
    });

    await Promise.race([
      this.page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }),
      delay(10000)
    ]);

    console.log('[BFS] Login successful');
  }

  async navigateToRentalSearch() {
    console.log('[BFS] Navigating to rental search...');
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('賃貸') && btn.textContent?.includes('物件検索')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    await delay(3000);
  }

  async openLineGuide() {
    const clicked = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      let guideCount = 0;
      for (const btn of buttons) {
        if (btn.textContent?.trim() === '入力ガイド') {
          guideCount++;
          if (guideCount === 4) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });
    await delay(2000);
    return clicked;
  }

  async closeModal() {
    // 多次尝试关闭modal
    for (let i = 0; i < 3; i++) {
      const closed = await this.page.evaluate(() => {
        // 尝试多种关闭方式
        const closeSelectors = [
          '.modal .close',
          '.modal .btn-close',
          '.modal [data-dismiss="modal"]',
          '.modal [aria-label="Close"]',
          '.modal-header button',
          '.modal .btn-secondary',
          '[class*="modal"] [class*="close"]'
        ];

        for (const selector of closeSelectors) {
          const btn = document.querySelector(selector);
          if (btn) {
            btn.click();
            return true;
          }
        }

        // 尝试点击取消按钮
        const buttons = document.querySelectorAll('.modal button, [role="dialog"] button');
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if (text === 'キャンセル' || text === '閉じる' || text === '×' || text === 'Cancel') {
            btn.click();
            return true;
          }
        }

        // 按ESC键关闭
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
        return false;
      });

      await delay(800);

      // 检查modal是否已关闭
      const modalClosed = await this.page.evaluate(() => {
        const modals = document.querySelectorAll('.modal, [role="dialog"]');
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return false;
          }
        }
        return true;
      });

      if (modalClosed) {
        await delay(500);
        return;
      }
    }

    // 如果还是没关闭，刷新页面
    console.log('  [Warning] Modal未关闭，刷新页面...');
    await this.page.reload({ waitUntil: 'networkidle0' });
    await delay(2000);
  }

  // 确保没有modal打开
  async ensureNoModal() {
    const hasModal = await this.page.evaluate(() => {
      const modals = document.querySelectorAll('.modal, [role="dialog"]');
      for (const modal of modals) {
        const style = window.getComputedStyle(modal);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return true;
        }
      }
      return false;
    });

    if (hasModal) {
      await this.closeModal();
    }
  }

  async getSelectOptions(index) {
    return await this.page.evaluate((idx) => {
      // 更全面的modal检测
      const modals = document.querySelectorAll('.modal, [role="dialog"]');
      let container = document;

      for (const modal of modals) {
        const style = window.getComputedStyle(modal);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          container = modal;
          break;
        }
      }

      const selects = container.querySelectorAll('select');
      if (selects.length <= idx) return [];

      return Array.from(selects[idx].options)
        .filter(o => !o.disabled && o.value && o.text.trim())
        .map(o => ({ value: o.value, text: o.text.trim() }));
    }, index);
  }

  // 等待select出现并有选项
  async waitForSelectWithOptions(index, timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const options = await this.getSelectOptions(index);
      if (options.length > 0) return options;
      await delay(300);
    }
    return [];
  }

  // 等待select内容变化（用于确保页面已更新）
  async waitForSelectChange(index, previousOptions, timeout = 5000) {
    const startTime = Date.now();
    const prevTexts = previousOptions.map(o => o.text).sort().join(',');

    while (Date.now() - startTime < timeout) {
      const currentOptions = await this.getSelectOptions(index);
      const currTexts = currentOptions.map(o => o.text).sort().join(',');

      // 如果选项发生变化，返回新选项
      if (currTexts !== prevTexts && currentOptions.length > 0) {
        return currentOptions;
      }
      await delay(300);
    }

    // 超时后返回当前选项
    return await this.getSelectOptions(index);
  }

  // 等待新页面加载（通过检测select数量或内容变化）
  async waitForNewPage(timeout = 5000) {
    await delay(1000);
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const ready = await this.page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
        if (!modal) return false;

        const selects = modal.querySelectorAll('select');
        if (selects.length === 0) return false;

        // 检查第一个select是否有有效选项
        const firstSelect = selects[0];
        const validOptions = Array.from(firstSelect.options).filter(o =>
          !o.disabled && o.value && o.text.trim() && o.text.trim() !== '選択してください'
        );

        return validOptions.length > 0;
      });

      if (ready) return true;
      await delay(300);
    }
    return false;
  }

  async selectOption(index, value) {
    const result = await this.page.evaluate((idx, val) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;
      const selects = container.querySelectorAll('select');

      if (selects.length <= idx) return { success: false, error: 'Select not found' };

      const select = selects[idx];
      for (const option of select.options) {
        if (option.value === val || option.text.trim() === val) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
      }
      return { success: false, error: 'Option not found' };
    }, index, value);

    await delay(500);
    return result.success;
  }

  async clickButton(text) {
    const clicked = await this.page.evaluate((txt) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;
      const buttons = container.querySelectorAll('button, input[type="button"]');

      for (const btn of buttons) {
        if (btn.textContent?.trim() === txt || btn.value === txt) {
          btn.click();
          return true;
        }
      }
      return false;
    }, text);
    await delay(500);
    return clicked;
  }

  // ========== 第1层：探索所有地方 ==========
  async exploreRegions() {
    console.log('\n[BFS] === 第1层：探索地方 ===');

    await this.openLineGuide();
    await delay(1500);

    const options = await this.getSelectOptions(0);
    this.explored.regions = options
      .filter(o => o.text !== '選択してください')
      .map(o => o.text);

    console.log(`[BFS] 発見した地方: ${this.explored.regions.join(', ')}`);

    await this.closeModal();
    return this.explored.regions;
  }

  // ========== 第2层：探索所有都道府県 ==========
  async explorePrefectures() {
    console.log('\n[BFS] === 第2层：探索都道府県 ===');

    for (const region of this.explored.regions) {
      if (isTimeout()) {
        console.log('[BFS] 时间到，停止探索');
        return;
      }

      console.log(`\n[BFS] 地方: ${region}`);

      await this.openLineGuide();
      await delay(1500);

      // 选择地方
      if (!await this.selectOption(0, region)) {
        console.log(`  ⚠ ${region} 選択失敗`);
        await this.closeModal();
        continue;
      }
      await delay(800);

      // 获取都道府県列表
      const prefOptions = await this.getSelectOptions(1);
      const prefectures = prefOptions
        .filter(o => o.text !== '選択してください')
        .map(o => o.text);

      this.explored.prefectures[region] = prefectures;
      this.stats.regionsExplored++;

      console.log(`  都道府県: ${prefectures.join(', ')}`);

      await this.closeModal();
      await delay(500);
    }
  }

  // ========== 第3层：探索所有カナ行 ==========
  async exploreKanaRows() {
    console.log('\n[BFS] === 第3层：探索カナ行 ===');

    for (const [region, prefectures] of Object.entries(this.explored.prefectures)) {
      for (const prefecture of prefectures) {
        if (isTimeout()) {
          console.log('[BFS] 时间到，停止探索');
          return;
        }

        console.log(`\n[BFS] ${region} > ${prefecture}`);

        // 重试最多3次
        let kanaRows = [];
        for (let retry = 0; retry < 3; retry++) {
          try {
            // 确保没有残留的modal
            await this.ensureNoModal();
            await delay(500);

            await this.openLineGuide();
            await delay(2000);

            // 等待第一个select出现
            const regionOptions = await this.waitForSelectWithOptions(0, 3000);
            if (regionOptions.length === 0) {
              console.log(`  [retry ${retry + 1}] 地方select未出现`);
              await this.closeModal();
              await delay(1000);
              continue;
            }

            // 验证是否是地方选择画面（应该包含東日本等）
            const isRegionSelect = regionOptions.some(o =>
              ['東日本', '中部圏', '近畿圏', '西日本'].includes(o.text)
            );
            if (!isRegionSelect) {
              console.log(`  [retry ${retry + 1}] 不是地方選択画面，重新打开`);
              await this.closeModal();
              await delay(1000);
              continue;
            }

            // 选择地方
            if (!await this.selectOption(0, region)) {
              console.log(`  [retry ${retry + 1}] 地方選択失敗`);
              await this.closeModal();
              await delay(1000);
              continue;
            }
            await delay(800);

            // 等待都道府県select更新
            await this.waitForSelectWithOptions(1, 2000);

            if (!await this.selectOption(1, prefecture)) {
              console.log(`  [retry ${retry + 1}] 都道府県選択失敗`);
              await this.closeModal();
              await delay(1000);
              continue;
            }
            await delay(800);

            // 点击次へ
            if (!await this.clickButton('次へ')) {
              console.log(`  [retry ${retry + 1}] 次へ失敗`);
              await this.closeModal();
              await delay(1000);
              continue;
            }
            await delay(2000);

            // 等待カナ行select出现
            const kanaOptions = await this.waitForSelectWithOptions(0, 3000);
            kanaRows = kanaOptions
              .filter(o => o.text !== '選択してください')
              .map(o => o.text);

            if (kanaRows.length > 0) {
              break; // 成功
            } else {
              console.log(`  [retry ${retry + 1}] カナ行が空`);
              await this.closeModal();
              await delay(1000);
            }
          } catch (err) {
            console.log(`  [retry ${retry + 1}] エラー: ${err.message}`);
            await this.closeModal();
            await delay(1000);
          }
        }

        if (kanaRows.length > 0) {
          this.explored.kanaRows[prefecture] = kanaRows;
          this.stats.prefecturesExplored++;
          console.log(`  カナ行: ${kanaRows.join(', ')}`);
        } else {
          console.log(`  ⚠ カナ行取得失敗`);
          this.stats.errors++;
        }

        await this.closeModal();
        await delay(500);
      }
    }
  }

  // ========== 第4层：探索所有路線 ==========
  async exploreLines() {
    console.log('\n[BFS] === 第4层：探索路線 ===');

    let lastLinesHash = '';

    for (const [region, prefectures] of Object.entries(this.explored.prefectures)) {
      for (const prefecture of prefectures) {
        const kanaRows = this.explored.kanaRows[prefecture] || [];

        for (const kana of kanaRows) {
          if (isTimeout()) {
            console.log('[BFS] 时间到，停止探索');
            return;
          }

          console.log(`\n[BFS] ${prefecture} > ${kana}`);

          let lines = [];
          for (let retry = 0; retry < 3; retry++) {
            try {
              await this.ensureNoModal();
              await delay(500);

              await this.openLineGuide();
              await delay(2000);

              await this.waitForSelectWithOptions(0, 3000);
              if (!await this.selectOption(0, region)) {
                console.log(`  [retry ${retry + 1}] 地方選択失敗`);
                await this.closeModal();
                continue;
              }
              await delay(1000);

              await this.waitForSelectWithOptions(1, 2000);
              if (!await this.selectOption(1, prefecture)) {
                console.log(`  [retry ${retry + 1}] 都道府県選択失敗`);
                await this.closeModal();
                continue;
              }
              await delay(1000);

              // 记录当前select状态
              const beforeClick = await this.getSelectOptions(1);

              if (!await this.clickButton('次へ')) {
                console.log(`  [retry ${retry + 1}] 次へ失敗`);
                await this.closeModal();
                continue;
              }

              // 等待页面更新
              await this.waitForNewPage(5000);
              await delay(1500);

              // 选择カナ行
              const kanaOptions = await this.waitForSelectWithOptions(0, 3000);
              if (kanaOptions.length === 0) {
                console.log(`  [retry ${retry + 1}] カナ行select未出現`);
                await this.closeModal();
                continue;
              }

              if (!await this.selectOption(0, kana)) {
                console.log(`  [retry ${retry + 1}] カナ行選択失敗`);
                await this.closeModal();
                continue;
              }
              await delay(1500);

              // 获取路線列表 - 使用waitForSelectChange确保数据已更新
              const lineOptions = await this.waitForSelectChange(1, beforeClick, 5000);
              lines = lineOptions
                .filter(o => o.text !== '選択してください')
                .map(o => o.text);

              // 数据验证
              const currentHash = lines.slice(0, 3).join(',');
              if (lines.length > 0 && currentHash === lastLinesHash) {
                console.log(`  [retry ${retry + 1}] ⚠ 检测到重复数据，重试...`);
                await this.closeModal();
                await delay(1000);
                continue;
              }

              if (lines.length > 0) {
                lastLinesHash = currentHash;
                break;
              }

              console.log(`  [retry ${retry + 1}] 路線リスト空`);
              await this.closeModal();
              await delay(500);
            } catch (err) {
              console.log(`  [retry ${retry + 1}] エラー: ${err.message}`);
              await this.closeModal();
              await delay(500);
            }
          }

          const key = `${prefecture}_${kana}`;
          this.explored.lines[key] = lines;

          if (lines.length > 0) {
            console.log(`  ✓ 路線(${lines.length}): ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? '...' : ''}`);
          } else {
            console.log(`  ✗ 路線取得失敗`);
            this.stats.errors++;
          }

          await this.closeModal();
          await delay(800);
        }
      }
    }
  }

  // ========== 第5层：探索所有駅 ==========
  async exploreStations() {
    console.log('\n[BFS] === 第5层：探索駅 ===');

    // 用于检测重复数据的缓存
    let lastStationsHash = '';

    for (const [region, prefectures] of Object.entries(this.explored.prefectures)) {
      for (const prefecture of prefectures) {
        const kanaRows = this.explored.kanaRows[prefecture] || [];

        for (const kana of kanaRows) {
          const key = `${prefecture}_${kana}`;
          const lines = this.explored.lines[key] || [];

          for (const lineName of lines) {
            if (isTimeout()) {
              console.log('[BFS] 时间到，停止探索');
              return;
            }

            // 检查是否已在数据库中
            const existing = await this.checkLineInDB(prefecture, lineName);
            if (existing) {
              console.log(`  [SKIP] ${lineName} (already in DB)`);
              continue;
            }

            console.log(`\n[BFS] ${prefecture} > ${lineName}`);

            let stations = [];
            for (let retry = 0; retry < 3; retry++) {
              try {
                await this.ensureNoModal();
                await delay(500);

                await this.openLineGuide();
                await delay(2000);

                // 第一页：选择地方和都道府県
                await this.waitForSelectWithOptions(0, 3000);
                if (!await this.selectOption(0, region)) {
                  console.log(`  [retry ${retry + 1}] 地方選択失敗`);
                  await this.closeModal();
                  continue;
                }
                await delay(1000);

                await this.waitForSelectWithOptions(1, 2000);
                if (!await this.selectOption(1, prefecture)) {
                  console.log(`  [retry ${retry + 1}] 都道府県選択失敗`);
                  await this.closeModal();
                  continue;
                }
                await delay(1000);

                // 记录当前select状态
                const beforeClick1 = await this.getSelectOptions(0);

                if (!await this.clickButton('次へ')) {
                  console.log(`  [retry ${retry + 1}] 次へ(1)失敗`);
                  await this.closeModal();
                  continue;
                }

                // 等待页面更新 - 关键修复点
                await this.waitForNewPage(5000);
                await delay(1500);

                // 第二页：选择カナ行和路線
                const kanaOptions = await this.waitForSelectWithOptions(0, 3000);
                if (kanaOptions.length === 0) {
                  console.log(`  [retry ${retry + 1}] カナ行select未出現`);
                  await this.closeModal();
                  continue;
                }

                if (!await this.selectOption(0, kana)) {
                  console.log(`  [retry ${retry + 1}] カナ行選択失敗`);
                  await this.closeModal();
                  continue;
                }
                await delay(1000);

                // 等待路線select更新
                const lineOptions = await this.waitForSelectWithOptions(1, 3000);
                if (lineOptions.length === 0) {
                  console.log(`  [retry ${retry + 1}] 路線select未出現`);
                  await this.closeModal();
                  continue;
                }

                if (!await this.selectOption(1, lineName)) {
                  console.log(`  [retry ${retry + 1}] 路線選択失敗`);
                  await this.closeModal();
                  continue;
                }
                await delay(1000);

                // 记录当前路線select的状态
                const beforeClick2 = await this.getSelectOptions(1);

                if (!await this.clickButton('次へ')) {
                  console.log(`  [retry ${retry + 1}] 次へ(2)失敗`);
                  await this.closeModal();
                  continue;
                }

                // 等待第三页加载 - 关键修复点
                await this.waitForNewPage(5000);
                await delay(1500);

                // 第三页：获取駅列表
                // 使用waitForSelectChange确保数据已更新
                const stationOptions = await this.waitForSelectChange(0, beforeClick2, 5000);

                stations = stationOptions
                  .filter(o => o.text !== '選択してください')
                  .map(o => o.text);

                // 数据验证：检查是否与上次完全相同（可能是污染数据）
                const currentHash = stations.slice(0, 5).join(',');
                if (stations.length > 0 && currentHash === lastStationsHash) {
                  console.log(`  [retry ${retry + 1}] ⚠ 检测到重复数据，重试...`);
                  await this.closeModal();
                  await delay(1000);
                  continue;
                }

                if (stations.length > 0) {
                  lastStationsHash = currentHash;
                  break;
                }

                console.log(`  [retry ${retry + 1}] 駅リスト空`);
                await this.closeModal();
                await delay(500);
              } catch (err) {
                console.log(`  [retry ${retry + 1}] エラー: ${err.message}`);
                await this.closeModal();
                await delay(500);
              }
            }

            if (stations.length > 0) {
              const stationKey = `${prefecture}_${lineName}`;
              this.explored.stations[stationKey] = stations;
              this.stats.linesExplored++;
              this.stats.stationsCollected += stations.length;

              console.log(`  ✓ 駅(${stations.length}): ${stations.slice(0, 5).join(', ')}${stations.length > 5 ? '...' : ''}`);

              // 保存到数据库
              await this.saveLineToDB(region, prefecture, lineName, stations);
            } else {
              console.log(`  ✗ 駅取得失敗`);
              this.stats.errors++;
            }

            await this.closeModal();
            await delay(800);
          }
        }
      }
    }
  }

  // 检查路線是否已在数据库中
  async checkLineInDB(prefecture, lineName) {
    const count = await db('lines')
      .where({ prefecture, line_name: lineName })
      .count('* as cnt')
      .first();
    return count && count.cnt > 0;
  }

  // 保存路線到数据库
  async saveLineToDB(region, prefecture, lineName, stations) {
    let saved = 0;
    for (let i = 0; i < stations.length; i++) {
      try {
        await db('lines').insert({
          region,
          prefecture,
          line_name: lineName,
          station: stations[i],
          station_order: i
        });
        saved++;
      } catch (error) {
        // 忽略重复
        if (!error.message.includes('UNIQUE constraint')) {
          console.error(`  Error: ${error.message}`);
        }
      }
    }
    if (saved > 0) {
      console.log(`  ✓ DB保存: ${lineName} (${saved}駅)`);
    }
  }

  // 打印统计信息
  printStats() {
    console.log('\n' + '='.repeat(60));
    console.log('探索統計');
    console.log('='.repeat(60));
    console.log(`実行時間: ${getElapsedTime()}`);
    console.log(`地方: ${this.stats.regionsExplored}`);
    console.log(`都道府県: ${this.stats.prefecturesExplored}`);
    console.log(`路線: ${this.stats.linesExplored}`);
    console.log(`駅: ${this.stats.stationsCollected}`);
    console.log(`エラー: ${this.stats.errors}`);
    console.log('='.repeat(60));
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
    await db.destroy();
  }

  async run() {
    try {
      await this.initialize();
      await this.login();
      await this.navigateToRentalSearch();

      console.log(`\n[BFS] 開始時刻: ${new Date().toLocaleString()}`);
      console.log(`[BFS] 制限時間: 30分`);

      // 广度优先探索
      // 第1层
      if (!isTimeout()) await this.exploreRegions();

      // 第2层
      if (!isTimeout()) await this.explorePrefectures();

      // 第3层
      if (!isTimeout()) await this.exploreKanaRows();

      // 第4层
      if (!isTimeout()) await this.exploreLines();

      // 第5层
      if (!isTimeout()) await this.exploreStations();

      this.printStats();

      console.log('\n[BFS] 探索完了！');
      console.log(`[BFS] 終了時刻: ${new Date().toLocaleString()}`);

    } catch (error) {
      console.error('[BFS] Error:', error);
      await this.page?.screenshot({ path: 'error-bfs-explore.png' });
    } finally {
      await this.close();
    }
  }
}

// 执行
const explorer = new BFSLineExplorer();
explorer.run();
