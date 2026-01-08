const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { getSelectionPath, normalizePrefecture } = require('./areaMapping');
const { getKanaRowForLine, getRegionForPrefecture } = require('./lineMapping');
const OpenAI = require('openai');

const REINS_LOGIN_URL = 'https://system.reins.jp/login/main/KG/GKG001200';
const TIMEOUT = 60000;
const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

class ReinsService {
  constructor() {
    this.browser = null;
    this.page = null;
    this.downloadedFiles = [];
    this.openaiClient = null;
  }

  /**
   * 初始化 OpenAI 客户端
   */
  initOpenAI() {
    if (!this.openaiClient && process.env.OPENAI_API_KEY) {
      this.openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
    return this.openaiClient;
  }

  /**
   * 检测网页上的错误消息
   */
  async detectPageErrors() {
    try {
      const errorInfo = await this.page.evaluate(() => {
        const text = document.body.innerText;
        const errors = [];

        // 常见错误模式
        const errorPatterns = [
          /エラー[：:]\s*([^\n]+)/g,
          /エラーが発生しました[：:]\s*([^\n]+)/g,
          /入力エラー[：:]\s*([^\n]+)/g,
          /選択してください[：:]\s*([^\n]+)/g,
          /必須項目です/g,
          /正しく入力してください/g,
          /見つかりません/g,
          /該当する.*?がありません/g
        ];

        for (const pattern of errorPatterns) {
          let match;
          while ((match = pattern.exec(text)) !== null) {
            errors.push(match[0]);
          }
        }

        // 检测模态框中的错误
        const modals = document.querySelectorAll('.modal.show, .modal[style*="display: block"], [role="dialog"], .alert-danger, .error-message');
        for (const modal of modals) {
          const modalText = modal.innerText?.trim();
          if (modalText && (modalText.includes('エラー') || modalText.includes('失敗') || modalText.includes('見つかりません'))) {
            errors.push(modalText.substring(0, 200));
          }
        }

        return errors.length > 0 ? errors : null;
      });

      return errorInfo;
    } catch (error) {
      console.log('[ErrorDetect] Detection failed:', error.message);
      return null;
    }
  }

  /**
   * 使用 AI 处理错误并获取解决方案
   */
  async handleErrorWithAI(errorMessages, context) {
    const client = this.initOpenAI();

    if (!client) {
      console.log('[AIErrorHandler] OpenAI API not configured');
      return null;
    }

    try {
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 🤖 AI エラー処理');
      console.log('└─────────────────────────────────────');
      console.log('  エラー内容:', errorMessages.join('; '));

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `REINSの不動産検索システムで以下のエラーが発生しました。

【エラーメッセージ】
${errorMessages.join('\n')}

【現在の検索条件】
${JSON.stringify(context, null, 2)}

このエラーを解決するためのアドバイスをJSON形式で回答してください:
{
  "action": "skip_line" または "use_location_only" または "retry" または "adjust_conditions",
  "reason": "理由の説明",
  "adjustments": {"field": "value"} // 必要な場合のみ
}

回答:`
        }]
      });

      const content = response.choices[0].message.content.trim();
      console.log('  AI回答:', content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        console.log('  推奨アクション:', result.action);
        console.log('  理由:', result.reason);
        return result;
      }

      return null;
    } catch (error) {
      console.error('[AIErrorHandler] Error:', error.message);
      return null;
    }
  }

  /**
   * 确保下载目录存在
   */
  ensureDownloadDir() {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
    // 清空旧文件
    const files = fs.readdirSync(DOWNLOADS_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(DOWNLOADS_DIR, file));
    }
    return DOWNLOADS_DIR;
  }

  async initBrowser() {
    if (!this.browser) {
      const options = {
        headless: process.env.HEADLESS !== 'false',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--allow-running-insecure-content',
          '--ignore-certificate-errors'
        ]
      };

      // Use system Chromium in Docker/production
      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      this.browser = await puppeteer.launch(options);
    }
    return this.browser;
  }

  async login(username, password) {
    try {
      const browser = await this.initBrowser();
      this.page = await browser.newPage();
      await this.page.setViewport({ width: 1920, height: 1080 });

      // 配置下载目录
      const downloadPath = this.ensureDownloadDir();
      const client = await this.page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath
      });

      console.log('Navigating to REINS login page...');
      await this.page.goto(REINS_LOGIN_URL, {
        waitUntil: 'networkidle0',
        timeout: TIMEOUT
      });

      await new Promise(resolve => setTimeout(resolve, 5000));
      await this.page.waitForSelector('input', { timeout: TIMEOUT });

      console.log('Filling login credentials...');
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
        new Promise(resolve => setTimeout(resolve, 10000))
      ]);

      console.log('Login completed');
      return true;

    } catch (error) {
      console.error('Login failed:', error.message);
      throw new Error('REINS login failed: ' + error.message);
    }
  }

  async navigateToRentalSearch() {
    try {
      console.log('Navigating to rental property search...');
      await new Promise(resolve => setTimeout(resolve, 3000));

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
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('Navigated to rental search page');
      }

    } catch (error) {
      console.error('Navigation failed:', error.message);
    }
  }

  /**
   * ユーザー要件を分析して選択パスを決定
   */
  analyzeLocationRequirements(prefecture, cities) {
    console.log('\n' + '='.repeat(60));
    console.log('📍 地域選択の分析');
    console.log('='.repeat(60));

    const normalizedPref = normalizePrefecture(prefecture);
    const city = cities && cities.length > 0 ? cities[0] : null;
    const path = getSelectionPath(normalizedPref, city);

    console.log('\n【入力情報】');
    console.log('  都道府県: ' + (prefecture || '(未指定)'));
    console.log('  市区町村: ' + (cities && cities.length > 0 ? cities.join(', ') : '(未指定)'));

    console.log('\n【分析結果】');
    console.log('  ① 地方: ' + (path.region || '東日本') + ' ← 都道府県から自動判定');
    console.log('  ② 都道府県: ' + normalizedPref);

    if (path.areaCategory) {
      console.log('  ③ 地域区分: ' + path.areaCategory + ' ← 市区町村から自動判定');
    } else {
      console.log('  ③ 地域区分: (最初のオプションを選択)');
    }

    if (city) {
      console.log('  ④ 市区町村: ' + city);
    } else {
      console.log('  ④ 市区町村: (最初のオプションを選択)');
    }

    console.log('  ⑤ 町丁目: 全域 (デフォルト)');
    console.log('');

    return { normalizedPref, city, path };
  }

  /**
   * 入力ガイドを使用して地域を選択
   * select要素を使用した多段選択に対応
   * フロー: 地方 → 都道府県 → 次へ → 地域区分 → 市区町村 → 次へ → 詳細地点 → 町丁目 → 決定
   */
  async selectLocationViaGuide(prefecture, cities) {
    try {
      // 分析フェーズ
      const { normalizedPref, city, path } = this.analyzeLocationRequirements(prefecture, cities);

      console.log('【実行開始】地域選択を開始します...\n');

      // 都道府県名の入力ガイドボタンを探してクリック
      const guideClicked = await this.page.evaluate(() => {
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
          if (btn.textContent?.trim() === '入力ガイド') {
            const parent = btn.closest('tr, div, td');
            if (parent?.textContent?.includes('都道府県') || parent?.textContent?.includes('所在地')) {
              btn.click();
              return { clicked: true, context: '都道府県/所在地' };
            }
          }
        }
        for (const btn of allButtons) {
          if (btn.textContent?.trim() === '入力ガイド') {
            btn.click();
            return { clicked: true, context: 'first guide button' };
          }
        }
        return { clicked: false };
      });

      if (!guideClicked.clicked) {
        console.log('入力ガイドボタンが見つかりません');
        return false;
      }

      console.log('  ✓ 入力ガイドを開きました (' + guideClicked.context + ')');
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.page.screenshot({ path: 'debug-location-guide-1.png' });

      // ========== 画面1: 地方・都道府県選択 ==========
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 画面1: 地方・都道府県選択');
      console.log('└─────────────────────────────────────');

      // Step 1: 地方を選択（select要素）
      if (path.region) {
        console.log('  [Step 1] 地方を選択: ' + path.region);
        const regionSelected = await this.selectFromDropdown(0, path.region);
        console.log('           → ' + (regionSelected ? '✓ 成功' : '✗ 失敗'));
        await new Promise(resolve => setTimeout(resolve, 1500));
        await this.page.screenshot({ path: 'debug-location-guide-1b.png' });
      }

      // Step 2: 都道府県を選択（select要素、2番目）
      console.log('  [Step 2] 都道府県を選択: ' + normalizedPref);
      const prefSelected = await this.selectFromDropdown(1, normalizedPref);
      console.log('           → ' + (prefSelected ? '✓ 成功' : '✗ 失敗'));
      await new Promise(resolve => setTimeout(resolve, 1500));
      await this.page.screenshot({ path: 'debug-location-guide-2.png' });

      // Step 3: 次へボタンをクリック
      console.log('  [Step 3] 「次へ」をクリック...');
      await this.clickModalButton('次へ');
      console.log('           → ✓ 次の画面へ');
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.page.screenshot({ path: 'debug-location-guide-3.png' });

      // ========== 画面2: 地域区分・市区町村選択 ==========
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 画面2: 地域区分・市区町村選択');
      console.log('└─────────────────────────────────────');

      // Step 4: 地域区分を選択（23区、市部など）- 最初のselect
      const areaCategoryDisplay = path.areaCategory || '(自動選択)';
      console.log('  [Step 4] 地域区分を選択: ' + areaCategoryDisplay);
      if (path.areaCategory) {
        const areaSelected = await this.selectFromDropdown(0, path.areaCategory);
        console.log('           → ' + (areaSelected ? '✓ 成功' : '✗ 失敗'));
      } else {
        const areaSelected = await this.selectFirstOption(0);
        console.log('           → ' + (areaSelected ? '✓ 成功（最初のオプション）' : '✗ 失敗'));
      }
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Step 5: 市区町村を選択 - 2番目のselect（所在地名２）
      // まず全オプションを遍歴し、ユーザー需要に合う最初の項目を選択
      const cityDisplay = cities && cities.length > 0 ? cities.join(', ') : '(自動選択)';
      console.log('  [Step 5] 市区町村を選択: ' + cityDisplay);

      // 全オプションを取得して表示
      const cityOptions = await this.getSelectOptions(1);
      if (cityOptions.length > 0) {
        console.log('           【利用可能なオプション】 (' + cityOptions.length + '件):');
        cityOptions.slice(0, 15).forEach((opt, i) => {
          console.log('             [' + i + '] ' + opt);
        });
        if (cityOptions.length > 15) {
          console.log('             ... 他 ' + (cityOptions.length - 15) + ' 件');
        }
      }

      // ユーザー需要に合う最初の項目を選択
      if (cities && cities.length > 0) {
        let citySelected = false;
        for (const c of cities) {
          // 各cityをオプションと照合
          const matchedOption = cityOptions.find(opt =>
            opt === c || opt.includes(c) || c.includes(opt)
          );
          if (matchedOption) {
            citySelected = await this.selectFromDropdown(1, matchedOption);
            if (citySelected) {
              console.log('           → 選択: "' + matchedOption + '" (需要: "' + c + '")');
              break;
            }
          }
        }
        if (!citySelected) {
          console.log('           → 需要に合うオプションなし、最初のオプションを選択');
          await this.selectFirstOption(1);
        }
      } else {
        const citySelected = await this.selectFirstOption(1);
        console.log('           → ' + (citySelected ? '✓ 成功（最初のオプション）' : '✗ 失敗'));
      }
      await this.page.screenshot({ path: 'debug-location-guide-4.png' });
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 6: 次へボタンをクリック
      console.log('  [Step 6] 「次へ」をクリック...');
      await this.clickModalButton('次へ');
      console.log('           → ✓ 次の画面へ');
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.page.screenshot({ path: 'debug-location-guide-5.png' });

      // ========== 画面3: 詳細地点・町丁目選択 ==========
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 画面3: 詳細地点・町丁目選択');
      console.log('└─────────────────────────────────────');

      // Step 7: 詳細地点を選択（最初のselect - 再度区を選択）
      // まず全オプションを遍歴し、ユーザー需要に合う最初の項目を選択
      const detailDisplay = cities && cities.length > 0 ? cities.join(', ') : '(自動選択)';
      console.log('  [Step 7] 詳細地点を選択: ' + detailDisplay);

      // 全オプションを取得して表示
      const detailOptions = await this.getSelectOptions(0);
      if (detailOptions.length > 0) {
        console.log('           【利用可能なオプション】 (' + detailOptions.length + '件):');
        detailOptions.slice(0, 15).forEach((opt, i) => {
          console.log('             [' + i + '] ' + opt);
        });
        if (detailOptions.length > 15) {
          console.log('             ... 他 ' + (detailOptions.length - 15) + ' 件');
        }
      }

      // ユーザー需要に合う最初の項目を選択
      let detailSelected = false;
      if (cities && cities.length > 0) {
        for (const c of cities) {
          // 各cityをオプションと照合
          const matchedOption = detailOptions.find(opt =>
            opt === c || opt.includes(c) || c.includes(opt)
          );
          if (matchedOption) {
            detailSelected = await this.selectFromDropdown(0, matchedOption);
            if (detailSelected) {
              console.log('           → 選択: "' + matchedOption + '" (需要: "' + c + '")');
              break;
            }
          }
        }
        if (!detailSelected) {
          console.log('           → 需要に合うオプションなし、最初のオプションを選択');
          detailSelected = await this.selectFirstOption(0);
        }
      } else {
        detailSelected = await this.selectFirstOption(0);
        console.log('           → ' + (detailSelected ? '✓ 成功（最初のオプション）' : '✗ 失敗'));
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
      await this.page.screenshot({ path: 'debug-location-guide-6.png' });

      // Step 8: 町丁目を選択（2番目のselect - 全域や具体的な丁目）
      console.log('  [Step 8] 町丁目を選択: 全域（優先）');
      const choSelected = await this.selectChoFromDropdown(1);
      console.log('           → ' + (choSelected ? '✓ 成功' : '✗ 失敗'));
      await new Promise(resolve => setTimeout(resolve, 1500));
      await this.page.screenshot({ path: 'debug-location-guide-7.png' });

      // Step 9: 決定ボタンをクリック
      console.log('  [Step 9] 「決定」をクリック...');
      await this.clickModalButton('決定');
      console.log('           → ✓ 地域選択完了');
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('\n' + '='.repeat(60));
      console.log('✅ 地域選択が完了しました');
      console.log('='.repeat(60) + '\n');
      await this.page.screenshot({ path: 'debug-location-guide-done.png' });
      return true;

    } catch (error) {
      console.error('地域選択エラー:', error.message);
      await this.page.screenshot({ path: 'debug-location-error.png' }).catch(() => {});
      return false;
    }
  }

  /**
   * 沿線・駅選択のユーザー要件を分析
   */
  analyzeLineRequirements(prefecture, lineName, startStation, endStation) {
    console.log('\n' + '='.repeat(60));
    console.log('🚃 沿線・駅選択の分析');
    console.log('='.repeat(60));

    const region = getRegionForPrefecture(prefecture || '東京都');
    const kanaRow = getKanaRowForLine(lineName);

    console.log('\n【入力情報】');
    console.log('  都道府県: ' + (prefecture || '(未指定)'));
    console.log('  沿線: ' + (lineName || '(未指定)'));
    console.log('  始発駅: ' + (startStation || '(未指定)'));
    console.log('  終点駅: ' + (endStation || '(未指定)'));

    console.log('\n【分析結果】');
    console.log('  ① 地方: ' + region + ' ← 都道府県から自動判定');
    console.log('  ② 都道府県: ' + (prefecture || '東京都'));
    console.log('  ③ カナ行: ' + (kanaRow || '(自動検索)') + ' ← 沿線名から自動判定');
    console.log('  ④ 沿線: ' + (lineName || '(最初のオプション)'));
    console.log('  ⑤ 始発駅: ' + (startStation || '(最初のオプション)'));
    console.log('  ⑥ 終点駅: ' + (endStation || '(最後のオプション)'));
    console.log('');

    return { region, kanaRow };
  }

  /**
   * 入力ガイドを使用して沿線・駅を選択
   * フロー: 地方 → 都道府県 → 次へ → カナ行 → 沿線 → 次へ → 始発駅 → 終点駅 → 決定
   * @param {string} prefecture - 都道府県名
   * @param {string} lineName - 沿線名
   * @param {string} startStation - 始発駅名（オプション）
   * @param {string} endStation - 終点駅名（オプション）
   * @param {number} guideIndex - 入力ガイドボタンのインデックス（デフォルト: 3）
   */
  async selectLineViaGuide(prefecture, lineName, startStation, endStation, guideIndex = 3) {
    try {
      // 分析フェーズ
      const { region, kanaRow } = this.analyzeLineRequirements(prefecture, lineName, startStation, endStation);

      console.log('【実行開始】沿線・駅選択を開始します...\n');

      // 沿線の入力ガイドボタンをクリック（index=3, 4, 5のいずれか）
      const guideClicked = await this.page.evaluate((idx) => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const guideButtons = buttons.filter(b => b.textContent?.trim() === '入力ガイド');
        if (guideButtons[idx]) {
          guideButtons[idx].click();
          return { clicked: true, index: idx };
        }
        return { clicked: false };
      }, guideIndex);

      if (!guideClicked.clicked) {
        console.log('沿線の入力ガイドボタンが見つかりません (index=' + guideIndex + ')');
        return false;
      }

      console.log('  ✓ 沿線入力ガイドを開きました (index=' + guideIndex + ')');
      await new Promise(resolve => setTimeout(resolve, 2500));
      await this.page.screenshot({ path: 'debug-line-guide-1.png' });

      // ========== 画面1: 地方・都道府県選択 ==========
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 画面1: 地方・都道府県選択');
      console.log('└─────────────────────────────────────');

      // Step 1: 地方を選択
      console.log('  [Step 1] 地方を選択: ' + region);
      const regionSelected = await this.selectFromDropdown(0, region);
      console.log('           → ' + (regionSelected ? '✓ 成功' : '✗ 失敗'));
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 2: 都道府県を選択
      const pref = prefecture || '東京都';
      console.log('  [Step 2] 都道府県を選択: ' + pref);
      const prefSelected = await this.selectFromDropdown(1, pref);
      console.log('           → ' + (prefSelected ? '✓ 成功' : '✗ 失敗'));
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.page.screenshot({ path: 'debug-line-guide-2.png' });

      // Step 3: 次へボタンをクリック
      console.log('  [Step 3] 「次へ」をクリック...');
      await this.clickModalButton('次へ');
      console.log('           → ✓ 次の画面へ');
      await new Promise(resolve => setTimeout(resolve, 2500));
      await this.page.screenshot({ path: 'debug-line-guide-3.png' });

      // ========== 画面2: 沿線選択 ==========
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 画面2: 沿線選択（カナ行フィルター）');
      console.log('└─────────────────────────────────────');

      // Step 4: カナ行を選択
      if (kanaRow) {
        console.log('  [Step 4] カナ行を選択: ' + kanaRow);
        const kanaSelected = await this.selectFromDropdown(0, kanaRow);
        console.log('           → ' + (kanaSelected ? '✓ 成功' : '✗ 失敗'));
      } else {
        console.log('  [Step 4] カナ行を自動検索...');
        // カナ行が不明な場合、全行を順に試す
        const kanaRows = ['あ行', 'か行', 'さ行', 'た行', 'な行', 'は行', 'ま行', 'や行', 'ら行'];
        let found = false;
        for (const row of kanaRows) {
          await this.selectFromDropdown(0, row);
          await new Promise(resolve => setTimeout(resolve, 1000));
          // 沿線リストに目的の路線があるか確認
          const hasLine = await this.page.evaluate((name) => {
            const modal = document.querySelector('.modal.show, .modal');
            const selects = modal?.querySelectorAll('select');
            if (selects && selects[1]) {
              const options = Array.from(selects[1].options);
              return options.some(o => o.text.includes(name));
            }
            return false;
          }, lineName);
          if (hasLine) {
            console.log('           → ✓ 「' + row + '」で見つかりました');
            found = true;
            break;
          }
        }
        if (!found) {
          console.log('           → ⚠ 路線が見つかりません、最初の行を使用');
          await this.selectFromDropdown(0, 'あ行');
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Step 5: 沿線を選択
      console.log('  [Step 5] 沿線を選択: ' + (lineName || '(最初のオプション)'));
      let lineSelected = false;
      if (lineName) {
        lineSelected = await this.selectFromDropdown(1, lineName);
      }
      if (!lineSelected) {
        lineSelected = await this.selectFirstOption(1);
      }
      console.log('           → ' + (lineSelected ? '✓ 成功' : '✗ 失敗'));
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.page.screenshot({ path: 'debug-line-guide-4.png' });

      // Step 6: 次へボタンをクリック
      console.log('  [Step 6] 「次へ」をクリック...');
      await this.clickModalButton('次へ');
      console.log('           → ✓ 次の画面へ');
      await new Promise(resolve => setTimeout(resolve, 2500));
      await this.page.screenshot({ path: 'debug-line-guide-5.png' });

      // ========== 画面3: 駅選択 ==========
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 画面3: 駅選択（区間指定）');
      console.log('└─────────────────────────────────────');

      // Step 7: 始発駅を選択
      console.log('  [Step 7] 始発駅を選択: ' + (startStation || '(最初のオプション)'));
      let startSelected = false;
      if (startStation) {
        startSelected = await this.selectFromDropdown(0, startStation);
      }
      if (!startSelected) {
        startSelected = await this.selectFirstOption(0);
      }
      console.log('           → ' + (startSelected ? '✓ 成功' : '✗ 失敗'));
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 8: 終点駅を選択
      console.log('  [Step 8] 終点駅を選択: ' + (endStation || '(最後のオプション)'));
      let endSelected = false;
      if (endStation) {
        endSelected = await this.selectFromDropdown(1, endStation);
      }
      if (!endSelected) {
        // 終点駅は最後のオプションを選択
        endSelected = await this.selectLastOption(1);
      }
      console.log('           → ' + (endSelected ? '✓ 成功' : '✗ 失敗'));
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.page.screenshot({ path: 'debug-line-guide-6.png' });

      // Step 9: 決定ボタンをクリック
      console.log('  [Step 9] 「決定」をクリック...');
      await this.clickModalButton('決定');
      console.log('           → ✓ 沿線・駅選択完了');
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('\n' + '='.repeat(60));
      console.log('✅ 沿線・駅選択が完了しました');
      console.log('='.repeat(60) + '\n');
      await this.page.screenshot({ path: 'debug-line-guide-done.png' });
      return true;

    } catch (error) {
      console.error('沿線・駅選択エラー:', error.message);
      await this.page.screenshot({ path: 'debug-line-error.png' }).catch(() => {});
      return false;
    }
  }

  /**
   * モーダル内のselect要素の全オプションを取得
   * @param {number} selectIndex - モーダル内のselect要素のインデックス（0始まり）
   * @returns {string[]} オプションのテキスト配列
   */
  async getSelectOptions(selectIndex) {
    const options = await this.page.evaluate((index) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;
      const selects = container.querySelectorAll('select.p-listbox-input, select.custom-select, select');

      if (selects.length <= index) {
        return [];
      }

      const select = selects[index];
      return Array.from(select.options).map(o => o.text.trim()).filter(t => t.length > 0);
    }, selectIndex);

    return options;
  }

  /**
   * モーダル内のselect要素の最後のオプションを選択
   * 選択前に全オプションを遍歴して表示
   * @param {number} selectIndex - モーダル内のselect要素のインデックス（0始まり）
   */
  async selectLastOption(selectIndex) {
    const result = await this.page.evaluate((index) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;

      const selects = container.querySelectorAll('select.p-listbox-input, select.custom-select, select');

      if (selects.length <= index) {
        return { found: false, error: 'select not found', index, totalSelects: selects.length };
      }

      const select = selects[index];
      const options = Array.from(select.options);

      if (options.length === 0) {
        return { found: false, error: 'no options available' };
      }

      // 全オプションを遍歴して表示
      const allOptions = options.map((o, i) => ({
        index: i,
        value: o.value,
        text: o.text.trim(),
        disabled: o.disabled
      }));

      console.log('【オプション一覧】Select #' + index + ' (' + allOptions.length + '件):');
      allOptions.forEach(o => {
        console.log('  [' + o.index + '] ' + o.text + (o.disabled ? ' (disabled)' : ''));
      });

      // 最後の有効なオプションを選択
      let lastOption = options[options.length - 1];
      for (let i = options.length - 1; i >= 0; i--) {
        if (!options[i].disabled && options[i].value) {
          lastOption = options[i];
          break;
        }
      }

      select.value = lastOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));

      return {
        found: true,
        selectId: select.id,
        selectedValue: lastOption.value,
        selectedText: lastOption.text,
        totalOptions: options.length,
        availableOptions: allOptions.slice(-10).map(o => o.text)
      };
    }, selectIndex);

    if (result.found) {
      console.log('  ✓ 最後のオプションを選択: "' + result.selectedText + '"');
    } else {
      console.log('  ✗ selectLastOption失敗:', result.error);
    }
    return result.found;
  }

  /**
   * モーダル内のselect要素から選択
   * 選択前に全オプションを遍歴し、最適なマッチを見つける
   * @param {number} selectIndex - モーダル内のselect要素のインデックス（0始まり）
   * @param {string} optionText - 選択するオプションのテキスト
   */
  async selectFromDropdown(selectIndex, optionText) {
    const result = await this.page.evaluate((index, text) => {
      // モーダル内のselect要素を取得
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;

      // p-listbox-input クラスを持つselectを探す
      const selects = container.querySelectorAll('select.p-listbox-input, select.custom-select, select');

      if (selects.length <= index) {
        return { found: false, error: 'select not found', index, totalSelects: selects.length };
      }

      const select = selects[index];
      const options = Array.from(select.options);

      // ========== Phase 1: 全オプションを遍歴して表示 ==========
      const allOptions = options.map((o, i) => ({
        index: i,
        value: o.value,
        text: o.text.trim(),
        disabled: o.disabled
      }));

      console.log('【オプション一覧】Select #' + index + ' (' + allOptions.length + '件):');
      allOptions.forEach(o => {
        console.log('  [' + o.index + '] ' + o.text + (o.disabled ? ' (disabled)' : ''));
      });

      // ========== Phase 2: 最適なマッチを探す ==========
      let bestMatch = null;
      let matchType = '';

      // 1. 完全一致を探す
      for (const option of options) {
        if (option.text.trim() === text) {
          bestMatch = option;
          matchType = '完全一致';
          break;
        }
      }

      // 2. 完全一致がなければ、前方一致を探す
      if (!bestMatch) {
        for (const option of options) {
          if (option.text.trim().startsWith(text)) {
            bestMatch = option;
            matchType = '前方一致';
            break;
          }
        }
      }

      // 3. 前方一致がなければ、部分一致を探す
      if (!bestMatch) {
        for (const option of options) {
          if (option.text.includes(text)) {
            bestMatch = option;
            matchType = '部分一致';
            break;
          }
        }
      }

      // 4. 部分一致もなければ、逆方向の部分一致（検索テキストがオプションを含む）
      if (!bestMatch) {
        for (const option of options) {
          if (text.includes(option.text.trim()) && option.text.trim().length > 1) {
            bestMatch = option;
            matchType = '逆部分一致';
            break;
          }
        }
      }

      // 5. 類似度ベースのマッチング（ひらがな/カタカナの正規化）
      if (!bestMatch) {
        const normalize = (str) => {
          return str
            .replace(/[\u30a1-\u30f6]/g, (match) => String.fromCharCode(match.charCodeAt(0) - 0x60))
            .replace(/[　\s]/g, '')
            .toLowerCase();
        };
        const normalizedText = normalize(text);
        for (const option of options) {
          if (normalize(option.text) === normalizedText || normalize(option.text).includes(normalizedText)) {
            bestMatch = option;
            matchType = '正規化マッチ';
            break;
          }
        }
      }

      // ========== Phase 3: 選択実行 ==========
      if (bestMatch && !bestMatch.disabled) {
        select.value = bestMatch.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));
        return {
          found: true,
          selectId: select.id,
          selectedValue: bestMatch.value,
          selectedText: bestMatch.text,
          matchType: matchType,
          searchText: text,
          totalOptions: allOptions.length,
          availableOptions: allOptions.slice(0, 10).map(o => o.text)
        };
      }

      return {
        found: false,
        error: 'option not found',
        searchText: text,
        totalOptions: allOptions.length,
        availableOptions: allOptions.map(o => o.text)
      };
    }, selectIndex, optionText);

    // 結果をログ出力
    if (result.found) {
      console.log('  ✓ 選択成功 [' + result.matchType + ']: "' + result.searchText + '" → "' + result.selectedText + '"');
    } else {
      console.log('  ✗ 選択失敗: "' + result.searchText + '"');
      console.log('    利用可能なオプション:', result.availableOptions?.join(', '));
    }

    return result.found;
  }

  /**
   * 町丁目のselect要素から選択（全域を優先、なければ最初のオプション）
   * 選択前に全オプションを遍歴して表示
   * @param {number} selectIndex - モーダル内のselect要素のインデックス（0始まり）
   */
  async selectChoFromDropdown(selectIndex) {
    const result = await this.page.evaluate((index) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;

      const selects = container.querySelectorAll('select.p-listbox-input, select.custom-select, select');

      if (selects.length <= index) {
        return { found: false, error: 'select not found', index, totalSelects: selects.length };
      }

      const select = selects[index];
      const options = Array.from(select.options);

      if (options.length === 0) {
        return { found: false, error: 'no options available' };
      }

      // 全オプションを遍歴して表示
      const allOptions = options.map((o, i) => ({
        index: i,
        value: o.value,
        text: o.text.trim(),
        disabled: o.disabled
      }));

      console.log('【オプション一覧】Select #' + index + ' (' + allOptions.length + '件):');
      allOptions.forEach(o => {
        console.log('  [' + o.index + '] ' + o.text + (o.disabled ? ' (disabled)' : ''));
      });

      // 「全域」を優先的に選択
      for (const option of options) {
        if (option.text === '全域' || option.text.includes('全域')) {
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
          return {
            found: true,
            selectId: select.id,
            selectedValue: option.value,
            selectedText: option.text,
            matchType: '全域優先',
            totalOptions: allOptions.length,
            availableOptions: allOptions.slice(0, 10).map(o => o.text)
          };
        }
      }

      // 全域がなければ最初の有効なオプションを選択
      let firstOption = options[0];
      for (const option of options) {
        if (!option.disabled && option.value) {
          firstOption = option;
          break;
        }
      }

      select.value = firstOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));

      return {
        found: true,
        selectId: select.id,
        selectedValue: firstOption.value,
        selectedText: firstOption.text,
        matchType: '最初のオプション',
        totalOptions: allOptions.length,
        availableOptions: allOptions.slice(0, 10).map(o => o.text)
      };
    }, selectIndex);

    if (result.found) {
      console.log('  ✓ 町丁目選択 [' + result.matchType + ']: "' + result.selectedText + '"');
    } else {
      console.log('  ✗ selectChoFromDropdown失敗:', result.error);
    }
    return result.found;
  }

  /**
   * モーダル内のselect要素の最初のオプションを選択
   * 選択前に全オプションを遍歴して表示
   * @param {number} selectIndex - モーダル内のselect要素のインデックス（0始まり）
   */
  async selectFirstOption(selectIndex) {
    const result = await this.page.evaluate((index) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;

      const selects = container.querySelectorAll('select.p-listbox-input, select.custom-select, select');

      if (selects.length <= index) {
        return { found: false, error: 'select not found', index, totalSelects: selects.length };
      }

      const select = selects[index];
      const options = Array.from(select.options);

      if (options.length === 0) {
        return { found: false, error: 'no options available' };
      }

      // 全オプションを遍歴して表示
      const allOptions = options.map((o, i) => ({
        index: i,
        value: o.value,
        text: o.text.trim(),
        disabled: o.disabled
      }));

      console.log('【オプション一覧】Select #' + index + ' (' + allOptions.length + '件):');
      allOptions.forEach(o => {
        console.log('  [' + o.index + '] ' + o.text + (o.disabled ? ' (disabled)' : ''));
      });

      // 最初の有効なオプションを選択
      let firstOption = options[0];
      for (const option of options) {
        if (!option.disabled && option.value) {
          firstOption = option;
          break;
        }
      }

      select.value = firstOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));

      return {
        found: true,
        selectId: select.id,
        selectedValue: firstOption.value,
        selectedText: firstOption.text,
        totalOptions: options.length,
        availableOptions: allOptions.slice(0, 10).map(o => o.text)
      };
    }, selectIndex);

    if (result.found) {
      console.log('  ✓ 最初のオプションを選択: "' + result.selectedText + '"');
    } else {
      console.log('  ✗ selectFirstOption失敗:', result.error);
    }
    return result.found;
  }

  /**
   * モーダル内のボタンをクリック
   * @param {string} buttonText - ボタンのテキスト
   */
  async clickModalButton(buttonText) {
    const clicked = await this.page.evaluate((text) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;

      // ボタンを探す
      const buttons = container.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === text) {
          btn.click();
          return { clicked: true, text, buttonId: btn.id };
        }
      }

      // テキストが含まれるボタンを探す
      for (const btn of buttons) {
        if (btn.textContent?.includes(text)) {
          btn.click();
          return { clicked: true, text: btn.textContent?.trim(), buttonId: btn.id };
        }
      }

      return { clicked: false, searchText: text };
    }, buttonText);

    console.log('  clickModalButton結果:', clicked);
    return clicked.clicked;
  }

  /**
   * 設備・条件・住宅性能等の入力ガイドを開く
   * ボタンの特徴: contextに「クリア」と「住宅性能」を含む
   */
  async openEquipmentGuide() {
    try {
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 設備・条件・住宅性能等 入力ガイドを開く');
      console.log('└─────────────────────────────────────');

      // スクロールしてオプションセクションを表示
      await this.page.evaluate(() => {
        const elements = document.querySelectorAll('*');
        for (const el of elements) {
          if (el.textContent?.includes('設備・条件・住宅性能等') && el.offsetHeight < 50) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
          }
        }
        window.scrollTo(0, document.body.scrollHeight * 0.6);
        return false;
      });

      await new Promise(resolve => setTimeout(resolve, 1500));

      // 全入力ガイドボタンを分析して設備ボタンを特定
      const buttonAnalysis = await this.page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('button'));
        const guideButtons = allButtons.filter(b => b.textContent?.trim() === '入力ガイド');

        const results = guideButtons.map((btn, index) => {
          let contextText = '';
          let el = btn.parentElement;
          for (let j = 0; j < 3; j++) {
            if (el) {
              contextText = el.innerText?.substring(0, 100) || '';
              el = el.parentElement;
            }
          }
          return {
            index,
            contextText: contextText.replace(/\s+/g, ' ').substring(0, 80),
            isEquipment: contextText.includes('クリア') && contextText.includes('住宅性能')
          };
        });

        return results;
      });

      console.log('  入力ガイドボタン分析:');
      buttonAnalysis.forEach(btn => {
        const mark = btn.isEquipment ? '★' : ' ';
        console.log(`  ${mark}[${btn.index}] ${btn.contextText.substring(0, 50)}...`);
      });

      const equipmentIndex = buttonAnalysis.findIndex(b => b.isEquipment);
      console.log(`  → 設備ボタン index: ${equipmentIndex}`);

      if (equipmentIndex === -1) {
        console.log('  ✗ 設備入力ガイドボタンが見つかりません');
        return false;
      }

      // ボタンをクリック
      const clicked = await this.page.evaluate((targetIndex) => {
        const allButtons = Array.from(document.querySelectorAll('button'));
        const guideButtons = allButtons.filter(b => b.textContent?.trim() === '入力ガイド');

        if (guideButtons[targetIndex]) {
          guideButtons[targetIndex].click();
          return { success: true, index: targetIndex };
        }
        return { success: false };
      }, equipmentIndex);

      if (clicked.success) {
        console.log('  ✓ 設備入力ガイドを開きました');
        await new Promise(resolve => setTimeout(resolve, 2500));
        await this.page.screenshot({ path: 'debug-equipment-guide.png' });
        return true;
      } else {
        console.log('  ✗ クリックに失敗しました');
        return false;
      }

    } catch (error) {
      console.error('設備入力ガイドを開く際にエラー:', error.message);
      return false;
    }
  }

  /**
   * 設備・条件を入力ガイドから選択
   * 選択前に全オプションを遍歴し、最適なマッチを見つける
   * @param {string[]} keywords - 選択したい設備・条件のキーワード
   */
  async selectEquipmentFromGuide(keywords) {
    try {
      console.log('\n┌─────────────────────────────────────');
      console.log('│ 設備・条件の選択');
      console.log('└─────────────────────────────────────');
      console.log('  選択キーワード:', keywords.join(', '));

      await new Promise(resolve => setTimeout(resolve, 2000));

      // ========== Phase 1: 全オプションを遍歴 ==========
      const allOptions = await this.page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]');
        if (!modal) return { found: false };

        const checkboxes = Array.from(modal.querySelectorAll('input[type="checkbox"]'));

        const options = checkboxes.map((cb, i) => {
          // ラベルを取得（複数の方法を試す）
          let label = '';
          const labelEl = document.querySelector(`label[for="${cb.id}"]`);
          if (labelEl) {
            label = labelEl.textContent?.trim();
          }
          if (!label) {
            const parent = cb.closest('.custom-control, .form-check, label, div');
            label = parent?.textContent?.trim()?.replace(/\s+/g, ' ') || '';
          }

          return {
            index: i,
            id: cb.id,
            value: cb.value,
            label: label.substring(0, 40),
            checked: cb.checked
          };
        });

        return { found: true, options, total: options.length };
      });

      if (!allOptions.found) {
        console.log('  ✗ モーダルが見つかりません');
        return [];
      }

      console.log(`\n  【利用可能なオプション】 Total: ${allOptions.total}`);
      console.log('  ' + '-'.repeat(50));

      // オプションをグループ化して表示（最初の30個）
      const displayOptions = allOptions.options.slice(0, 30);
      displayOptions.forEach(opt => {
        console.log(`    [${opt.index}] ${opt.label}`);
      });
      if (allOptions.total > 30) {
        console.log(`    ... 他 ${allOptions.total - 30} 件`);
      }

      // ========== Phase 2: キーワードマッチング ==========
      console.log('\n  【マッチング処理】');

      const selected = await this.page.evaluate((keywordList, allOpts) => {
        const results = [];
        const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]');
        if (!modal) return results;

        for (const keyword of keywordList) {
          let matched = false;

          // 1. 完全一致
          for (const opt of allOpts) {
            if (opt.label === keyword) {
              const checkbox = document.getElementById(opt.id);
              if (checkbox && !checkbox.checked) {
                checkbox.click();
                results.push({ keyword, label: opt.label, matchType: '完全一致', id: opt.id });
                matched = true;
                break;
              }
            }
          }

          // 2. 部分一致
          if (!matched) {
            for (const opt of allOpts) {
              if (opt.label.includes(keyword) || keyword.includes(opt.label)) {
                const checkbox = document.getElementById(opt.id);
                if (checkbox && !checkbox.checked) {
                  checkbox.click();
                  results.push({ keyword, label: opt.label, matchType: '部分一致', id: opt.id });
                  matched = true;
                  break;
                }
              }
            }
          }

          // 3. 類似マッチング（カタカナ・ひらがな正規化）
          if (!matched) {
            const normalize = (str) => {
              return str
                .replace(/[\u30a1-\u30f6]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0x60))
                .replace(/[　\s]/g, '')
                .toLowerCase();
            };
            const normalizedKeyword = normalize(keyword);

            for (const opt of allOpts) {
              if (normalize(opt.label).includes(normalizedKeyword)) {
                const checkbox = document.getElementById(opt.id);
                if (checkbox && !checkbox.checked) {
                  checkbox.click();
                  results.push({ keyword, label: opt.label, matchType: '正規化マッチ', id: opt.id });
                  matched = true;
                  break;
                }
              }
            }
          }

          if (!matched) {
            results.push({ keyword, label: null, matchType: 'マッチなし', id: null });
          }
        }

        return results;
      }, keywords, allOptions.options);

      // 結果を表示
      selected.forEach(item => {
        if (item.label) {
          console.log(`    ✓ "${item.keyword}" → "${item.label}" [${item.matchType}]`);
        } else {
          console.log(`    ✗ "${item.keyword}" → マッチなし`);
        }
      });

      const successCount = selected.filter(s => s.label).length;
      console.log(`\n  選択結果: ${successCount}/${keywords.length} 件成功`);

      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.page.screenshot({ path: 'debug-equipment-selected.png' });

      // ========== Phase 3: 決定ボタンをクリック ==========
      console.log('\n  「決定」をクリック...');
      const closeClicked = await this.page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"]');
        const buttons = modal?.querySelectorAll('button') || [];
        for (const btn of buttons) {
          if (btn.textContent?.trim() === '決定') {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (closeClicked) {
        console.log('  ✓ 設備・条件の選択完了');
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
      return selected.filter(s => s.label);

    } catch (error) {
      console.error('設備選択エラー:', error.message);
      return [];
    }
  }

  async fillSearchConditions(conditions) {
    try {
      await new Promise(resolve => setTimeout(resolve, 3000));

      const reinsFields = conditions.reinsFields || {};
      const userRequirements = conditions.userRequirements || {};
      const textInputs = reinsFields.textInputs || {};
      const selects = reinsFields.selects || {};
      const checkboxes = reinsFields.checkboxes || {};
      const keywords = reinsFields.keywords || [];

      // ========== 智能分析阶段 ==========
      console.log('\n' + '═'.repeat(60));
      console.log('🔍 検索条件の分析と入力');
      console.log('═'.repeat(60));

      console.log('\n【Phase 1】基本条件の設定');
      console.log('─'.repeat(40));

      // 物件種別
      const propertyTypeValue = selects['__BVID__293'] || '03';
      const propertyTypeNames = { '01': '土地', '02': '一戸建', '03': '賃貸マンション/アパート' };
      console.log('  物件種別: ' + (propertyTypeNames[propertyTypeValue] || propertyTypeValue));

      await this.page.evaluate((selectId, value) => {
        const select = document.getElementById(selectId);
        if (select) {
          select.value = value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        const allSelects = document.querySelectorAll('select');
        for (const s of allSelects) {
          const options = Array.from(s.options);
          if (options.some(o => o.text.includes('賃貸マンション'))) {
            s.value = value;
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, '__BVID__293', propertyTypeValue);

      await new Promise(resolve => setTimeout(resolve, 1000));

      // ========== 地域選択 ==========
      console.log('\n【Phase 2】地域の選択（入力ガイド使用）');
      console.log('─'.repeat(40));

      const prefecture = userRequirements.prefecture || textInputs['__BVID__325'] || '東京都';
      const cities = userRequirements.cities || [];

      if (prefecture || cities.length > 0) {
        const locationSelected = await this.selectLocationViaGuide(prefecture, cities);

        if (!locationSelected) {
          // 入力ガイドが失敗した場合、従来のテキスト入力にフォールバック
          console.log('入力ガイド failed, falling back to text input...');
          const prefectureClicked = await this.page.evaluate((inputId) => {
            const input = document.getElementById(inputId);
            if (input) {
              input.focus();
              input.click();
              return true;
            }
            return false;
          }, '__BVID__325');

          if (prefectureClicked) {
            await this.page.keyboard.down('Control');
            await this.page.keyboard.press('a');
            await this.page.keyboard.up('Control');
            await this.page.keyboard.press('Backspace');
            await this.page.keyboard.type(prefecture, { delay: 30 });
            await this.page.keyboard.press('Tab');
            console.log('Prefecture filled via text input');
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      // ========== 沿線・駅選択（オプション - 失敗時はスキップ） ==========
      const line = userRequirements.line || textInputs['__BVID__376'];
      const startStation = userRequirements.startStation;
      const endStation = userRequirements.endStation;
      const station = userRequirements.station;
      let lineSelectionSuccess = false;

      if (line) {
        console.log('\n【Phase 2.5】沿線・駅の選択（入力ガイド使用）');
        console.log('─'.repeat(40));
        console.log('  ※ 沿線選択は任意です。失敗時は所在地のみで検索します。');

        try {
          // 沿線が指定されている場合、入力ガイドで選択を試みる
          const lineSelected = await this.selectLineViaGuide(
            prefecture,
            line,
            startStation || station,  // 始発駅（単一駅指定の場合は両方に同じ駅）
            endStation || station      // 終点駅
          );

          if (lineSelected) {
            lineSelectionSuccess = true;
            console.log('  ✓ 沿線・駅選択成功');
          } else {
            console.log('  ⚠ 沿線選択失敗 - スキップして所在地のみで検索');

            // エラー検出してAIに相談
            const errors = await this.detectPageErrors();
            if (errors && errors.length > 0) {
              const aiAdvice = await this.handleErrorWithAI(errors, {
                line,
                station,
                startStation,
                endStation,
                prefecture
              });

              if (aiAdvice) {
                console.log('  AI推奨:', aiAdvice.action, '-', aiAdvice.reason);
              }
            }

            // モーダルを閉じる（エラー状態をクリア）
            await this.page.evaluate(() => {
              const closeButtons = document.querySelectorAll('button');
              for (const btn of closeButtons) {
                const text = btn.textContent?.trim();
                if (text === '閉じる' || text === 'キャンセル' || text === '戻る') {
                  btn.click();
                  return true;
                }
              }
              // ESCキーでモーダルを閉じる
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
              return false;
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (lineError) {
          console.log('  ⚠ 沿線選択中にエラー:', lineError.message);
          console.log('  → 沿線選択をスキップし、所在地のみで検索を続行');

          // モーダルを閉じる
          await this.page.evaluate(() => {
            const closeButtons = document.querySelectorAll('button');
            for (const btn of closeButtons) {
              const text = btn.textContent?.trim();
              if (text === '閉じる' || text === 'キャンセル' || text === '戻る') {
                btn.click();
                return true;
              }
            }
            return false;
          }).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // 沿線選択の結果をログ
      if (line && !lineSelectionSuccess) {
        console.log('\n【注意】沿線条件は適用されていません。所在地のみで検索します。');
      }

      // ========== その他条件入力 ==========
      console.log('\n【Phase 3】その他条件の入力');
      console.log('─'.repeat(40));

      // フィールド名のマッピング
      const fieldNames = {
        '__BVID__452': '賃料（下限）',
        '__BVID__454': '賃料（上限）',
        '__BVID__481': '面積（下限）',
        '__BVID__483': '面積（上限）',
        '__BVID__520': '階数（下限）',
        '__BVID__385': '徒歩分数'
      };

      const selectNames = {
        '__BVID__525': '向き',
        '__BVID__542': '駐車場'
      };

      // テキスト入力
      let hasTextInput = false;
      for (const [fieldId, value] of Object.entries(textInputs)) {
        if (fieldId === '__BVID__325') continue;
        if (fieldId === '__BVID__329') continue;
        if (fieldId === '__BVID__567') continue;

        const clicked = await this.page.evaluate((id) => {
          const input = document.getElementById(id);
          if (input) {
            input.focus();
            input.click();
            return true;
          }
          return false;
        }, fieldId);

        if (clicked) {
          await this.page.keyboard.down('Control');
          await this.page.keyboard.press('a');
          await this.page.keyboard.up('Control');
          await this.page.keyboard.press('Backspace');
          await this.page.keyboard.type(value.toString(), { delay: 20 });
          await this.page.keyboard.press('Tab');
          const name = fieldNames[fieldId] || fieldId;
          console.log('  ✓ ' + name + ': ' + value);
          hasTextInput = true;
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // セレクト入力
      for (const [selectId, value] of Object.entries(selects)) {
        if (selectId === '__BVID__293') continue;

        await this.page.evaluate((id, val) => {
          const select = document.getElementById(id);
          if (select) {
            select.value = val;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        }, selectId, value);

        const name = selectNames[selectId] || selectId;
        console.log('  ✓ ' + name + ': ' + value);
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // チェックボックス
      let checkedCount = 0;
      for (const [checkboxId, checked] of Object.entries(checkboxes)) {
        if (checked) {
          await this.page.evaluate((id) => {
            const checkbox = document.getElementById(id);
            if (checkbox && !checkbox.checked) {
              checkbox.click();
              return true;
            }
            return false;
          }, checkboxId);

          checkedCount++;
        }
      }
      if (checkedCount > 0) {
        console.log('  ✓ チェックボックス: ' + checkedCount + '項目選択');
      }

      if (!hasTextInput && Object.keys(selects).length <= 1 && checkedCount === 0) {
        console.log('  (追加条件なし)');
      }

      // ========== 設備条件選択 ==========
      if (keywords && keywords.length > 0) {
        console.log('\n【Phase 4】設備・条件の選択（入力ガイド使用）');
        console.log('─'.repeat(40));
        console.log('  選択する設備: ' + keywords.join(', '));

        const guideOpened = await this.openEquipmentGuide();

        if (guideOpened) {
          const selected = await this.selectEquipmentFromGuide(keywords);
          if (selected && selected.length > 0) {
            console.log('  ✓ ' + selected.length + '項目の設備を選択しました');
          }
        } else {
          console.log('  ⚠ 入力ガイドが利用できません、備考欄に入力します');
          if (textInputs['__BVID__567']) {
            const bikoClicked = await this.page.evaluate((id) => {
              const input = document.getElementById(id);
              if (input) {
                input.focus();
                input.click();
                return true;
              }
              return false;
            }, '__BVID__567');

            if (bikoClicked) {
              await this.page.keyboard.down('Control');
              await this.page.keyboard.press('a');
              await this.page.keyboard.up('Control');
              await this.page.keyboard.press('Backspace');
              await this.page.keyboard.type(textInputs['__BVID__567'], { delay: 20 });
              await this.page.keyboard.press('Tab');
              console.log('  ✓ 備考欄に入力: ' + textInputs['__BVID__567']);
            }
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.page.screenshot({ path: 'debug-after-fill.png' });

      console.log('\n' + '═'.repeat(60));
      console.log('✅ 検索条件の入力が完了しました');
      console.log('═'.repeat(60) + '\n');

    } catch (error) {
      console.error('Failed to fill search conditions:', error.message);
      await this.page.screenshot({ path: 'debug-fill-error.png' }).catch(() => {});
    }
  }

  async handleResultsDialog() {
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));

      const dialogHandled = await this.page.evaluate(() => {
        const text = document.body.innerText;
        if (text.includes('500件を超えています') || text.includes('このまま検索を続行しますか')) {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            const btnText = btn.textContent?.trim();
            if (btnText === 'OK' || btnText === 'はい' || btnText === '続行') {
              btn.click();
              return { found: true, clicked: btnText };
            }
          }

          const modals = document.querySelectorAll('.modal, [role="dialog"], .swal2-container, .v-dialog');
          for (const modal of modals) {
            const modalBtns = modal.querySelectorAll('button');
            for (const btn of modalBtns) {
              const btnText = btn.textContent?.trim();
              if (btnText === 'OK' || btnText === 'はい' || btnText === '続行') {
                btn.click();
                return { found: true, clicked: btnText };
              }
            }
          }

          return { found: true, clicked: null };
        }
        return { found: false };
      });

      if (dialogHandled.found) {
        console.log('500件超過ダイアログを検出:', dialogHandled.clicked ? dialogHandled.clicked + 'をクリック' : '対処中');
        await new Promise(resolve => setTimeout(resolve, 3000));
        return true;
      }

      return false;

    } catch (error) {
      console.error('Dialog handling error:', error.message);
      return false;
    }
  }

  async executeSearch(conditions = {}) {
    try {
      console.log('Executing search...');

      const clicked = await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if (text === '検索' || (text.includes('検索') && !text.includes('物件検索') && !text.includes('条件'))) {
            btn.click();
            return text;
          }
        }
        return null;
      });

      if (clicked) {
        console.log('Search button clicked:', clicked);
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 检测搜索后的错误
        const errors = await this.detectPageErrors();
        if (errors && errors.length > 0) {
          console.log('\n⚠ 検索エラーを検出:', errors.join('; '));

          // 使用AI分析错误并获取建议
          const aiAdvice = await this.handleErrorWithAI(errors, conditions);

          if (aiAdvice) {
            console.log('AI推奨アクション:', aiAdvice.action);

            // 根据AI建议采取行动
            if (aiAdvice.action === 'use_location_only' || aiAdvice.action === 'skip_line') {
              console.log('→ 沿線条件をクリアして再検索を試みます...');

              // 清除沿线输入
              await this.page.evaluate(() => {
                const lineInputs = document.querySelectorAll('input[id*="376"], input[id*="380"]');
                lineInputs.forEach(input => {
                  input.value = '';
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                });
              });

              // 关闭错误对话框
              await this.page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                  const text = btn.textContent?.trim();
                  if (text === 'OK' || text === '閉じる' || text === 'キャンセル') {
                    btn.click();
                    return true;
                  }
                }
                return false;
              });

              await new Promise(resolve => setTimeout(resolve, 1000));

              // 重新点击搜索按钮
              await this.page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                  const text = btn.textContent?.trim();
                  if (text === '検索' || (text.includes('検索') && !text.includes('物件検索') && !text.includes('条件'))) {
                    btn.click();
                    return true;
                  }
                }
                return false;
              });

              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
        }

        const hadDialog = await this.handleResultsDialog();
        if (hadDialog) {
          console.log('Handled 500+ results dialog');
        }

        await new Promise(resolve => setTimeout(resolve, 3000));
        await this.page.screenshot({ path: 'debug-search-results.png', fullPage: true });
      } else {
        console.log('Search button not found');
      }

    } catch (error) {
      console.error('Search execution failed:', error.message);
    }
  }

  /**
   * 等待文件下载完成
   */
  async waitForDownload(timeout = 30000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      const pdfFiles = files.filter(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
      if (pdfFiles.length > 0) {
        return pdfFiles.map(f => path.join(DOWNLOADS_DIR, f));
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return [];
  }

  /**
   * 合并多个PDF文件
   */
  async mergePDFs(pdfPaths, outputPath) {
    try {
      console.log('\n📄 PDF合并開始...');
      const mergedPdf = await PDFDocument.create();

      for (const pdfPath of pdfPaths) {
        console.log('  読み込み中:', path.basename(pdfPath));
        const pdfBytes = fs.readFileSync(pdfPath);
        const pdf = await PDFDocument.load(pdfBytes);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
      }

      const mergedBytes = await mergedPdf.save();
      fs.writeFileSync(outputPath, mergedBytes);
      console.log('✅ PDF合并完了:', outputPath);
      return outputPath;
    } catch (error) {
      console.error('PDF合并エラー:', error.message);
      return null;
    }
  }

  /**
   * 物件を選択してPDFをダウンロード
   * REINS の結果ページ構造:
   * - 各物件行の左端にチェックボックス
   * - "ページ内全選択" ボタンで一括選択
   * - "印刷表示" ボタンでPDF出力
   */
  async extractProperties() {
    try {
      console.log('\n📋 物件選択とPDFダウンロード開始...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      await this.page.screenshot({ path: 'debug-results-page.png', fullPage: true });

      // 結果ページの確認
      const pageInfo = await this.page.evaluate(() => {
        const text = document.body.innerText;
        const titleMatch = text.match(/賃貸.*?(\d+)件/);
        const hasResults = text.includes('物件番号') && text.includes('万円');

        // 全選択ボタンを探す
        const buttons = Array.from(document.querySelectorAll('button'));
        const selectAllBtn = buttons.find(b => b.textContent?.includes('ページ内全選択'));
        const printBtn = buttons.find(b => b.textContent?.includes('印刷表示'));

        return {
          hasResults,
          totalCount: titleMatch ? parseInt(titleMatch[1]) : 0,
          hasSelectAllBtn: !!selectAllBtn,
          hasPrintBtn: !!printBtn
        };
      });

      console.log('検索結果:', pageInfo.totalCount, '件');
      console.log('ページ内全選択ボタン:', pageInfo.hasSelectAllBtn ? 'あり' : 'なし');
      console.log('印刷表示ボタン:', pageInfo.hasPrintBtn ? 'あり' : 'なし');

      if (!pageInfo.hasResults) {
        console.log('検索結果がありません');
        return { type: 'properties', properties: [] };
      }

      // 物件のチェックボックスを探す（REINS の構造に合わせる）
      const checkboxInfo = await this.page.evaluate(() => {
        // REINSでは物件リストの各行にチェックボックスがある
        // チェックボックスは通常、物件番号の前にある
        const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));

        // 物件選択用のチェックボックスを特定
        // 親要素のテキストに物件番号（12桁の数字）が含まれるものを探す
        const propertyCheckboxes = allCheckboxes.filter(cb => {
          // 親要素を3階層まで遡って確認
          let parent = cb.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            const text = parent.innerText || '';
            // 物件番号（12桁）または物件情報のキーワードを探す
            if (/\d{12}/.test(text) || (text.includes('万円') && text.includes('㎡'))) {
              return true;
            }
            parent = parent.parentElement;
          }
          return false;
        });

        return {
          total: propertyCheckboxes.length,
          allTotal: allCheckboxes.length
        };
      });

      console.log('物件チェックボックス:', checkboxInfo.total, '件 (全:', checkboxInfo.allTotal, '件)');

      let selectedCount = 0;

      // 方法1: 個別のチェックボックスを選択（最大3件）
      if (checkboxInfo.total > 0) {
        const maxSelect = Math.min(checkboxInfo.total, 3);

        for (let i = 0; i < maxSelect; i++) {
          const selected = await this.page.evaluate((index) => {
            const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            const propertyCheckboxes = allCheckboxes.filter(cb => {
              let parent = cb.parentElement;
              for (let i = 0; i < 5 && parent; i++) {
                const text = parent.innerText || '';
                if (/\d{12}/.test(text) || (text.includes('万円') && text.includes('㎡'))) {
                  return true;
                }
                parent = parent.parentElement;
              }
              return false;
            });

            if (propertyCheckboxes[index] && !propertyCheckboxes[index].checked) {
              propertyCheckboxes[index].click();
              return { success: true };
            }
            return { success: false };
          }, i);

          if (selected.success) {
            selectedCount++;
            console.log(`  ✓ 物件 ${i + 1} を選択`);
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      // 方法2: チェックボックスが見つからない場合、「ページ内全選択」ボタンを試す
      if (selectedCount === 0 && pageInfo.hasSelectAllBtn) {
        console.log('\n「ページ内全選択」ボタンを使用...');
        const clicked = await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const selectAllBtn = buttons.find(b => b.textContent?.includes('ページ内全選択'));
          if (selectAllBtn) {
            selectAllBtn.click();
            return true;
          }
          return false;
        });

        if (clicked) {
          console.log('  ✓ ページ内全選択を実行');
          selectedCount = Math.min(pageInfo.totalCount, 50); // 1ページ最大50件
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      await this.page.screenshot({ path: 'debug-selected-properties.png', fullPage: true });

      // 図面一括取得ボタンをクリック
      if (selectedCount > 0) {
        console.log('\n📋 「図面一括取得」ボタンをクリック...');

        const bulkDownloadClicked = await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          // 優先順位: 図面一括取得 > 図面取得 > 一括取得 > 印刷表示
          const keywords = ['図面一括取得', '図面取得', '一括取得', '印刷表示', '印刷', 'PDF'];

          for (const keyword of keywords) {
            const btn = buttons.find(b => b.textContent?.trim().includes(keyword));
            if (btn) {
              btn.click();
              return { success: true, text: btn.textContent?.trim() };
            }
          }
          return { success: false };
        });

        if (bulkDownloadClicked.success) {
          console.log(`✓ 「${bulkDownloadClicked.text}」をクリック`);
          await new Promise(resolve => setTimeout(resolve, 2000));

          // 確認ダイアログを処理（モーダルやアラート）
          console.log('確認ダイアログを処理中...');
          const confirmResult = await this.page.evaluate(() => {
            // モーダルダイアログを探す
            const modals = document.querySelectorAll('.modal, [role="dialog"], .popup, .dialog');
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                // 確認/OKボタンを探してクリック
                const confirmButtons = modal.querySelectorAll('button');
                for (const btn of confirmButtons) {
                  const text = btn.textContent?.trim() || '';
                  if (text.includes('OK') || text.includes('確認') || text.includes('はい') || text.includes('ダウンロード') || text.includes('取得')) {
                    btn.click();
                    return { clicked: true, text: text };
                  }
                }
              }
            }

            // 通常のボタンも探す
            const allButtons = document.querySelectorAll('button');
            for (const btn of allButtons) {
              const text = btn.textContent?.trim() || '';
              if (text === 'OK' || text === '確認' || text === 'はい') {
                btn.click();
                return { clicked: true, text: text };
              }
            }

            return { clicked: false };
          });

          if (confirmResult.clicked) {
            console.log(`✓ 確認ボタン「${confirmResult.text}」をクリック`);
          }

          await new Promise(resolve => setTimeout(resolve, 3000));
          await this.page.screenshot({ path: 'debug-after-confirm.png', fullPage: true });

          // ダウンロード完了を待機
          console.log('\n⏳ PDFダウンロード完了を待機中...');
          const downloadedFiles = await this.waitForDownload(20000);

          if (downloadedFiles.length > 0) {
            const timestamp = Date.now();
            console.log(`✓ ${downloadedFiles.length}件のPDFをダウンロード`);

            // 複数PDFの場合は合併
            if (downloadedFiles.length > 1) {
              const mergedPath = path.join(DOWNLOADS_DIR, `merged_${timestamp}.pdf`);
              await this.mergePDFs(downloadedFiles, mergedPath);
              return {
                type: 'pdf',
                pdfPath: mergedPath,
                count: selectedCount
              };
            } else {
              return {
                type: 'pdf',
                pdfPath: downloadedFiles[0],
                count: selectedCount
              };
            }
          }

          // ダウンロードが発生しなかった場合、新しいタブをチェック
          const pages = await this.browser.pages();
          console.log('開いているページ数:', pages.length);

          if (pages.length > 1) {
            // 新しいタブ（印刷プレビュー）が開いた場合
            const printPage = pages[pages.length - 1];
            await new Promise(resolve => setTimeout(resolve, 2000));

            // ページタイトルを確認
            const pageTitle = await printPage.title().catch(() => '');
            console.log('プレビューページタイトル:', pageTitle);

            // プレビューページのスクリーンショット
            await printPage.screenshot({ path: 'debug-print-dialog.png', fullPage: true });

            // Puppeteerで直接PDFを生成
            console.log('\n📄 PDFを直接生成中...');
            const timestamp = Date.now();
            const pdfPath = path.join(DOWNLOADS_DIR, `properties_${timestamp}.pdf`);

            try {
              await printPage.pdf({
                path: pdfPath,
                format: 'A4',
                printBackground: true,
                margin: {
                  top: '10mm',
                  right: '10mm',
                  bottom: '10mm',
                  left: '10mm'
                }
              });

              // ファイルが存在するか確認
              if (fs.existsSync(pdfPath)) {
                const stats = fs.statSync(pdfPath);
                console.log(`✓ PDF生成完了: ${path.basename(pdfPath)} (${Math.round(stats.size / 1024)}KB)`);

                // プレビューページを閉じる
                await printPage.close().catch(() => {});

                return {
                  type: 'pdf',
                  pdfPath: pdfPath,
                  count: selectedCount
                };
              }
            } catch (pdfError) {
              console.log('PDF生成エラー:', pdfError.message);
            }

            // PDFの直接生成に失敗した場合、印刷ボタンをクリックしてみる
            console.log('\n印刷ボタンをクリック...');
            const printBtnClicked = await printPage.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              const printBtn = buttons.find(b => b.textContent?.trim() === '印刷');
              if (printBtn) {
                printBtn.click();
                return true;
              }
              return false;
            }).catch(() => false);

            if (printBtnClicked) {
              console.log('✓ 印刷ボタンをクリック');
              await new Promise(resolve => setTimeout(resolve, 3000));
            }

            // ダウンロード完了を待機
            console.log('\n⏳ ダウンロード完了を待機中...');
            const downloadedFiles = await this.waitForDownload(15000);

            if (downloadedFiles.length > 0) {
              console.log(`✓ ${downloadedFiles.length}件のPDFをダウンロード`);

              // PDFを合并
              const mergedPath = path.join(DOWNLOADS_DIR, `merged_${timestamp}.pdf`);
              await this.mergePDFs(downloadedFiles, mergedPath);

              // 印刷プレビューページを閉じる
              await printPage.close().catch(() => {});

              return {
                type: 'pdf',
                pdfPath: mergedPath,
                count: selectedCount
              };
            }

            // 印刷プレビューページを閉じる
            await printPage.close().catch(() => {});
          }
        }
      }

      // PDFダウンロードに失敗した場合、従来の詳細抽出にフォールバック
      console.log('\nPDFダウンロードに失敗、詳細抽出にフォールバック...');
      return await this.extractPropertiesViaDetail();

    } catch (error) {
      console.error('物件抽出エラー:', error.message);
      await this.page.screenshot({ path: 'debug-extract-error.png', fullPage: true }).catch(() => {});
      return { type: 'error', error: error.message };
    }
  }

  /**
   * 詳細ボタンから物件情報を抽出（フォールバック用）
   */
  async extractPropertiesViaDetail() {
    const properties = [];

    const detailButtonCount = await this.page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a, span'));
      return buttons.filter(b => b.textContent?.trim() === '詳細').length;
    });

    console.log('Found', detailButtonCount, '詳細 buttons');
    const maxProperties = Math.min(detailButtonCount, 3);

    for (let i = 0; i < maxProperties; i++) {
      try {
        console.log('\nExtracting property', (i + 1), '/', maxProperties);

        const clicked = await this.page.evaluate((index) => {
          const buttons = Array.from(document.querySelectorAll('button, a, span'));
          const detailButtons = buttons.filter(b => b.textContent?.trim() === '詳細');
          if (detailButtons[index]) {
            detailButtons[index].click();
            return true;
          }
          return false;
        }, i);

        if (!clicked) continue;

        await new Promise(resolve => setTimeout(resolve, 2500));

        const propertyData = await this.page.evaluate(() => {
          const text = document.body.innerText;
          const data = { propertyNo: '', name: '', location: '', rent: '', area: '', layout: '' };

          const propNoMatch = text.match(/物件番号[：:\s]*(\d{12})/);
          if (propNoMatch) data.propertyNo = propNoMatch[1];

          const locationMatch = text.match(/所在地[：:\s]*([^\n]+)/);
          if (locationMatch) data.location = locationMatch[1].trim().substring(0, 50);

          const rentMatch = text.match(/賃料[：:\s]*([\d,.]+)万円/);
          if (rentMatch) data.rent = rentMatch[1] + '万円';

          const areaMatch = text.match(/(?:専有面積|面積)[：:\s]*([\d.]+)(?:m²|㎡)/);
          if (areaMatch) data.area = areaMatch[1] + '㎡';

          const layoutMatch = text.match(/間取[り]?[：:\s]*([1-9][SLDK]{1,4}|ワンルーム)/);
          if (layoutMatch) data.layout = layoutMatch[1];

          return data;
        });

        propertyData.index = i + 1;
        properties.push(propertyData);

        console.log('  物件番号:', propertyData.propertyNo || 'N/A');
        console.log('  賃料:', propertyData.rent || 'N/A');

        await this.page.goBack({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1500));

      } catch (err) {
        console.log('Error extracting property', (i + 1), ':', err.message);
        await this.page.goBack({ waitUntil: 'networkidle0', timeout: 5000 }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return { type: 'properties', properties };
  }

  async searchProperties(username, password, conditions) {
    try {
      await this.login(username, password);
      await this.navigateToRentalSearch();
      await this.fillSearchConditions(conditions);
      await this.executeSearch(conditions);  // 传递条件用于AI错误处理
      const properties = await this.extractProperties();
      await this.close();
      return properties;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

module.exports = new ReinsService();
