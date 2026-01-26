/**
 * REINS 所在地 DFS 探索脚本
 *
 * 使用深度优先搜索遍历 REINS 所在地层级列表，并将结果存入数据库
 * 层级结构: 地方 → 都道府県 → 地域区分 → 市区町村 → 町丁目
 *
 * 优先探索: 大阪府, 福岡県, 愛知県, 北海道
 *
 * 运行: node scripts/explore-locations-dfs.js
 * 1小时后自动停止
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const { db, initDatabase } = require('../db/connection');

// 配置
const CONFIG = {
  REINS_LOGIN_URL: 'https://system.reins.jp/login/main/KG/GKG001200',
  SEARCH_URL: 'https://system.reins.jp/main/KG/GKG003100',
  MAX_RUNTIME_MS: 60 * 60 * 1000, // 1小时
  PAGE_DELAY: 1500,
  MODAL_DELAY: 2000,
};

// 优先探索的都道府県（按优先级排序）
const PRIORITY_PREFECTURES = [
  { prefecture: '福岡県', region: '西日本' },
  { prefecture: '北海道', region: '東日本' },
];

// 未完成的city级别任务（手动补充）
const INCOMPLETE_CITIES = [
  { region: '近畿圏', prefecture: '大阪府', city: '堺市' },
  { region: '近畿圏', prefecture: '大阪府', city: 'その他地域' },
];

class LocationExplorerDFS {
  constructor() {
    this.browser = null;
    this.page = null;
    this.startTime = null;
    this.stats = {
      prefecturesExplored: 0,
      citiesExplored: 0,
      wardsExplored: 0,
      townsAdded: 0,
      errors: 0
    };
    this.stack = []; // DFS 栈
  }

  isTimeout() {
    return Date.now() - this.startTime >= CONFIG.MAX_RUNTIME_MS;
  }

  printProgress() {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000 / 60);
    const remaining = Math.floor((CONFIG.MAX_RUNTIME_MS - (Date.now() - this.startTime)) / 1000 / 60);

    console.log('\n' + '='.repeat(60));
    console.log(`📊 探索進捗 (経過: ${elapsed}分, 残り: ${remaining}分)`);
    console.log('='.repeat(60));
    console.log(`  都道府県: ${this.stats.prefecturesExplored}`);
    console.log(`  地域区分: ${this.stats.citiesExplored}`);
    console.log(`  市区町村: ${this.stats.wardsExplored}`);
    console.log(`  町丁目追加: ${this.stats.townsAdded}`);
    console.log(`  エラー: ${this.stats.errors}`);
    console.log(`  スタック残り: ${this.stack.length}`);
    console.log('='.repeat(60) + '\n');
  }

  async initBrowser() {
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1920, height: 1080 });
  }

  async login() {
    const username = process.env.REINS_USERNAME;
    const password = process.env.REINS_PASSWORD;

    if (!username || !password) {
      throw new Error('REINS_USERNAME と REINS_PASSWORD を .env に設定してください');
    }

    console.log('🔐 REINSにログイン中...');
    await this.page.goto(CONFIG.REINS_LOGIN_URL, {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    await this.delay(5000);
    await this.page.waitForSelector('input', { timeout: 60000 });

    console.log('  認証情報を入力中...');
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
      this.delay(10000)
    ]);

    console.log('✅ ログイン成功');
    await this.delay(2000);
  }

  async navigateToSearchPage() {
    console.log('🔍 賃貸物件検索画面に移動中...');
    await this.delay(3000);

    // Wait for page to be ready
    await this.page.waitForSelector('button', { timeout: 30000 });
    await this.delay(2000);

    const clicked = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('賃貸') && btn.textContent?.includes('物件検索')) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      await this.delay(5000);
      console.log('✅ 賃貸物件検索画面に到達');
    } else {
      console.log('⚠️ 賃貸物件検索ボタンが見つかりません');
    }
  }

  async ensurePageValid() {
    try {
      const url = await this.page.url();
      if (!url.includes('GKG003') && !url.includes('reins.jp')) {
        console.log('  ⚠️ ページが無効、再ナビゲート...');
        await this.navigateToSearchPage();
        return false;
      }
      return true;
    } catch (error) {
      console.log('  ⚠️ ページ状態エラー、ブラウザ再起動...');
      await this.restartBrowser();
      return false;
    }
  }

  async restartBrowser() {
    console.log('\n🔄 ブラウザを再起動中...');
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (e) {}

    this.browser = null;
    this.page = null;
    await this.delay(3000);

    await this.initBrowser();
    await this.login();
    await this.navigateToSearchPage();

    console.log('✅ ブラウザ再起動完了\n');
  }

  async openLocationGuide() {
    console.log('  🔄 ページリロード...');
    await this.page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
    await this.delay(2000);

    const isValid = await this.ensurePageValid();
    if (!isValid) {
      await this.navigateToSearchPage();
      await this.delay(2000);
    }

    const clicked = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === '入力ガイド') {
          const parent = btn.closest('tr, div, td');
          if (parent?.textContent?.includes('都道府県') || parent?.textContent?.includes('所在地')) {
            btn.click();
            return true;
          }
        }
      }
      for (const btn of buttons) {
        if (btn.textContent?.trim() === '入力ガイド') {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) {
      throw new Error('入力ガイドボタンが見つかりません');
    }

    await this.delay(CONFIG.MODAL_DELAY + 500);

    await this.page.waitForSelector('.modal.show select, .modal[style*="display: block"] select, [role="dialog"] select', {
      timeout: 10000
    }).catch(() => console.log('  ⚠️ select要素の待機タイムアウト'));

    const isScreen1 = await this.verifyScreen1();
    if (!isScreen1) {
      throw new Error('画面1の検証に失敗しました');
    }
  }

  async verifyScreen1() {
    const info = await this.page.evaluate(() => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]') || document;
      const selects = modal.querySelectorAll('select');
      if (!selects[0]) return { isScreen1: false, options: [] };

      const firstOptions = Array.from(selects[0].options).map(o => o.text?.trim()).filter(t => t);
      const isScreen1 = firstOptions.some(opt =>
        opt.includes('東日本') || opt.includes('中部圏') || opt.includes('近畿圏') || opt.includes('西日本')
      );

      return { isScreen1, options: firstOptions.slice(0, 10) };
    });

    if (!info.isScreen1) {
      console.log(`  ⚠️ 画面1ではありません。利用可能: ${info.options.join(', ')}`);
    }
    return info.isScreen1;
  }

  async closeModal() {
    try {
      await this.page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]') || document;
        const buttons = modal.querySelectorAll('button, input[type="button"]');
        for (const btn of buttons) {
          const text = btn.textContent?.trim() || btn.value?.trim();
          if (text === 'キャンセル' || text === '閉じる' || text === 'Cancel' || text === '×') {
            btn.click();
            return;
          }
        }
        const closeBtn = modal.querySelector('button.close, .btn-close, [data-dismiss="modal"]');
        if (closeBtn) closeBtn.click();
      });
      await this.delay(2000);
    } catch (error) {
      console.log('  ⚠️ モーダル閉じエラー（無視）');
      await this.delay(1000);
    }
  }

  async getSelectOptions(selectIndex) {
    return await this.page.evaluate((idx) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]') || document;
      const selects = modal.querySelectorAll('select');
      if (selects[idx]) {
        return Array.from(selects[idx].options)
          .map(opt => opt.text?.trim())
          .filter(text => text && text !== '' && text !== '選択してください' && !text.includes('---'));
      }
      return [];
    }, selectIndex);
  }

  async selectOption(selectIndex, value) {
    const result = await this.page.evaluate((idx, val) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]') || document;
      const selects = modal.querySelectorAll('select');
      if (!selects[idx]) {
        return { success: false, error: `select[${idx}] not found` };
      }

      const options = selects[idx].options;
      for (let i = 0; i < options.length; i++) {
        if (options[i].text?.trim() === val || options[i].text?.includes(val)) {
          selects[idx].selectedIndex = i;
          selects[idx].dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
      }

      return { success: false, error: `"${val}" not found` };
    }, selectIndex, value);

    if (!result.success) {
      console.log(`  ⚠️ selectOption(${selectIndex}, "${value}") 失敗: ${result.error}`);
    }

    await this.delay(CONFIG.PAGE_DELAY);
    return result.success;
  }

  async clickButton(text) {
    const clicked = await this.page.evaluate((btnText) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]') || document;
      const buttons = modal.querySelectorAll('button, input[type="button"], input[type="submit"]');
      for (const btn of buttons) {
        const btnLabel = btn.textContent?.trim() || btn.value?.trim();
        if (btnLabel === btnText || btnLabel?.includes(btnText)) {
          btn.click();
          return true;
        }
      }
      return false;
    }, text);

    await this.delay(CONFIG.MODAL_DELAY);
    return clicked;
  }

  async saveLocation(region, prefecture, city, ward, town) {
    try {
      await db('locations').insert({ region, prefecture, city, ward, town });
      this.stats.townsAdded++;
      return true;
    } catch (error) {
      if (!error.message.includes('UNIQUE constraint') && !error.message.includes('duplicate')) {
        console.error(`  ❌ 保存失敗: ${error.message}`);
        this.stats.errors++;
      }
      return false;
    }
  }

  async isExplored(region, prefecture, city = null, ward = null) {
    const query = db('locations').where({ region, prefecture });
    if (city) query.where('city', city);
    if (ward) query.where('ward', ward);
    const count = await query.count('* as cnt').first();
    return count.cnt > 0;
  }

  /**
   * DFS 探索主逻辑
   */
  async explore() {
    this.startTime = Date.now();

    console.log('\n' + '🚀'.repeat(30));
    console.log('   REINS 所在地 DFS 探索開始');
    console.log('   優先: 福岡県, 北海道 + 大阪府(未完了分)');
    console.log('   最大実行時間: 1時間');
    console.log('🚀'.repeat(30) + '\n');

    await initDatabase();
    console.log('✅ データベース初期化完了');

    await this.initBrowser();
    await this.login();
    await this.navigateToSearchPage();

    // 初始化 DFS 栈 - 按优先级反向加入（后进先出）
    for (let i = PRIORITY_PREFECTURES.length - 1; i >= 0; i--) {
      const { prefecture, region } = PRIORITY_PREFECTURES[i];
      const explored = await this.isExplored(region, prefecture);
      if (!explored) {
        this.stack.push({
          level: 'prefecture',
          region: region,
          prefecture: prefecture,
          city: null,
          ward: null
        });
      } else {
        console.log(`⏭️ ${prefecture}: 既存データあり、スキップ`);
      }
    }

    // 添加未完成的city级别任务（优先处理）
    for (let i = INCOMPLETE_CITIES.length - 1; i >= 0; i--) {
      const { region, prefecture, city } = INCOMPLETE_CITIES[i];
      const explored = await this.isExplored(region, prefecture, city);
      if (!explored) {
        this.stack.push({
          level: 'city',
          region: region,
          prefecture: prefecture,
          city: city,
          ward: null
        });
        console.log(`📋 未完了追加: ${prefecture} > ${city}`);
      } else {
        console.log(`⏭️ ${prefecture} > ${city}: 既存データあり、スキップ`);
      }
    }

    // DFS 主循环
    while (this.stack.length > 0 && !this.isTimeout()) {
      const node = this.stack.pop(); // DFS: 从栈顶取出

      try {
        await this.processNode(node);
      } catch (error) {
        console.error(`  ❌ エラー: ${error.message}`);
        this.stats.errors++;
        await this.page.screenshot({ path: `error-${Date.now()}.png` }).catch(() => {});
        try {
          await this.closeModal();
          await this.delay(2000);
        } catch (e) {}
      }

      // 每处理5个节点打印一次进度
      if ((this.stats.citiesExplored + this.stats.wardsExplored) % 5 === 0 && this.stats.citiesExplored > 0) {
        this.printProgress();
      }
    }

    this.printProgress();
    console.log('\n✅ 探索完了！');

    if (this.isTimeout()) {
      console.log('⏰ 1時間経過により終了しました');
    }
  }

  async processNode(node) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        switch (node.level) {
          case 'prefecture':
            await this.explorePrefectureDFS(node.region, node.prefecture);
            break;
          case 'city':
            await this.exploreCityDFS(node.region, node.prefecture, node.city);
            break;
          case 'ward':
            await this.exploreWardDFS(node.region, node.prefecture, node.city, node.ward);
            break;
        }
        return; // Success, exit retry loop
      } catch (error) {
        console.error(`  ❌ 試行${attempt}/${maxRetries}: ${error.message}`);
        if (attempt < maxRetries) {
          console.log('  🔄 ブラウザ再起動して再試行...');
          await this.restartBrowser();
          await this.delay(3000);
        } else {
          console.error(`  ❌ ${maxRetries}回試行後も失敗: ${node.level} - ${node.prefecture}`);
          this.stats.errors++;
        }
      }
    }
  }

  /**
   * DFS: 探索都道府県 - 立即深入探索所有地域区分
   */
  async explorePrefectureDFS(region, prefecture) {
    console.log(`\n🗾 都道府県探索: ${prefecture} (${region})`);
    this.stats.prefecturesExplored++;

    try {
      await this.openLocationGuide();

      console.log(`  → 地方: ${region}, 都道府県: ${prefecture}`);
      await this.selectOption(0, region);
      await this.selectOption(1, prefecture);
      await this.clickButton('次へ');

      const cityOptions = await this.getSelectOptions(0);
      console.log(`  📋 地域区分: ${cityOptions.length}件 [${cityOptions.slice(0, 3).join(', ')}...]`);

      await this.closeModal();

      // DFS: 反向加入栈（后加入的先处理）
      for (let i = cityOptions.length - 1; i >= 0; i--) {
        this.stack.push({
          level: 'city',
          region: region,
          prefecture: prefecture,
          city: cityOptions[i],
          ward: null
        });
      }
    } catch (error) {
      console.error(`  ❌ ${prefecture} 探索失敗: ${error.message}`);
      this.stats.errors++;
      await this.closeModal().catch(() => {});
    }
  }

  /**
   * DFS: 探索地域区分 - 立即深入探索所有市区町村
   */
  async exploreCityDFS(region, prefecture, city) {
    console.log(`\n🏙️ 地域区分探索: ${prefecture} > ${city}`);
    this.stats.citiesExplored++;

    try {
      await this.openLocationGuide();

      await this.selectOption(0, region);
      await this.selectOption(1, prefecture);
      await this.clickButton('次へ');

      const cityOk = await this.selectOption(0, city);
      if (!cityOk) {
        throw new Error(`地域区分「${city}」の選択に失敗`);
      }
      await this.delay(CONFIG.PAGE_DELAY);

      const wardOptions = await this.getSelectOptions(1);
      console.log(`  📋 市区町村: ${wardOptions.length}件 [${wardOptions.slice(0, 5).join(', ')}...]`);

      await this.closeModal();

      // DFS: 反向加入栈
      for (let i = wardOptions.length - 1; i >= 0; i--) {
        this.stack.push({
          level: 'ward',
          region: region,
          prefecture: prefecture,
          city: city,
          ward: wardOptions[i]
        });
      }
    } catch (error) {
      console.error(`  ❌ ${city} 探索失敗: ${error.message}`);
      this.stats.errors++;
      await this.closeModal().catch(() => {});
    }
  }

  /**
   * DFS: 探索市区町村 - 获取所有町丁目并保存
   */
  async exploreWardDFS(region, prefecture, city, ward) {
    console.log(`\n🏘️ 市区町村探索: ${prefecture} > ${city} > ${ward}`);
    this.stats.wardsExplored++;

    try {
      await this.openLocationGuide();

      await this.selectOption(0, region);
      await this.selectOption(1, prefecture);
      await this.clickButton('次へ');

      await this.selectOption(0, city);
      await this.delay(CONFIG.PAGE_DELAY);
      await this.selectOption(1, ward);
      await this.clickButton('次へ');

      await this.delay(CONFIG.PAGE_DELAY);

      const detailOptions = await this.getSelectOptions(0);
      console.log(`  → 詳細地点: ${detailOptions.length}件`);

      for (const detail of detailOptions) {
        if (this.isTimeout()) break;

        await this.selectOption(0, detail);
        await this.delay(CONFIG.PAGE_DELAY);

        const townOptions = await this.getSelectOptions(1);
        console.log(`    📍 ${detail}: ${townOptions.length}件`);

        for (const town of townOptions) {
          await this.saveLocation(region, prefecture, city, ward, town);
        }
      }

      await this.closeModal();

    } catch (error) {
      console.error(`  ❌ ${ward} 探索失敗: ${error.message}`);
      this.stats.errors++;
      await this.closeModal().catch(() => {});
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
    await db.destroy();
  }
}

async function main() {
  const explorer = new LocationExplorerDFS();

  try {
    await explorer.explore();
  } catch (error) {
    console.error('❌ 致命的エラー:', error.message);
    console.error(error.stack);
  } finally {
    await explorer.cleanup();
  }
}

main();
