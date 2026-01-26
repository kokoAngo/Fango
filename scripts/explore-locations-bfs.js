/**
 * REINS 所在地 BFS 探索脚本
 *
 * 使用广度优先搜索遍历 REINS 所在地层级列表，并将结果存入数据库
 * 层级结构: 地方 → 都道府県 → 地域区分 → 市区町村 → 町丁目
 *
 * 运行: node scripts/explore-locations-bfs.js
 * 1小时后自动停止
 */

require('dotenv').config();
const puppeteer = require('puppeteer');
const { db, initDatabase } = require('../db/connection');

// 配置
const CONFIG = {
  REINS_LOGIN_URL: 'https://system.reins.jp/login/main/KG/GKG001200',
  SEARCH_URL: 'https://system.reins.jp/main/KG/GKG003100', // 物件検索画面
  MAX_RUNTIME_MS: 60 * 60 * 1000, // 1小时
  PAGE_DELAY: 1500, // 页面操作间隔
  MODAL_DELAY: 2000, // 模态框加载等待
};

// 地方与都道府县映射
const REGION_PREFECTURES = {
  '東日本': ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
             '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
             '新潟県', '山梨県', '長野県'],
  '中部圏': ['富山県', '石川県', '福井県', '岐阜県', '静岡県', '愛知県', '三重県'],
  '近畿圏': ['滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'],
  '西日本': ['鳥取県', '島根県', '岡山県', '広島県', '山口県',
             '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
             '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
};

// 都道府県から地方を逆引き
const PREFECTURE_TO_REGION = {};
for (const [region, prefectures] of Object.entries(REGION_PREFECTURES)) {
  for (const pref of prefectures) {
    PREFECTURE_TO_REGION[pref] = region;
  }
}

class LocationExplorer {
  constructor() {
    this.browser = null;
    this.page = null;
    this.startTime = null;
    this.stats = {
      regionsExplored: 0,
      prefecturesExplored: 0,
      citiesExplored: 0,
      wardsExplored: 0,
      townsAdded: 0,
      errors: 0
    };
    this.queue = []; // BFS 队列
  }

  /**
   * 检查是否超时
   */
  isTimeout() {
    return Date.now() - this.startTime >= CONFIG.MAX_RUNTIME_MS;
  }

  /**
   * 打印进度
   */
  printProgress() {
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000 / 60);
    const remaining = Math.floor((CONFIG.MAX_RUNTIME_MS - (Date.now() - this.startTime)) / 1000 / 60);

