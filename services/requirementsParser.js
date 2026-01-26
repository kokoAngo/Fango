/**
 * 用户需求解析器
 * 从自然语言中提取搜索条件并映射到REINS表单字段
 */

class RequirementsParser {
  constructor() {
    // 東京23区列表 - 用于推断都道府県
    this.tokyo23 = [
      '千代田区', '中央区', '港区', '新宿区', '文京区', '台東区', '墨田区', '江東区',
      '品川区', '目黒区', '大田区', '世田谷区', '渋谷区', '中野区', '杉並区', '豊島区',
      '北区', '荒川区', '板橋区', '練馬区', '足立区', '葛飾区', '江戸川区'
    ];

    // 大阪市区列表
    this.osakaCities = [
      '北区', '都島区', '福島区', '此花区', '西区', '港区', '大正区', '天王寺区',
      '浪速区', '西淀川区', '東淀川区', '東成区', '生野区', '旭区', '城東区', '阿倍野区',
      '住吉区', '東住吉区', '西成区', '淀川区', '鶴見区', '住之江区', '平野区', '中央区'
    ];

    // 常用地区简称映射
    this.prefectureAliases = {
      '東京': '東京都', '大阪': '大阪府', '京都': '京都府', '北海道': '北海道',
      '神奈川': '神奈川県', '埼玉': '埼玉県', '千葉': '千葉県', '愛知': '愛知県',
      '福岡': '福岡県', '兵庫': '兵庫県', '広島': '広島県', '宮城': '宮城県',
      '横浜': '神奈川県', '川崎': '神奈川県', '名古屋': '愛知県'
    };

    // REINS表单字段名称映射（用于日志）
    this.fieldNames = {
      '__BVID__293': '物件種別1',
      '__BVID__325': '都道府県名',
      '__BVID__329': '所在地名1',
      '__BVID__376': '沿線名',
      '__BVID__380': '駅名',
      '__BVID__385': '駅から徒歩',
      '__BVID__452': '賃料（下限）',
      '__BVID__454': '賃料（上限）',
      '__BVID__481': '建物面積（下限）',
      '__BVID__483': '建物面積（上限）',
      '__BVID__520': '所在階（下限）',
      '__BVID__522': '所在階（上限）',
      '__BVID__525': '向き',
      '__BVID__542': '駐車場',
      '__BVID__567': '備考1（設備条件検索用）',
      '__BVID__311': '新築',
      '__BVID__314': '図面あり',
      '__BVID__316': '画像あり',
      '__BVID__496': '角部屋',
      '__BVID__497': 'ワンルーム',
      '__BVID__499': 'K',
      '__BVID__501': 'DK',
      '__BVID__503': 'LK',
      '__BVID__505': 'LDK',
      '__BVID__507': 'SK',
      '__BVID__509': 'SDK',
      '__BVID__511': 'SLK',
      '__BVID__513': 'SLDK'
    };

    // 房型映射到REINS checkbox IDs
    // __BVID__497: ワンルーム, __BVID__499: K, __BVID__501: DK, __BVID__503: LK
    // __BVID__505: LDK, __BVID__507: SK, __BVID__509: SDK, __BVID__511: SLK, __BVID__513: SLDK
    this.layoutMapping = {
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
      '4LDK': '__BVID__505',
      'SK': '__BVID__507',
      '1SK': '__BVID__507',
      'SDK': '__BVID__509',
      '1SDK': '__BVID__509',
      'SLK': '__BVID__511',
      '1SLK': '__BVID__511',
      'SLDK': '__BVID__513',
      '1SLDK': '__BVID__513',
      '2SLDK': '__BVID__513'
    };

    // 方位映射
    this.directionMapping = {
      '北': '1', '北東': '2', '東': '3', '南東': '4',
      '南': '5', '南西': '6', '西': '7', '北西': '8'
    };

    // 物件种类映射
    this.propertyTypeMapping = {
      'マンション': '03',
      'アパート': '03',
      '一戸建': '02',
      '一戸建て': '02',
      '戸建': '02',
      '土地': '01'
    };
  }

