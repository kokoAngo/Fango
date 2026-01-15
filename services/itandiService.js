const puppeteer = require('puppeteer');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs').promises;

// ITANDI BB配置
const ITANDI_CONFIG = {
    loginUrl: 'https://service.itandi.co.jp/',
    credentials: {
        email: 'info@fun-t.jp',
        password: 'funt0406'
    },
    searchUrl: 'https://itandibb.com/rent_rooms/list'
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));

class ITANDIService {
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
        console.log('[ITANDI] 下载目录设置为:', dir);
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
                console.log('[ITANDI] 下载路径已配置:', this.downloadDir);
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
        console.log('[ITANDI] 登录中...');

        await page.goto(ITANDI_CONFIG.loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(2000);

        // 点击登录按钮进入登录页面
        const loginLinkClicked = await page.evaluate(() => {
            const links = document.querySelectorAll('a, button');
            for (const link of links) {
                const text = link.textContent?.trim() || '';
                if (text.includes('ログイン') && text.includes('登録')) {
                    link.click();
                    return true;
                }
            }
            return false;
        });

        if (loginLinkClicked) {
            await wait(3000);
            console.log('[ITANDI] 已点击登录链接，当前URL:', page.url());
        }

        // 输入邮箱
        const emailInput = await page.$('input[type="text"][name="email"], input[type="email"], input#email');
        if (emailInput) {
            await emailInput.click();
            await emailInput.type(ITANDI_CONFIG.credentials.email, { delay: 30 });
            console.log('[ITANDI] 邮箱已输入');
        }

        await wait(500);

        // 输入密码
        const passwordInput = await page.$('input[type="password"]');
        if (passwordInput) {
            await passwordInput.click();
            await passwordInput.type(ITANDI_CONFIG.credentials.password, { delay: 30 });
            console.log('[ITANDI] 密码已输入');
        }

        await wait(500);

        // 点击登录按钮 - 使用evaluate查找按钮
        const loginClicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, input[type="submit"]');
            for (const btn of buttons) {
                const text = btn.textContent?.trim() || btn.value || '';
                if (text.includes('ログイン') || btn.type === 'submit') {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (loginClicked) {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        }

        await wait(3000);
        console.log('[ITANDI] 登录完成，当前URL:', page.url());
        return true;
    }

    async navigateToSearch() {
        const page = this.page;
        console.log('[ITANDI] 导航到搜索页面...');

        await page.goto(ITANDI_CONFIG.searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await wait(2000);

        console.log('[ITANDI] 搜索页面已打开');
        return true;
    }

    async getSearchFormStructure() {
        const page = this.page;
        console.log('[ITANDI] 获取表单结构...');

        const structure = await page.evaluate(() => {
            const result = {
                location: [],
                rent: { min: '', max: '' },
                layouts: [],
                buildingTypes: [],
                dealTypes: [],
                equipments: []
            };

            // 获取间取り选项
            const layoutCheckboxes = document.querySelectorAll('input[name="room_layout:in"]');
            layoutCheckboxes.forEach(cb => {
                result.layouts.push({
                    id: cb.id,
                    value: cb.value,
                    label: cb.id
                });
            });

            // 获取建物种类选项
            const buildingTypeCheckboxes = document.querySelectorAll('input[name="building_detail_type:in"]');
            buildingTypeCheckboxes.forEach(cb => {
                const label = document.querySelector(`label[for="${cb.id}"]`)?.innerText || cb.id;
                result.buildingTypes.push({
                    id: cb.id,
                    value: cb.value,
                    label: label
                });
            });

            // 获取取引态様选项
            const dealTypeCheckboxes = document.querySelectorAll('input[name="offer_deal_type:in"]');
            dealTypeCheckboxes.forEach(cb => {
                const label = document.querySelector(`label[for="${cb.id}"]`)?.innerText || cb.id;
                result.dealTypes.push({
                    id: cb.id,
                    value: cb.value,
                    label: label
                });
            });

            return result;
        });

        console.log('[ITANDI] 表单结构:', JSON.stringify(structure, null, 2));
        return structure;
    }

    async aiTranslateRequirements(userRequirements, tantoushaRequirements, formStructure) {
        console.log('[ITANDI] AI翻译搜索条件...');

        const prompt = `あなたは不動産検索の専門家です。ユーザーの希望条件をITANDI BBの検索フォームパラメータに変換してください。

## ユーザーの希望条件
${userRequirements}

## 担当者の追加条件
${tantoushaRequirements || '（なし）'}

## ITANDI BB フォーム構造
利用可能な間取り: ${formStructure.layouts.map(l => l.label).join(', ')}
利用可能な建物種類: ${formStructure.buildingTypes.map(b => b.label).join(', ')}
利用可能な取引態様: ${formStructure.dealTypes.map(d => d.label).join(', ')}

## タスク
上記の条件をITANDI BBの検索パラメータに変換してください。

JSON形式で回答してください：
{
  "prefecture": "都道府県名（例：東京都）",
  "city": "市区町村名（例：渋谷区）",
  "station": "駅名（例：渋谷）",
  "walkMinutes": 徒歩分数（数値のみ、例：10）,
  "rentMin": 賃料下限（数値のみ、例：80000）,
  "rentMax": 賃料上限（数値のみ、例：120000）,
  "layouts": ["選択する間取りのID配列（例：["1LDK", "2LDK"]）"],
  "buildingTypes": ["選択する建物種類のvalue配列（例：["mansion", "apartment"]）"],
  "equipments": ["設備条件の配列（例：["オートロック", "ペット可"]）"],
  "reasoning": "選択理由"
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
                console.log('[ITANDI] AI翻译结果:', JSON.stringify(result, null, 2));
                return result;
            }
        } catch (error) {
            console.error('[ITANDI] AI翻译错误:', error.message);
        }

        return {
            prefecture: '東京都',
            city: '',
            station: '',
            walkMinutes: null,
            rentMin: null,
            rentMax: null,
            layouts: [],
            buildingTypes: [],
            equipments: [],
            reasoning: 'デフォルト条件'
        };
    }

    async fillSearchForm(searchParams, userRequirements) {
        const page = this.page;
        console.log('[ITANDI] フォームに入力中...');

        // 1. 先选择所在地（会打开modal，可能导致其他输入被重置）
        if (searchParams.prefecture || searchParams.city) {
            await this.selectLocation(searchParams.prefecture, searchParams.city, userRequirements);
        }

        await wait(500);

        // 2. 間取り選択
        if (searchParams.layouts && searchParams.layouts.length > 0) {
            console.log('[ITANDI] 間取り設定:', searchParams.layouts);
            for (const layout of searchParams.layouts) {
                await page.evaluate((id) => {
                    const checkbox = document.getElementById(id);
                    if (checkbox && !checkbox.checked) {
                        checkbox.click();
                    }
                }, layout);
                await wait(100);
            }
        }

        // 3. 建物種類選択
        if (searchParams.buildingTypes && searchParams.buildingTypes.length > 0) {
            console.log('[ITANDI] 建物種類設定:', searchParams.buildingTypes);
            for (const type of searchParams.buildingTypes) {
                await page.evaluate((id) => {
                    const checkbox = document.getElementById(id);
                    if (checkbox && !checkbox.checked) {
                        checkbox.click();
                    }
                }, type);
                await wait(100);
            }
        }

        // 4. 賃料入力（最後に設定して消えないようにする）
        if (searchParams.rentMax) {
            const valueInMan = Math.floor(searchParams.rentMax / 10000); // 万円単位
            console.log('[ITANDI] 賃料上限設定:', searchParams.rentMax, '→', valueInMan, '万円');

            // 使用Puppeteer的方式找到并输入价格（更可靠地触发React状态更新）
            const rentInput = await page.$('input[name*="rent"][name*="lteq"]');
            if (rentInput) {
                // 清空现有值
                await rentInput.click({ clickCount: 3 }); // 全选
                await page.keyboard.press('Backspace');
                await wait(100);

                // 输入新值
                await rentInput.type(String(valueInMan), { delay: 50 });
                await wait(100);

                // 触发blur事件确保React更新
                await rentInput.evaluate(el => {
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                });

                console.log('[ITANDI] 賃料入力完了:', valueInMan, '万円');
            } else {
                console.log('[ITANDI] 賃料入力欄が見つかりません');
                // 尝试备用方式：使用evaluate查找
                const rentResult = await page.evaluate((value) => {
                    const inputs = document.querySelectorAll('input');
                    for (const input of inputs) {
                        const name = input.name || '';
                        if (name.includes('rent') && name.includes('lteq')) {
                            // 使用React兼容的方式设置值
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            nativeInputValueSetter.call(input, value);
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                            input.dispatchEvent(new Event('blur', { bubbles: true }));
                            return { success: true, value, name };
                        }
                    }
                    return { success: false };
                }, valueInMan);
                console.log('[ITANDI] 賃料入力結果(備用):', JSON.stringify(rentResult));
            }
            await wait(300);
        }

        await wait(500);
        console.log('[ITANDI] フォーム入力完了');
        return true;
    }

    // 都道府県→地域マッピング
    getRegionMap() {
        return {
            '東京都': '関東',
            '神奈川県': '関東',
            '埼玉県': '関東',
            '千葉県': '関東',
            '茨城県': '関東',
            '栃木県': '関東',
            '群馬県': '関東',
            '大阪府': '近畿',
            '京都府': '近畿',
            '兵庫県': '近畿',
            '奈良県': '近畿',
            '和歌山県': '近畿',
            '滋賀県': '近畿',
            '愛知県': '中部',
            '静岡県': '中部',
            '岐阜県': '中部',
            '三重県': '中部',
            '新潟県': '中部',
            '長野県': '中部',
            '山梨県': '中部',
            '石川県': '中部',
            '富山県': '中部',
            '福井県': '中部',
            '北海道': '北海道',
            '青森県': '東北',
            '岩手県': '東北',
            '宮城県': '東北',
            '秋田県': '東北',
            '山形県': '東北',
            '福島県': '東北',
            '広島県': '中国',
            '岡山県': '中国',
            '山口県': '中国',
            '鳥取県': '中国',
            '島根県': '中国',
            '香川県': '四国',
            '徳島県': '四国',
            '愛媛県': '四国',
            '高知県': '四国',
            '福岡県': '九州',
            '佐賀県': '九州',
            '長崎県': '九州',
            '熊本県': '九州',
            '大分県': '九州',
            '宮崎県': '九州',
            '鹿児島県': '九州',
            '沖縄県': '九州'
        };
    }

    // 市区町村リストを取得
    async getCityOptions() {
        const page = this.page;
        return await page.evaluate(() => {
            const cities = [];
            const labels = document.querySelectorAll('label');
            for (const label of labels) {
                const text = label.innerText?.trim();
                // 市区町村のラベルを識別（区、市、町、村で終わる）
                if (text && (text.endsWith('区') || text.endsWith('市') || text.endsWith('町') || text.endsWith('村')) && text.length < 15) {
                    cities.push(text);
                }
            }
            return cities;
        });
    }

    // 町域・丁目リストを取得
    async getTownOptions() {
        const page = this.page;
        return await page.evaluate(() => {
            const towns = [];
            // 除外するキーワード（取引態様、建物種類、間取りなど）
            const excludeKeywords = [
                '貸主', '代理', '専属専任媒介', '専任媒介', '一般媒介',
                'マンション', 'アパート', '一戸建て', 'テラスハウス', 'タウンハウス', 'シェアハウス',
                '1R', '1K', '1DK', '1LDK', '2K', '2DK', '2LDK', '3K', '3DK', '3LDK', '4K', '4DK', '4LDK', '5K',
                '敷金', '礼金', '広告費', '可能', '要連絡', '都市ガス', 'プロパン',
                '北海道', '東北', '関東', '中部', '近畿', '中国', '四国', '九州',
                '検索', '確定', 'クリア', 'リセット'
            ];

            // モーダル内の町域・丁目リストを探す
            const modal = document.querySelector('[class*="Modal"], [role="dialog"]');
            if (!modal) return towns;

            // モーダル内のラベルを検索
            const labels = modal.querySelectorAll('label');
            for (const label of labels) {
                const text = label.innerText?.trim();
                if (!text || text.length === 0 || text.length > 30) continue;

                // 除外キーワードをチェック
                if (excludeKeywords.some(kw => text.includes(kw))) continue;

                // 都道府県・市区町村を除外
                if (text.endsWith('県') || text.endsWith('都') || text.endsWith('府') || text.endsWith('道')) continue;
                if (text.match(/^.+[区市町村]$/)) continue;

                // チェックボックスまたはラジオボタンを含むラベルのみ対象
                const input = label.querySelector('input[type="checkbox"], input[type="radio"]');
                if (!input) continue;

                towns.push(text);
            }
            return [...new Set(towns)]; // 重複を除去
        });
    }

    // AIで市区町村を選択
    async aiSelectCity(cities, userRequirements) {
        console.log('[ITANDI] AI市区町村選択中... 選択肢数:', cities.length);

        const prompt = `あなたは不動産検索の専門家です。ユーザーの希望条件に最も合う市区町村を選んでください。

## ユーザーの希望条件
${userRequirements}

## 選択可能な市区町村
${cities.join(', ')}

## タスク
ユーザーの希望条件に最も合う市区町村を1つ選んでください。
駅名や地名が指定されている場合は、その駅/地名がある市区町村を選んでください。

JSON形式で回答してください：
{
  "selectedCity": "選択した市区町村名",
  "reasoning": "選択理由"
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
                console.log('[ITANDI] AI市区町村選択結果:', result);
                return result.selectedCity;
            }
        } catch (error) {
            console.error('[ITANDI] AI市区町村選択エラー:', error.message);
        }

        return cities[0]; // デフォルトは最初の選択肢
    }

    // AIで町域・丁目を選択
    async aiSelectTown(towns, userRequirements, selectedCity) {
        if (towns.length === 0) {
            console.log('[ITANDI] 町域・丁目の選択肢がありません');
            return null;
        }

        console.log('[ITANDI] AI町域・丁目選択中... 選択肢数:', towns.length);

        const prompt = `あなたは不動産検索の専門家です。ユーザーの希望条件に最も合う町域・丁目を選んでください。

## ユーザーの希望条件
${userRequirements}

## 選択済み市区町村
${selectedCity}

## 選択可能な町域・丁目
${towns.slice(0, 50).join(', ')}${towns.length > 50 ? '... 他' + (towns.length - 50) + '件' : ''}

## タスク
ユーザーの希望条件に最も合う町域・丁目を1つ選んでください。
駅名が指定されている場合は、その駅の周辺エリアを選んでください。
特に指定がない場合や判断が難しい場合は、"選択なし" と回答してください。

JSON形式で回答してください：
{
  "selectedTown": "選択した町域・丁目名（または '選択なし'）",
  "reasoning": "選択理由"
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
                console.log('[ITANDI] AI町域・丁目選択結果:', result);
                if (result.selectedTown && result.selectedTown !== '選択なし') {
                    return result.selectedTown;
                }
            }
        } catch (error) {
            console.error('[ITANDI] AI町域・丁目選択エラー:', error.message);
        }

        return null; // 選択なし
    }

    // 所在地選択（モーダルダイアログ処理 - AI選択対応）
    async selectLocation(prefecture, city, userRequirements) {
        const page = this.page;
        console.log('[ITANDI] 所在地選択開始:', prefecture, city);

        // 1. 所在地で絞り込みボタンをクリック
        console.log('[ITANDI] 所在地で絞り込みボタンをクリック...');
        const buttonClicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.innerText?.includes('所在地で絞り込み')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (!buttonClicked) {
            console.log('[ITANDI] 所在地ボタンが見つかりません');
            return false;
        }

        await wait(2000);

        // 2. モーダルが開くまで待機
        let modalOpened = false;
        for (let i = 0; i < 5; i++) {
            modalOpened = await page.evaluate(() => {
                // 複数のセレクタで確認
                const selectors = [
                    '[class*="Modal"]',
                    '[class*="modal"]',
                    '[role="dialog"]',
                    '[class*="Backdrop"]',
                    '[class*="backdrop"]'
                ];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.offsetParent !== null) {
                        return true;
                    }
                }
                // regionNameラジオボタンが表示されているか確認
                const regionRadio = document.querySelector('input[name="regionName"]');
                if (regionRadio && regionRadio.offsetParent !== null) {
                    return true;
                }
                return false;
            });

            if (modalOpened) break;
            console.log('[ITANDI] モーダル待機中...', i + 1);
            await wait(1000);
        }

        if (!modalOpened) {
            console.log('[ITANDI] モーダルが開いていません');
            return false;
        }

        console.log('[ITANDI] モーダルが開きました');

        // 3. 地域を選択（関東など）
        if (prefecture) {
            const regionMap = this.getRegionMap();
            const region = regionMap[prefecture] || '関東';
            console.log('[ITANDI] 地域選択:', region);

            const regionClicked = await page.evaluate((regionName) => {
                const radios = document.querySelectorAll('input[name="regionName"]');
                for (const radio of radios) {
                    if (radio.value === regionName) {
                        radio.click();
                        return { success: true, method: 'radio-value', clicked: regionName };
                    }
                }
                const labels = document.querySelectorAll('label');
                for (const label of labels) {
                    const text = label.innerText?.trim();
                    if (text === regionName) {
                        label.click();
                        return { success: true, method: 'label', clicked: regionName };
                    }
                }
                return { success: false };
            }, region);

            console.log('[ITANDI] 地域クリック結果:', regionClicked);
            await wait(800);

            // 4. 都道府県を選択
            console.log('[ITANDI] 都道府県選択:', prefecture);
            const prefClicked = await page.evaluate((pref) => {
                const labels = document.querySelectorAll('label');
                for (const label of labels) {
                    const text = label.innerText?.trim();
                    if (text === pref) {
                        label.click();
                        return { success: true, method: 'label', clicked: pref };
                    }
                }
                return { success: false, reason: 'prefecture not found' };
            }, prefecture);

            console.log('[ITANDI] 都道府県クリック結果:', prefClicked);
            await wait(1000);
        }

        // 5. 市区町村リストを取得してAIで選択
        console.log('[ITANDI] 市区町村リスト取得中...');
        const cityOptions = await this.getCityOptions();
        console.log('[ITANDI] 利用可能な市区町村:', cityOptions.slice(0, 10).join(', '), cityOptions.length > 10 ? `... 他${cityOptions.length - 10}件` : '');

        let selectedCity = city;
        if (cityOptions.length > 0 && userRequirements) {
            // AIで最適な市区町村を選択
            selectedCity = await this.aiSelectCity(cityOptions, userRequirements);
        }

        if (selectedCity) {
            console.log('[ITANDI] 市区町村選択:', selectedCity);
            const cityClicked = await page.evaluate((cityName) => {
                const labels = document.querySelectorAll('label');
                for (const label of labels) {
                    const text = label.innerText?.trim();
                    if (text === cityName) {
                        label.click();
                        return { success: true, method: 'label', clicked: cityName };
                    }
                }
                return { success: false, reason: 'city not found' };
            }, selectedCity);

            console.log('[ITANDI] 市区町村クリック結果:', cityClicked);
            await wait(1000);

            // 6. 町域・丁目リストを取得してAIで選択
            console.log('[ITANDI] 町域・丁目リスト取得中...');
            const townOptions = await this.getTownOptions();
            console.log('[ITANDI] 利用可能な町域・丁目:', townOptions.slice(0, 10).join(', '), townOptions.length > 10 ? `... 他${townOptions.length - 10}件` : '');

            if (townOptions.length > 0 && userRequirements) {
                // AIで最適な町域・丁目を選択
                const selectedTown = await this.aiSelectTown(townOptions, userRequirements, selectedCity);

                if (selectedTown) {
                    console.log('[ITANDI] 町域・丁目選択:', selectedTown);
                    const townClicked = await page.evaluate((townName) => {
                        const labels = document.querySelectorAll('label');
                        for (const label of labels) {
                            const text = label.innerText?.trim();
                            if (text === townName) {
                                label.click();
                                return { success: true, method: 'label', clicked: townName };
                            }
                        }
                        return { success: false, reason: 'town not found' };
                    }, selectedTown);

                    console.log('[ITANDI] 町域・丁目クリック結果:', townClicked);
                    await wait(500);
                }
            }
        }

        // 7. 確定ボタンをクリック
        console.log('[ITANDI] 確定ボタンをクリック...');
        const confirmClicked = await page.evaluate(() => {
            const allButtons = document.querySelectorAll('button');
            for (const btn of allButtons) {
                const text = btn.innerText?.trim();
                if (text === '確定') {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        console.log('[ITANDI] 確定クリック結果:', confirmClicked);
        await wait(1000);

        return true;
    }

    async executeSearch() {
        const page = this.page;
        console.log('[ITANDI] 検索実行...');

        const searchButtonClicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.innerText?.trim() === '検索') {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (searchButtonClicked) {
            await wait(3000);
            console.log('[ITANDI] 検索実行完了');
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

                // 检查是否有新的完成的PDF文件
                if (pdfFiles.length > lastFiles.length && tempFiles.length === 0) {
                    console.log('[ITANDI] 下载完成，PDF文件:', pdfFiles);
                    return pdfFiles;
                }

                lastFiles = pdfFiles;
            } catch (e) {
                // 目录可能不存在
            }

            await wait(500);
        }

        console.log('[ITANDI] 下载超时');
        return [];
    }

    // 选择搜索结果中的物件
    async selectProperties(maxCount = 5) {
        const page = this.page;
        console.log('[ITANDI] 选择物件...');

        // 等待搜索结果加载
        await wait(2000);

        // 获取物件列表中的复选框
        const selectedCount = await page.evaluate((max) => {
            let count = 0;
            // 查找物件卡片上的复选框
            const checkboxes = document.querySelectorAll('input[type="checkbox"]');
            for (const cb of checkboxes) {
                // 排除全选等特殊复选框
                const label = cb.parentElement?.innerText || '';
                if (label.includes('全て') || label.includes('全選択')) continue;

                // 检查是否是物件选择复选框
                const isPropertyCheckbox = cb.name?.includes('room') ||
                                           cb.name?.includes('property') ||
                                           cb.id?.includes('room') ||
                                           cb.closest('[class*="Card"]') ||
                                           cb.closest('[class*="card"]') ||
                                           cb.closest('[class*="item"]');

                if (isPropertyCheckbox && !cb.checked && count < max) {
                    cb.click();
                    count++;
                }
            }
            return count;
        }, maxCount);

        console.log('[ITANDI] 选中物件数:', selectedCount);
        await wait(500);
        return selectedCount;
    }

    // 截图搜索结果
    async takeScreenshot() {
        const page = this.page;
        console.log('[ITANDI] 截图搜索结果...');

        if (!this.downloadDir) {
            console.log('[ITANDI] 未设置下载目录，跳过截图');
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
        const screenshotPath = path.join(screenshotDir, `itandi-result-${timestamp}.png`);

        // 截图
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log('[ITANDI] 截图已保存:', screenshotPath);

        return screenshotPath;
    }

    // 下载PDF (暂停 - 待实现図面按钮点击)
    // ITANDI PDF下载按钮: <button class="MuiButtonBase-root MuiButton-root MuiButton-text MuiButton-textPrimary...>図面</button>
    async downloadPDF() {
        const page = this.page;
        console.log('[ITANDI] 开始下载PDF (図面按钮)...');

        if (!this.downloadDir) {
            console.log('[ITANDI] 未设置下载目录，跳过PDF下载');
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

        // 查找所有図面按钮
        const zumenButtons = await page.$$('button');
        const zumenButtonIndices = [];

        // 找出包含"図面"文本的按钮索引
        for (let i = 0; i < zumenButtons.length; i++) {
            const text = await page.evaluate(el => el.innerText || '', zumenButtons[i]);
            if (text.includes('図面')) {
                zumenButtonIndices.push(i);
            }
        }

        console.log('[ITANDI] 找到図面按钮数量:', zumenButtonIndices.length);

        if (zumenButtonIndices.length === 0) {
            console.log('[ITANDI] 未找到図面按钮');
            return [];
        }

        // 最多下载5个物件的PDF
        const maxDownloads = Math.min(5, zumenButtonIndices.length);

        for (let i = 0; i < maxDownloads; i++) {
            console.log(`[ITANDI] 处理第 ${i + 1}/${maxDownloads} 个物件...`);

            try {
                // 重新获取按钮（页面可能已变化）
                const buttons = await page.$$('button');
                let targetButton = null;
                let buttonIndex = 0;

                for (let j = 0; j < buttons.length; j++) {
                    const text = await page.evaluate(el => el.innerText || '', buttons[j]);
                    if (text.includes('図面')) {
                        if (buttonIndex === i) {
                            targetButton = buttons[j];
                            break;
                        }
                        buttonIndex++;
                    }
                }

                if (!targetButton) {
                    console.log('[ITANDI] 未找到目标図面按钮');
                    continue;
                }

                // 记录点击前的文件列表
                const filesBeforeClick = await fs.readdir(this.downloadDir);

                // 点击図面按钮
                console.log('[ITANDI] 点击図面按钮...');
                await targetButton.click();
                await wait(1000);

                // 查找并点击"管理帯でダウンロード"选项
                console.log('[ITANDI] 查找管理帯でダウンロード选项...');
                const downloadClicked = await page.evaluate(() => {
                    // 查找下拉菜单中的选项 - 精确匹配管理帯
                    const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], li, a, span, div');

                    // 第一优先: 精确匹配"管理帯でダウンロード"且不包含"仲介"
                    for (const item of menuItems) {
                        const text = (item.innerText || item.textContent || '').trim();
                        // 精确匹配：文本应该只是"管理帯でダウンロード"
                        if (text === '管理帯でダウンロード') {
                            item.click();
                            return { success: true, text: text, method: 'exact' };
                        }
                    }

                    // 第二优先: 包含"管理帯"但不包含"仲介"
                    for (const item of menuItems) {
                        const text = (item.innerText || item.textContent || '').trim();
                        if (text.includes('管理帯') && !text.includes('仲介')) {
                            item.click();
                            return { success: true, text: text.substring(0, 30), method: 'partial' };
                        }
                    }

                    // 打印所有菜单项用于调试
                    const debugItems = [];
                    menuItems.forEach((item, i) => {
                        const text = (item.innerText || item.textContent || '').trim();
                        if (text.includes('ダウンロード') && i < 20) {
                            debugItems.push({ index: i, text: text.substring(0, 50), tag: item.tagName });
                        }
                    });

                    return { success: false, debugItems };
                });

                if (downloadClicked.success) {
                    console.log('[ITANDI] 点击了下载选项:', downloadClicked.text, '方式:', downloadClicked.method);

                    // 等待下载完成
                    const newFiles = await this.waitForPdfDownload(filesBeforeClick, 15000);

                    if (newFiles.length > 0) {
                        console.log('[ITANDI] 下载成功:', newFiles);
                        downloadedPdfs.push(...newFiles.map(f => path.join(this.downloadDir, f)));
                        existingFiles = [...existingFiles, ...newFiles];
                    } else {
                        console.log('[ITANDI] 未检测到新下载的PDF文件');
                    }
                } else {
                    console.log('[ITANDI] 未找到管理帯でダウンロード选项，调试信息:', JSON.stringify(downloadClicked.debugItems || []));
                    // 点击页面其他地方关闭菜单
                    await page.mouse.click(100, 100);
                }

                await wait(1000);

            } catch (error) {
                console.error(`[ITANDI] 处理第 ${i + 1} 个物件时出错:`, error.message);
            }
        }

        console.log('[ITANDI] PDF下载完成，共下载:', downloadedPdfs.length, '个文件');
        return downloadedPdfs;
    }

    // 等待PDF下载完成
    async waitForPdfDownload(existingFiles, timeout = 15000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                const currentFiles = await fs.readdir(this.downloadDir);
                const pdfFiles = currentFiles.filter(f => f.endsWith('.pdf'));
                const tempFiles = currentFiles.filter(f => f.endsWith('.crdownload') || f.endsWith('.tmp'));
                const newPdfs = pdfFiles.filter(f => !existingFiles.includes(f));

                if (newPdfs.length > 0 && tempFiles.length === 0) {
                    console.log('[ITANDI] 下载完成，新PDF文件:', newPdfs);
                    return newPdfs;
                }

                if (tempFiles.length > 0) {
                    console.log('[ITANDI] 下载中... 临时文件:', tempFiles.length);
                }
            } catch (e) {}
            await wait(500);
        }
        console.log('[ITANDI] 下载超时');
        return [];
    }

    async search(userRequirements, tantoushaRequirements, downloadDir = null) {
        try {
            console.log('[ITANDI] 検索開始...');

            // 设置下载目录
            if (downloadDir) {
                this.setDownloadDir(downloadDir);
            }

            // 1. 登录
            await this.login();

            // 2. 导航到搜索页面
            await this.navigateToSearch();

            // 3. 获取表单结构
            const formStructure = await this.getSearchFormStructure();

            // 4. AI翻译条件
            const searchParams = await this.aiTranslateRequirements(
                userRequirements,
                tantoushaRequirements,
                formStructure
            );

            // 5. 填写表单（传递userRequirements用于AI选择市区町村和町域）
            await this.fillSearchForm(searchParams, userRequirements);

            // 6. 执行搜索
            await this.executeSearch();

            // 7. 截图搜索结果（如果设置了下载目录）
            let screenshotPath = null;
            if (this.downloadDir) {
                screenshotPath = await this.takeScreenshot();
            }

            // 8. 下载PDF - 図面按钮 → 管理帯でダウンロード
            let downloadedPdfs = [];
            if (this.downloadDir) {
                downloadedPdfs = await this.downloadPDF();
            }

            return {
                success: true,
                platform: 'ITANDI',
                searchParams,
                message: '検索完了',
                resultUrl: this.page.url(),
                screenshotPath,
                downloadedPdfs
            };

        } catch (error) {
            console.error('[ITANDI] 検索エラー:', error);
            return {
                success: false,
                platform: 'ITANDI',
                error: error.message
            };
        }
    }
}

module.exports = new ITANDIService();
