const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs').promises;
const PDFDocument = require('pdfkit');

// ATBB配置
const ATBB_CONFIG = {
    loginUrl: 'https://atbb.athome.jp/',
    accounts: [
        { username: '002807970004', password: 'funt8320' },
        { username: '002807970002', password: 'funt8320' },
        { username: '002807970001', password: 'funt0406' }
    ]
};

// 等待函数
const wait = (ms) => new Promise(r => setTimeout(r, ms));

class ATBBService {
    constructor() {
        this.browser = null;
        this.page = null;
        this.searchPage = null;
        this.currentAccountIndex = 0;
        this.downloadDir = null;
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    // 设置下载目录
    setDownloadDir(dir) {
        this.downloadDir = dir;
        console.log('[ATBB] 下载目录设置为:', dir);
    }

    // 启动浏览器
    async initBrowser() {
        if (!this.browser) {
            // 创建用户数据目录用于保存Chrome设置
            const userDataDir = path.join(__dirname, '..', 'chrome-user-data-atbb');

            // 确保下载目录存在
            if (this.downloadDir) {
                try {
                    await fs.mkdir(this.downloadDir, { recursive: true });
                } catch (e) {}
            }

            // Chrome启动参数 - 设置PDF自动下载而不是在浏览器中预览
            this.browser = await puppeteer.launch({
                headless: false,
                executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                defaultViewport: { width: 1400, height: 900 },
                userDataDir: userDataDir,
                args: [
                    '--lang=ja-JP',
                    '--no-sandbox',
                    '--disable-extensions'
                ]
            });

            // 打开Chrome PDF设置页面，设置为直接下载PDF
            console.log('[ATBB] 配置Chrome PDF设置...');
            const settingsPage = await this.browser.newPage();
            await settingsPage.goto('chrome://settings/content/pdfDocuments', { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 1000));

            // 点击"PDF をダウンロードする"选项
            try {
                await settingsPage.evaluate(() => {
                    // 查找包含"ダウンロード"文字的radio button或选项
                    const labels = document.querySelectorAll('label, cr-radio-button, div[role="radio"]');
                    for (const label of labels) {
                        if (label.textContent && label.textContent.includes('ダウンロード')) {
                            label.click();
                            return true;
                        }
                    }
                    // 尝试其他选择器
                    const options = document.querySelectorAll('[aria-label*="ダウンロード"], [title*="ダウンロード"]');
                    for (const opt of options) {
                        opt.click();
                        return true;
                    }
                    return false;
                });
                console.log('[ATBB] PDF设置已更改为直接下载');
            } catch (e) {
                console.log('[ATBB] PDF设置可能已经是下载模式');
            }
            await new Promise(r => setTimeout(r, 500));
            await settingsPage.close();

            this.page = await this.browser.newPage();

            // 配置下载目录和PDF自动下载
            if (this.downloadDir) {
                const client = await this.page.target().createCDPSession();

                // 配置下载行为
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: this.downloadDir
                });

                // 使用Browser.setDownloadBehavior来设置全局下载行为
                try {
                    await client.send('Browser.setDownloadBehavior', {
                        behavior: 'allowAndName',
                        downloadPath: this.downloadDir,
                        eventsEnabled: true
                    });
                } catch (e) {
                    // 如果allowAndName不支持，尝试allow
                    await client.send('Browser.setDownloadBehavior', {
                        behavior: 'allow',
                        downloadPath: this.downloadDir,
                        eventsEnabled: true
                    });
                }

                console.log('[ATBB] 下载路径已配置:', this.downloadDir);
            }
        }
        return this.page;
    }

    // 为搜索页面配置下载目录
    async configureDownloadForSearchPage() {
        if (this.searchPage && this.downloadDir) {
            const client = await this.searchPage.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: this.downloadDir
            });
            console.log('[ATBB] 搜索页面下载路径已配置:', this.downloadDir);
        }
    }

    // 关闭浏览器
    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            this.searchPage = null;
        }
    }

    // 登录ATBB (尝试多个账号)
    async login(accountIndex = 0) {
        // 先关闭之前的浏览器实例，确保干净状态
        await this.closeBrowser();

        const page = await this.initBrowser();
        const account = ATBB_CONFIG.accounts[accountIndex];
        this.currentAccountIndex = accountIndex;

        console.log(`[ATBB] 登录中... (${account.username}) [账号${accountIndex + 1}/${ATBB_CONFIG.accounts.length}]`);
        await page.goto(ATBB_CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        await wait(1000);

        // 查找并输入账号 - 尝试多种选择器
        const loginIdSelectors = ['input[name="loginId"]', 'input[id="loginId"]', 'input[type="text"]'];
        let loginIdInput = null;
        for (const selector of loginIdSelectors) {
            loginIdInput = await page.$(selector);
            if (loginIdInput) {
                console.log('[ATBB] 找到账号输入框:', selector);
                break;
            }
        }

        if (loginIdInput) {
            await loginIdInput.click({ clickCount: 3 }); // 选中全部文本
            await wait(100);
            await loginIdInput.type(account.username, { delay: 50 });
            console.log('[ATBB] 账号已输入');
        } else {
            console.log('[ATBB] 未找到账号输入框');
        }

        await wait(500);

        // 查找并输入密码 - 尝试多种选择器
        const passwordSelectors = ['input[name="password"]', 'input[type="password"]', 'input[id="password"]'];
        let passwordInput = null;
        for (const selector of passwordSelectors) {
            passwordInput = await page.$(selector);
            if (passwordInput) {
                console.log('[ATBB] 找到密码输入框:', selector);
                break;
            }
        }

        if (passwordInput) {
            await passwordInput.click({ clickCount: 3 }); // 选中全部文本
            await wait(100);
            await passwordInput.type(account.password, { delay: 50 });
            console.log('[ATBB] 密码已输入');
        } else {
            console.log('[ATBB] 未找到密码输入框');
        }

        await wait(500);
        console.log('[ATBB] 账号密码已输入，点击登录按钮...');

        // 查找并点击登录按钮
        const submitSelectors = ['input[type="submit"]', 'button[type="submit"]', 'input[value*="ログイン"]', 'button:contains("ログイン")'];
        let submitButton = null;
        for (const selector of submitSelectors) {
            try {
                submitButton = await page.$(selector);
                if (submitButton) {
                    console.log('[ATBB] 找到登录按钮:', selector);
                    break;
                }
            } catch (e) {}
        }

        if (submitButton) {
            // 点击登录按钮并等待导航
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                submitButton.click()
            ]).catch(e => {
                console.log('[ATBB] 导航等待超时，继续处理:', e.message);
            });
        } else {
            // 尝试通过evaluate点击
            await page.evaluate(() => {
                const btn = document.querySelector('input[type="submit"]') ||
                           document.querySelector('button[type="submit"]');
                if (btn) btn.click();
            });
        }

        await wait(2000);

        // 验证是否成功跳转到portal
        let currentUrl = page.url();
        console.log('[ATBB] 登录后URL:', currentUrl);

        // 如果还在登录页面，尝试等待更长时间（最多10秒）
        if (currentUrl.includes('atbb.athome.jp') && !currentUrl.includes('members')) {
            console.log('[ATBB] 仍在登录页面，等待跳转...');
            await wait(3000);
            currentUrl = page.url();
            console.log('[ATBB] 当前URL:', currentUrl);
        }

        // 关闭确认弹窗（登录后才处理弹窗）
        console.log('[ATBB] 处理登录后弹窗...');
        await this.closeDialogs(page);
        await wait(500);

        // 再次检查URL
        currentUrl = page.url();
        if (!currentUrl.includes('members.athome.jp/portal')) {
            console.log('[ATBB] 警告: 未跳转到portal页面，当前URL:', currentUrl);
        } else {
            console.log('[ATBB] 登录成功，已跳转到portal页面');
        }

        return true;
    }

    // 关闭弹窗
    async closeDialogs(page) {
        // 先打印页面上的按钮用于调试
        const debugButtons = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn, a[class*="btn"]');
            return Array.from(buttons).slice(0, 20).map(btn => ({
                tag: btn.tagName,
                text: (btn.innerText || btn.value || '').substring(0, 50),
                className: btn.className
            })).filter(b => b.text.trim());
        });
        if (debugButtons.length > 0) {
            console.log('[ATBB] closeDialogs - 页面按钮:', JSON.stringify(debugButtons));
        }

        for (let i = 0; i < 5; i++) {
            const closed = await page.evaluate(() => {
                // 检查页面文本是否包含特定弹窗
                const pageText = document.body?.innerText || '';

                const buttons = document.querySelectorAll('button, .btn02d-06, input[type="button"], input[type="submit"], a.btn, a[class*="btn"]');
                for (const btn of buttons) {
                    const text = btn.innerText || btn.value || '';

                    // 1. 強制終了確認弹窗 - 选择 OK
                    if (pageText.includes('強制終了させてよろしいですか') || pageText.includes('強制終了してよろしいですか')) {
                        if (text === 'OK' || text.includes('OK') || text === 'はい') {
                            btn.click();
                            console.log('点击了: OK (強制終了確認)');
                            return 'force_confirm_ok';
                        }
                    }

                    // 2. 管理者ID会社情報定期確認弹窗 - 选择"表示の一時停止"
                    if (pageText.includes('管理者IDによるご登録情報') || pageText.includes('会社情報') && pageText.includes('定期確認')) {
                        if (text.includes('表示の一時停止') || text.includes('一時表示停止') || text.includes('表示一時停止') || text.includes('一時停止')) {
                            btn.click();
                            console.log('点击了: 表示の一時停止 (会社情報確認)');
                            return 'company_info';
                        }
                    }

                    // 3. 其他用户正在使用弹窗 - 选择"強制停止させて利用する"
                    if (pageText.includes('ほかのユーザーが利用している') || pageText.includes('他のユーザーが利用')) {
                        if (text.includes('強制停止させて利用') || text.includes('強制終了') || text.includes('強制')) {
                            btn.click();
                            console.log('点击了: 強制停止させて利用する');
                            return 'force_stop';
                        }
                    }

                    // 4. 公司信息确认弹窗 - 选择"表示の一時停止"
                    if (text.includes('表示の一時停止') || text.includes('一時表示停止') || text.includes('表示一時停止') || text.includes('一時停止')) {
                        btn.click();
                        console.log('点击了: 表示の一時停止');
                        return 'temp_stop';
                    }

                    // 5. 其他弹窗
                    if (text.includes('後で確認') || text.includes('閉じる')) {
                        btn.click();
                        return 'other';
                    }
                }
                return false;
            });
            if (closed) {
                console.log('[ATBB] 关闭弹窗:', closed);
                await wait(500);
            } else {
                break;
            }
        }
    }

    // 进入流通物件検索页面
    async openSearchPage() {
        console.log('[ATBB] 进入流通物件検索...');
        console.log('[ATBB] 当前页面URL:', this.page.url());

        // 记录当前页面数量
        const pagesBefore = await this.browser.pages();
        const pageCountBefore = pagesBefore.length;
        console.log('[ATBB] 点击前页面数:', pageCountBefore);

        // 点击流通物件検索
        const clicked = await this.page.evaluate(() => {
            const divs = document.querySelectorAll('.cursor-pointer, [onclick], div');
            for (const div of divs) {
                const text = div.innerText?.trim();
                if (text?.startsWith('流通物件検索') &&
                    !text.includes('保存') &&
                    !text.includes('地図')) {
                    console.log('找到并点击:', text.substring(0, 30));
                    div.click();
                    return true;
                }
            }
            return false;
        });

        console.log('[ATBB] 点击结果:', clicked);

        // 等待新页面打开
        await wait(3000);

        // 获取新打开的页面
        const pagesAfter = await this.browser.pages();
        console.log('[ATBB] 点击后页面数:', pagesAfter.length);

        // 选择最新的页面（如果有新页面打开）
        if (pagesAfter.length > pageCountBefore) {
            this.searchPage = pagesAfter[pagesAfter.length - 1];
        } else {
            // 没有新页面，可能在同一页面跳转
            this.searchPage = this.page;
        }

        await this.searchPage.bringToFront();
        await wait(1000);
        console.log('[ATBB] 搜索页面URL:', this.searchPage.url());

        // 检查是否需要处理并发登录或其他用户正在使用
        const url = this.searchPage.url();
        const pageText = await this.searchPage.evaluate(() => document.body?.innerText || '');

        // 检测"ほかのユーザーが利用している"弹窗
        if (url.includes('ConcurrentLogin') || pageText.includes('ほかのユーザーが利用している') || pageText.includes('他のユーザーが利用')) {
            console.log('[ATBB] 检测到其他用户正在使用，选择強制停止させて利用する...');

            // 打印页面上所有按钮，用于调试
            const allButtons = await this.searchPage.evaluate(() => {
                const buttons = document.querySelectorAll('input[type="submit"], button, a, input[type="button"]');
                return Array.from(buttons).map(btn => ({
                    tag: btn.tagName,
                    text: btn.value || btn.innerText || '',
                    className: btn.className
                })).filter(b => b.text.trim());
            });
            console.log('[ATBB] 页面上的按钮:', JSON.stringify(allButtons, null, 2));

            // 设置 dialog 事件监听，自动处理原生 alert/confirm 弹窗
            this.searchPage.on('dialog', async dialog => {
                console.log('[ATBB] 检测到原生弹窗:', dialog.type(), dialog.message());
                // 点击 OK 确认
                await dialog.accept();
                console.log('[ATBB] 已点击 OK 确认原生弹窗');
            });

            // 直接尝试强制登录
            const forceClicked = await this.searchPage.evaluate(() => {
                const buttons = document.querySelectorAll('input[type="submit"], button, a, input[type="button"]');
                for (const btn of buttons) {
                    const text = btn.value || btn.innerText || '';
                    // 优先选择"強制終了させてATBBを利用する"
                    if (text.includes('強制終了させてATBBを利用') || text.includes('強制停止させて利用') || text.includes('強制終了') || text.includes('ATBBを利用する')) {
                        console.log('点击:', text);
                        btn.click();
                        return text;
                    }
                }
                return false;
            });

            if (forceClicked) {
                console.log('[ATBB] 已点击:', forceClicked);
                await wait(3000);

                // 重新获取页面
                const newPages = await this.browser.pages();
                this.searchPage = newPages[newPages.length - 1];
                await this.searchPage.bringToFront();
                await wait(1000);
            } else {
                console.log('[ATBB] 未找到強制停止按钮，尝试下一个账号...');
                // 尝试下一个账号
                const nextIndex = this.currentAccountIndex + 1;
                if (nextIndex < ATBB_CONFIG.accounts.length) {
                    await this.closeBrowser();
                    await this.login(nextIndex);
                    return await this.openSearchPage();
                }
            }
        }

        console.log('[ATBB] 搜索页面已打开:', this.searchPage.url());
        return this.searchPage;
    }

    // 获取可选项
    async getSearchOptions() {
        const page = this.searchPage;

        console.log('[ATBB] 获取可选项...');

        const options = await page.evaluate(() => {
            // 物件種目
            const shumokuRadios = Array.from(document.querySelectorAll('input[name="atbbShumokuDaibunrui"]')).map(r => {
                const label = r.parentElement?.innerText?.trim() ||
                              r.nextElementSibling?.innerText?.trim() ||
                              document.querySelector(`label[for="${r.id}"]`)?.innerText?.trim();
                return { value: r.value, label: label?.replace(/\s+/g, '') };
            }).filter(r => r.label);

            // 搜索方式
            const searchMethods = [];
            const methodElements = document.querySelectorAll('.box_header, .titlebar');
            methodElements.forEach(el => {
                const text = el.innerText?.trim();
                if (text?.includes('フリーワード') || text?.includes('所在地') || text?.includes('沿線')) {
                    searchMethods.push(text.split('\n')[0]);
                }
            });

            // 其他可选项（如果存在）
            const selects = Array.from(document.querySelectorAll('select')).map(s => ({
                name: s.name,
                id: s.id,
                options: Array.from(s.options).slice(0, 20).map(o => ({ value: o.value, text: o.text }))
            })).filter(s => s.options.length > 0);

            return {
                shumoku: shumokuRadios,
                searchMethods,
                selects
            };
        });

        console.log('[ATBB] 可选项:', JSON.stringify(options.shumoku, null, 2));
        return options;
    }

    // 使用AI选择条件
    async aiSelectConditions(options, userRequirements, tantoushaRequirements) {
        console.log('[ATBB] 调用AI进行选择...');

        const prompt = `あなたは不動産検索の専門家です。以下の情報を基に、ATBBの検索条件を選択してください。

## ユーザーの希望条件
${userRequirements}

## 担当者の追加条件
${tantoushaRequirements || '（なし）'}

## 選択可能な物件種目
${options.shumoku.map(s => `- value="${s.value}": ${s.label}`).join('\n')}

## 検索方式
${options.searchMethods.join('\n')}

## タスク
上記の条件に基づいて、最適な物件種目を1つ選んでください。
また、フリーワード検索に入力すべきキーワードがあれば提案してください。

JSON形式で回答してください：
{
  "shumokuValue": "選択する物件種目のvalue",
  "shumokuReason": "選択理由",
  "freewordKeywords": ["キーワード1", "キーワード2"],
  "searchStrategy": "検索戦略の説明"
}`;

        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1024
            });

            const content = response.choices[0].message.content;
            // JSONを抽出
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                console.log('[ATBB] AI選択結果:', result);
                return result;
            }
        } catch (error) {
            console.error('[ATBB] AI選択エラー:', error.message);
        }

        // デフォルト: 賃貸居住用
        return {
            shumokuValue: '6',
            shumokuReason: 'デフォルト選択',
            freewordKeywords: [],
            searchStrategy: 'デフォルト検索'
        };
    }

    // フォームに入力
    async fillSearchForm(aiSelection, userRequirements, tantoushaRequirements) {
        const page = this.searchPage;

        console.log('[ATBB] フォームに入力中...');

        // 物件種目を選択
        await page.evaluate((value) => {
            const radios = document.querySelectorAll('input[name="atbbShumokuDaibunrui"]');
            for (const r of radios) {
                if (r.value === value) {
                    r.click();
                    return true;
                }
            }
            // デフォルト: 賃貸居住用を探す
            for (const r of radios) {
                const label = r.parentElement?.innerText || '';
                if (label.includes('賃貸居住用')) {
                    r.click();
                    return true;
                }
            }
            return false;
        }, aiSelection.shumokuValue);

        await wait(1000);
        console.log('[ATBB] 物件種目を選択しました:', aiSelection.shumokuValue);

        // 所在地/沿線から探すを選択
        await this.selectLocationSearch(userRequirements, tantoushaRequirements);

        return true;
    }

    // 所在地選択（都道府県チェックボックスを選択）
    async selectLocationSearch(userRequirements, tantoushaRequirements) {
        const page = this.searchPage;
        console.log('[ATBB] 所在地選択...');

        // 都道府県チェックボックス (name="area") を取得
        const areaOptions = await page.evaluate(() => {
            const options = [];
            const checkboxes = document.querySelectorAll('input[type="checkbox"][name="area"]');
            checkboxes.forEach(cb => {
                const label = cb.parentElement?.innerText?.trim() ||
                             cb.nextElementSibling?.innerText?.trim() ||
                             document.querySelector(`label[for="${cb.id}"]`)?.innerText?.trim();
                if (label) {
                    options.push({
                        value: cb.value,
                        label: label.replace(/\s+/g, '').substring(0, 15)
                    });
                }
            });
            return options;
        });

        console.log('[ATBB] 都道府県選択肢:', JSON.stringify(areaOptions.slice(0, 30), null, 2));

        if (areaOptions.length === 0) {
            console.log('[ATBB] 都道府県選択肢が見つかりません');
            return;
        }

        // AIに都道府県を選択させる
        const selectedArea = await this.aiSelectArea(areaOptions, userRequirements);

        if (selectedArea) {
            console.log('[ATBB] AI選択した都道府県:', selectedArea);

            // チェックボックスをクリック
            await page.evaluate((value) => {
                const cb = document.querySelector(`input[type="checkbox"][name="area"][value="${value}"]`);
                if (cb && !cb.checked) {
                    cb.click();
                    return true;
                }
                return false;
            }, selectedArea.value);

            await wait(1000);

            // 所在地検索ボタンをクリック
            console.log('[ATBB] 所在地検索ボタンをクリック...');
            const clicked = await page.evaluate(() => {
                // 所在地検索ボタンを探す
                const btn = document.querySelector('input[value="所在地検索"]');
                if (btn) {
                    btn.click();
                    return '所在地検索';
                }
                // 代替: submitAction を直接呼び出す
                if (typeof submitAction === 'function' && document.bfcm300s) {
                    submitAction(document.bfcm300s, 'bfcm300s002');
                    return 'submitAction';
                }
                return false;
            });

            if (clicked) {
                console.log('[ATBB] ボタンクリック:', clicked);
                await wait(3000);

                // 市区町村選択ページへ
                await this.selectCity(userRequirements, tantoushaRequirements);
            } else {
                console.log('[ATBB] 所在地検索ボタンが見つかりません');
            }
        }
    }

    // AIで都道府県を選択
    async aiSelectArea(options, userRequirements) {
        console.log('[ATBB] AIで都道府県を選択...');

        const optionsText = options.map((opt, i) => `${i}: ${opt.label} (value=${opt.value})`).join('\n');

        const prompt = `あなたは不動産検索の専門家です。ユーザーの希望条件に最も適した都道府県を選択してください。

## ユーザーの希望条件
${userRequirements}

## 選択可能な都道府県
${optionsText}

## タスク
上記の条件に最も適した都道府県のインデックス番号を1つ選んでください。

JSON形式で回答してください：
{
  "selectedIndex": 選択した番号,
  "selectedName": "選択した都道府県名",
  "reason": "選択理由"
}`;

        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 256
            });

            const content = response.choices[0].message.content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                console.log('[ATBB] AI都道府県選択結果:', result);
                return options[result.selectedIndex];
            }
        } catch (error) {
            console.error('[ATBB] AI都道府県選択エラー:', error.message);
        }

        // デフォルト: 東京都
        const tokyo = options.find(o => o.label.includes('東京'));
        return tokyo || options[0];
    }

    // 市区町村を選択（selectドロップダウン方式）
    async selectCity(userRequirements, tantoushaRequirements) {
        const page = this.searchPage;
        console.log('[ATBB] 市区町村選択...');

        // 市区町村のselect要素から選択肢を取得
        const cityOptions = await page.evaluate(() => {
            const options = [];
            // sentaku1Shikugunのselectを探す（東京都の場合はsentaku1ZenShikugun_13）
            const selects = document.querySelectorAll('select[name="sentaku1Shikugun"]');
            for (const sel of selects) {
                if (sel.options.length > 1) {
                    Array.from(sel.options).forEach(opt => {
                        if (opt.value && opt.text) {
                            options.push({
                                type: 'select',
                                value: opt.value,
                                text: opt.text,
                                selectId: sel.id,
                                selectName: sel.name
                            });
                        }
                    });
                    break; // 最初の有効なselectのみ
                }
            }
            return options;
        });

        console.log('[ATBB] 市区郡選択肢:', JSON.stringify(cityOptions.slice(0, 30), null, 2));

        if (cityOptions.length === 0) {
            console.log('[ATBB] 市区郡選択肢が見つかりません');
            return;
        }

        // AIに選択させる
        const selectedCity = await this.aiSelectLocation(cityOptions, userRequirements, '市区郡');

        if (selectedCity && selectedCity.option) {
            console.log('[ATBB] AI選択した市区郡:', selectedCity.option.text);

            // selectで選択
            await page.evaluate((selectId, value) => {
                const sel = document.getElementById(selectId) ||
                           document.querySelector(`select[name="sentaku1Shikugun"]`);
                if (sel) {
                    sel.value = value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            }, selectedCity.option.selectId, selectedCity.option.value);

            await wait(500);

            // "選択 >>" ボタンをクリック
            console.log('[ATBB] 選択ボタンをクリック...');
            const sentakuClicked = await page.evaluate(() => {
                const buttons = document.querySelectorAll('input[type="button"], input[type="submit"]');
                for (const btn of buttons) {
                    const val = btn.value || '';
                    if (val.includes('選択') && val.includes('>>')) {
                        btn.click();
                        return val;
                    }
                }
                return false;
            });

            if (sentakuClicked) {
                console.log('[ATBB] 選択ボタンクリック:', sentakuClicked);
                await wait(1000);

                // "条件入力画面へ" ボタンをクリック
                console.log('[ATBB] 条件入力画面へボタンをクリック...');
                const jokenClicked = await page.evaluate(() => {
                    const buttons = document.querySelectorAll('input[type="button"], input[type="submit"]');
                    for (const btn of buttons) {
                        const val = btn.value || '';
                        if (val.includes('条件入力画面へ')) {
                            btn.click();
                            return val;
                        }
                    }
                    return false;
                });

                if (jokenClicked) {
                    console.log('[ATBB] 条件入力画面へクリック:', jokenClicked);
                    await wait(3000);

                    // 検索条件入力ページへ遷移
                    console.log('[ATBB] 条件入力ページURL:', page.url());

                    // 条件入力ページで詳細条件を設定
                    await this.fillDetailedConditions(userRequirements, tantoushaRequirements);
                }
            }
        }
    }

    // 条件入力ページの詳細条件を取得
    async getDetailedConditionOptions() {
        const page = this.searchPage;
        console.log('[ATBB] 詳細条件オプションを取得中...');

        const options = await page.evaluate(() => {
            const result = {
                chinryoOptions: [],
                mensekiOptions: [],
                madoriOptions: [],
                ekiHoFunOptions: [],
                chikuNensuOptions: [],
                kodawariOptions: []
            };

            // 賃料オプション
            const chinryoFromSel = document.querySelector('select[name="chinryoFrom"]');
            const chinryoToSel = document.querySelector('select[name="chinryoTo"]');
            if (chinryoFromSel) {
                result.chinryoOptions = Array.from(chinryoFromSel.options).map(o => ({
                    value: o.value,
                    text: o.text
                }));
            }

            // 間取りオプション
            document.querySelectorAll('input[name="madoriKubun"]').forEach(cb => {
                const label = cb.parentElement?.innerText?.trim() || '';
                result.madoriOptions.push({
                    value: cb.value,
                    label: label.replace(/\s+/g, ' ').substring(0, 30)
                });
            });

            // 駅歩分オプション
            document.querySelectorAll('input[name="ekiHoFun"]').forEach(r => {
                const valMap = {
                    '-1': '指定なし',
                    '1': '1分以内',
                    '3': '3分以内',
                    '5': '5分以内',
                    '10': '10分以内',
                    '15': '15分以内',
                    '20': '20分以内'
                };
                result.ekiHoFunOptions.push({
                    value: r.value,
                    label: valMap[r.value] || r.value
                });
            });

            // 築年数オプション
            document.querySelectorAll('input[name="chikuNensu"]').forEach(r => {
                const valMap = {
                    '-1': '指定なし',
                    '00': '新築',
                    '01': '1年以内',
                    '02': '2年以内',
                    '03': '3年以内',
                    '04': '4年以内',
                    '05': '5年以内',
                    '10': '10年以内',
                    '15': '15年以内',
                    '20': '20年以内'
                };
                result.chikuNensuOptions.push({
                    value: r.value,
                    label: valMap[r.value] || r.value
                });
            });

            // こだわり条件オプション
            document.querySelectorAll('input[name="kodawariJokenCode"]').forEach(cb => {
                const label = cb.parentElement?.innerText?.trim() || '';
                result.kodawariOptions.push({
                    value: cb.value,
                    label: label.replace(/\s+/g, ' ').substring(0, 30)
                });
            });

            return result;
        });

        return options;
    }

    // AIで詳細条件を選択
    async aiSelectDetailedConditions(options, userRequirements, tantoushaRequirements) {
        console.log('[ATBB] AIで詳細条件を選択中...');

        const prompt = `あなたは不動産検索の専門家です。ユーザーと担当者の希望条件を分析し、ATBBの検索条件を設定してください。

## ユーザーの希望条件
${userRequirements}

## 担当者の追加条件
${tantoushaRequirements || '（なし）'}

## 選択可能な条件

### 賃料（万円）
下限なし, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 10.5, 11.0, 11.5, 12.0, 12.5, 13.0, 13.5, 14.0, 14.5, 15.0, 15.5, 16.0, 17.0, 18.0, 19.0, 20.0, 25.0, 30.0万円以上

### 間取り
${options.madoriOptions.map(o => `${o.value}: ${o.label}`).join('\n')}

### 駅歩分
${options.ekiHoFunOptions.map(o => `${o.value}: ${o.label}`).join('\n')}

### 築年数
${options.chikuNensuOptions.map(o => `${o.value}: ${o.label}`).join('\n')}

### こだわり条件（複数選択可）
${options.kodawariOptions.map(o => `${o.value}: ${o.label}`).join('\n')}

## タスク
上記の条件から、ユーザーの希望に最も適した検索条件を選択してください。

JSON形式で回答してください：
{
  "chinryoFrom": "賃料下限のvalue（例: -1 は下限なし、50000 は5万円）",
  "chinryoTo": "賃料上限のvalue（例: 150000 は15万円、-1 は上限なし）",
  "madoriValues": ["選択する間取りのvalue配列（例: 07 は2LDK）"],
  "ekiHoFunValue": "駅歩分のvalue（例: 10 は10分以内）",
  "chikuNensuValue": "築年数のvalue（例: -1 は指定なし）",
  "kodawariValues": ["選択するこだわり条件のvalue配列（例: 15 はペット相談、09 はオートロック）"],
  "reasoning": "選択理由の説明"
}`;

        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 1024
            });

            const content = response.choices[0].message.content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                console.log('[ATBB] AI詳細条件選択結果:', JSON.stringify(result, null, 2));
                return result;
            }
        } catch (error) {
            console.error('[ATBB] AI詳細条件選択エラー:', error.message);
        }

        // デフォルト値
        return {
            chinryoFrom: '-1',
            chinryoTo: '150000',
            madoriValues: ['07'],
            ekiHoFunValue: '10',
            chikuNensuValue: '-1',
            kodawariValues: [],
            reasoning: 'デフォルト設定'
        };
    }

    // 詳細条件をフォームに入力
    async fillDetailedConditions(userRequirements, tantoushaRequirements) {
        const page = this.searchPage;
        console.log('[ATBB] 詳細条件入力中...');

        // オプションを取得
        const options = await this.getDetailedConditionOptions();

        // AIで条件を選択
        const conditions = await this.aiSelectDetailedConditions(options, userRequirements, tantoushaRequirements);

        // 賃料を設定
        console.log('[ATBB] 賃料設定:', conditions.chinryoFrom, '〜', conditions.chinryoTo);
        await page.evaluate((fromVal, toVal) => {
            const fromSel = document.querySelector('select[name="chinryoFrom"]');
            const toSel = document.querySelector('select[name="chinryoTo"]');
            if (fromSel && fromVal) {
                fromSel.value = fromVal;
                fromSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (toSel && toVal) {
                toSel.value = toVal;
                toSel.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, conditions.chinryoFrom, conditions.chinryoTo);
        await wait(300);

        // 間取りを設定
        if (conditions.madoriValues && conditions.madoriValues.length > 0) {
            console.log('[ATBB] 間取り設定:', conditions.madoriValues);
            await page.evaluate((values) => {
                values.forEach(val => {
                    const cb = document.querySelector(`input[name="madoriKubun"][value="${val}"]`);
                    if (cb && !cb.checked) {
                        cb.click();
                    }
                });
            }, conditions.madoriValues);
            await wait(300);
        }

        // 駅歩分を設定
        if (conditions.ekiHoFunValue) {
            console.log('[ATBB] 駅歩分設定:', conditions.ekiHoFunValue);
            await page.evaluate((val) => {
                const radio = document.querySelector(`input[name="ekiHoFun"][value="${val}"]`);
                if (radio) radio.click();
            }, conditions.ekiHoFunValue);
            await wait(300);
        }

        // 築年数を設定
        if (conditions.chikuNensuValue) {
            console.log('[ATBB] 築年数設定:', conditions.chikuNensuValue);
            await page.evaluate((val) => {
                const radio = document.querySelector(`input[name="chikuNensu"][value="${val}"]`);
                if (radio) radio.click();
            }, conditions.chikuNensuValue);
            await wait(300);
        }

        // こだわり条件を設定
        if (conditions.kodawariValues && conditions.kodawariValues.length > 0) {
            console.log('[ATBB] こだわり条件設定:', conditions.kodawariValues);
            await page.evaluate((values) => {
                values.forEach(val => {
                    const cb = document.querySelector(`input[name="kodawariJokenCode"][value="${val}"]`);
                    if (cb && !cb.checked) {
                        cb.click();
                    }
                });
            }, conditions.kodawariValues);
            await wait(300);
        }

        console.log('[ATBB] 詳細条件入力完了');
        console.log('[ATBB] AI選択理由:', conditions.reasoning);

        // 検索ボタンをクリック
        console.log('[ATBB] 検索ボタンをクリック...');
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('input[type="button"], button');
            for (const btn of buttons) {
                const text = btn.value || btn.innerText || '';
                if (text === '検索') {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        await wait(5000);
        console.log('[ATBB] 検索結果ページURL:', page.url());

        return conditions;
    }

    // AIで地域を選択
    async aiSelectLocation(options, userRequirements, locationType) {
        console.log(`[ATBB] AIで${locationType}を選択...`);

        const optionsText = options.map((opt, i) => {
            if (opt.type === 'checkbox') return `${i}: ${opt.label} (checkbox, value=${opt.value})`;
            if (opt.type === 'link') return `${i}: ${opt.text} (link)`;
            if (opt.type === 'select') return `${i}: ${opt.text} (select, value=${opt.value})`;
            return `${i}: ${JSON.stringify(opt)}`;
        }).join('\n');

        const prompt = `あなたは不動産検索の専門家です。ユーザーの希望条件に最も適した${locationType}を選択してください。

## ユーザーの希望条件
${userRequirements}

## 選択可能な${locationType}
${optionsText}

## タスク
上記の条件に最も適した${locationType}のインデックス番号を選んでください。
複数選択が必要な場合は、最も重要な1つだけを選んでください。

JSON形式で回答してください：
{
  "selectedIndex": 選択した番号,
  "selectedName": "選択した${locationType}名",
  "reason": "選択理由"
}`;

        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 512
            });

            const content = response.choices[0].message.content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const result = JSON.parse(jsonMatch[0]);
                console.log(`[ATBB] AI${locationType}選択結果:`, result);
                return { ...result, option: options[result.selectedIndex] };
            }
        } catch (error) {
            console.error(`[ATBB] AI${locationType}選択エラー:`, error.message);
        }

        return null;
    }

    // 地域オプションをクリック
    async clickLocationOption(page, selection) {
        if (!selection || !selection.option) return;

        const opt = selection.option;
        console.log('[ATBB] クリックするオプション:', opt);

        if (opt.type === 'checkbox') {
            await page.evaluate((value, name) => {
                const cb = document.querySelector(`input[type="checkbox"][value="${value}"]`) ||
                          document.querySelector(`input[type="checkbox"][name="${name}"]`);
                if (cb) {
                    cb.click();
                    return true;
                }
                return false;
            }, opt.value, opt.name);
        } else if (opt.type === 'link') {
            await page.evaluate((text) => {
                const links = document.querySelectorAll('a');
                for (const link of links) {
                    if (link.innerText?.trim() === text) {
                        link.click();
                        return true;
                    }
                }
                return false;
            }, opt.text);
        } else if (opt.type === 'select') {
            await page.evaluate((selectName, value) => {
                const sel = document.querySelector(`select[name="${selectName}"]`);
                if (sel) {
                    sel.value = value;
                    sel.dispatchEvent(new Event('change'));
                    return true;
                }
                return false;
            }, opt.selectName, opt.value);
        }
    }

    // 等待下载完成
    async waitForDownload(downloadDir, timeout = 30000) {
        const startTime = Date.now();
        let lastFiles = [];

        while (Date.now() - startTime < timeout) {
            try {
                const files = await fs.readdir(downloadDir);
                const pdfFiles = files.filter(f => f.endsWith('.pdf'));
                const tempFiles = files.filter(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));

                if (pdfFiles.length > lastFiles.length && tempFiles.length === 0) {
                    console.log('[ATBB] 下载完成，PDF文件:', pdfFiles);
                    return pdfFiles;
                }

                lastFiles = pdfFiles;
            } catch (e) {
                // 目录可能不存在
            }

            await wait(500);
        }

        console.log('[ATBB] 下载超时');
        return [];
    }

    // 选择搜索结果中的物件
    async selectProperties(maxCount = 5) {
        const page = this.searchPage;
        console.log('[ATBB] 选择物件...');

        await wait(2000);

        const selectedCount = await page.evaluate((max) => {
            let count = 0;
            const checkboxes = document.querySelectorAll('input[type="checkbox"]');
            for (const cb of checkboxes) {
                const name = cb.name || '';
                const id = cb.id || '';

                // ATBB的物件选择复选框
                if ((name.includes('bukken') || name.includes('atbb') || id.includes('check')) &&
                    !cb.checked && count < max) {
                    cb.click();
                    count++;
                }
            }
            return count;
        }, maxCount);

        console.log('[ATBB] 选中物件数:', selectedCount);
        await wait(500);
        return selectedCount;
    }

    // 截图搜索结果 - 已停用
    async takeScreenshot() {
        console.log('[ATBB] 截图功能已停用');
        return null;
    }

    // 等待PDF下载完成
    async waitForPdfDownload(downloadDir, existingFiles, timeout = 15000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const currentFiles = await fs.readdir(downloadDir);
                const pdfFiles = currentFiles.filter(f => f.endsWith('.pdf'));
                const tempFiles = currentFiles.filter(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));

                // 检查是否有新的PDF文件且没有临时文件
                const newPdfs = pdfFiles.filter(f => !existingFiles.includes(f));
                if (newPdfs.length > 0 && tempFiles.length === 0) {
                    console.log('[ATBB] 下载完成，新PDF文件:', newPdfs);
                    return newPdfs;
                }

                // 如果有临时文件，继续等待
                if (tempFiles.length > 0) {
                    console.log('[ATBB] 下载中... 临时文件:', tempFiles.length);
                }
            } catch (e) {
                // 忽略目录读取错误
            }

            await wait(500);
        }

        console.log('[ATBB] 下载超时');
        return [];
    }

    // 为新页面配置下载行为
    async configureDownloadForPage(page) {
        if (!page || !this.downloadDir) return;

        try {
            const client = await page.target().createCDPSession();

            // 页面级别的下载配置
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: this.downloadDir
            });

            // 浏览器级别的下载配置（对于跨域页面更可靠）
            try {
                await client.send('Browser.setDownloadBehavior', {
                    behavior: 'allowAndName',
                    downloadPath: this.downloadDir,
                    eventsEnabled: true
                });
            } catch (e) {
                // 如果allowAndName不支持，尝试allow
                await client.send('Browser.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: this.downloadDir,
                    eventsEnabled: true
                });
            }

            console.log('[ATBB] 页面下载行为已配置');
        } catch (e) {
            console.log('[ATBB] 配置下载行为失败:', e.message);
        }
    }

    // 获取当前下载目录中的文件列表
    async getExistingPdfFiles() {
        try {
            const files = await fs.readdir(this.downloadDir);
            return files.filter(f => f.endsWith('.pdf') && !f.includes('merged'));
        } catch (e) {
            return [];
        }
    }

    // 等待新PDF文件下载完成
    async waitForNewPdfDownload(existingFiles, timeout = 15000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const currentFiles = await fs.readdir(this.downloadDir);
                const pdfFiles = currentFiles.filter(f => f.endsWith('.pdf') && !f.includes('merged'));
                const tempFiles = currentFiles.filter(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));

                // 检查是否有新的PDF文件且没有临时文件
                const newPdfs = pdfFiles.filter(f => !existingFiles.includes(f));
                if (newPdfs.length > 0 && tempFiles.length === 0) {
                    console.log('[ATBB] 检测到新PDF文件:', newPdfs);
                    return newPdfs.map(f => path.join(this.downloadDir, f));
                }

                // 如果有临时文件，继续等待
                if (tempFiles.length > 0) {
                    console.log('[ATBB] 下载中... 临时文件:', tempFiles.length);
                }
            } catch (e) {
                // 忽略目录读取错误
            }

            await wait(500);
        }

        console.log('[ATBB] 等待PDF下载超时');
        return [];
    }

    // 下载PDF - ATBB流程: インフォシート按钮 → PDF出力 → 自动下载
    async downloadPDF() {
        const page = this.searchPage;
        console.log('[ATBB] 开始下载PDF (自动下载方式)...');

        if (!this.downloadDir) {
            console.log('[ATBB] 未设置下载目录，跳过处理');
            return { pdfs: [], screenshotCount: 0 };
        }

        // 确保目录存在
        try {
            await fs.mkdir(this.downloadDir, { recursive: true });
        } catch (e) {}

        const downloadedPdfs = []; // 存储下载的PDF路径

        // 获取所有インフォシート按钮
        const infoSheetButtons = await page.$$('button[name^="infoSheet"]');
        console.log('[ATBB] 找到インフォシート按钮数量:', infoSheetButtons.length);

        if (infoSheetButtons.length === 0) {
            console.log('[ATBB] 未找到インフォシート按钮');
            return { pdfs: [], screenshotCount: 0 };
        }

        // 最多处理5个物件
        const maxDownloads = Math.min(5, infoSheetButtons.length);

        for (let i = 0; i < maxDownloads; i++) {
            console.log(`[ATBB] 处理第 ${i + 1}/${maxDownloads} 个物件...`);

            try {
                // 记录当前已有的PDF文件
                const existingPdfs = await this.getExistingPdfFiles();

                // 重新获取按钮（页面可能已刷新）
                const buttons = await page.$$('button[name^="infoSheet"]');
                if (i >= buttons.length) {
                    console.log('[ATBB] 按钮索引超出范围，跳过');
                    break;
                }

                // 记录当前页面数量
                const pagesBefore = await this.browser.pages();
                const pageCountBefore = pagesBefore.length;

                // 点击インフォシート按钮
                console.log('[ATBB] 点击インフォシート按钮...');
                await buttons[i].click();
                await wait(2000);

                // 等待新页面打开
                const pagesAfter = await this.browser.pages();
                console.log('[ATBB] 页面数量变化:', pageCountBefore, '->', pagesAfter.length);

                let infoSheetPage = null;
                if (pagesAfter.length > pageCountBefore) {
                    // 新页面打开了
                    infoSheetPage = pagesAfter[pagesAfter.length - 1];

                    // 配置新页面的下载行为
                    await this.configureDownloadForPage(infoSheetPage);

                    await infoSheetPage.bringToFront();
                    await wait(3000); // 等待页面完全加载
                    console.log('[ATBB] インフォシート页面URL:', infoSheetPage.url());

                    // 查找PDF出力按钮
                    console.log('[ATBB] 查找PDF出力按钮...');

                    // 尝试在页面中查找PDF出力按钮
                    const pdfButtonInfo = await infoSheetPage.evaluate(() => {
                        const elements = document.querySelectorAll('button, input[type="button"], input[type="submit"], a');
                        const pdfButtons = [];
                        for (const el of elements) {
                            const text = el.textContent || el.value || '';
                            if (text.includes('PDF') || text.includes('pdf')) {
                                pdfButtons.push({
                                    tag: el.tagName,
                                    text: text.trim().substring(0, 50),
                                    className: el.className,
                                    id: el.id
                                });
                            }
                        }
                        return pdfButtons;
                    });

                    console.log('[ATBB] 找到PDF相关按钮:', JSON.stringify(pdfButtonInfo, null, 2));

                    // 记录点击PDF按钮前的PDF文件
                    const beforePdfClick = await this.getExistingPdfFiles();

                    // 点击PDF出力按钮（右上角的那个，id为button-pdf-format）
                    const clickResult = await infoSheetPage.evaluate(() => {
                        // 优先点击id为button-pdf-format的按钮
                        const targetButton = document.getElementById('button-pdf-format');
                        if (targetButton) {
                            targetButton.click();
                            return { success: true, text: 'PDF出力 (button-pdf-format)' };
                        }

                        // 备选：查找text完全等于"PDF出力"的按钮（不含"不動産向"）
                        const elements = document.querySelectorAll('button, input[type="button"], input[type="submit"], a');
                        for (const el of elements) {
                            const text = (el.textContent || el.value || '').trim();
                            if (text === 'PDF出力' || text === 'PDF 出力') {
                                el.click();
                                return { success: true, text: text };
                            }
                        }

                        // 再备选：查找包含PDF出力但不含"不動産向"的按钮
                        for (const el of elements) {
                            const text = (el.textContent || el.value || '').trim();
                            if ((text.includes('PDF出力') || text.includes('PDF 出力')) && !text.includes('不動産向')) {
                                el.click();
                                return { success: true, text: text };
                            }
                        }

                        return { success: false };
                    });

                    console.log('[ATBB] PDF按钮点击结果:', clickResult);

                    if (clickResult.success) {
                        await wait(2000); // 等待PDF生成/页面打开

                        // 检查是否有新页面打开（PDF预览或直接下载）
                        const pagesAfterPdf = await this.browser.pages();
                        console.log('[ATBB] PDF点击后页面数:', pagesAfterPdf.length);

                        if (pagesAfterPdf.length > pagesAfter.length) {
                            // 新页面打开了（可能是PDF预览）
                            const pdfPage = pagesAfterPdf[pagesAfterPdf.length - 1];

                            // 配置PDF页面的下载行为
                            await this.configureDownloadForPage(pdfPage);

                            await pdfPage.bringToFront();
                            await wait(1000);

                            const pdfUrl = pdfPage.url();
                            console.log('[ATBB] PDF页面URL:', pdfUrl);

                            // 由于禁用了PDF预览，PDF应该直接下载
                            // 等待下载完成
                            const newPdfs = await this.waitForNewPdfDownload(beforePdfClick, 10000);
                            if (newPdfs.length > 0) {
                                downloadedPdfs.push(...newPdfs);
                                console.log('[ATBB] PDF已下载:', newPdfs);
                            } else {
                                // 如果没有检测到下载，尝试使用fetch API下载
                                console.log('[ATBB] 尝试通过URL下载PDF...');
                                if (pdfUrl && (pdfUrl.includes('.pdf') || pdfUrl.includes('pdf'))) {
                                    try {
                                        const pdfPath = path.join(this.downloadDir, `property_${i + 1}_${Date.now()}.pdf`);
                                        // 使用page.pdf()保存当前页面为PDF
                                        await pdfPage.pdf({ path: pdfPath, format: 'A4' });
                                        downloadedPdfs.push(pdfPath);
                                        console.log('[ATBB] PDF已通过page.pdf()保存:', pdfPath);
                                    } catch (pdfError) {
                                        console.log('[ATBB] page.pdf()失败:', pdfError.message);
                                    }
                                }
                            }

                            // 关闭PDF页面
                            try {
                                await pdfPage.close();
                            } catch (e) {}
                        } else {
                            // 没有打开新页面，PDF可能直接开始下载了
                            console.log('[ATBB] 等待PDF直接下载...');
                            const newPdfs = await this.waitForNewPdfDownload(beforePdfClick, 10000);
                            if (newPdfs.length > 0) {
                                downloadedPdfs.push(...newPdfs);
                                console.log('[ATBB] PDF已下载:', newPdfs);
                            }
                        }
                    }

                    // 关闭インフォシート页面
                    try {
                        await infoSheetPage.close();
                    } catch (e) {}
                    await wait(500);

                    // 返回搜索结果页面
                    await this.searchPage.bringToFront();
                } else {
                    console.log('[ATBB] 未检测到新页面打开');
                }

                await wait(1000);

            } catch (error) {
                console.error(`[ATBB] 处理第 ${i + 1} 个物件时出错:`, error.message);
            }
        }

        console.log('[ATBB] PDF下载完成，共下载:', downloadedPdfs.length, '个文件');
        return {
            pdfs: downloadedPdfs,
            screenshotCount: downloadedPdfs.length
        };
    }

    // 合并截图为PDF
    async mergeScreenshotsToPdf(screenshotPaths) {
        const pdfPath = path.join(this.downloadDir, `atbb_properties_${Date.now()}.pdf`);
        console.log('[ATBB] 开始合并截图为PDF:', screenshotPaths.length, '张图片');

        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ autoFirstPage: false });
            const writeStream = require('fs').createWriteStream(pdfPath);

            doc.pipe(writeStream);

            // 添加每张截图作为PDF页面
            for (const imgPath of screenshotPaths) {
                try {
                    const img = doc.openImage(imgPath);
                    // 根据图片尺寸设置页面大小
                    doc.addPage({ size: [img.width, img.height] });
                    doc.image(img, 0, 0, { width: img.width, height: img.height });
                    console.log('[ATBB] 添加图片到PDF:', imgPath);
                } catch (e) {
                    console.error('[ATBB] 添加图片失败:', imgPath, e.message);
                }
            }

            doc.end();

            writeStream.on('finish', () => {
                console.log('[ATBB] PDF文件已生成:', pdfPath);
                resolve(pdfPath);
            });

            writeStream.on('error', (err) => {
                console.error('[ATBB] PDF生成失败:', err);
                reject(err);
            });
        });
    }

    // メイン検索処理
    async search(userRequirements, tantoushaRequirements, downloadDir = null) {
        try {
            // 设置下载目录
            if (downloadDir) {
                this.setDownloadDir(downloadDir);
            }

            // 1. ログイン
            await this.login();

            // 2. 検索ページを開く
            await this.openSearchPage();

            // 3. 可選項を取得
            const options = await this.getSearchOptions();

            // 4. AIで選択
            const aiSelection = await this.aiSelectConditions(options, userRequirements, tantoushaRequirements);

            // 5. フォームに入力（所在地選択含む）
            await this.fillSearchForm(aiSelection, userRequirements, tantoushaRequirements);

            // 6. 截图搜索结果（如果设置了下载目录）
            let screenshotPath = null;
            if (this.downloadDir) {
                screenshotPath = await this.takeScreenshot();
            }

            // 7. 下载PDF - インフォシート → PDF出力
            let downloadedPdfs = [];
            let screenshotCount = 0;
            if (this.downloadDir) {
                const pdfResult = await this.downloadPDF();
                downloadedPdfs = pdfResult.pdfs || [];
                screenshotCount = pdfResult.screenshotCount || 0;
            }

            // 結果を返す
            return {
                success: true,
                platform: 'ATBB',
                aiSelection,
                options,
                searchPageUrl: this.searchPage?.url(),
                message: '検索完了',
                screenshotPath,
                downloadedPdfs,
                screenshotCount  // 截图数量（物件数）
            };

        } catch (error) {
            console.error('[ATBB] 検索エラー:', error);
            throw error;
        }
    }
}

module.exports = new ATBBService();