  /**
   * 解析用户需求
   */
  parse(text) {
    if (!text || text.trim() === '') {
      return {};
    }

    const result = {
      prefecture: null,
      cities: [],              // 改为数组，支持多个区
      station: null,           // 単一駅名
      startStation: null,      // 始発駅（区間指定用）
      endStation: null,        // 終点駅（区間指定用）
      line: null,              // 沿線名
      walkMinutes: null,
      rentMin: null,
      rentMax: null,
      areaMin: null,
      areaMax: null,
      layouts: [],
      direction: null,
      propertyType: null,
      isNew: false,
      petAllowed: false,
      corner: false,
      withDrawing: false,
      withImage: false,
      floorMin: null,          // 新増：階数
      parking: null,           // 新増：駐車場 (1=有, 2=無, 3=近隣確保)
      keywords: []
    };

    // 提取所有区名（去除前缀符号）
    // 注意：排除沿線名（如有楽町線）误匹配
    const cityMatches = text.match(/[・\-\s]*([^\s・\-、。\n]+(?:区|市|町|村))/g);
    if (cityMatches) {
      for (const match of cityMatches) {
        let city = match.replace(/^[・\-\s]+/, '').trim();
        // 排除沿線名（如：有楽町線 → 有楽町 の誤検出を防ぐ）
        if (!city || city.includes('線') || text.includes(city + '線')) {
          continue;
        }
        // 「東京都新宿区」のような形式から「新宿区」だけを抽出
        const cityOnlyMatch = city.match(/([^\s都府県]+(?:区|市|町|村))$/);
        if (cityOnlyMatch) {
          city = cityOnlyMatch[1];
        }
        if (city && !result.cities.includes(city)) {
          result.cities.push(city);
        }
      }
    }

    // 从区名推断都道府県
    for (const city of result.cities) {
      if (this.tokyo23.includes(city)) {
        result.prefecture = '東京都';
        break;
      }
    }

    // 如果没有从区推断出来，尝试直接提取
    if (!result.prefecture) {
      for (const [alias, full] of Object.entries(this.prefectureAliases)) {
        if (text.includes(alias)) {
          result.prefecture = full;
          break;
        }
      }
    }

    // 提取沿線名 - 先提取沿線，再提取駅
    const linePatterns = [
      /([^\s、。・\n]+線)沿線?/,   // XX線沿線、XX線沿い
      /([^\s、。・\n]+線)/         // XX線
    ];
    for (const pattern of linePatterns) {
      const match = text.match(pattern);
      if (match && !match[1].includes('沿')) {
        result.line = match[1];
        break;
      }
    }

    // 提取駅区間（XX駅〜YY駅、XX駅からYY駅）
    const stationRangeMatch = text.match(/([^\s、。・\n]+)駅[〜～\-からまで]+([^\s、。・\n]+)駅/);
    if (stationRangeMatch) {
      result.startStation = stationRangeMatch[1];
      result.endStation = stationRangeMatch[2];
    } else if (result.line) {
      // 路線名が検出された場合、「駅」なしの駅名区間も試す
      // 例: "副都心線で 池袋〜雑司が谷〜西早稲田"

      // 路線名を除去したテキストで駅名を探す
      const textWithoutLine = text.replace(result.line, '').replace(/[でにの、。\s]+/g, ' ').trim();

      // 3駅以上の区間: A〜B〜C（最初と最後を取る）
      const threeStationMatch = textWithoutLine.match(/([^\s〜～\-]+)[〜～\-]([^\s〜～\-]+)[〜～\-]([^\s〜～\-]+)/);
      if (threeStationMatch) {
        result.startStation = threeStationMatch[1].replace(/駅$/, '');
        result.endStation = threeStationMatch[3].replace(/駅$/, '');
      } else {
        // 2駅の区間: A〜B
        const twoStationMatch = textWithoutLine.match(/([^\s〜～\-]+)[〜～\-]([^\s〜～\-]+)/);
        if (twoStationMatch) {
          result.startStation = twoStationMatch[1].replace(/駅$/, '');
          result.endStation = twoStationMatch[2].replace(/駅$/, '');
        }
      }
    } else {
      // 提取单一车站名
      const stationMatch = text.match(/([^\s、。・\n]+)駅/);
      if (stationMatch) {
        result.station = stationMatch[1];
      }
    }

    // 提取徒歩時間
    const walkMatch = text.match(/徒歩(\d+)分/);
    if (walkMatch) {
      result.walkMinutes = parseInt(walkMatch[1]);
    }

    // 提取租金范围 - 支持更多格式
    const rentPatterns = [
      /(\d+(?:\.\d+)?)万円?(?:以内|以下|まで)/,
      /賃料[^\d]*(\d+(?:\.\d+)?)万/,
      /家賃[^\d]*(\d+(?:\.\d+)?)万/,
      /(\d+(?:\.\d+)?)万[^\d]*以内/
    ];

    for (const pattern of rentPatterns) {
      const match = text.match(pattern);
      if (match && !result.rentMax) {
        result.rentMax = parseFloat(match[1]);
        break;
      }
    }

    const rentMinMatch = text.match(/(\d+(?:\.\d+)?)万円?(?:以上|から)/);
    if (rentMinMatch) {
      result.rentMin = parseFloat(rentMinMatch[1]);
    }

    const rentRangeMatch = text.match(/(\d+(?:\.\d+)?)万?[~～\-ー](\d+(?:\.\d+)?)万/);
    if (rentRangeMatch) {
      result.rentMin = parseFloat(rentRangeMatch[1]);
      result.rentMax = parseFloat(rentRangeMatch[2]);
    }

    // 提取面积 - 支持更多格式
    const areaPatterns = [
      /(\d+)(?:㎡|平米|m2|m²)以上/i,
      /(\d+)(?:㎡|平米|m2|m²)[^\d]*以上/i
    ];

    for (const pattern of areaPatterns) {
      const match = text.match(pattern);
      if (match) {
        result.areaMin = parseInt(match[1]);
        break;
      }
    }

    const areaMaxMatch = text.match(/(\d+)(?:㎡|平米|m2|m²)(?:以内|以下)/i);
    if (areaMaxMatch) {
      result.areaMax = parseInt(areaMaxMatch[1]);
    }

    // 提取房型
    const layoutPatterns = [
      /(\d[SLDK]+)/gi,
      /(ワンルーム)/gi,
      /(1R)/gi
    ];
    for (const pattern of layoutPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        for (const match of matches) {
          const upper = match.toUpperCase();
          if (this.layoutMapping[upper] && !result.layouts.includes(upper)) {
            result.layouts.push(upper);
          }
        }
      }
    }

