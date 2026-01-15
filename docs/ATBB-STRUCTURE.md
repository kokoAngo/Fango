# ATBB 网页结构分析报告

## 1. 登录页面
- **URL**: `https://atbb.athome.jp/`
- **账号输入框**: `input[name="loginId"]`
- **密码输入框**: `input[type="password"]`
- **登录按钮**: `input[type="submit"]` (value="ログイン")

## 2. Portal 页面
- **URL**: `https://members.athome.jp/portal`
- **流通物件検索**: 点击包含文本 "流通物件検索" 的 div 元素

### 弹窗处理
| 弹窗类型 | 按钮文本 | 操作 |
|---------|---------|------|
| 会社情報定期確認 | `表示の一時停止` | 点击 |
| 其他弹窗 | `閉じる`, `後で確認` | 点击 |

## 3. 并发登录页面
- **URL**: `https://atbb.athome.co.jp/front-web/login/ConcurrentLoginException.jsp`
- **强制登录按钮**: `input.btn06d` (value="強制終了させてATBBを利用する", onclick="forceLogin()")
- **确认弹窗**: `confirm("強制終了させてよろしいですか？")` → 点击 OK

## 4. 搜索页面 (核心)
- **URL**: `https://atbb.athome.co.jp/front-web/mainservlet/bfcm003s201`

### 4.1 物件種目选择 (单选框)
```
name="atbbShumokuDaibunrui"
```
| value | 标签 |
|-------|------|
| 01 | 売土地 |
| 02 | 売戸建 |
| 03 | 売マンション |
| 04 | 売事業用 |
| 05 | 売リゾート向け |
| 06 | 賃貸居住用 |
| 07 | 賃貸事業用 |
| 08 | 貸土地 |
| 09 | 貸駐車場 |

### 4.2 搜索方式按钮
| 按钮文本 | className | onclick |
|---------|-----------|---------|
| 所在地検索 | `btn06d btn18` | `submitAction(document.bfcm300s, 'bfcm300s002')` |
| 沿線検索 | `btn06c` | `submitAction(document.bfcm300s, 'bfcm300s003')` |
| 地図検索 | - | `submitAction(document.bfcm300s, 'bfcm300s001')` |
| 検索 | - | `searchFreeWord(document.bfcm300s, 'bfcm300s008')` |
| リセット | `btn06c` | `submitAction(document.bfcm300s, 'bfcm300s007')` |

### 4.3 フリーワード検索
- **输入框**: `input[name="freeWordSearchSubject"]` (id="freeWordSearchSubject")

### 4.4 都道府県选择 (复选框)
```
name="area"
```
| value | 标签 |
|-------|------|
| 0101 | 北海道全域 |
| 0102 | 札幌市 |
| 02 | 青森県 |
| 03 | 岩手県 |
| 04 | 宮城県 |
| 05 | 秋田県 |
| 06 | 山形県 |
| 07 | 福島県 |
| 08 | 茨城県 |
| 09 | 栃木県 |
| 10 | 群馬県 |
| 11 | 埼玉県 |
| 12 | 千葉県 |
| **13** | **東京都** |
| 14 | 神奈川県 |
| 15 | 新潟県 |
| 16 | 富山県 |
| 17 | 石川県 |
| 18 | 福井県 |
| 19 | 山梨県 |
| 20 | 長野県 |
| 21 | 岐阜県 |
| 22 | 静岡県 |
| 23 | 愛知県 |
| 24 | 三重県 |

### 4.5 地图区域链接
地区选择也可以通过链接点击:
- `北海道`, `東北地方`, `関東地方`, `北陸地方`, `中部地方`, `近畿地方`

## 5. 推荐的操作流程

```javascript
// 1. 选择物件種目
await page.click('input[name="atbbShumokuDaibunrui"][value="06"]'); // 賃貸居住用

// 2. 选择都道府県 (例: 東京都)
await page.click('input[name="area"][value="13"]');

// 3. 点击所在地検索按钮
await page.click('input[value="所在地検索"]');
// 或: await page.evaluate(() => submitAction(document.bfcm300s, 'bfcm300s002'));

// 4. 等待市区町村选择页面加载
await page.waitForNavigation();
```

## 6. 注意事项

1. **Dialog 处理**: 并发登录时会弹出 confirm 对话框，需要监听并接受
2. **新页面处理**: 点击流通物件検索会打开新页面，需要切换页面上下文
3. **复选框选择**: 都道府県使用复选框，可以多选
4. **表单提交**: 使用 `submitAction(document.bfcm300s, 'actionCode')` 提交表单
