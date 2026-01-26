/**
 * 探索愛知県的REINS沿線データ
 * 收集所有路线名和车站名，保存到SQLite数据库
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const REINS_LOGIN_URL = 'https://system.reins.jp/login/main/KG/GKG001200';

// 数据库连接
const { db, initDatabase } = require('../db/connection');

const delay = ms => new Promise(r => setTimeout(r, ms));

class AichiLineExplorer {
  constructor() {
    this.browser = null;
    this.page = null;
    this.collectedData = {
      prefecture: '愛知県',
      region: '中部圏',
      lines: {}  // { lineName: [stations] }
    };
  }

  async initialize() {
    console.log('[Explorer] Initializing database...');
    await initDatabase();

    console.log('[Explorer] Launching browser...');
    const chromePath = process.env.CHROME_PATH ||
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

    this.browser = await puppeteer.launch({
      headless: false,
      defaultViewport: { width: 1400, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      executablePath: chromePath
    });
    this.page = await this.browser.newPage();
  }

  async login() {
    console.log('[Explorer] Logging in to REINS...');
    await this.page.goto(REINS_LOGIN_URL, { waitUntil: 'networkidle0', timeout: 60000 });

    await delay(5000);
    await this.page.waitForSelector('input', { timeout: 60000 });

    const username = process.env.REINS_USERNAME;
    const password = process.env.REINS_PASSWORD;

    console.log('[Explorer] Filling credentials...');
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

    console.log('[Explorer] Login successful');
  }

  async navigateToRentalSearch() {
    console.log('[Explorer] Navigating to rental search...');

    // 点击賃貸物件検索ボタン
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
    console.log('[Explorer] On rental search page');
  }

  async openLineGuide() {
    console.log('[Explorer] Opening line selection guide...');

    // 找到沿線的入力ガイドボタン（第4个）
    const clicked = await this.page.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      let guideCount = 0;
      for (const btn of buttons) {
        if (btn.textContent?.trim() === '入力ガイド') {
          guideCount++;
          if (guideCount === 4) {
            btn.click();
            return { clicked: true, index: guideCount };
          }
        }
      }
      return { clicked: false, total: guideCount };
    });

    console.log('[Explorer] Guide button click result:', clicked);
    await delay(2000);
  }

  async selectRegionAndPrefecture() {
    console.log('[Explorer] Selecting 中部圏 → 愛知県...');

    // 选择地方
    await this.selectFromDropdown(0, '中部圏');
    await delay(1000);

    // 选择都道府県
    await this.selectFromDropdown(1, '愛知県');
    await delay(1000);

    // 点击次へ
    await this.clickButton('次へ');
    await delay(2000);

    console.log('[Explorer] Region and prefecture selected');
  }

  async selectFromDropdown(index, value) {
    const result = await this.page.evaluate((idx, val) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;
      const selects = container.querySelectorAll('select');

      if (selects.length <= idx) {
        return { success: false, error: 'Select not found', count: selects.length };
      }

      const select = selects[idx];
      const options = Array.from(select.options).map(o => o.text.trim());

      for (const option of select.options) {
        if (option.text.trim() === val || option.value === val) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, selected: option.text };
        }
      }

      return { success: false, available: options.slice(0, 10) };
    }, index, value);

    console.log(`  [Select ${index}] ${value}:`, result.success ? '✓' : '✗');
    if (!result.success) {
      console.log('    Available:', result.available?.join(', ') || result.error);
    }
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
    return clicked;
  }

  async getSelectOptions(index) {
    return await this.page.evaluate((idx) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;
      const selects = container.querySelectorAll('select');

      if (selects.length <= idx) return [];

      return Array.from(selects[idx].options)
        .filter(o => !o.disabled && o.text.trim())
        .map(o => o.text.trim());
    }, index);
  }

  async closeModal() {
    // モーダルを閉じる（閉じるボタンまたはキャンセルボタン）
    await this.page.evaluate(() => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]');
      if (!modal) return;

      // 閉じるボタンを探す
      const closeBtn = modal.querySelector('.close, .btn-close, [data-dismiss="modal"], [aria-label="Close"]');
      if (closeBtn) {
        closeBtn.click();
        return;
      }

      // キャンセルボタンを探す
      const buttons = modal.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('キャンセル') || btn.textContent?.includes('閉じる')) {
          btn.click();
          return;
        }
      }
    });
    await delay(1000);
  }

  async exploreOneLine(kana, lineName) {
    // モーダルを開いて特定の路線の駅を取得する
    console.log(`    [${kana}] ${lineName} を探索中...`);

    // 沿線入力ガイドを開く
    await this.openLineGuide();
    await delay(1500);

    // 地方選択画面かチェック
    const firstOptions = await this.getSelectOptions(0);
    if (firstOptions.includes('中部圏')) {
      // 地方と県を選択
      await this.selectFromDropdown(0, '中部圏');
      await delay(800);
      await this.selectFromDropdown(1, '愛知県');
      await delay(800);
      await this.clickButton('次へ');
      await delay(1500);
    }

    // カナ行を選択
    await this.selectFromDropdown(0, kana);
    await delay(800);

    // 路線を選択
    await this.selectFromDropdown(1, lineName);
    await delay(500);

    // 次へをクリック
    await this.clickButton('次へ');
    await delay(2000);

    // 駅リストを取得
    const stations = await this.getSelectOptions(0);
    const validStations = stations.filter(s => s && s !== '選択してください');

    console.log(`       → ${validStations.length}駅`);

    // モーダルを閉じる
    await this.closeModal();
    await delay(1000);

    return validStations;
  }

  async exploreAllLines() {
    console.log('\n' + '='.repeat(60));
    console.log('探索愛知県の全沿線データ');
    console.log('='.repeat(60));

    // まずカナ行ごとの路線リストを取得
    const allLines = [];

    for (const kana of ['あ行', 'か行', 'さ行', 'た行', 'な行', 'は行', 'ま行', 'ら行']) {
      console.log(`\n【${kana}】の路線リストを取得...`);

      // モーダルを開く
      await this.openLineGuide();
      await delay(1500);

      // 地方と県を選択
      await this.selectFromDropdown(0, '中部圏');
      await delay(800);
      await this.selectFromDropdown(1, '愛知県');
      await delay(800);
      await this.clickButton('次へ');
      await delay(1500);

      // カナ行を選択
      await this.selectFromDropdown(0, kana);
      await delay(1000);

      // 路線リストを取得
      const lines = await this.getSelectOptions(1);
      const validLines = lines.filter(l => l && l !== '選択してください');
      console.log(`  路線数: ${validLines.length}`);

      for (const line of validLines) {
        allLines.push({ kana, line });
        console.log(`    - ${line}`);
      }

      // モーダルを閉じる
      await this.closeModal();
      await delay(1000);
    }

    console.log(`\n合計 ${allLines.length} 路線を発見`);
    console.log('\n' + '='.repeat(60));
    console.log('各路線の駅データを収集中...');
    console.log('='.repeat(60));

    // 各路線の駅を収集
    for (let i = 0; i < allLines.length; i++) {
      const { kana, line } = allLines[i];
      console.log(`\n[${i + 1}/${allLines.length}] ${line}`);

      try {
        const stations = await this.exploreOneLine(kana, line);
        if (stations.length > 0) {
          this.collectedData.lines[line] = stations;
        }
      } catch (error) {
        console.error(`  ⚠ エラー: ${error.message}`);
        // エラーが発生したらモーダルを閉じる
        await this.closeModal();
        await delay(1000);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log(`収集完了: ${Object.keys(this.collectedData.lines).length}路線`);
    console.log('='.repeat(60));
  }

  async saveToDatabase() {
    console.log('\n' + '='.repeat(60));
    console.log('データベースに保存中...');
    console.log('='.repeat(60));

    const { region, prefecture, lines } = this.collectedData;
    let totalLines = 0;
    let totalStations = 0;

    for (const [lineName, stations] of Object.entries(lines)) {
      if (!stations || stations.length === 0) continue;

      totalLines++;

      for (let i = 0; i < stations.length; i++) {
        const station = stations[i];
        if (!station) continue;

        try {
          await db('lines').insert({
            region,
            prefecture,
            line_name: lineName,
            station,
            station_order: i
          });
          totalStations++;
        } catch (error) {
          // 忽略重复记录
          if (!error.message.includes('UNIQUE constraint')) {
            console.error(`  Error inserting ${lineName} - ${station}:`, error.message);
          }
        }
      }

      console.log(`  ✓ ${lineName}: ${stations.length}駅`);
    }

    console.log(`\n保存完了: ${totalLines}路線, ${totalStations}駅`);
  }

  async exportToJson() {
    const outputPath = path.join(__dirname, '..', 'data', 'aichi-lines-explored.json');
    fs.writeFileSync(outputPath, JSON.stringify(this.collectedData, null, 2), 'utf-8');
    console.log(`\nJSONエクスポート: ${outputPath}`);
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
      await this.openLineGuide();
      await this.selectRegionAndPrefecture();
      await this.exploreAllLines();
      await this.saveToDatabase();
      await this.exportToJson();

      console.log('\n' + '='.repeat(60));
      console.log('探索完了！');
      console.log('='.repeat(60));

      // 显示收集到的数据摘要
      const lineNames = Object.keys(this.collectedData.lines);
      console.log(`\n収集した路線 (${lineNames.length}件):`);
      for (const name of lineNames) {
        console.log(`  - ${name} (${this.collectedData.lines[name].length}駅)`);
      }

    } catch (error) {
      console.error('Error:', error);
      await this.page?.screenshot({ path: 'error-explore-aichi.png' });
    } finally {
      await this.close();
    }
  }
}

// 执行
const explorer = new AichiLineExplorer();
explorer.run();