    // 提取方位 - 只有明确指定方向时才设置
    // 注意: "日当たりの良い" などは好みであり、厳格な要件ではないため、方位は設定しない
    const directionPatterns = ['南向き', '北向き', '東向き', '西向き', '南東向き', '南西向き', '北東向き', '北西向き'];
    for (const dir of directionPatterns) {
      if (text.includes(dir)) {
        const cleanDir = dir.replace('向き', '');
        result.direction = cleanDir;
        break;
      }
    }
    // 方位のみの指定も検出
    if (!result.direction) {
      const simpleDirections = [
        { pattern: '南側', dir: '南' },
        { pattern: '東側', dir: '東' },
        { pattern: '西側', dir: '西' },
        { pattern: '北側', dir: '北' }
      ];
      for (const { pattern, dir } of simpleDirections) {
        if (text.includes(pattern)) {
          result.direction = dir;
          break;
        }
      }
    }

    // 提取階数（2階以上、二階以上）
    const floorMatch = text.match(/([2２二]階以上|[3３三]階以上)/);
    if (floorMatch) {
      if (floorMatch[1].includes('2') || floorMatch[1].includes('２') || floorMatch[1].includes('二')) {
        result.floorMin = 2;
      } else if (floorMatch[1].includes('3') || floorMatch[1].includes('３') || floorMatch[1].includes('三')) {
        result.floorMin = 3;
      }
    }

