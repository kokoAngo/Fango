const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs').promises;

// いえらぶBB配置 - 从explorer-ierabu-v3.js学习
const IERABU_CONFIG = {
    loginUrl: 'https://bb.ielove.jp/ielovebb/login/index/',  // 正确的登录URL
    credentials: {
        email: 'goto@fun-t.jp',
        password: 'funt040600'
    },
    searchUrl: 'https://bb.ielove.jp/ielovebb/rent/searchmenu/'
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

class IerabuService {
    constructor() {
        this.browser = null;
        this.page = null;
        this.downloadDir = null;
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
    }

    // 设置下载目录
    setDownloadDir(dir) {
        this.downloadDir = dir;
        console.log('[いえらぶBB] 下载目录设置为:', dir);
    }

    async initBrowser() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: false,
                executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                defaultViewport: { width: 1400, height: 900 },
                args: ['--lang=ja-JP', '--no-sandbox']
            });
            this.page = await this.browser.newPage();

            // 配置下载目录
            if (this.downloadDir) {
                const client = await this.page.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: this.downloadDir
                });
                console.log('[いえらぶBB] 下载路径已配置:', this.downloadDir);
            }
        }
        return this.page;
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }
    }

    async login() {
        // 先关闭之前的浏览器实例，确保干净状态
        await this.closeBrowser();

        const page = await this.initBrowser();
        console.log('[いえらぶBB] 登录中...');

        // 使用正确的登录URL (从explorer-ierabu-v3.js学习)
        await page.goto(IERABU_CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(2000);

        // 输入账号 (使用与explorer相同的选择器)
        await page.type('input[type="text"], input[type="email"]', IERABU_CONFIG.credentials.email, { delay: 30 });
        console.log('[いえらぶBB] 账号已输入');

        // 输入密码
        await page.type('input[type="password"]', IERABU_CONFIG.credentials.password, { delay: 30 });
        console.log('[いえらぶBB] 密码已输入');

        await wait(500);

        // 点击登录按钮 (使用explorer中的#loginButton)
        await page.click('#loginButton');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

        await wait(3000);
        console.log('[いえらぶBB] 登录完成，当前URL:', page.url());
        return true;
    }

    async navigateToSearch() {
        const page = this.page;
        console.log('[いえらぶBB] 导航到搜索页面...');

        await page.goto(IERABU_CONFIG.searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(2000);

        // 点击 "市区町村から探す" 按钮以显示都道府県复选框
        console.log('[いえらぶBB] 点击市区町村から探す按钮...');
        const buttonClicked = await page.evaluate(() => {
            // 尝试找到按钮
            const btn = document.getElementById('shikuchoson');
            if (btn) {
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return { success: true, method: 'id' };
            }

            // 备选方案: 通过文本查找
            const buttons = document.querySelectorAll('button, a, div[onclick]');
            for (const b of buttons) {
                if (b.textContent?.includes('市区町村から探す')) {
                    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return { success: true, method: 'text' };
                }
            }
            return { success: false };
        });

        console.log('[いえらぶBB] 按钮点击结果:', buttonClicked);
        await wait(2000);

        console.log('[いえらぶBB] 搜索页面已打开');
        return true;
    }

    async getPrefectureOptions() {
        const page = this.page;
        console.log('[いえらぶBB] 获取都道府県选项...');

        const prefectures = await page.evaluate(() => {
            const options = [];
            const checkboxes = document.querySelectorAll('input[name="todofuken[]"]');

            checkboxes.forEach(cb => {
                const id = cb.id;
                const value = cb.value || id.replace('todofuken-', '');

                // 尝试多种方式获取label
                let label = '';

                // 方法1: label[for="id"]
                const labelEl = document.querySelector(`label[for="${id}"]`);
                if (labelEl) {
                    label = labelEl.innerText?.trim() || '';
                }

                // 方法2: 父元素中的文本
                if (!label && cb.parentElement) {
                    const parentText = cb.parentElement.textContent?.trim();
                    if (parentText && parentText.length < 20) {
                        label = parentText;
                    }
                }

                // 方法3: 使用预定义的映射
                if (!label) {
                    const prefMap = {
                        '01': '北海道', '02': '青森県', '03': '岩手県', '04': '宮城県',
                        '05': '秋田県', '06': '山形県', '07': '福島県', '08': '茨城県',
                        '09': '栃木県', '10': '群馬県', '11': '埼玉県', '12': '千葉県',
                        '13': '東京都', '14': '神奈川県', '15': '新潟県', '16': '富山県',
                        '17': '石川県', '18': '福井県', '19': '山梨県', '20': '長野県',
                        '21': '岐阜県', '22': '静岡県', '23': '愛知県', '24': '三重県',
                        '25': '滋賀県', '26': '京都府', '27': '大阪府', '28': '兵庫県',
                        '29': '奈良県', '30': '和歌山県', '31': '鳥取県', '32': '島根県',
                        '33': '岡山県', '34': '広島県', '35': '山口県', '36': '徳島県',
                        '37': '香川県', '38': '愛媛県', '39': '高知県', '40': '福岡県',
                        '41': '佐賀県', '42': '長崎県', '43': '熊本県', '44': '大分県',
                        '45': '宮崎県', '46': '鹿児島県', '47': '沖縄県'
                    };
                    label = prefMap[value] || `都道府県${value}`;
                }

                options.push({ id, value, label });
            });

            return options;
        });

        console.log('[いえらぶBB] 都道府県选项数量:', prefectures.length);
        if (prefectures.length > 0) {
            console.log('[いえらぶBB] 前5个:', prefectures.slice(0, 5).map(p => p.label).join(', '));
        }
        return prefectures;
    }

    async getCityOptions(prefectureValue) {
        const page = this.page;
        console.log('[いえらぶBB] 获取市区町村选项...');

        const cities = await page.evaluate((prefValue) => {
            const options = [];
            const checkboxes = document.querySelectorAll('input[name="shikuchoson[]"]');
            checkboxes.forEach(cb => {
                const id = cb.id;
                // ID格式: shikuchoson-14_101 (14=神奈川県, 101=横浜市鶴見区)
                if (id.startsWith(`shikuchoson-${prefValue}_`)) {
                    const label = document.querySelector(`label[for="${id}"]`)?.innerText?.trim() || '';
                    const value = cb.value || id.replace('shikuchoson-', '');
                    if (label) {
                        options.push({ id, value, label });
                    }
                }
            });
            return options;
        }, prefectureValue);

        console.log('[いえらぶBB] 市区町村选项数:', cities.length);
        return cities;
    }

    async aiSelectPrefecture(prefectures, userRequirements) {
        console.log('[いえらぶBB] AI选择都道府県...');

        // 只传递都道府県名称列表
        const prefectureNames = prefectures.map(p => p.label).join(', ');

        const prompt = `あなたは不動産検索の専門家です。ユーザーの希望条件に最も適した都道府県を選択してください。

## ユーザーの希望条件
${userRequirements}

## 選択可能な都道府県
${prefectureNames}

## タスク
上記の条件に最も適した都道府県を1つ選んでください。
都道府県名をそのまま回答してください。

JSON形式で回答してください：
{
  "selectedPrefecture": "選択した都道府県名（例：東京都）",
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
                console.log('[いえらぶBB] AI都道府県選択結果:', result);

                // 名前で検索
                const selected = prefectures.find(p => p.label === result.selectedPrefecture);
                if (selected) {
                    return selected;
                }

                // 部分一致で検索
                const partialMatch = prefectures.find(p =>
                    p.label.includes(result.selectedPrefecture) ||
                    result.selectedPrefecture.includes(p.label)
                );
                if (partialMatch) {
                    return partialMatch;
                }
            }
        } catch (error) {
            console.error('[いえらぶBB] AI都道府県選択エラー:', error.message);
        }

        // デフォルト: 東京都
        const tokyo = prefectures.find(p => p.label.includes('東京'));
        return tokyo || prefectures[0];
    }

    async aiSelectCity(cities, userRequirements) {
        console.log('[いえらぶBB] AI选择市区町村...');

        // 只传递市区町村名称列表
        const cityNames = cities.map(c => c.label).join(', ');

        const prompt = `あなたは不動産検索の専門家です。ユーザーの希望条件に最も適した市区町村を選択してください。

## ユーザーの希望条件
${userRequirements}

## 選択可能な市区町村
${cityNames}

## タスク
上記の条件に最も適した市区町村を1つ選んでください。
駅名が指定されている場合は、その駅がある市区町村を選んでください。

JSON形式で回答してください：
{
  "selectedCity": "選択した市区町村名（例：渋谷区）",
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
                console.log('[いえらぶBB] AI市区町村選択結果:', result);

                // 名前で検索
                const selected = cities.find(c => c.label === result.selectedCity);
                if (selected) {
                    return selected;
                }

                // 部分一致で検索
                const partialMatch = cities.find(c =>
                    c.label.includes(result.selectedCity) ||
                    result.selectedCity.includes(c.label)
                );
                if (partialMatch) {
                    return partialMatch;
                }
            }
        } catch (error) {
            console.error('[いえらぶBB] AI市区町村選択エラー:', error.message);
        }

        return cities[0];
    }

    async selectLocation(userRequirements) {
        const page = this.page;
        console.log('[いえらぶBB] 地域選択中...');

        // 1. 获取都道府県选项
        const prefectures = await this.getPrefectureOptions();

        // 检查是否有都道府県选项
        if (!prefectures || prefectures.length === 0) {
            console.log('[いえらぶBB] 警告: 没有找到都道府県选项，尝试等待页面加载...');
            await wait(2000);

            // 重新获取
            const prefecturesRetry = await this.getPrefectureOptions();
            if (!prefecturesRetry || prefecturesRetry.length === 0) {
                console.log('[いえらぶBB] 仍然没有找到都道府県选项，跳过地域选择');
                return { prefecture: null, city: null };
            }
        }

        // 2. AI选择都道府県
        const selectedPref = await this.aiSelectPrefecture(prefectures, userRequirements);

        if (!selectedPref) {
            console.log('[いえらぶBB] AI未能选择都道府県');
            return { prefecture: null, city: null };
        }

        console.log('[いえらぶBB] 選択した都道府県:', selectedPref.label);

        // 3. 点击都道府県复选框
        await page.evaluate((id) => {
            const checkbox = document.getElementById(id);
            if (checkbox && !checkbox.checked) {
                checkbox.click();
            }
        }, selectedPref.id);

        await wait(1000);

        // 4. 获取市区町村选项
        const cities = await this.getCityOptions(selectedPref.value);
        let selectedCity = null;

        if (cities && cities.length > 0) {
            // 5. AI选择市区町村
            selectedCity = await this.aiSelectCity(cities, userRequirements);

            if (selectedCity) {
                console.log('[いえらぶBB] 選択した市区町村:', selectedCity.label);

                // 6. 点击市区町村复选框
                await page.evaluate((id) => {
                    const checkbox = document.getElementById(id);
                    if (checkbox && !checkbox.checked) {
                        checkbox.click();
                    }
                }, selectedCity.id);

                await wait(500);
            }
        }

        return { prefecture: selectedPref, city: selectedCity };
    }

    async executeSearch() {
        const page = this.page;
        console.log('[いえらぶBB] 検索実行...');

        // 点击検索按钮
        const searchButtonClicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('input[type="submit"], button[type="submit"]');
            for (const btn of buttons) {
                const text = btn.value || btn.innerText || '';
                if (text.includes('検索') || text.includes('物件検索')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (searchButtonClicked) {
            await wait(3000);
            console.log('[いえらぶBB] 検索実行完了');
            return true;
        }

        return false;
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
                    console.log('[いえらぶBB] 下载完成，PDF文件:', pdfFiles);
                    return pdfFiles;
                }

                lastFiles = pdfFiles;
            } catch (e) {
                // 目录可能不存在
            }

            await wait(500);
        }

        console.log('[いえらぶBB] 下载超时');
        return [];
    }

    // 选择搜索结果中的物件
    async selectProperties(maxCount = 5) {
        const page = this.page;
        console.log('[いえらぶBB] 选择物件...');

        await wait(2000);

        const selectedCount = await page.evaluate((max) => {
            let count = 0;
            const checkboxes = document.querySelectorAll('input[type="checkbox"]');
            for (const cb of checkboxes) {
                const label = cb.parentElement?.innerText || '';
                if (label.includes('全て') || label.includes('全選択')) continue;

                // いえらぶBB的物件选择复选框
                const name = cb.name || '';
                const id = cb.id || '';
                if ((name.includes('bukken') || name.includes('property') || id.includes('bukken')) &&
                    !cb.checked && count < max) {
                    cb.click();
                    count++;
                }
            }
            return count;
        }, maxCount);

        console.log('[いえらぶBB] 选中物件数:', selectedCount);
        await wait(500);
        return selectedCount;
    }

    // 截图搜索结果
    async takeScreenshot() {
        const page = this.page;
        console.log('[いえらぶBB] 截图搜索结果...');

        if (!this.downloadDir) {
            console.log('[いえらぶBB] 未设置下载目录，跳过截图');
            return null;
        }

        // 创建 screenshots 子文件夹
        const screenshotDir = path.join(this.downloadDir, 'screenshots');
        try {
            await fs.mkdir(screenshotDir, { recursive: true });
        } catch (e) {
            // 目录已存在
        }

        // 生成截图文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const screenshotPath = path.join(screenshotDir, `ierabu-result-${timestamp}.png`);

        // 截图
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log('[いえらぶBB] 截图已保存:', screenshotPath);

        return screenshotPath;
    }

    // 下载PDF - 点击チラシ作成按钮，然后选择下载选项
    async downloadPDF() {
        const page = this.page;
        console.log('[いえらぶBB] 开始下载PDF (チラシ作成按钮)...');

        if (!this.downloadDir) {
            console.log('[いえらぶBB] 未设置下载目录，跳过PDF下载');
            return [];
        }

        // 确保目录存在
        try {
            await fs.mkdir(this.downloadDir, { recursive: true });
        } catch (e) {}

        // 记录下载前的文件
        let existingFiles = [];
        try {
            existingFiles = await fs.readdir(this.downloadDir);
        } catch (e) {}

        const downloadedPdfs = [];

        // 检查当前页面URL
        const currentUrl = page.url();
        console.log('[いえらぶBB] 当前页面URL:', currentUrl);

        // 检查是否在搜索结果页面
        if (!currentUrl.includes('/rent/index/') && !currentUrl.includes('/rent/list/')) {
            console.log('[いえらぶBB] 警告: 当前不在搜索结果页面');
        }

        // 等待页面完全加载
        await wait(3000);

        // 等待物件列表加载完成
        try {
            await page.waitForSelector('a.openZumenDownloadDialog, [class*="チラシ"]', { timeout: 10000 });
            console.log('[いえらぶBB] 物件列表已加载');
        } catch (e) {
            console.log('[いえらぶBB] 等待物件列表超时，继续尝试查找按钮');
        }

        // 检查搜索结果数量
        const resultCount = await page.evaluate(() => {
            // 尝试获取搜索结果数量
            const countText = document.body.innerText.match(/(\d+)件/);
            return countText ? countText[1] : '未知';
        });
        console.log('[いえらぶBB] 搜索结果数量:', resultCount);

        // 查找所有チラシ作成按钮 - 使用更具体的选择器
        let chirashiButtons = [];
        try {
            chirashiButtons = await page.$$eval('a, button, span, div, input', (elements) => {
                const buttons = [];
                for (const el of elements) {
                    const text = (el.innerText || el.textContent || '').trim();
                    // 只匹配精确的チラシ作成文本，避免匹配包含大量子元素的容器
                    if (text === 'チラシ作成') {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && rect.width < 200) {
                            buttons.push({
                                tag: el.tagName,
                                text: text,
                                className: el.className
                            });
                        }
                    }
                }
                return buttons;
            });
        } catch (evalError) {
            console.log('[いえらぶBB] 查找按钮时出错:', evalError.message);
            return [];
        }
        console.log('[いえらぶBB] 找到チラシ作成按钮数量:', chirashiButtons.length);

        if (chirashiButtons.length === 0) {
            console.log('[いえらぶBB] 未找到チラシ作成按钮');
            // 打印页面中的链接用于调试
            const debugInfo = await page.evaluate(() => {
                const links = document.querySelectorAll('a');
                const chirashiLinks = [];
                for (const link of links) {
                    const text = (link.innerText || '').trim();
                    const href = link.href || '';
                    if (text.includes('チラシ') || href.includes('zumen')) {
                        chirashiLinks.push({ text: text.substring(0, 30), href: href.substring(0, 50) });
                    }
                }
                return chirashiLinks.slice(0, 10);
            });
            console.log('[いえらぶBB] 页面中的チラシ相关链接:', JSON.stringify(debugInfo));
            return [];
        }

        // 最多处理5个物件
        const maxDownloads = Math.min(5, chirashiButtons.length);

        for (let i = 0; i < maxDownloads; i++) {
            console.log(`[いえらぶBB] 处理第 ${i + 1}/${maxDownloads} 个物件...`);

            try {
                // 记录点击前的文件列表
                const filesBeforeClick = await fs.readdir(this.downloadDir);

                // 等待页面稳定
                await wait(500);

                // 重新查找チラシ作成按钮（因为DOM可能变化）
                const clickResult = await page.evaluate((index) => {
                    const elements = document.querySelectorAll('a, button, span, div, input');
                    const chirashiElements = [];
                    for (const el of elements) {
                        const text = (el.innerText || el.textContent || '').trim();
                        if (text === 'チラシ作成') {
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0 && rect.width < 200) {
                                chirashiElements.push(el);
                            }
                        }
                    }
                    if (index < chirashiElements.length) {
                        chirashiElements[index].click();
                        return { success: true, clicked: index, total: chirashiElements.length };
                    }
                    return { success: false, total: chirashiElements.length };
                }, i);

                console.log('[いえらぶBB] 点击チラシ作成按钮结果:', clickResult);

                if (!clickResult.success) {
                    console.log('[いえらぶBB] 无法点击チラシ作成按钮，跳过');
                    continue;
                }

                // 等待ui-dialog弹窗出现
                await wait(2000);

                // 确保弹窗已加载
                await page.waitForSelector('.ui-dialog-content', { timeout: 5000 }).catch(() => {
                    console.log('[いえらぶBB] ui-dialog弹窗未出现');
                });

                // 查找ダウンロード按钮 - 在ui-dialog弹窗中查找<A>标签
                const downloadResult = await page.evaluate(() => {
                    // 首先查找ui-dialog弹窗
                    const dialog = document.querySelector('.ui-dialog-content');
                    if (!dialog) {
                        return { success: false, reason: 'no_dialog', debugInfo: 'ui-dialog-content not found' };
                    }

                    // 在弹窗中查找下载链接<A>标签
                    const downloadLinks = dialog.querySelectorAll('a');
                    const downloadButtons = [];

                    for (const link of downloadLinks) {
                        const text = (link.innerText || link.textContent || '').trim();
                        // 精确匹配下载按钮文本
                        if (text === '管理会社帯でダウンロード' || text === '帯替えしてダウンロード') {
                            const rect = link.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                downloadButtons.push({
                                    element: link,
                                    text: text,
                                    isKanriKaisha: text === '管理会社帯でダウンロード'
                                });
                            }
                        }
                    }

                    console.log('找到ダウンロード按钮数量:', downloadButtons.length);

                    if (downloadButtons.length === 0) {
                        // 备用方案：查找所有包含ダウンロード的<A>标签
                        const allLinks = dialog.querySelectorAll('a');
                        for (const link of allLinks) {
                            const text = (link.innerText || link.textContent || '').trim();
                            if (text.includes('ダウンロード')) {
                                link.click();
                                return { success: true, method: 'fallback', clicked: text };
                            }
                        }
                        return { success: false, reason: 'no_download_buttons', debugInfo: 'No download links in dialog' };
                    }

                    // 优先选择管理会社帯でダウンロード
                    const kanriButton = downloadButtons.find(b => b.isKanriKaisha);
                    if (kanriButton) {
                        kanriButton.element.click();
                        return { success: true, method: 'kanri_kaisha', clicked: kanriButton.text };
                    }

                    // 否则点击第一个
                    downloadButtons[0].element.click();
                    return { success: true, method: 'first', clicked: downloadButtons[0].text };
                });

                console.log('[いえらぶBB] 下载按钮点击结果:', downloadResult);

                if (!downloadResult.success) {
                    console.log('[いえらぶBB] 未找到下载按钮，调试信息:', downloadResult.debugInfo);
                    // 关闭可能打开的菜单
                    await page.keyboard.press('Escape');
                    await wait(500);
                    continue;
                }

                // 等待下载完成
                await wait(2000);
                const newFiles = await this.waitForPdfDownload(filesBeforeClick, 15000);

                if (newFiles.length > 0) {
                    console.log('[いえらぶBB] 下载成功:', newFiles);
                    downloadedPdfs.push(...newFiles.map(f => path.join(this.downloadDir, f)));
                    existingFiles = [...existingFiles, ...newFiles];
                } else {
                    console.log('[いえらぶBB] 未检测到新下载的PDF文件');
                }

                // 关闭可能打开的菜单
                await page.keyboard.press('Escape');
                await wait(1000);

            } catch (error) {
                console.error(`[いえらぶBB] 处理第 ${i + 1} 个物件时出错:`, error.message);
                // 尝试关闭可能打开的菜单
                try {
                    await page.keyboard.press('Escape');
                } catch (e) {}
            }
        }

        console.log('[いえらぶBB] PDF下载完成，共下载:', downloadedPdfs.length, '个文件');
        return downloadedPdfs;
    }

    // 等待PDF或图片下载完成
    async waitForPdfDownload(existingFiles, timeout = 15000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                const currentFiles = await fs.readdir(this.downloadDir);
                // 支持PDF和图片格式
                const downloadedFiles = currentFiles.filter(f =>
                    f.endsWith('.pdf') ||
                    f.endsWith('.png') ||
                    f.endsWith('.jpg') ||
                    f.endsWith('.jpeg') ||
                    f.endsWith('.PNG') ||
                    f.endsWith('.JPG') ||
                    f.endsWith('.JPEG')
                );
                const tempFiles = currentFiles.filter(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
                const newFiles = downloadedFiles.filter(f => !existingFiles.includes(f));

                if (newFiles.length > 0 && tempFiles.length === 0) {
                    console.log('[いえらぶBB] 下载完成，新文件:', newFiles);
                    return newFiles;
                }

                if (tempFiles.length > 0) {
                    console.log('[いえらぶBB] 下载中... 临时文件:', tempFiles.length);
                }
            } catch (e) {}
            await wait(500);
        }
        console.log('[いえらぶBB] 下载超时');
        return [];
    }

    async search(userRequirements, tantoushaRequirements, downloadDir = null) {
        try {
            console.log('[いえらぶBB] 検索開始...');

            // 设置下载目录
            if (downloadDir) {
                this.setDownloadDir(downloadDir);
            }

            // 1. 登录
            await this.login();

            // 2. 导航到搜索页面
            await this.navigateToSearch();

            // 3. 选择地域
            const location = await this.selectLocation(userRequirements);

            // 4. 执行搜索
            await this.executeSearch();

            // 5. 截图搜索结果（如果设置了下载目录）
            let screenshotPath = null;
            if (this.downloadDir) {
                screenshotPath = await this.takeScreenshot();
            }

            // 6. 下载PDF - 点击物件名旁边的下载图标
            let downloadedPdfs = [];
            if (this.downloadDir) {
                downloadedPdfs = await this.downloadPDF();
            }

            return {
                success: true,
                platform: 'いえらぶBB',
                location,
                message: '検索完了',
                resultUrl: this.page.url(),
                screenshotPath,
                downloadedPdfs
            };

        } catch (error) {
            console.error('[いえらぶBB] 検索エラー:', error);
            return {
                success: false,
                platform: 'いえらぶBB',
                error: error.message
            };
        }
    }
}

module.exports = new IerabuService();
