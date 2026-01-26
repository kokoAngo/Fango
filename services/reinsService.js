const puppeteer = require('puppeteer');
const { PDFDocument, degrees } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { getSelectionPath, normalizePrefecture } = require('./areaMapping');
const { getKanaRowForLine, getRegionForPrefecture } = require('./lineMapping');
const OpenAI = require('openai');
const reinsCache = require('./reinsCacheService');

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
   * @param {boolean} clearOld - 是否清空旧文件（默认false）
   */
  ensureDownloadDir(clearOld = false) {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
    // 只有明确指定时才清空旧文件
    if (clearOld) {
      const files = fs.readdirSync(DOWNLOADS_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(DOWNLOADS_DIR, file));
      }
    }
    return DOWNLOADS_DIR;
  }

  async initBrowser() {
    if (!this.browser) {
      const options = {
        headless: false,
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

  async login(username, password, customDownloadDir = null) {
    try {
      const browser = await this.initBrowser();
      this.page = await browser.newPage();
      await this.page.setViewport({ width: 1920, height: 1080 });

      // 配置下载目录（使用自定义目录或默认目录）
      this.currentDownloadDir = customDownloadDir || this.ensureDownloadDir();
      if (customDownloadDir && !fs.existsSync(customDownloadDir)) {
        fs.mkdirSync(customDownloadDir, { recursive: true });
      }
      const client = await this.page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: this.currentDownloadDir
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
  async selectLocationViaGuide(prefecture, cities, detail = null) {
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
      let selectedWard = null; // キャッシュ用に選択されたward名を記録
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
              selectedWard = matchedOption;
              console.log('           → 選択: "' + matchedOption + '" (需要: "' + c + '")');
              break;
            }
          }
        }
        if (!citySelected) {
          console.log('           → 需要に合うオプションなし、最初のオプションを選択');
          await this.selectFirstOption(1);
          selectedWard = cityOptions[0] || null;
        }
      } else {
        const citySelected = await this.selectFirstOption(1);
        selectedWard = cityOptions[0] || null;
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

      // 選択後、町丁目リストが更新されるまで待機
      console.log('           → 町丁目リストの更新を待機中...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 選択が正しく反映されたか確認
      const verifyResult = await this.page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
        const container = modal || document;
        const selects = container.querySelectorAll('select.p-listbox-input, select.custom-select, select');
        if (selects.length >= 2) {
          const leftSelect = selects[0];
          const rightSelect = selects[1];
          const leftSelected = leftSelect.options[leftSelect.selectedIndex];
          const rightOptions = Array.from(rightSelect.options).map(o => o.text.trim());
          return {
            leftSelectedText: leftSelected ? leftSelected.text.trim() : null,
            leftSelectedIndex: leftSelect.selectedIndex,
            rightOptionsCount: rightOptions.length,
            rightFirstOptions: rightOptions.slice(0, 5)
          };
        }
        return null;
      });

      if (verifyResult) {
        console.log('           【選択確認】');
        console.log('             左側選択中: "' + verifyResult.leftSelectedText + '" (index: ' + verifyResult.leftSelectedIndex + ')');
        console.log('             右側オプション数: ' + verifyResult.rightOptionsCount);
        console.log('             右側先頭5件: ' + verifyResult.rightFirstOptions.join(', '));
      }

      await this.page.screenshot({ path: 'debug-location-guide-6.png' });

      // Step 8: 町丁目を選択（2番目のselect - AIに選んでもらう）
      console.log('  [Step 8] 町丁目を選択:');
      console.log('           詳細地名ヒント: ' + (detail || '(なし)'));
      const choSelected = detail
        ? await this.selectChoWithAI(1, detail, city, normalizedPref, selectedWard)
        : await this.selectChoFromDropdown(1, normalizedPref, selectedWard);
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

      // 駅の選択肢を取得してキャッシュに保存
      const stationOptions = await this.getSelectOptions(0);
      if (stationOptions.length > 0 && prefecture && lineName) {
        const added = await reinsCache.addLine(prefecture, lineName, stationOptions);
        if (added > 0) {
          console.log(`  [Cache] ${added}件の駅をキャッシュに保存 (${lineName})`);
        }
      }

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
        // 方法1: optionをクリックしてVueの反応をトリガー
        const optionIndex = options.indexOf(bestMatch);

        // まずselectをフォーカス
        select.focus();

        // selectedIndexを設定（これがVueの反応をトリガーする場合がある）
        select.selectedIndex = optionIndex;

        // 値も設定
        select.value = bestMatch.value;

        // 複数のイベントを発火してVue/Bootstrap-Vueの反応を確保
        // MouseEventでオプションをクリック
        bestMatch.selected = true;

        // 各種イベントを発火
        select.dispatchEvent(new Event('focus', { bubbles: true }));
        select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        select.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));

        // Vue 3 / Vue 2 の InputEvent もトリガー
        try {
          select.dispatchEvent(new InputEvent('input', { bubbles: true, data: bestMatch.value }));
        } catch (e) {
          // InputEvent がサポートされていない場合は無視
        }

        // blur して再度変更を確定
        select.blur();
        select.focus();

        console.log('【選択実行】index=' + optionIndex + ', value=' + bestMatch.value + ', text=' + bestMatch.text.trim());

        return {
          found: true,
          selectId: select.id,
          selectedValue: bestMatch.value,
          selectedText: bestMatch.text,
          matchType: matchType,
          searchText: text,
          totalOptions: allOptions.length,
          availableOptions: allOptions.slice(0, 10).map(o => o.text),
          selectedIndex: optionIndex
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
   * @param {string} prefecture - 都道府県名（キャッシュ用）
   * @param {string} ward - 区名（キャッシュ用）
   */
  async selectChoFromDropdown(selectIndex, prefecture = null, ward = null) {
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
      // 町丁目をキャッシュに保存（「全域」以外）
      if (prefecture && ward && result.availableOptions) {
        const townNames = result.availableOptions.filter(t => t && t !== '全域');
        if (townNames.length > 0) {
          const added = await reinsCache.addTowns(prefecture, ward, ward, townNames);
          if (added > 0) {
            console.log(`           [Cache] ${added}件の町丁目をキャッシュに保存`);
          }
        }
      }
      console.log('  ✓ 町丁目選択 [' + result.matchType + ']: "' + result.selectedText + '"');
    } else {
      console.log('  ✗ selectChoFromDropdown失敗:', result.error);
    }
    return result.found;
  }

  /**
   * AI を使用して町丁目を選択
   * @param {number} selectIndex - select要素のインデックス
   * @param {string} detailHint - ユーザーが指定した詳細地名（例: "大岡山"）
   * @param {string} city - 市区町村名
   * @param {string} prefecture - 都道府県名（キャッシュ用）
   * @param {string} ward - 区名（キャッシュ用）
   */
  async selectChoWithAI(selectIndex, detailHint, city, prefecture = null, ward = null) {
    // まず選択肢を取得
    const optionsData = await this.page.evaluate((index) => {
      const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
      const container = modal || document;
      const selects = container.querySelectorAll('select.p-listbox-input, select.custom-select, select');

      if (selects.length <= index) {
        return { found: false, error: 'select not found' };
      }

      const select = selects[index];
      const options = Array.from(select.options).map((o, i) => ({
        index: i,
        value: o.value,
        text: o.text.trim(),
        disabled: o.disabled
      })).filter(o => !o.disabled && o.text);

      return { found: true, options, selectId: select.id };
    }, selectIndex);

    if (!optionsData.found || !optionsData.options || optionsData.options.length === 0) {
      console.log('  ⚠ 町丁目の選択肢が取得できません');
      return this.selectChoFromDropdown(selectIndex);
    }

    // 町丁目をキャッシュに保存（「全域」以外）
    if (prefecture && ward && optionsData.options.length > 0) {
      const townNames = optionsData.options
        .map(o => o.text)
        .filter(t => t && t !== '全域');
      if (townNames.length > 0) {
        const added = await reinsCache.addTowns(prefecture, city || ward, ward, townNames);
        if (added > 0) {
          console.log(`           [Cache] ${added}件の町丁目をキャッシュに保存`);
        }
      }
    }

    // オプションをログに表示
    console.log('           【町丁目の選択肢】 (' + optionsData.options.length + '件):');
    optionsData.options.slice(0, 20).forEach((opt, i) => {
      console.log('             [' + i + '] ' + opt.text);
    });
    if (optionsData.options.length > 20) {
      console.log('             ... 他 ' + (optionsData.options.length - 20) + ' 件');
    }

    // detailHint がない場合、または「全域」がある場合はデフォルト処理
    if (!detailHint || detailHint.trim() === '') {
      console.log('           → 詳細地名未指定、デフォルト選択');
      return this.selectChoFromDropdown(selectIndex);
    }

    // AI に選択を依頼
    const client = this.initOpenAI();
    if (!client) {
      console.log('           → OpenAI未設定、デフォルト選択');
      return this.selectChoFromDropdown(selectIndex);
    }

    try {
      console.log('           → 🤖 AI に最適な町丁目を選択してもらいます...');

      const optionTexts = optionsData.options.map(o => o.text);
      const prompt = `不動産検索で「${city}」の町丁目を選択しています。

ユーザーの希望する詳細地名: 「${detailHint}」

利用可能な選択肢:
${optionTexts.map((t, i) => `${i}. ${t}`).join('\n')}

上記の選択肢から、ユーザーの希望に最も近いものを1つ選んでください。
「全域」は広く検索できるので、具体的な町名がマッチしない場合は「全域」を選んでください。

回答はJSON形式で:
{"selectedIndex": 数字, "selectedText": "選択した項目名", "reason": "選択理由"}`;

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 200,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.choices[0].message.content.trim();
      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const aiChoice = JSON.parse(jsonMatch[0]);
        console.log('           → AI選択: "' + aiChoice.selectedText + '" (' + aiChoice.reason + ')');

        // AI が選んだ選択肢を実際に選択
        const selectedOpt = optionsData.options.find(o =>
          o.text === aiChoice.selectedText || o.index === aiChoice.selectedIndex
        );

        if (selectedOpt) {
          const selectResult = await this.page.evaluate((index, value) => {
            const modal = document.querySelector('.modal.show, .modal[style*="display: block"], [role="dialog"], .modal');
            const container = modal || document;
            const selects = container.querySelectorAll('select.p-listbox-input, select.custom-select, select');
            if (selects.length <= index) return false;

            const select = selects[index];
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }, selectIndex, selectedOpt.value);

          if (selectResult) {
            console.log('  ✓ 町丁目選択 [AI選択]: "' + selectedOpt.text + '"');
            return true;
          }
        }
      }
    } catch (error) {
      console.log('           → AI選択エラー:', error.message);
    }

    // フォールバック
    console.log('           → AIフォールバック、デフォルト選択');
    return this.selectChoFromDropdown(selectIndex);
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
      let firstOptionIndex = 0;
      for (let i = 0; i < options.length; i++) {
        if (!options[i].disabled && options[i].value) {
          firstOption = options[i];
          firstOptionIndex = i;
          break;
        }
      }

      // フォーカスしてから選択
      select.focus();

      // selectedIndexを設定
      select.selectedIndex = firstOptionIndex;

      // 値も設定
      select.value = firstOption.value;

      // オプションを選択状態に
      firstOption.selected = true;

      // 複数のイベントを発火してVue/Bootstrap-Vueの反応を確保
      select.dispatchEvent(new Event('focus', { bubbles: true }));
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      select.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));

      // Vue 3 / Vue 2 の InputEvent もトリガー
      try {
        select.dispatchEvent(new InputEvent('input', { bubbles: true, data: firstOption.value }));
      } catch (e) {
        // InputEvent がサポートされていない場合は無視
      }

      // blur して再度変更を確定
      select.blur();
      select.focus();

      console.log('【選択実行】index=' + firstOptionIndex + ', value=' + firstOption.value + ', text=' + firstOption.text.trim());

      return {
        found: true,
        selectId: select.id,
        selectedValue: firstOption.value,
        selectedText: firstOption.text,
        totalOptions: options.length,
        availableOptions: allOptions.slice(0, 10).map(o => o.text),
        selectedIndex: firstOptionIndex
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

      // ========== 検索方法の判定 ==========
      // searchMethod が "line" の場合は所在地選択をスキップし、沿線選択のみを行う
      const searchMethod = userRequirements.searchMethod || 'location';
      const shouldSelectLine = searchMethod === 'line' || searchMethod === 'bus';
      const shouldSelectLocation = searchMethod === 'location' || !shouldSelectLine;

      const prefecture = userRequirements.prefecture || textInputs['__BVID__325'] || '東京都';
      const cities = userRequirements.cities || [];
      // detail を locations から取得（最初の location の detail を使用）
      const detail = userRequirements.locations && userRequirements.locations.length > 0
        ? userRequirements.locations[0].detail
        : null;

      // ========== 地域選択（所在地検索の場合のみ） ==========
      if (shouldSelectLocation) {
        console.log('\n【Phase 2】地域の選択（入力ガイド使用）');
        console.log('─'.repeat(40));

        console.log('[fillSearchConditions] detail読み取り:');
        console.log('  userRequirements.locations:', JSON.stringify(userRequirements.locations, null, 2));
        console.log('  detail:', detail);

        if (prefecture || cities.length > 0) {
          const locationSelected = await this.selectLocationViaGuide(prefecture, cities, detail);

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
      } else {
        console.log('\n【Phase 2】地域の選択: スキップ（沿線検索モード）');
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      // ========== 沿線・駅選択（沿線検索の場合のみ） ==========
      // 沿線情報を取得（searchMethod が line の場合のみ textInputs から取得）
      const line = shouldSelectLine ? (userRequirements.line || textInputs['__BVID__376']) : userRequirements.line;
      const startStation = userRequirements.startStation;
      const endStation = userRequirements.endStation;
      const station = userRequirements.station;
      let lineSelectionSuccess = false;

      // searchMethod に基づいてログを出力
      if (!shouldSelectLine) {
        console.log('\n【Phase 2.5】沿線・駅の選択: スキップ（所在地検索モード）');
      }

      if (line && shouldSelectLine) {
        console.log('\n【Phase 2.5】沿線・駅の選択（入力ガイド使用）');
        console.log('─'.repeat(40));
        console.log('  ※ 沿線検索モード: 所在地は未指定、沿線・駅のみで検索します。');

        try {
          // 沿線が指定されている場合、入力ガイドで選択を試みる
          const lineGuideIndex = userRequirements.lineGuideIndex || 3;  // デフォルトは沿線1
          const lineSelected = await this.selectLineViaGuide(
            prefecture,
            line,
            startStation || station,  // 始発駅（単一駅指定の場合は両方に同じ駅）
            endStation || station,     // 終点駅
            lineGuideIndex             // 沿線セクションのインデックス
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
        '__WALK_MINUTES__': '徒歩分数'
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

        let clicked = false;

        // 徒歩分数は動的にフィールドを検索（BVIDは毎回変わる可能性があるため）
        if (fieldId === '__WALK_MINUTES__') {
          // 沿線セクションに対応する徒歩分数フィールドを選択
          // lineGuideIndex: 沿線1=3, 沿線2=4, 沿線3=5
          // walkFieldIndex: 沿線1=0, 沿線2=1, 沿線3=2
          const lineGuideIndex = userRequirements.lineGuideIndex || 3;
          const walkFieldIndex = lineGuideIndex - 3;

          clicked = await this.page.evaluate((targetIndex) => {
            // 沿線エリア内で maxLength=5 の入力フィールドを探す
            // 駅名入力欄の下にある、左側の maxLength=5 フィールドが徒歩分数
            const allInputs = Array.from(document.querySelectorAll('input[type="text"][maxlength="5"]'));

            // 位置情報を取得して、最も上かつ左にあるものを選択
            const inputsWithPosition = allInputs.map(input => {
              const rect = input.getBoundingClientRect();
              return { input, top: rect.top, left: rect.left, id: input.id };
            }).filter(item => item.top > 0 && item.left > 0); // 表示されているもののみ

            // top でソートし、同じ top なら left でソート
            inputsWithPosition.sort((a, b) => {
              if (Math.abs(a.top - b.top) < 10) { // 同じ行とみなす
                return a.left - b.left; // 左側を優先
              }
              return a.top - b.top; // 上を優先
            });

            console.log('[徒歩分数] 検出されたmaxLength=5フィールド:', inputsWithPosition.length, '件');
            console.log('[徒歩分数] targetIndex:', targetIndex);

            // 指定されたインデックスの徒歩分数フィールドを選択
            if (inputsWithPosition.length > targetIndex) {
              const target = inputsWithPosition[targetIndex].input;
              target.focus();
              target.click();
              console.log('[徒歩分数] 沿線' + (targetIndex + 1) + 'のフィールドを選択: id=' + target.id);
              return true;
            }

            // フォールバック: 最初のフィールドを使用
            if (inputsWithPosition.length > 0) {
              const target = inputsWithPosition[0].input;
              target.focus();
              target.click();
              console.log('[徒歩分数] フォールバック: 最初のフィールドを選択: id=' + target.id);
              return true;
            }

            console.log('[徒歩分数] maxLength=5 の入力フィールドが見つかりません');
            return false;
          }, walkFieldIndex);
        } else {
          clicked = await this.page.evaluate((id) => {
            const input = document.getElementById(id);
            if (input) {
              input.focus();
              input.click();
              return true;
            }
            return false;
          }, fieldId);
        }

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
    const downloadDir = this.currentDownloadDir || DOWNLOADS_DIR;
    const existingFiles = new Set(fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : []);
    return this.waitForDownloadWithExisting(timeout, existingFiles);
  }

  /**
   * 等待文件下载完成（使用预先记录的文件列表）
   * 重要：等待所有下载完成后再返回（REINS可能会分割成多个PDF）
   */
  async waitForDownloadWithExisting(timeout = 30000, existingFiles = new Set()) {
    const downloadDir = this.currentDownloadDir || DOWNLOADS_DIR;
    const startTime = Date.now();

    console.log(`  等待目录: ${downloadDir}`);
    console.log(`  排除文件数: ${existingFiles.size}`);

    let foundNewPdf = false;
    let stableCount = 0;  // 用于检测下载是否稳定完成

    while (Date.now() - startTime < timeout) {
      if (!fs.existsSync(downloadDir)) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      const files = fs.readdirSync(downloadDir);

      // 检查是否有正在下载的文件
      const downloadingFiles = files.filter(f =>
        f.endsWith('.crdownload') || f.endsWith('.tmp') || f.endsWith('.download')
      );

      // 只返回新下载的PDF文件（排除已有文件和临时下载文件）
      const newPdfFiles = files.filter(f =>
        f.endsWith('.pdf') &&
        !f.endsWith('.crdownload') &&
        !existingFiles.has(f)
      );

      if (downloadingFiles.length > 0) {
        console.log(`  下载中: ${downloadingFiles.join(', ')}`);
        stableCount = 0;  // 还有文件在下载，重置稳定计数
        foundNewPdf = newPdfFiles.length > 0;
      } else if (newPdfFiles.length > 0) {
        // 没有正在下载的文件，且有新PDF
        stableCount++;

        if (stableCount >= 2) {
          // 等待2次循环确认下载稳定完成（防止新下载刚开始）
          console.log(`  检测到新文件: ${newPdfFiles.join(', ')}`);
          return newPdfFiles.map(f => path.join(downloadDir, f));
        }
      } else if (foundNewPdf) {
        // 之前有新PDF但现在没有了（可能是检测错误），继续等待
        stableCount = 0;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 超时后最后检查一次
    const finalFiles = fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : [];
    const finalNewPdfs = finalFiles.filter(f =>
      f.endsWith('.pdf') &&
      !f.endsWith('.crdownload') &&
      !existingFiles.has(f)
    );

    if (finalNewPdfs.length > 0) {
      console.log(`  超时，但找到新文件: ${finalNewPdfs.join(', ')}`);
      return finalNewPdfs.map(f => path.join(downloadDir, f));
    }

    console.log(`  超时，目录中的文件: ${finalFiles.join(', ') || '(无)'}`);
    return [];
  }

  /**
   * 将PDF页面渲染为图片（Base64）- 使用Puppeteer + PDF.js CDN
   * @param {string} pdfPath - PDF文件路径
   * @param {number} pageNum - 页码（从1开始）
   * @returns {string} - Base64编码的PNG图片
   */
  async renderPdfPageToImage(pdfPath, pageNum) {
    let browser = null;
    try {
      // 读取PDF文件并转换为Base64
      const pdfBytes = fs.readFileSync(pdfPath);
      const pdfBase64 = pdfBytes.toString('base64');

      // 启动临时浏览器实例
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 850, height: 1200 });

      // 创建内嵌PDF.js的HTML页面
      const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
          <style>
            body { margin: 0; padding: 0; background: white; }
            canvas { display: block; }
          </style>
        </head>
        <body>
          <canvas id="pdf-canvas"></canvas>
          <script>
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

            async function renderPdf() {
              const pdfData = atob('${pdfBase64}');
              const pdfArray = new Uint8Array(pdfData.length);
              for (let i = 0; i < pdfData.length; i++) {
                pdfArray[i] = pdfData.charCodeAt(i);
              }

              const pdf = await pdfjsLib.getDocument({ data: pdfArray }).promise;
              const pdfPage = await pdf.getPage(${pageNum});

              const scale = 1.5;
              const viewport = pdfPage.getViewport({ scale });

              const canvas = document.getElementById('pdf-canvas');
              const context = canvas.getContext('2d');
              canvas.width = viewport.width;
              canvas.height = viewport.height;

              await pdfPage.render({
                canvasContext: context,
                viewport: viewport
              }).promise;

              window.pdfRendered = true;
            }

            renderPdf().catch(err => {
              console.error('PDF render error:', err);
              window.pdfError = err.message;
            });
          </script>
        </body>
        </html>
      `;

      await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 30000 });

      // 等待PDF渲染完成
      await page.waitForFunction(() => window.pdfRendered || window.pdfError, { timeout: 30000 });

      // 检查是否有错误
      const pdfError = await page.evaluate(() => window.pdfError);
      if (pdfError) {
        throw new Error(pdfError);
      }

      // 获取canvas尺寸并截图
      const canvasBox = await page.$eval('#pdf-canvas', el => ({
        width: el.width,
        height: el.height
      }));

      // 调整viewport以适应canvas
      await page.setViewport({ width: canvasBox.width, height: canvasBox.height });

      const screenshot = await page.screenshot({
        encoding: 'base64',
        type: 'png',
        clip: { x: 0, y: 0, width: canvasBox.width, height: canvasBox.height }
      });

      return screenshot;
    } catch (error) {
      console.error(`  ⚠️ ページ ${pageNum} の画像変換エラー:`, error.message);
      return null;
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }

  /**
   * GPT Vision でPDF页面の正しい向きを分析
   * @param {string} base64Image - Base64编码的图片
   * @param {number} pageNum - 页码
   * @returns {number} - 需要旋转的角度（0, 90, 180, 270）
   */
  async analyzePageOrientationWithGPT(base64Image, pageNum) {
    const client = this.initOpenAI();
    if (!client || !base64Image) return 0;

    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `この画像は不動産物件の図面または情報ページです。
画像が正しく読める向きになっているか確認してください。

文字やテキストが正しい向き（上から下、左から右）で読めるように、
画像を何度回転させる必要がありますか？

回答は数字のみ（0, 90, 180, 270のいずれか）:
- 0 = 回転不要（正しい向き）
- 90 = 右に90度回転が必要
- 180 = 180度回転が必要
- 270 = 左に90度回転が必要（または右に270度）

数字のみで回答してください。`
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64Image}`,
                  detail: 'low'
                }
              }
            ]
          }
        ]
      });

      const content = response.choices[0].message.content.trim();
      const rotation = parseInt(content.match(/\d+/)?.[0] || '0', 10);

      if ([0, 90, 180, 270].includes(rotation)) {
        return rotation;
      }
      return 0;
    } catch (error) {
      console.error(`  ⚠️ GPT分析エラー (ページ ${pageNum}):`, error.message);
      return 0;
    }
  }

  /**
   * GPT Visionを使用してPDFの全ページの向きを分析
   * @param {string} pdfPath - PDF文件路径
   * @returns {Array<number>} - 各ページの必要回転角度
   */
  async analyzePdfOrientationWithGPT(pdfPath) {
    console.log('  🤖 GPT Visionでページ向きを分析中...');

    try {
      // 使用 pdf-lib 获取页数
      const pdfBytes = fs.readFileSync(pdfPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const numPages = pdfDoc.getPageCount();

      const rotations = [];

      for (let i = 1; i <= numPages; i++) {
        process.stdout.write(`    ページ ${i}/${numPages}: `);

        const base64Image = await this.renderPdfPageToImage(pdfPath, i);
        if (!base64Image) {
          console.log('画像変換失敗、スキップ');
          rotations.push(0);
          continue;
        }

        const rotation = await this.analyzePageOrientationWithGPT(base64Image, i);
        rotations.push(rotation);

        if (rotation === 0) {
          console.log('正常 ✓');
        } else {
          console.log(`${rotation}°回転が必要`);
        }
      }

      return rotations;
    } catch (error) {
      console.error('  ⚠️ PDF分析エラー:', error.message);
      return [];
    }
  }

  /**
   * 检测并校正PDF页面方向（简单宽高比方式，作为fallback）
   * 如果页面是横向（宽 > 高），则旋转90度变为纵向
   * @param {PDFPage} page - PDF页面对象
   * @returns {boolean} - 是否进行了旋转
   */
  correctPageOrientation(page) {
    const { width, height } = page.getSize();
    const currentRotation = page.getRotation().angle;

    // 考虑当前旋转角度后的实际方向
    // 0° 或 180°: 原始方向
    // 90° 或 270°: 宽高互换
    const isRotated90or270 = (currentRotation === 90 || currentRotation === 270);
    const effectiveWidth = isRotated90or270 ? height : width;
    const effectiveHeight = isRotated90or270 ? width : height;

    // 如果实际宽度 > 实际高度，说明是横向，需要旋转
    if (effectiveWidth > effectiveHeight) {
      const newRotation = (currentRotation + 90) % 360;
      page.setRotation(degrees(newRotation));
      console.log(`    📐 ページ回転: ${currentRotation}° → ${newRotation}° (横向き→縦向き)`);
      return true;
    }
    return false;
  }

  /**
   * 合并多个PDF文件
   * @param {string[]} pdfPaths - PDF文件路径数组
   * @param {string} outputPath - 输出文件路径
   * @param {boolean|string} correctOrientation - 方向校正模式（暂时弃用，默认false）
   *   - true/'gpt': 使用GPT Vision分析
   *   - 'simple': 使用简单宽高比方式
   *   - false: 不校正（默认）
   */
  async mergePDFs(pdfPaths, outputPath, correctOrientation = false) {
    try {
      console.log('\n📄 PDF合并開始...');

      const useGPT = correctOrientation === true || correctOrientation === 'gpt';
      const useSimple = correctOrientation === 'simple';

      if (useGPT) {
        console.log('  📐 ページ方向補正: GPT Vision（AI分析）');
      } else if (useSimple) {
        console.log('  📐 ページ方向補正: 簡易モード（横→縦）');
      }

      // Step 1: 如果使用GPT，先分析所有PDF的页面方向
      const allRotations = new Map(); // pdfPath -> [rotations]

      if (useGPT) {
        for (const pdfPath of pdfPaths) {
          console.log(`  分析中: ${path.basename(pdfPath)}`);
          const rotations = await this.analyzePdfOrientationWithGPT(pdfPath);
          allRotations.set(pdfPath, rotations);
        }
      }

      // Step 2: 合并PDF并应用旋转
      const mergedPdf = await PDFDocument.create();
      let rotatedCount = 0;

      for (const pdfPath of pdfPaths) {
        console.log('  読み込み中:', path.basename(pdfPath));
        const pdfBytes = fs.readFileSync(pdfPath);
        const pdf = await PDFDocument.load(pdfBytes);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        const rotations = allRotations.get(pdfPath) || [];

        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];

          if (useGPT && rotations[i] && rotations[i] !== 0) {
            // GPT分析结果：应用指定的旋转角度
            const currentRotation = page.getRotation().angle;
            const newRotation = (currentRotation + rotations[i]) % 360;
            page.setRotation(degrees(newRotation));
            console.log(`    📐 ページ${i + 1}: ${currentRotation}° → ${newRotation}°`);
            rotatedCount++;
          } else if (useSimple) {
            // 简单模式：横向变纵向
            if (this.correctPageOrientation(page)) {
              rotatedCount++;
            }
          }

          mergedPdf.addPage(page);
        }
      }

      if (rotatedCount > 0) {
        console.log(`  📐 合計 ${rotatedCount} ページを回転しました`);
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
      const selectedPropertyIds = [];  // 選択した物件IDを保存

      // 方法1: 「ページ内全選択」ボタンを優先使用（高速）
      if (pageInfo.hasSelectAllBtn) {
        console.log('\n「ページ内全選択」ボタンを使用（高速モード）...');

        // ページ全選択ボタンをクリック（より確実な方法）
        const clicked = await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const selectAllBtn = buttons.find(b => b.textContent?.includes('ページ内全選択'));
          if (selectAllBtn) {
            // イベントを確実に発火させる
            selectAllBtn.focus();
            selectAllBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
          }
          return false;
        });

        // クリック後に追加で待機
        await new Promise(resolve => setTimeout(resolve, 1000));

        // ページ全選択の効果を確認するためスクリーンショット
        await this.page.screenshot({ path: 'debug-after-select-all.png', fullPage: true });

        if (clicked) {
          console.log('  ✓ ページ内全選択を実行');
          await new Promise(resolve => setTimeout(resolve, 2000));

          // 全選択後に物件IDを抽出（複数の方法を試す）
          const allIds = await this.page.evaluate(() => {
            const ids = [];

            // 方法1: チェック済みチェックボックスから抽出
            const checkedBoxes = Array.from(document.querySelectorAll('input[type="checkbox"]:checked'));
            for (const cb of checkedBoxes) {
              let parent = cb.parentElement;
              for (let i = 0; i < 10 && parent; i++) {
                const text = parent.innerText || '';
                const idMatch = text.match(/(\d{12})/);
                if (idMatch && !ids.includes(idMatch[1])) {
                  ids.push(idMatch[1]);
                  break;
                }
                parent = parent.parentElement;
              }
            }

            // 方法2: チェックボックスがない場合、選択された行から抽出（REINS特有）
            if (ids.length === 0) {
              // 選択状態のクラスを持つ行を探す
              const selectedRows = document.querySelectorAll('tr.selected, tr[class*="select"], tr[style*="background"]');
              for (const row of selectedRows) {
                const text = row.innerText || '';
                const idMatch = text.match(/(\d{12})/);
                if (idMatch && !ids.includes(idMatch[1])) {
                  ids.push(idMatch[1]);
                }
              }
            }

            // 方法3: ページ内のすべての12桁物件番号を抽出
            if (ids.length === 0) {
              const pageText = document.body.innerText;
              const matches = pageText.match(/\b\d{12}\b/g) || [];
              const uniqueIds = [...new Set(matches)];
              ids.push(...uniqueIds);
            }

            return ids;
          });

          selectedCount = allIds.length || Math.min(pageInfo.totalCount, 100);
          if (allIds.length > 0) {
            selectedPropertyIds.push(...allIds);
            console.log(`  ✓ ${allIds.length}件の物件を一括選択`);
          } else {
            console.log(`  ✓ 全選択完了（推定: ${selectedCount}件）`);
          }
        }
      }

      // 方法2: 全選択ボタンがない場合、個別のチェックボックスを選択（最大100件）
      if (selectedCount === 0 && checkboxInfo.total > 0) {
        console.log('\n個別選択モードを使用...');
        const maxSelect = Math.min(checkboxInfo.total, 100);

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

              // 物件IDを抽出（12桁の数字）
              let propertyId = null;
              let parent = propertyCheckboxes[index].parentElement;
              for (let i = 0; i < 10 && parent; i++) {
                const text = parent.innerText || '';
                const idMatch = text.match(/(\d{12})/);
                if (idMatch) {
                  propertyId = idMatch[1];
                  break;
                }
                parent = parent.parentElement;
              }

              return { success: true, propertyId: propertyId };
            }
            return { success: false, propertyId: null };
          }, i);

          if (selected.success) {
            selectedCount++;
            if (selected.propertyId) {
              selectedPropertyIds.push(selected.propertyId);
              console.log(`  ✓ 物件 ${i + 1} を選択 (ID: ${selected.propertyId})`);
            } else {
              console.log(`  ✓ 物件 ${i + 1} を選択`);
            }
          }
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      }

      await this.page.screenshot({ path: 'debug-selected-properties.png', fullPage: true });

      // 図面一括取得ボタンをクリック
      if (selectedCount > 0) {
        console.log('\n📋 「図面一括取得」ボタンをクリック...');

        // ダウンロード前に既存ファイルを記録
        const downloadDir = this.currentDownloadDir || DOWNLOADS_DIR;
        const existingFilesBeforeDownload = new Set(
          fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : []
        );
        console.log(`ダウンロード先: ${downloadDir}`);
        console.log(`既存ファイル数: ${existingFilesBeforeDownload.size}`);

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
            const modals = document.querySelectorAll('.modal, [role="dialog"], .popup, .dialog, .alert');
            for (const modal of modals) {
              const style = window.getComputedStyle(modal);
              if (style.display !== 'none' && style.visibility !== 'hidden') {
                const modalText = modal.innerText || '';

                // エラーメッセージのチェック
                const isError = modalText.includes('選択してください') ||
                                modalText.includes('エラー') ||
                                modalText.includes('失敗') ||
                                modalText.includes('できません');

                // 確認/OKボタンを探してクリック
                const confirmButtons = modal.querySelectorAll('button');
                for (const btn of confirmButtons) {
                  const text = btn.textContent?.trim() || '';
                  if (text.includes('OK') || text.includes('確認') || text.includes('はい') || text.includes('ダウンロード') || text.includes('取得') || text.includes('一括取得')) {
                    btn.click();
                    return { clicked: true, text: text, isError: isError, message: modalText.substring(0, 100) };
                  }
                }
              }
            }

            // 通常のボタンも探す
            const allButtons = document.querySelectorAll('button');
            for (const btn of allButtons) {
              const text = btn.textContent?.trim() || '';
              if (text === 'OK' || text === '確認' || text === 'はい' || text === '一括取得') {
                btn.click();
                return { clicked: true, text: text, isError: false, message: '' };
              }
            }

            return { clicked: false, isError: false, message: '' };
          });

          if (confirmResult.clicked) {
            if (confirmResult.isError) {
              console.log(`⚠ エラーダイアログ: ${confirmResult.message}`);
            } else {
              console.log(`✓ 確認ボタン「${confirmResult.text}」をクリック`);
            }
          }

          await new Promise(resolve => setTimeout(resolve, 3000));
          await this.page.screenshot({ path: 'debug-after-confirm.png', fullPage: true });

          // ダウンロード完了を待機（既存ファイルリストを使用）
          console.log('\n⏳ PDFダウンロード完了を待機中...');
          const downloadedFiles = await this.waitForDownloadWithExisting(30000, existingFilesBeforeDownload);

          if (downloadedFiles.length > 0) {
            console.log(`✓ ${downloadedFiles.length}件のPDFをダウンロード`);
            downloadedFiles.forEach(f => console.log(`  - ${path.basename(f)}`));
            // すべてのPDFを返す（REINSは50件以上の場合、複数のPDFに分割する）
            return {
              type: 'pdf',
              pdfPath: downloadedFiles[0],
              pdfFiles: downloadedFiles,  // すべてのPDFファイル
              count: selectedCount,
              propertyIds: selectedPropertyIds
            };
          }
          console.log('ダウンロードファイルが検出されませんでした');

          // ダウンロードが発生しなかった場合、新しいタブをチェック
          const pages = await this.browser.pages();
          console.log('開いているページ数:', pages.length);

          if (pages.length > 1) {
            // 新しいタブ（印刷プレビュー/PDF）が開いた場合
            const printPage = pages[pages.length - 1];
            await new Promise(resolve => setTimeout(resolve, 2000));

            // ページURLを確認
            const pageUrl = printPage.url();
            const pageTitle = await printPage.title().catch(() => '');
            console.log('プレビューページURL:', pageUrl);
            console.log('プレビューページタイトル:', pageTitle);

            // プレビューページのスクリーンショット
            await printPage.screenshot({ path: 'debug-print-dialog.png', fullPage: true });

            const downloadDir = this.currentDownloadDir || DOWNLOADS_DIR;
            const pdfTimestamp = Date.now();
            const pdfPath = path.join(downloadDir, `properties_${pdfTimestamp}.pdf`);

            // 方法1: URLが直接PDFの場合、fetchでダウンロード
            if (pageUrl.includes('.pdf') || pageUrl.includes('pdf') || pageUrl.includes('blob:')) {
              console.log('\n📥 PDF URLを検出、直接ダウンロード試行...');
              try {
                // ブラウザコンテキストでPDFを取得
                const pdfData = await printPage.evaluate(async (url) => {
                  try {
                    const response = await fetch(url, { credentials: 'include' });
                    if (response.ok) {
                      const blob = await response.blob();
                      const reader = new FileReader();
                      return new Promise((resolve) => {
                        reader.onloadend = () => resolve(reader.result);
                        reader.readAsDataURL(blob);
                      });
                    }
                  } catch (e) {
                    return null;
                  }
                  return null;
                }, pageUrl);

                if (pdfData && pdfData.startsWith('data:application/pdf')) {
                  const base64Data = pdfData.replace(/^data:application\/pdf;base64,/, '');
                  fs.writeFileSync(pdfPath, Buffer.from(base64Data, 'base64'));
                  const stats = fs.statSync(pdfPath);
                  console.log(`✓ PDF直接ダウンロード完了: ${path.basename(pdfPath)} (${Math.round(stats.size / 1024)}KB)`);
                  await printPage.close().catch(() => {});
                  return { type: 'pdf', pdfPath: pdfPath, count: selectedCount, propertyIds: selectedPropertyIds };
                }
              } catch (fetchError) {
                console.log('PDF直接ダウンロード失敗:', fetchError.message);
              }
            }

            // 方法2: ページ内にiframe/object/embedでPDFが埋め込まれている場合
            console.log('\n🔍 埋め込みPDFを検索中...');
            const embeddedPdfUrl = await printPage.evaluate(() => {
              // iframe内のPDF
              const iframes = document.querySelectorAll('iframe');
              for (const iframe of iframes) {
                const src = iframe.src || iframe.getAttribute('data-src');
                if (src && (src.includes('.pdf') || src.includes('pdf'))) {
                  return src;
                }
              }
              // object/embed内のPDF
              const objects = document.querySelectorAll('object, embed');
              for (const obj of objects) {
                const data = obj.data || obj.src || obj.getAttribute('data');
                if (data && (data.includes('.pdf') || data.includes('pdf'))) {
                  return data;
                }
              }
              // リンク内のPDF
              const links = document.querySelectorAll('a[href*=".pdf"], a[href*="pdf"]');
              if (links.length > 0) {
                return links[0].href;
              }
              return null;
            });

            if (embeddedPdfUrl) {
              console.log('埋め込みPDF URL発見:', embeddedPdfUrl);
              try {
                // CDPでダウンロード
                const client = await printPage.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', {
                  behavior: 'allow',
                  downloadPath: downloadDir
                });

                // 埋め込みPDFページに移動
                await printPage.goto(embeddedPdfUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(resolve => setTimeout(resolve, 3000));

                // ダウンロード待機
                const embeddedDownloads = await this.waitForDownloadWithExisting(15000, existingFilesBeforeDownload);
                if (embeddedDownloads.length > 0) {
                  console.log(`✓ 埋め込みPDFダウンロード完了: ${embeddedDownloads.length}件`);
                  await printPage.close().catch(() => {});
                  return { type: 'pdf', pdfPath: embeddedDownloads[0], count: selectedCount, propertyIds: selectedPropertyIds };
                }
              } catch (embeddedError) {
                console.log('埋め込みPDFダウンロード失敗:', embeddedError.message);
              }
            }

            // 方法3: 印刷ボタンをクリック（PDFダウンロードをトリガー）
            console.log('\n🖨️ 印刷/ダウンロードボタンを検索...');
            const downloadTriggered = await printPage.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
              const keywords = ['ダウンロード', 'Download', 'PDF', '保存', '印刷', 'Print'];
              for (const keyword of keywords) {
                const btn = buttons.find(b => {
                  const text = b.textContent?.trim() || b.value || '';
                  return text.includes(keyword);
                });
                if (btn) {
                  btn.click();
                  return { clicked: true, text: btn.textContent?.trim() || btn.value };
                }
              }
              return { clicked: false };
            }).catch(() => ({ clicked: false }));

            if (downloadTriggered.clicked) {
              console.log(`✓ 「${downloadTriggered.text}」をクリック`);
              await new Promise(resolve => setTimeout(resolve, 5000));
              const triggeredDownloads = await this.waitForDownloadWithExisting(15000, existingFilesBeforeDownload);
              if (triggeredDownloads.length > 0) {
                console.log(`✓ ${triggeredDownloads.length}件のPDFをダウンロード`);
                await printPage.close().catch(() => {});
                return { type: 'pdf', pdfPath: triggeredDownloads[0], count: selectedCount, propertyIds: selectedPropertyIds };
              }
            }

            // 方法4: フォールバック - Puppeteerで直接PDFを生成
            console.log('\n📄 フォールバック: Puppeteerで直接PDF生成...');
            try {
              await printPage.pdf({
                path: pdfPath,
                format: 'A4',
                printBackground: true,
                margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
              });

              if (fs.existsSync(pdfPath)) {
                const stats = fs.statSync(pdfPath);
                console.log(`✓ PDF生成完了: ${path.basename(pdfPath)} (${Math.round(stats.size / 1024)}KB)`);
                await printPage.close().catch(() => {});
                return { type: 'pdf', pdfPath: pdfPath, count: selectedCount, propertyIds: selectedPropertyIds };
              }
            } catch (pdfError) {
              console.log('PDF生成エラー:', pdfError.message);
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
    const maxProperties = Math.min(detailButtonCount, 5);

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
      // 使用自定义下载目录（如果提供）
      const downloadDir = conditions.downloadDir || null;
      await this.login(username, password, downloadDir);
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

  /**
   * 多轮搜索 - 根据多个搜索选项分别搜索，然后合并结果
   * @param {string} username - REINS 用户名
   * @param {string} password - REINS 密码
   * @param {object} baseConditions - 基本搜索条件（賃料、面積、間取り等）
   * @param {array} searchOptions - 搜索选项数组
   * @param {object} options - 额外选项 { maxRounds: 最大搜索轮数, selectedOptions: 用户选择的选项ID数组 }
   */
  async searchMultipleRounds(username, password, baseConditions, searchOptions, options = {}) {
    const maxRounds = options.maxRounds || 5;  // 最大搜索轮数
    const selectedOptionIds = options.selectedOptions || null;  // 用户选择的选项ID

    // 如果用户指定了选项，只搜索这些选项
    let optionsToSearch = searchOptions;
    if (selectedOptionIds && Array.isArray(selectedOptionIds)) {
      optionsToSearch = searchOptions.filter(opt => selectedOptionIds.includes(opt.id));
    }

    // 限制搜索轮数
    optionsToSearch = optionsToSearch.slice(0, maxRounds);

    console.log('\n' + '='.repeat(60));
    console.log('🔄 多轮検索を開始します');
    console.log('='.repeat(60));
    console.log('  検索オプション数:', optionsToSearch.length);
    optionsToSearch.forEach((opt, i) => {
      console.log(`  [${i + 1}] ${opt.description}`);
    });
    console.log('');

    const allResults = {
      totalRounds: optionsToSearch.length,
      completedRounds: 0,
      rounds: [],
      allProperties: [],
      allPdfFiles: [],
      uniquePropertyIds: new Set(),
      errors: []
    };

    try {
      // 登录一次
      const downloadDir = baseConditions.downloadDir || null;
      await this.login(username, password, downloadDir);

      // 对每个选项进行搜索
      for (let i = 0; i < optionsToSearch.length; i++) {
        const option = optionsToSearch[i];
        console.log('\n' + '-'.repeat(50));
        console.log(`📍 Round ${i + 1}/${optionsToSearch.length}: ${option.description}`);
        console.log('-'.repeat(50));

        try {
          // 构建此轮的搜索条件
          const roundConditions = this.buildConditionsFromOption(baseConditions, option);

          // 导航到搜索页面
          await this.navigateToRentalSearch();

          // 填充并执行搜索
          await this.fillSearchConditions(roundConditions);
          await this.executeSearch(roundConditions);

          // 提取结果
          const result = await this.extractProperties();

          // 记录此轮结果
          const roundResult = {
            round: i + 1,
            option: option,
            success: true,
            propertiesCount: result.properties ? result.properties.length : 0,
            pdfFiles: result.pdfFiles || [],
            properties: result.properties || []
          };

          allResults.rounds.push(roundResult);
          allResults.completedRounds++;

          // 合并结果（去重）
          if (result.properties) {
            for (const prop of result.properties) {
              if (prop.propertyNo && !allResults.uniquePropertyIds.has(prop.propertyNo)) {
                allResults.uniquePropertyIds.add(prop.propertyNo);
                allResults.allProperties.push({
                  ...prop,
                  foundInRound: i + 1,
                  searchOption: option.description
                });
              }
            }
          }

          if (result.pdfFiles) {
            allResults.allPdfFiles.push(...result.pdfFiles);
          }

          console.log(`  ✓ 検索完了: ${roundResult.propertiesCount}件の物件を発見`);

        } catch (error) {
          console.error(`  ✗ Round ${i + 1} エラー:`, error.message);
          allResults.rounds.push({
            round: i + 1,
            option: option,
            success: false,
            error: error.message
          });
          allResults.errors.push({
            round: i + 1,
            option: option.description,
            error: error.message
          });
        }

        // 轮次之间等待
        if (i < optionsToSearch.length - 1) {
          console.log('  次の検索まで待機中...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      await this.close();

      // 结果摘要
      console.log('\n' + '='.repeat(60));
      console.log('📊 多轮検索結果サマリー');
      console.log('='.repeat(60));
      console.log('  完了ラウンド:', allResults.completedRounds, '/', allResults.totalRounds);
      console.log('  発見物件数（重複除く）:', allResults.allProperties.length);
      console.log('  PDFファイル数:', allResults.allPdfFiles.length);
      if (allResults.errors.length > 0) {
        console.log('  エラー数:', allResults.errors.length);
      }
      console.log('');

      return {
        type: 'multiRoundSearch',
        totalRounds: allResults.totalRounds,
        completedRounds: allResults.completedRounds,
        rounds: allResults.rounds,
        properties: allResults.allProperties,
        pdfFiles: allResults.allPdfFiles,
        uniquePropertyCount: allResults.allProperties.length,
        errors: allResults.errors
      };

    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * 并发搜索 - 同时启动多个浏览器实例进行搜索，然后合并结果
   * @param {string} username - REINS 用户名
   * @param {string} password - REINS 密码
   * @param {object} baseConditions - 基本搜索条件
   * @param {array} searchOptions - 搜索选项数组
   * @param {object} options - 额外选项 { maxConcurrent: 最大并发数, selectedOptions: 用户选择的选项ID数组 }
   */
  async searchConcurrent(username, password, baseConditions, searchOptions, options = {}) {
    const maxConcurrent = options.maxConcurrent || 3;  // 最大并发数（避免资源占用过多）
    const selectedOptionIds = options.selectedOptions || null;

    // 如果用户指定了选项，只搜索这些选项
    let optionsToSearch = searchOptions;
    if (selectedOptionIds && Array.isArray(selectedOptionIds)) {
      optionsToSearch = searchOptions.filter(opt => selectedOptionIds.includes(opt.id));
    }

    // 限制并发数
    optionsToSearch = optionsToSearch.slice(0, maxConcurrent);

    console.log('\n' + '='.repeat(60));
    console.log('⚡ 並列検索を開始します');
    console.log('='.repeat(60));
    console.log('  検索オプション数:', optionsToSearch.length);
    console.log('  最大並列数:', maxConcurrent);
    optionsToSearch.forEach((opt, i) => {
      console.log(`  [${i + 1}] ${opt.description}`);
    });
    console.log('');

    const startTime = Date.now();

    // 创建并发搜索任务
    const searchTasks = optionsToSearch.map((option, index) => {
      return this.runSingleSearch(username, password, baseConditions, option, index + 1);
    });

    // 并发执行所有搜索
    console.log('  🚀 並列検索を実行中...\n');
    const results = await Promise.allSettled(searchTasks);

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);

    // 收集和合并结果
    const allResults = {
      totalRounds: optionsToSearch.length,
      completedRounds: 0,
      rounds: [],
      allProperties: [],
      allPdfFiles: [],
      uniquePropertyIds: new Set(),
      errors: []
    };

    results.forEach((result, index) => {
      const option = optionsToSearch[index];

      if (result.status === 'fulfilled' && result.value) {
        const searchResult = result.value;
        allResults.completedRounds++;

        const roundResult = {
          round: index + 1,
          option: option,
          success: true,
          propertiesCount: searchResult.properties?.length || 0,
          pdfFiles: searchResult.pdfFiles || [],
          pdfPath: searchResult.pdfPath || null,
          properties: searchResult.properties || [],
          propertyIds: searchResult.propertyIds || []
        };
        allResults.rounds.push(roundResult);

        // 合并 PDF 文件（优先使用 pdfFiles 数组，避免重复）
        if (searchResult.pdfFiles && searchResult.pdfFiles.length > 0) {
          allResults.allPdfFiles.push(...searchResult.pdfFiles);
        } else if (searchResult.pdfPath) {
          allResults.allPdfFiles.push(searchResult.pdfPath);
        }

        // 合并物件（去重）
        if (searchResult.properties) {
          for (const prop of searchResult.properties) {
            const propId = prop.propertyNo || prop.propertyId;
            if (propId && !allResults.uniquePropertyIds.has(propId)) {
              allResults.uniquePropertyIds.add(propId);
              allResults.allProperties.push({
                ...prop,
                foundInRound: index + 1,
                searchOption: option.description
              });
            }
          }
        }

        // 也用 propertyIds 去重
        if (searchResult.propertyIds) {
          for (const propId of searchResult.propertyIds) {
            if (!allResults.uniquePropertyIds.has(propId)) {
              allResults.uniquePropertyIds.add(propId);
            }
          }
        }

        console.log(`  ✓ [${index + 1}] ${option.description}: ${roundResult.propertiesCount}件`);

      } else {
        const errorMsg = result.reason?.message || 'Unknown error';
        allResults.rounds.push({
          round: index + 1,
          option: option,
          success: false,
          error: errorMsg
        });
        allResults.errors.push({
          round: index + 1,
          option: option.description,
          error: errorMsg
        });
        console.log(`  ✗ [${index + 1}] ${option.description}: エラー - ${errorMsg}`);
      }
    });

    // 结果摘要
    console.log('\n' + '='.repeat(60));
    console.log('📊 並列検索結果サマリー');
    console.log('='.repeat(60));
    console.log('  実行時間:', duration, '秒');
    console.log('  完了:', allResults.completedRounds, '/', allResults.totalRounds);
    console.log('  発見物件数（重複除く）:', allResults.uniquePropertyIds.size);
    console.log('  PDFファイル数:', allResults.allPdfFiles.length);
    if (allResults.errors.length > 0) {
      console.log('  エラー数:', allResults.errors.length);
    }
    console.log('');

    return {
      type: 'concurrentSearch',
      totalRounds: allResults.totalRounds,
      completedRounds: allResults.completedRounds,
      duration: parseFloat(duration),
      rounds: allResults.rounds,
      properties: allResults.allProperties,
      pdfFiles: allResults.allPdfFiles,
      uniquePropertyCount: allResults.uniquePropertyIds.size,
      errors: allResults.errors
    };
  }

  /**
   * 运行单个搜索（独立的 ReinsService 实例，避免并发竞争条件）
   */
  async runSingleSearch(username, password, baseConditions, option, roundNumber) {
    // 创建独立的 ReinsService 实例，避免共享 this.page/this.browser 的竞争条件
    const isolatedService = new ReinsService();

    try {
      console.log(`  [${roundNumber}] 🌐 ブラウザを起動中: ${option.description}`);

      // 为每个线程创建独立的子目录，避免并发下载时文件名冲突
      const baseDownloadDir = baseConditions.downloadDir || this.ensureDownloadDir();
      const threadDownloadDir = path.join(baseDownloadDir, `thread_${roundNumber}`);
      if (!fs.existsSync(threadDownloadDir)) {
        fs.mkdirSync(threadDownloadDir, { recursive: true });
      }

      // 使用独立服务实例的 login 方法（使用线程专用下载目录）
      await isolatedService.login(username, password, threadDownloadDir);

      console.log(`  [${roundNumber}] ✓ ログイン完了`);

      // 构建搜索条件
      const conditions = isolatedService.buildConditionsFromOption(baseConditions, option);

      // 导航到搜索页面
      await isolatedService.navigateToRentalSearch();

      // 填充并执行搜索
      await isolatedService.fillSearchConditions(conditions);
      await isolatedService.executeSearch(conditions);

      // 提取结果
      const result = await isolatedService.extractProperties();

      console.log(`  [${roundNumber}] ✓ 検索完了: ${option.description}`);

      return result;

    } catch (error) {
      console.error(`  [${roundNumber}] ✗ エラー: ${error.message}`);
      throw error;

    } finally {
      // 关闭独立服务的浏览器实例
      await isolatedService.close();
    }
  }

  /**
   * 根据搜索选项构建完整的搜索条件
   */
  buildConditionsFromOption(baseConditions, option) {
    console.log('\n[buildConditionsFromOption] 入力オプション:');
    console.log('  option.city:', option.city);
    console.log('  option.town:', option.town);
    console.log('  option.detail:', option.detail);

    const conditions = { ...baseConditions };

    // 设置搜索方法
    conditions.searchMethod = option.searchMethod;

    if (option.searchMethod === 'location') {
      // 所在地搜索
      conditions.prefecture = option.prefecture;
      conditions.cities = option.city ? [option.city] : [];
      // 清除沿线信息
      conditions.line = null;
      conditions.station = null;
    } else if (option.searchMethod === 'line') {
      // 沿线搜索
      conditions.prefecture = option.prefecture;
      conditions.line = option.line;
      conditions.station = option.station;
      conditions.stationTo = option.stationTo || null;
      conditions.walkMinutes = option.walkMinutes || null;
      conditions.lineGuideIndex = option.lineGuideIndex || 3;  // 沿線1=3, 沿線2=4, 沿線3=5
      // 清除所在地信息
      conditions.cities = [];
    }

    // 构建 reinsFields（用于 fillSearchConditions）
    const textInputs = {};

    // 賃料（万円）
    if (baseConditions.rentMin) {
      textInputs['__BVID__452'] = baseConditions.rentMin.toString();
    }
    if (baseConditions.rentMax) {
      textInputs['__BVID__454'] = baseConditions.rentMax.toString();
    }

    // 面積（㎡）
    if (baseConditions.areaMin) {
      textInputs['__BVID__481'] = baseConditions.areaMin.toString();
    }
    if (baseConditions.areaMax) {
      textInputs['__BVID__483'] = baseConditions.areaMax.toString();
    }

    // 階数
    if (baseConditions.floorMin) {
      textInputs['__BVID__520'] = baseConditions.floorMin.toString();
    }

    // 徒歩分数（動的にフィールドを検索するため特殊キーを使用）
    if (option.walkMinutes) {
      textInputs['__WALK_MINUTES__'] = option.walkMinutes.toString();
    }

    // 构建 selects
    const selects = {};

    // 物件種別
    if (baseConditions.propertyType) {
      selects['__BVID__293'] = baseConditions.propertyType;
    }

    // 向き
    if (baseConditions.direction) {
      selects['__BVID__525'] = baseConditions.direction;
    }

    // 駐車場
    if (baseConditions.parking) {
      selects['__BVID__542'] = baseConditions.parking;
    }

    // 构建 checkboxes
    const checkboxes = {};

    // 新築
    if (baseConditions.isNew) {
      checkboxes['__BVID__307'] = true;
    }

    // 角部屋
    if (baseConditions.corner) {
      checkboxes['__BVID__492'] = true;
    }

    // 间取りチェックボックス
    const layoutMapping = {
      'ワンルーム': '__BVID__497',
      '1R': '__BVID__497',
      'K': '__BVID__499',
      '1K': '__BVID__499',
      '2K': '__BVID__499',
      'DK': '__BVID__501',
      '1DK': '__BVID__501',
      '2DK': '__BVID__501',
      '3DK': '__BVID__501',
      'LK': '__BVID__503',
      '1LK': '__BVID__503',
      '2LK': '__BVID__503',
      'LDK': '__BVID__505',
      '1LDK': '__BVID__505',
      '2LDK': '__BVID__505',
      '3LDK': '__BVID__505',
      '4LDK': '__BVID__505'
    };

    if (baseConditions.layouts && Array.isArray(baseConditions.layouts)) {
      for (const layout of baseConditions.layouts) {
        const checkboxId = layoutMapping[layout];
        if (checkboxId) {
          checkboxes[checkboxId] = true;
        }
      }
    }

    // 设置 reinsFields
    conditions.reinsFields = {
      textInputs,
      selects,
      checkboxes,
      keywords: baseConditions.keywords || []
    };

    // 设置 userRequirements（包含町丁目信息）
    conditions.userRequirements = {
      prefecture: conditions.prefecture,
      cities: conditions.cities,
      searchMethod: conditions.searchMethod,
      line: conditions.line,
      station: conditions.station,
      stationTo: conditions.stationTo,
      walkMinutes: conditions.walkMinutes,
      lineGuideIndex: conditions.lineGuideIndex || 3,  // 沿線セクションのインデックス
      locations: option.city ? [{
        prefecture: option.prefecture,
        city: option.city,
        town: option.town || null,
        detail: option.detail || option.town || null  // town を detail として使用
      }] : [],
      equipment: baseConditions.equipment || [],
      petAllowed: baseConditions.petAllowed || false
    };

    console.log('[buildConditionsFromOption] 設定された userRequirements.locations:');
    console.log('  locations:', JSON.stringify(conditions.userRequirements.locations, null, 2));

    return conditions;
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