    // 提取物件種別
    for (const [type, value] of Object.entries(this.propertyTypeMapping)) {
      if (text.includes(type)) {
        result.propertyType = value;
        break;
      }
    }

    // 提取布尔条件
    if (text.includes('新築') || text.includes('築浅')) {
      result.isNew = true;
    }

    if (text.includes('ペット可') || text.includes('ペット相談') || text.includes('ペットOK') ||
        text.includes('猫を飼') || text.includes('犬を飼') || text.includes('ペットを飼') ||
        text.includes('猫飼育') || text.includes('犬飼育') || text.includes('ペット飼育')) {
      result.petAllowed = true;
      result.keywords.push('ペット可');
    }

    if (text.includes('角部屋')) {
      result.corner = true;
    }

    if (text.includes('図面') || text.includes('間取り図')) {
      result.withDrawing = true;
    }

    if (text.includes('写真') || text.includes('画像')) {
      result.withImage = true;
    }

    // 提取駐車場条件
    if (text.includes('駐車場なし') || text.includes('駐車場無') || text.includes('駐車場不要')) {
      result.parking = '2';  // 無／空無
    } else if (text.includes('近隣駐車場') || text.includes('駐車場近隣') ||
               (text.includes('近隣') && text.includes('駐車場'))) {
      result.parking = '3';  // 近隣確保
      // 駐車場は駐車場ドロップダウンで処理するため、keywordsには追加しない
    } else if (text.includes('駐車場あり') || text.includes('駐車場有') || text.includes('駐車場付') ||
        text.match(/駐車場[^\s]*可/) || text.includes('カースペース') ||
        text.includes('駐車場が必要') || text.includes('駐車場必要') || text.includes('駐車場を希望') ||
        text.includes('駐車場希望') || text.match(/駐車場.*欲しい/) || text.match(/駐車場.*ほしい/)) {
      result.parking = '1';  // 有／空有
      // 駐車場は駐車場ドロップダウンで処理するため、keywordsには追加しない
    }

    // 提取其他关键词（設備・条件・住宅性能等の入力ガイドで選択）
    const keywordPatterns = [
      // 空調・暖房
      '冷房', '暖房', 'エアコン', '床暖房', '堀ごたつ', '灯油ストーブ', 'ＦＦ暖房', 'セントラルヒーティング',
      // セキュリティ
      'オートロック', 'TVモニター', 'モニター付', 'インターホン', '防犯カメラ', 'ディンプルキー',
      // キッチン
      'システムキッチン', 'IH', 'ガスコンロ', 'カウンターキッチン', '食器洗浄機', '食洗機',
      // バス・トイレ
      'バストイレ別', 'バス・トイレ別', '追焚', '浴室乾燥', '温水洗浄便座', 'ウォシュレット',
      // 収納
      'ウォークインクローゼット', 'シューズボックス', '床下収納',
      // 設備
      '宅配ボックス', 'インターネット', 'Wi-Fi', '光ファイバー', 'CATV', 'BS', 'CS',
      // 内装
      'フローリング', 'クッションフロア', '畳',
      // 洗濯
      '室内洗濯機', '洗濯機置場', '乾燥機',
      // その他
      '最上階', '角部屋', 'バルコニー', 'ルーフバルコニー', 'ロフト', 'メゾネット',
      '礼金なし', '敷金なし', '即入居', 'リノベーション', 'デザイナーズ',
      'ペット可', 'ペット相談', '楽器可', '事務所可', 'SOHO可'
    ];

    for (const keyword of keywordPatterns) {
      if (text.includes(keyword) && !result.keywords.includes(keyword)) {
        result.keywords.push(keyword);
      }
    }

    // 注意：階数は専用フィールドを使うため、keywordsには追加しない

