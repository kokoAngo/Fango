/**
 * 深度优先探索REINS沿线数据
 * 每条路線完成后立即保存到数据库
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

function isTimeout() {
  return Date.now() - startTime >= MAX_RUNTIME_MS;
}

function getElapsedTime() {
  const elapsed = Date.now() - startTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  return `${minutes}分${seconds}秒`;
}

class DFSLineExplorer {
  constructor() {
    this.browser = null;
    this.page = null;
    this.stats = {
      linesExplored: 0,
      stationsCollected: 0,
      skipped: 0,
      errors: 0
    };
  }

  async initialize() {
    console.log('[DFS] Initializing...');
    await initDatabase();
    await this.launchBrowser();
  }

  async launchBrowser() {
    const chromePath = process.env.CHROME_PATH ||
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

    this.browser = await puppeteer.launch({
      headless: false,  // 非headless更稳定
      defaultViewport: { width: 1400, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: chromePath
    });
    this.page = await this.browser.newPage();
    console.log('[DFS] Browser launched');
  }

  async restartBrowser() {
    console.log('    [!] Modal問題発生、ブラウザ再起動...');
    try {
      if (this.browser) await this.browser.close();
    } catch (e) { /* ignore */ }
    await delay(1000);
    await this.launchBrowser();
    await this.login();
    await this.navigateToRentalSearch();
  }

  async login() {
    console.log('[DFS] Logging in to REINS...');
    await this.page.goto('https://system.reins.jp/login/main/KG/GKG001200', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

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

    console.log('[DFS] Login successful');
  }

  async navigateToRentalSearch() {
    await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('賃貸') && btn.textContent?.includes('物件検索')) {
          btn.click();
          return;
        }
      }
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
    for (let i = 0; i < 3; i++) {
      await this.page.evaluate(() => {
        const closeSelectors = [
          '.modal .close', '.modal .btn-close',
          '.modal [data-dismiss="modal"]', '.modal-header button'
        ];
        for (const selector of closeSelectors) {
          const btn = document.querySelector(selector);
          if (btn) { btn.click(); return; }
        }
        const buttons = document.querySelectorAll('.modal button');
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if (text === 'キャンセル' || text === '閉じる' || text === '×') {
            btn.click();
            return;
          }
        }
        // ESC键
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27 }));
      });
      await delay(800);

      const closed = await this.page.evaluate(() => {
        const modals = document.querySelectorAll('.modal, [role="dialog"]');
        for (const modal of modals) {
          const style = window.getComputedStyle(modal);
          if (style.display !== 'none' && style.visibility !== 'hidden') return false;
        }
        return true;
      });

      if (closed) {
        await delay(300);
        return;
      }
    }
    // 如果还没关闭，重启浏览器
    await this.restartBrowser();
  }

  async ensureOnRentalSearch() {
    // 检查是否在租赁搜索页面
    const hasGuideButton = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === '入力ガイド') return true;
      }
      return false;
    });

    if (!hasGuideButton) {
      await this.navigateToRentalSearch();
    }
  }

  async getSelectOptions(index) {
    return await this.page.evaluate((idx) => {
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

  async waitForSelect(index, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const options = await this.getSelectOptions(index);
      if (options.length > 0) return options;
      await delay(300);
    }
    return [];
  }

  // 等待select内容变化（确保页面已更新）
  async waitForSelectChange(index, previousOptions, timeout = 5000) {
    const startTime = Date.now();
    const prevTexts = previousOptions.map(o => o.text).sort().join(',');

    while (Date.now() - startTime < timeout) {
      const currentOptions = await this.getSelectOptions(index);
      const currTexts = currentOptions.map(o => o.text).sort().join(',');

      if (currTexts !== prevTexts && currentOptions.length > 0) {
        return currentOptions;
      }
      await delay(300);
    }
    return await this.getSelectOptions(index);
  }

  // 等待新页面加载完成
  async waitForNewPage(timeout = 5000) {
    await delay(1000);
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const ready = await this.page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
        if (!modal) return false;
        const selects = modal.querySelectorAll('select');
        if (selects.length === 0) return false;
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
      if (selects.length <= idx) return false;
      const select = selects[idx];
      for (const option of select.options) {
        if (option.value === val || option.text.trim() === val) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, index, value);
    await delay(500);
    return result;
  }

  async clickButton(text) {
    const clicked = await this.page.evaluate((txt) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]');
      const container = modal || document;
      const buttons = container.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === txt) {
          btn.click();
          return true;
        }
      }
      return false;
    }, text);
    await delay(500);
    return clicked;
  }

  async checkLineInDB(prefecture, lineName) {
    const count = await db('lines')
      .where({ prefecture, line_name: lineName })
      .count('* as cnt')
      .first();
    return count && count.cnt > 0;
  }

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
        if (!error.message.includes('UNIQUE constraint')) {
          console.error(`    DB Error: ${error.message}`);
        }
      }
    }
    return saved;
  }

  // 深度优先：完整探索一条路線
  async exploreOneLine(region, prefecture, kana, lineName) {
    // 检查是否已在DB
    if (await this.checkLineInDB(prefecture, lineName)) {
      return { skipped: true };
    }

    try {
      await this.ensureOnRentalSearch();
      await this.closeModal();
      await delay(500);
      await this.openLineGuide();
      await delay(2000);

      // 验证是地方选择画面
      const regionOpts = await this.waitForSelect(0, 3000);
      const isRegionScreen = regionOpts.some(o =>
        ['東日本', '中部圏', '近畿圏', '西日本'].includes(o.text)
      );
      if (!isRegionScreen) {
        await this.closeModal();
        return { error: '不是地方選択画面' };
      }

      // 选择地方
      if (!await this.selectOption(0, region)) {
        await this.closeModal();
        return { error: '地方選択失敗' };
      }
      await delay(800);

      // 选择都道府県
      await this.waitForSelect(1, 2000);
      if (!await this.selectOption(1, prefecture)) {
        await this.closeModal();
        return { error: '都道府県選択失敗' };
      }
      await delay(800);

      // 记录当前select状态
      const beforeClick1 = await this.getSelectOptions(1);

      // 次へ
      if (!await this.clickButton('次へ')) {
        await this.closeModal();
        return { error: '次へ失敗(1)' };
      }

      // 等待页面更新
      await this.waitForNewPage(5000);
      await delay(1000);

      // 选择カナ行
      const kanaOpts = await this.waitForSelect(0, 3000);
      if (kanaOpts.length === 0) {
        await this.closeModal();
        return { error: 'カナ行select未出現' };
      }
      if (!await this.selectOption(0, kana)) {
        await this.closeModal();
        return { error: 'カナ行選択失敗' };
      }
      await delay(1000);

      // 选择路線
      const lineOpts = await this.waitForSelect(1, 3000);
      if (lineOpts.length === 0) {
        await this.closeModal();
        return { error: '路線select未出現' };
      }
      if (!await this.selectOption(1, lineName)) {
        await this.closeModal();
        return { error: '路線選択失敗' };
      }
      await delay(800);

      // 记录当前路線select状态
      const beforeClick2 = await this.getSelectOptions(1);

      // 次へ进入駅选择
      if (!await this.clickButton('次へ')) {
        await this.closeModal();
        return { error: '次へ失敗(2)' };
      }

      // 等待页面更新 - 关键修复点
      await this.waitForNewPage(5000);
      await delay(1000);

      // 获取駅列表 - 使用waitForSelectChange确保数据已更新
      const stationOpts = await this.waitForSelectChange(0, beforeClick2, 5000);
      const stations = stationOpts
        .filter(o => o.text !== '選択してください')
        .map(o => o.text);

      await this.closeModal();

      if (stations.length === 0) {
        return { error: '駅が取得できない' };
      }

      // 保存到数据库
      const saved = await this.saveLineToDB(region, prefecture, lineName, stations);

      return { success: true, stations: stations.length, saved };

    } catch (err) {
      await this.closeModal();
      return { error: err.message };
    }
  }

  // 深度优先主循环
  async runDFS() {
    console.log('\n[DFS] 深度优先探索開始');
    console.log(`[DFS] 開始時刻: ${new Date().toLocaleString()}`);
    console.log(`[DFS] 制限時間: 30分\n`);

    // 优先探索的主要都市圏（按优先级排序）
    const priorityList = [
      { region: '東日本', prefecture: '東京都' },
      { region: '近畿圏', prefecture: '大阪府' },
      { region: '近畿圏', prefecture: '京都府' },
      { region: '東日本', prefecture: '神奈川県' },
      { region: '東日本', prefecture: '埼玉県' },
      { region: '中部圏', prefecture: '愛知県' },
      { region: '東日本', prefecture: '千葉県' },
      { region: '近畿圏', prefecture: '兵庫県' },
      { region: '西日本', prefecture: '福岡県' },
      { region: '東日本', prefecture: '北海道' },
    ];

    // 其他地方列表（优先列表之后）
    const regions = [
      { name: '東日本', prefectures: ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '新潟県', '山梨県', '長野県'] },
      { name: '中部圏', prefectures: ['富山県', '石川県', '福井県', '岐阜県', '静岡県', '三重県'] },
      { name: '近畿圏', prefectures: ['滋賀県', '奈良県', '和歌山県'] },
      { name: '西日本', prefectures: ['鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'] }
    ];

    // 先探索优先列表
    console.log('【優先都市圏を探索】\n');
    for (const item of priorityList) {
      if (isTimeout()) break;
      await this.explorePrefecture(item.region, item.prefecture);
    }

    // 再探索其他地方
    if (!isTimeout()) {
      console.log('\n【その他の地域を探索】\n');
      for (const region of regions) {
        if (isTimeout()) break;
        for (const prefecture of region.prefectures) {
          if (isTimeout()) break;
          await this.explorePrefecture(region.name, prefecture);
        }
      }
    }
  }

  // 探索单个都道府県
  async explorePrefecture(regionName, prefecture) {
    console.log(`\n=== ${regionName} > ${prefecture} ===`);

    // 确保在正确页面
    await this.ensureOnRentalSearch();

    // 获取カナ行列表
    await this.closeModal();
    await delay(500);
    await this.openLineGuide();
    await delay(2000);

    let kanaRows = [];
    const regionOpts = await this.waitForSelect(0, 3000);
    if (regionOpts.some(o => ['東日本', '中部圏', '近畿圏', '西日本'].includes(o.text))) {
      await this.selectOption(0, regionName);
      await delay(1000);
      await this.waitForSelect(1, 2000);
      await this.selectOption(1, prefecture);
      await delay(1000);

      // 记录当前状态
      const beforeClick = await this.getSelectOptions(1);

      await this.clickButton('次へ');
      await this.waitForNewPage(5000);
      await delay(1000);

      // 使用waitForSelectChange确保数据已更新
      const kanaOpts = await this.waitForSelectChange(0, beforeClick, 5000);
      kanaRows = kanaOpts
        .filter(o => o.text !== '選択してください')
        .map(o => o.text);
    }
    await this.closeModal();

    if (kanaRows.length === 0) {
      console.log('  カナ行取得失敗、スキップ');
      return;
    }

    console.log(`  カナ行: ${kanaRows.join(', ')}`);

    // 遍历每个カナ行
    for (const kana of kanaRows) {
      if (isTimeout()) break;

      // 获取路線列表
      await this.ensureOnRentalSearch();
      await this.closeModal();
      await delay(500);
      await this.openLineGuide();
      await delay(2000);

      let lines = [];
      const opts = await this.waitForSelect(0, 3000);
      if (opts.some(o => ['東日本', '中部圏', '近畿圏', '西日本'].includes(o.text))) {
        await this.selectOption(0, regionName);
        await delay(800);
        await this.waitForSelect(1, 2000);
        await this.selectOption(1, prefecture);
        await delay(800);

        // 记录当前状态
        const beforeClick1 = await this.getSelectOptions(1);

        await this.clickButton('次へ');
        await this.waitForNewPage(5000);
        await delay(1000);

        // 等待カナ行更新
        await this.waitForSelectChange(0, beforeClick1, 3000);
        await this.selectOption(0, kana);
        await delay(1200);

        const lineOpts = await this.waitForSelect(1, 3000);
        lines = lineOpts
          .filter(o => o.text !== '選択してください')
          .map(o => o.text);
      }
      await this.closeModal();

      if (lines.length === 0) continue;

      console.log(`\n  [${kana}] ${lines.length}路線: ${lines.slice(0, 3).join(', ')}${lines.length > 3 ? '...' : ''}`);

      // 遍历每条路線（深度优先核心）
      for (const lineName of lines) {
        if (isTimeout()) break;

        let result;
        try {
          result = await this.exploreOneLine(regionName, prefecture, kana, lineName);
        } catch (err) {
          // 浏览器崩溃，重启
          if (err.message.includes('Session closed') || err.message.includes('Target closed') || err.message.includes('Protocol error')) {
            console.log(`\n    [!] ブラウザ再起動中...`);
            try {
              await this.restartBrowser();
              result = { error: 'ブラウザ再起動' };
            } catch (restartErr) {
              console.log(`    [!] 再起動失敗: ${restartErr.message}`);
              result = { error: '再起動失敗' };
            }
          } else {
            result = { error: err.message };
          }
        }

        if (result.skipped) {
          process.stdout.write('.');
          this.stats.skipped++;
        } else if (result.success) {
          console.log(`    ✓ ${lineName}: ${result.stations}駅`);
          this.stats.linesExplored++;
          this.stats.stationsCollected += result.stations;
        } else {
          console.log(`    ✗ ${lineName}: ${result.error}`);
          this.stats.errors++;
        }
      }
    }
  }

  async close() {
    try {
      if (this.browser) {
        await delay(1000);
        await this.browser.close();
      }
    } catch (e) {
      console.log('[DFS] Browser close warning:', e.message);
    }
    try {
      await db.destroy();
    } catch (e) {
      // ignore
    }
  }

  async run() {
    try {
      await this.initialize();
      await this.login();
      await this.navigateToRentalSearch();

      await this.runDFS();

      console.log('\n\n' + '='.repeat(50));
      console.log('探索統計');
      console.log('='.repeat(50));
      console.log(`実行時間: ${getElapsedTime()}`);
      console.log(`新規路線: ${this.stats.linesExplored}`);
      console.log(`新規駅数: ${this.stats.stationsCollected}`);
      console.log(`スキップ: ${this.stats.skipped} (既存)`);
      console.log(`エラー: ${this.stats.errors}`);
      console.log('='.repeat(50));

    } catch (error) {
      console.error('[DFS] Error:', error);
    } finally {
      await this.close();
    }
  }
}

const explorer = new DFSLineExplorer();
explorer.run();
