const puppeteer = require('puppeteer');

const REINS_LOGIN_URL = 'https://system.reins.jp/login/main/KG/GKG001200';
const TIMEOUT = 60000;

class ReinsService {
  constructor() {
    this.browser = null;
    this.page = null;
  }

  async initBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: process.env.HEADLESS === 'true',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
    return this.browser;
  }

  async login(username, password) {
    try {
      const browser = await this.initBrowser();
      this.page = await browser.newPage();
      await this.page.setViewport({ width: 1920, height: 1080 });

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

  async openEquipmentGuide() {
    try {
      console.log('Looking for 入力ガイド button in 設備・条件・住宅性能等 section...');

      await this.page.evaluate(() => {
        const sections = document.querySelectorAll('legend, h3, h4, th, td');
        for (const section of sections) {
          if (section.textContent?.includes('設備') || section.textContent?.includes('オプション')) {
            section.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return true;
          }
        }
        window.scrollTo(0, document.body.scrollHeight / 2);
        return false;
      });

      await new Promise(resolve => setTimeout(resolve, 1500));
      await this.page.screenshot({ path: 'debug-before-guide.png' });

      const guideClicked = await this.page.evaluate(() => {
        const allRows = document.querySelectorAll('tr');
        for (const row of allRows) {
          const text = row.textContent || '';
          if (text.includes('設備') && text.includes('条件') && text.includes('入力ガイド')) {
            const btns = row.querySelectorAll('button, a, span');
            for (const btn of btns) {
              if (btn.textContent?.trim() === '入力ガイド') {
                btn.click();
                return { clicked: true, context: '設備・条件・住宅性能等' };
              }
            }
          }
        }

        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
          if (btn.textContent?.includes('入力ガイド')) {
            const parent = btn.closest('tr, div, fieldset');
            if (parent && (parent.textContent?.includes('設備') || parent.textContent?.includes('オプション'))) {
              btn.click();
              return { clicked: true, context: 'found via parent' };
            }
          }
        }

        const allLinks = document.querySelectorAll('a, button, span[role="button"]');
        for (const link of allLinks) {
          if (link.textContent?.trim() === '入力ガイド') {
            link.click();
            return { clicked: true, context: 'any link' };
          }
        }

        return { clicked: false };
      });

      if (guideClicked.clicked) {
        console.log('Clicked 入力ガイド button:', guideClicked.context);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.page.screenshot({ path: 'debug-equipment-guide.png' });
        return true;
      } else {
        console.log('入力ガイド button not found');
        return false;
      }

    } catch (error) {
      console.error('Failed to open equipment guide:', error.message);
      return false;
    }
  }

  async selectEquipmentFromGuide(keywords) {
    try {
      console.log('Selecting equipment from guide:', keywords);
      await new Promise(resolve => setTimeout(resolve, 2000));

      const selected = await this.page.evaluate((keywordList) => {
        const results = [];
        const modal = document.querySelector('.modal-content, [role="dialog"], .popup, .v-dialog');
        const container = modal || document;

        const options = container.querySelectorAll('input[type="checkbox"], label, li, .list-item, button');

        for (const option of options) {
          const text = option.textContent?.trim() || '';
          const labelText = option.closest('label')?.textContent?.trim() || text;

          for (const keyword of keywordList) {
            if (text.includes(keyword) || labelText.includes(keyword)) {
              if (option.tagName === 'INPUT' && option.type === 'checkbox') {
                if (!option.checked) {
                  option.click();
                  results.push({ keyword, text: labelText, type: 'checkbox' });
                }
              } else if (option.tagName === 'LABEL' || option.tagName === 'LI') {
                option.click();
                results.push({ keyword, text: labelText, type: option.tagName.toLowerCase() });
              }
              break;
            }
          }
        }

        return results;
      }, keywords);

      console.log('Selected equipment from guide:', selected);

      await new Promise(resolve => setTimeout(resolve, 1000));

      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if (text === 'OK' || text === '確定' || text === '決定' || text === '選択' || text === '閉じる') {
            btn.click();
            return text;
          }
        }
        return null;
      });

      await new Promise(resolve => setTimeout(resolve, 1000));
      return selected;

    } catch (error) {
      console.error('Failed to select equipment:', error.message);
      return [];
    }
  }

  async fillSearchConditions(conditions) {
    try {
      console.log('Filling search conditions...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      const reinsFields = conditions.reinsFields || {};
      const textInputs = reinsFields.textInputs || {};
      const selects = reinsFields.selects || {};
      const checkboxes = reinsFields.checkboxes || {};
      const keywords = reinsFields.keywords || [];

      console.log('Selecting property type...');
      const propertyTypeValue = selects['__BVID__293'] || '03';

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

      const prefecture = textInputs['__BVID__325'] || '東京都';
      console.log('Filling prefecture:', prefecture);

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
        console.log('Prefecture filled');
      }

      await new Promise(resolve => setTimeout(resolve, 500));

      for (const [fieldId, value] of Object.entries(textInputs)) {
        if (fieldId === '__BVID__325') continue;
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
          console.log('Filled field', fieldId, ':', value);
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

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

        console.log('Selected', selectId, ':', value);
        await new Promise(resolve => setTimeout(resolve, 200));
      }

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

          console.log('Checked', checkboxId);
        }
      }

      if (keywords && keywords.length > 0) {
        console.log('\n=== Trying to select equipment via 入力ガイド ===');
        console.log('Keywords to select:', keywords);

        const guideOpened = await this.openEquipmentGuide();

        if (guideOpened) {
          await this.selectEquipmentFromGuide(keywords);
        } else {
          console.log('入力ガイド not available, filling 備考 field instead');
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
              console.log('Filled 備考:', textInputs['__BVID__567']);
            }
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.page.screenshot({ path: 'debug-after-fill.png' });
      console.log('Search conditions filled');

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

  async executeSearch() {
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

  async extractProperties() {
    try {
      console.log('Extracting top 10 property results by clicking 詳細 buttons...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Take screenshot of results page
      await this.page.screenshot({ path: 'debug-results-page.png', fullPage: true });

      const properties = [];

      // Get count of 詳細 buttons
      const detailButtonCount = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a, span'));
        return buttons.filter(b => b.textContent?.trim() === '詳細').length;
      });

      console.log('Found', detailButtonCount, '詳細 buttons');

      const maxProperties = Math.min(detailButtonCount, 10);

      for (let i = 0; i < maxProperties; i++) {
        try {
          console.log('\nExtracting property', (i + 1), '/', maxProperties);

          // Click the i-th 詳細 button
          const clicked = await this.page.evaluate((index) => {
            const buttons = Array.from(document.querySelectorAll('button, a, span'));
            const detailButtons = buttons.filter(b => b.textContent?.trim() === '詳細');
            if (detailButtons[index]) {
              detailButtons[index].click();
              return true;
            }
            return false;
          }, i);

          if (!clicked) {
            console.log('Could not click 詳細 button', i);
            continue;
          }

          // Wait for detail page to load
          await new Promise(resolve => setTimeout(resolve, 2500));

          // Take screenshot of detail page
          if (i === 0) {
            await this.page.screenshot({ path: 'debug-detail-page.png', fullPage: true });
          }

          // Extract property details from the detail page
          const propertyData = await this.page.evaluate(() => {
            const text = document.body.innerText;
            const data = {
              propertyNo: '',
              name: '',
              location: '',
              rent: '',
              management: '',
              deposit: '',
              area: '',
              layout: '',
              floor: '',
              age: '',
              station: '',
              direction: '',
              structure: '',
              rawText: text.substring(0, 1000)
            };

            // Property number
            const propNoMatch = text.match(/物件番号[：:\s]*(\d{12})/);
            if (propNoMatch) data.propertyNo = propNoMatch[1];

            // Location - try multiple patterns
            const locationPatterns = [
              /所在地[：:\s]*([^\n]+)/,
              /住所[：:\s]*([^\n]+)/,
              /(東京都[^\n]{5,50})/
            ];
            for (const pattern of locationPatterns) {
              const match = text.match(pattern);
              if (match) {
                data.location = match[1].trim().substring(0, 50);
                break;
              }
            }

            // Building name
            const buildingPatterns = [
              /建物名[：:\s]*([^\n]+)/,
              /物件名[：:\s]*([^\n]+)/,
              /マンション名[：:\s]*([^\n]+)/
            ];
            for (const pattern of buildingPatterns) {
              const match = text.match(pattern);
              if (match && match[1].trim().length > 1) {
                data.name = match[1].trim().substring(0, 30);
                break;
              }
            }

            // Rent
            const rentPatterns = [
              /賃料[：:\s]*([\d,.]+)万円/,
              /賃料[：:\s]*([\d,.]+)円/,
              /月額[：:\s]*([\d,.]+)万円/
            ];
            for (const pattern of rentPatterns) {
              const match = text.match(pattern);
              if (match) {
                const val = match[1].replace(/,/g, '');
                if (pattern.source.includes('万円')) {
                  data.rent = val + '万円';
                } else {
                  // Convert to 万円
                  const num = parseFloat(val);
                  if (num > 1000) {
                    data.rent = (num / 10000).toFixed(1) + '万円';
                  } else {
                    data.rent = val + '円';
                  }
                }
                break;
              }
            }

            // Management fee
            const mgmtMatch = text.match(/(?:管理費|共益費)[：:\s]*([\d,.]+)/);
            if (mgmtMatch) data.management = mgmtMatch[1].replace(/,/g, '') + '円';

            // Deposit
            const depositMatch = text.match(/敷金[：:\s]*([\d,.]+|なし)/);
            if (depositMatch) data.deposit = depositMatch[1];

            // Area
            const areaPatterns = [
              /(?:専有面積|使用部分面積|面積)[：:\s]*([\d.]+)(?:m²|㎡)/,
              /([\d.]+)(?:m²|㎡)/
            ];
            for (const pattern of areaPatterns) {
              const match = text.match(pattern);
              if (match) {
                data.area = match[1] + '㎡';
                break;
              }
            }

            // Layout
            const layoutMatch = text.match(/間取[り]?[：:\s]*([1-9][SLDK]{1,4}|ワンルーム)/);
            if (layoutMatch) {
              data.layout = layoutMatch[1];
            } else {
              const layoutMatch2 = text.match(/([1-9][SLDK]{1,4}|ワンルーム)/);
              if (layoutMatch2) data.layout = layoutMatch2[1];
            }

            // Floor
            const floorPatterns = [
              /所在階[：:\s]*(\d+)階/,
              /階数[：:\s]*(\d+)階/,
              /(\d+)階(?:\/|建)/
            ];
            for (const pattern of floorPatterns) {
              const match = text.match(pattern);
              if (match) {
                data.floor = match[1] + '階';
                break;
              }
            }

            // Age/Year built
            const agePatterns = [
              /築年月?[：:\s]*(\d{4}年\d*月?)/,
              /竣工[：:\s]*(\d{4}年)/,
              /(\d{4})年[（(]?[平昭令]?/
            ];
            for (const pattern of agePatterns) {
              const match = text.match(pattern);
              if (match) {
                data.age = match[1];
                break;
              }
            }

            // Station/Access
            const stationPatterns = [
              /(?:最寄駅|交通|アクセス)[：:\s]*([^\n]{5,50}駅[^\n]{0,20})/,
              /([^\s]+線[\s　]*[^\s]+駅[^\n]{0,30})/
            ];
            for (const pattern of stationPatterns) {
              const match = text.match(pattern);
              if (match) {
                data.station = match[1].trim().substring(0, 40);
                break;
              }
            }

            // Direction
            const directionMatch = text.match(/(?:向き|方位)[：:\s]*(東|西|南|北|東南|南西|北東|北西)/);
            if (directionMatch) data.direction = directionMatch[1];

            // Structure
            const structureMatch = text.match(/(?:構造|建物構造)[：:\s]*([^\n]{2,20})/);
            if (structureMatch) data.structure = structureMatch[1].trim();

            return data;
          });

          // Set name if not found
          if (!propertyData.name && propertyData.location) {
            propertyData.name = propertyData.location.substring(0, 20);
          }
          if (!propertyData.name) {
            propertyData.name = '物件 #' + (i + 1);
          }

          propertyData.index = i + 1;
          properties.push(propertyData);

          console.log('  物件番号:', propertyData.propertyNo || 'N/A');
          console.log('  所在地:', propertyData.location || 'N/A');
          console.log('  賃料:', propertyData.rent || 'N/A');
          console.log('  面積:', propertyData.area || 'N/A');
          console.log('  間取り:', propertyData.layout || 'N/A');

          // Go back to results page
          await this.page.goBack({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 1500));

        } catch (err) {
          console.log('Error extracting property', (i + 1), ':', err.message);
          // Try to go back anyway
          await this.page.goBack({ waitUntil: 'networkidle0', timeout: 5000 }).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log('\n========== Extraction Complete ==========');
      console.log('Total properties extracted:', properties.length);

      if (properties.length > 0) {
        properties.forEach((p, i) => {
          console.log('\n[' + (i + 1) + '] ' + p.name);
          console.log('    所在地: ' + (p.location || 'N/A'));
          console.log('    賃料: ' + (p.rent || 'N/A') + ' | 面積: ' + (p.area || 'N/A') + ' | 間取り: ' + (p.layout || 'N/A'));
          console.log('    築年: ' + (p.age || 'N/A') + ' | 階: ' + (p.floor || 'N/A'));
          console.log('    駅: ' + (p.station || 'N/A'));
        });
      }

      return properties;

    } catch (error) {
      console.error('Failed to extract properties:', error.message);
      await this.page.screenshot({ path: 'debug-extract-error.png', fullPage: true }).catch(() => {});
      return [];
    }
  }

  async searchProperties(username, password, conditions) {
    try {
      await this.login(username, password);
      await this.navigateToRentalSearch();
      await this.fillSearchConditions(conditions);
      await this.executeSearch();
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