    return result;
  }

  /**
   * 将解析结果转换为REINS表单字段格式
   */
  toReinsFields(parsed) {
    const fields = {
      textInputs: {},
      selects: {},
      checkboxes: {},
      keywords: parsed.keywords || []
    };

    // 都道府県名
    if (parsed.prefecture) {
      fields.textInputs['__BVID__325'] = parsed.prefecture;
    }

    // 所在地名1 (第一个区)
    if (parsed.cities && parsed.cities.length > 0) {
      fields.textInputs['__BVID__329'] = parsed.cities[0];
    }

    // 沿線名
    if (parsed.line) {
      fields.textInputs['__BVID__376'] = parsed.line;
    }

    // 駅名（単一指定）
    if (parsed.station) {
      fields.textInputs['__BVID__380'] = parsed.station;
    }

    // 駅区間（入力ガイド用に保持、テキスト入力には含めない）
    // startStation, endStationはuserRequirementsとして渡される

    // 駅から徒歩
    if (parsed.walkMinutes) {
      fields.textInputs['__BVID__385'] = parsed.walkMinutes.toString();
    }

    // 賃料 (単位：万円)
    if (parsed.rentMin) {
      fields.textInputs['__BVID__452'] = parsed.rentMin.toString();
    }
    if (parsed.rentMax) {
      fields.textInputs['__BVID__454'] = parsed.rentMax.toString();
    }

    // 建物面積
    if (parsed.areaMin) {
      fields.textInputs['__BVID__481'] = parsed.areaMin.toString();
    }
    if (parsed.areaMax) {
      fields.textInputs['__BVID__483'] = parsed.areaMax.toString();
    }

    // 所在階（下限）- 2階以上などの条件
    if (parsed.floorMin) {
      fields.textInputs['__BVID__520'] = parsed.floorMin.toString();
    }

    // 備考 - 設備条件を備考で検索（REINSフォームに専用チェックボックスがないため）
    if (parsed.keywords && parsed.keywords.length > 0) {
      fields.textInputs['__BVID__567'] = parsed.keywords.join(' ');
    }

    // 物件種別1
    if (parsed.propertyType) {
      fields.selects['__BVID__293'] = parsed.propertyType;
    }

    // 向き
    if (parsed.direction && this.directionMapping[parsed.direction]) {
      fields.selects['__BVID__525'] = this.directionMapping[parsed.direction];
    }

    // 駐車場 (1=有／空有, 2=無／空無, 3=近隣確保)
    if (parsed.parking) {
      fields.selects['__BVID__542'] = parsed.parking;
    }

    // Checkboxes
    if (parsed.isNew) fields.checkboxes['__BVID__311'] = true;
    if (parsed.withDrawing) fields.checkboxes['__BVID__314'] = true;
    if (parsed.withImage) fields.checkboxes['__BVID__316'] = true;
    if (parsed.corner) fields.checkboxes['__BVID__496'] = true;

    // 間取り
    for (const layout of parsed.layouts || []) {
      const checkboxId = this.layoutMapping[layout];
      if (checkboxId) {
        fields.checkboxes[checkboxId] = true;
      }
    }

    return fields;
  }

  /**
   * 打印日志 - 显示字段名和值
   */
  logFields(fields) {
    console.log('\n=== 填写REINS表单 ===');

    console.log('\n[文本输入]');
    for (const [id, value] of Object.entries(fields.textInputs)) {
      const name = this.fieldNames[id] || id;
      console.log(`  ${name}: ${value}`);
    }

    console.log('\n[下拉选择]');
    for (const [id, value] of Object.entries(fields.selects)) {
      const name = this.fieldNames[id] || id;
      console.log(`  ${name}: ${value}`);
    }

    console.log('\n[复选框]');
    for (const [id, checked] of Object.entries(fields.checkboxes)) {
      if (checked) {
        const name = this.fieldNames[id] || id;
        console.log(`  ✓ ${name}`);
      }
    }

    console.log('');
  }
}

module.exports = new RequirementsParser();