    console.log('\n' + '='.repeat(60));
    console.log(`📊 探索進捗 (経過: ${elapsed}分, 残り: ${remaining}分)`);
    console.log('='.repeat(60));
    console.log(`  地方: ${this.stats.regionsExplored}`);
    console.log(`  都道府県: ${this.stats.prefecturesExplored}`);
    console.log(`  地域区分: ${this.stats.citiesExplored}`);
    console.log(`  市区町村: ${this.stats.wardsExplored}`);
    console.log(`  町丁目追加: ${this.stats.townsAdded}`);
    console.log(`  エラー: ${this.stats.errors}`);
    console.log(`  キュー残り: ${this.queue.length}`);
    console.log('='.repeat(60) + '\n');
  }

  /**
   * 初始化浏览器
   */
  async initBrowser() {
    this.browser = await puppeteer.launch({
      headless: true,  // 使用无头模式
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

  /**
   * 登录 REINS
   */
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
      // チェックボックスにチェック
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => { if (!cb.checked) cb.click(); });
    }, username, password);

    // ログインボタンをクリック
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

  /**
   * 导航到物件検索画面
   */
  async navigateToSearchPage() {
    console.log('🔍 賃貸物件検索画面に移動中...');
    await this.delay(3000);

    // 点击「賃貸」「物件検索」按钮
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
      console.log('⚠️ 賃貸物件検索ボタンが見つかりません、手動でナビゲートしてください');
    }
  }

  /**
   * 检查页面是否有效，如果无效则重新导航或重启浏览器
   */
  async ensurePageValid() {
    try {
      const url = await this.page.url();
      // 检查是否在搜索页面
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

  /**
   * 重启浏览器并重新登录
   */
  async restartBrowser() {
    console.log('\n🔄 ブラウザを再起動中...');

    // 关闭现有浏览器
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } catch (e) {
      // 忽略
    }

    this.browser = null;
    this.page = null;

    // 等待一会儿
    await this.delay(3000);

    // 重新初始化
    await this.initBrowser();
    await this.login();
    await this.navigateToSearchPage();

    console.log('✅ ブラウザ再起動完了\n');
  }

  /**
   * 打开所在地入力ガイド并确保从画面1开始
   */
  async openLocationGuide() {
    // ★ 关键修复: 刷新页面以完全重置模态框状态
    console.log('  🔄 ページリロード（モーダル状態リセット）...');
    await this.page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
    await this.delay(2000);

    // 确保页面有效
    const isValid = await this.ensurePageValid();
    if (!isValid) {
      // 如果页面无效，重新导航
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
      // 如果没找到，点击第一个入力ガイド
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

    // 等待模态框完全加载
    await this.page.waitForSelector('.modal.show select, .modal[style*="display: block"] select, [role="dialog"] select', {
      timeout: 10000
    }).catch(() => console.log('  ⚠️ select要素の待機タイムアウト'));

    // 验证确实在画面1
    const isScreen1 = await this.verifyScreen1();
    if (!isScreen1) {
      throw new Error('画面1の検証に失敗しました');
    }
  }

  /**
   * 验证当前是否在画面1（只检查，不操作）
   */
  async verifyScreen1() {
    const info = await this.page.evaluate(() => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]') || document;
      const selects = modal.querySelectorAll('select');
      if (!selects[0]) return { isScreen1: false, options: [] };

      const firstOptions = Array.from(selects[0].options).map(o => o.text?.trim()).filter(t => t);

      // 画面1的特征：第一个select包含地方选项
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

  /**
   * 关闭模态框 - 点击キャンセル按钮
   */
  async closeModal() {
    try {
      const closed = await this.page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]') || document;
        const buttons = modal.querySelectorAll('button, input[type="button"]');

        // 优先点击キャンセル按钮
        for (const btn of buttons) {
          const text = btn.textContent?.trim() || btn.value?.trim();
          if (text === 'キャンセル' || text === '閉じる' || text === 'Cancel' || text === '×') {
            btn.click();
            return 'cancel';
          }
        }

        // 尝试点击关闭按钮
        const closeBtn = modal.querySelector('button.close, .btn-close, [data-dismiss="modal"]');
        if (closeBtn) {
          closeBtn.click();
          return 'close';
        }

        return false;
      });

      await this.delay(2000);
    } catch (error) {
      // 忽略关闭模态框的错误
      console.log('  ⚠️ モーダル閉じエラー（無視）');
      await this.delay(1000);
    }
  }

  /**
   * 获取下拉框选项
   */
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

  /**
   * 选择下拉框选项
   */
  async selectOption(selectIndex, value) {
    const result = await this.page.evaluate((idx, val) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]') || document;
      const selects = modal.querySelectorAll('select');
      if (!selects[idx]) {
        return { success: false, error: `select[${idx}] not found, total: ${selects.length}` };
      }

      const options = selects[idx].options;
      const optionTexts = Array.from(options).map(o => o.text?.trim());

      for (let i = 0; i < options.length; i++) {
        if (options[i].text?.trim() === val || options[i].text?.includes(val)) {
          selects[idx].selectedIndex = i;
          selects[idx].dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, selected: options[i].text?.trim(), options: optionTexts.slice(0, 10) };
        }
      }

      return { success: false, error: `"${val}" not found`, options: optionTexts.slice(0, 10) };
    }, selectIndex, value);

    if (!result.success) {
      console.log(`  ⚠️ selectOption(${selectIndex}, "${value}") 失敗: ${result.error}`);
      console.log(`     利用可能: ${result.options?.join(', ')}`);
    }

    await this.delay(CONFIG.PAGE_DELAY);
    return result.success;
  }

  /**
   * 点击按钮
   */
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

  /**
   * 保存位置数据到数据库
   */
  async saveLocation(region, prefecture, city, ward, town) {
    try {
      await db('locations').insert({
        region,
        prefecture,
        city,
        ward,
        town
      });
      this.stats.townsAdded++;
      return true;
    } catch (error) {
      // 忽略唯一约束冲突
      if (!error.message.includes('UNIQUE constraint') && !error.message.includes('duplicate')) {
        console.error(`  ❌ 保存失敗: ${error.message}`);
        this.stats.errors++;
      }
      return false;
    }
  }

  /**
   * 检查是否已探索过
   */
  async isExplored(region, prefecture, city = null, ward = null) {
    const query = db('locations').where({ region, prefecture });
    if (city) query.where('city', city);
    if (ward) query.where('ward', ward);

    const count = await query.count('* as cnt').first();
    return count.cnt > 0;
  }

  /**
   * BFS 探索主逻辑
   */
  async explore() {
    this.startTime = Date.now();

    console.log('\n' + '🚀'.repeat(30));
    console.log('   REINS 所在地 BFS 探索開始');
    console.log('   最大実行時間: 1時間');
    console.log('🚀'.repeat(30) + '\n');

    // 初始化数据库
    await initDatabase();
    console.log('✅ データベース初期化完了');

    // 初始化浏览器并登录
    await this.initBrowser();
    await this.login();
    await this.navigateToSearchPage();

    // 初始化 BFS 队列 - 从地方开始
    for (const region of Object.keys(REGION_PREFECTURES)) {
      this.queue.push({
        level: 'region',
        region: region,
        prefecture: null,
        city: null,
        ward: null
      });
    }

    // BFS 主循环
    while (this.queue.length > 0 && !this.isTimeout()) {
      const node = this.queue.shift();

      try {
        await this.processNode(node);
      } catch (error) {
        console.error(`  ❌ エラー: ${error.message}`);
        this.stats.errors++;
        await this.page.screenshot({ path: `error-${Date.now()}.png` }).catch(() => {});

        // 尝试恢复
        try {
          await this.closeModal();
          await this.delay(2000);
        } catch (e) {
          // 忽略
        }
      }

      // 每处理10个节点打印一次进度
      if ((this.stats.prefecturesExplored + this.stats.citiesExplored + this.stats.wardsExplored) % 10 === 0) {
        this.printProgress();
      }
    }

    // 完成
    this.printProgress();
    console.log('\n✅ 探索完了！');

    if (this.isTimeout()) {
      console.log('⏰ 1時間経過により終了しました');
    }
  }

  /**
   * 处理 BFS 节点
   */
  async processNode(node) {
    switch (node.level) {
      case 'region':
        await this.exploreRegion(node.region);
        break;
      case 'prefecture':
        await this.explorePrefecture(node.region, node.prefecture);
        break;
      case 'city':
        await this.exploreCity(node.region, node.prefecture, node.city);
        break;
      case 'ward':
        await this.exploreWard(node.region, node.prefecture, node.city, node.ward);
        break;
    }
  }

  /**
   * 探索地方下的都道府県
   */
  async exploreRegion(region) {
    console.log(`\n📍 地方探索: ${region}`);
    this.stats.regionsExplored++;

    // 将该地方的所有都道府県加入队列
    const prefectures = REGION_PREFECTURES[region] || [];
    for (const pref of prefectures) {
      // 检查是否已有数据
      const explored = await this.isExplored(region, pref);
      if (!explored) {
        this.queue.push({
          level: 'prefecture',
          region: region,
          prefecture: pref,
          city: null,
          ward: null
        });
      } else {
        console.log(`  ⏭️ ${pref}: 既存データあり、スキップ`);
      }
    }
  }

  /**
   * 探索都道府県下的地域区分
   */
  async explorePrefecture(region, prefecture) {
    console.log(`\n🗾 都道府県探索: ${prefecture} (${region})`);
    this.stats.prefecturesExplored++;

    try {
      // 打开入力ガイド
      await this.openLocationGuide();

      // 画面1: 选择地方
      console.log(`  → 地方を選択: ${region}`);
      const regionOk = await this.selectOption(0, region);
      if (!regionOk) {
        throw new Error(`地方「${region}」の選択に失敗`);
      }

      // 选择都道府県
      console.log(`  → 都道府県を選択: ${prefecture}`);
      const prefOk = await this.selectOption(1, prefecture);
      if (!prefOk) {
        throw new Error(`都道府県「${prefecture}」の選択に失敗`);
      }

      // 点击次へ
      await this.clickButton('次へ');

      // 画面2: 获取地域区分选项
      const cityOptions = await this.getSelectOptions(0);
      console.log(`  📋 地域区分: ${cityOptions.length}件 [${cityOptions.slice(0, 3).join(', ')}...]`);

      // 关闭模态框
      await this.closeModal();

      // 将地域区分加入队列
      for (const city of cityOptions) {
        this.queue.push({
          level: 'city',
          region: region,
          prefecture: prefecture,
          city: city,
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
   * 探索地域区分下的市区町村
   */
  async exploreCity(region, prefecture, city) {
    console.log(`\n🏙️ 地域区分探索: ${prefecture} > ${city}`);
    this.stats.citiesExplored++;

    try {
      // 打开入力ガイド
      await this.openLocationGuide();

      // 画面1: 选择地方和都道府県
      console.log(`  → 地方: ${region}, 都道府県: ${prefecture}`);
      await this.selectOption(0, region);
      await this.selectOption(1, prefecture);
      await this.clickButton('次へ');

      // 画面2: 选择地域区分
      console.log(`  → 地域区分を選択: ${city}`);
      const cityOk = await this.selectOption(0, city);
      if (!cityOk) {
        // 如果找不到指定的地域区分，列出可用选项
        const availableCities = await this.getSelectOptions(0);
        console.log(`  ⚠️ 利用可能な地域区分: ${availableCities.join(', ')}`);
        throw new Error(`地域区分「${city}」の選択に失敗`);
      }
      await this.delay(CONFIG.PAGE_DELAY);

      // 获取市区町村选项
      const wardOptions = await this.getSelectOptions(1);
      console.log(`  📋 市区町村: ${wardOptions.length}件 [${wardOptions.slice(0, 5).join(', ')}...]`);

      // 关闭模态框
      await this.closeModal();

      // 将市区町村加入队列
      for (const ward of wardOptions) {
        this.queue.push({
          level: 'ward',
          region: region,
          prefecture: prefecture,
          city: city,
          ward: ward
        });
      }
    } catch (error) {
      console.error(`  ❌ ${city} 探索失敗: ${error.message}`);
      this.stats.errors++;
      await this.closeModal().catch(() => {});
    }
  }

  /**
   * 探索市区町村下的町丁目
   */
  async exploreWard(region, prefecture, city, ward) {
    console.log(`\n🏘️ 市区町村探索: ${prefecture} > ${city} > ${ward}`);
    this.stats.wardsExplored++;

    try {
      // 打开入力ガイド
      await this.openLocationGuide();

      // 画面1: 选择地方和都道府県
      console.log(`  → [画面1] 地方: ${region}, 都道府県: ${prefecture}`);
      await this.selectOption(0, region);
      await this.selectOption(1, prefecture);
      await this.clickButton('次へ');

      // 画面2: 选择地域区分和市区町村
      console.log(`  → [画面2] 地域区分: ${city}, 市区町村: ${ward}`);
      await this.selectOption(0, city);
      await this.delay(CONFIG.PAGE_DELAY);
      await this.selectOption(1, ward);
      await this.clickButton('次へ');

      // 画面3: 选择詳細地点
      await this.delay(CONFIG.PAGE_DELAY);

      // 获取詳細地点选项
      const detailOptions = await this.getSelectOptions(0);
      console.log(`  → [画面3] 詳細地点: ${detailOptions.length}件`);

      // 遍历每个詳細地点获取町丁目
      for (const detail of detailOptions) {
        if (this.isTimeout()) break;

        await this.selectOption(0, detail);
        await this.delay(CONFIG.PAGE_DELAY);

        // 获取町丁目选项
        const townOptions = await this.getSelectOptions(1);
        console.log(`    📍 ${detail}: ${townOptions.length}件の町丁目`);

        // 保存到数据库
        for (const town of townOptions) {
          await this.saveLocation(region, prefecture, city, ward, town);
        }
      }

      // 关闭模态框
      await this.closeModal();

    } catch (error) {
      console.error(`  ❌ ${ward} 探索失敗: ${error.message}`);
      this.stats.errors++;
      await this.closeModal().catch(() => {});
    }
  }

  /**
   * 延时工具
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 清理资源
   */
  async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
    await db.destroy();
  }
}

// 主入口
async function main() {
  const explorer = new LocationExplorer();

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
