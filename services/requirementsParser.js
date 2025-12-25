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
      '__BVID__456': '賃料（下限）',
      '__BVID__458': '賃料（上限）',
      '__BVID__481': '建物面積（下限）',
      '__BVID__483': '建物面積（上限）',
      '__BVID__520': '所在階（下限）',
      '__BVID__522': '所在階（上限）',
      '__BVID__525': '向き',
      '__BVID__567': '備考1（設備条件検索用）',
      '__BVID__311': '新築',
      '__BVID__314': '図面あり',
      '__BVID__316': '画像あり',
      '__BVID__496': '角部屋',
      '__BVID__501': 'ワンルーム',
      '__BVID__503': 'K',
      '__BVID__505': 'DK',
      '__BVID__507': 'LK',
      '__BVID__509': 'LDK',
      '__BVID__511': 'SK',
      '__BVID__513': 'SDK',
      '__BVID__515': 'SLK',
      '__BVID__517': 'SLDK'
    };

    // 房型映射到REINS checkbox IDs
    this.layoutMapping = {
      'ワンルーム': '__BVID__501',
      '1R': '__BVID__501',
      'K': '__BVID__503',
      '1K': '__BVID__503',
      'DK': '__BVID__505',
      '1DK': '__BVID__505',
      '2DK': '__BVID__505',
      'LK': '__BVID__507',
      '1LK': '__BVID__507',
      'LDK': '__BVID__509',
      '1LDK': '__BVID__509',
      '2LDK': '__BVID__509',
      '3LDK': '__BVID__509',
      '4LDK': '__BVID__509',
      'SK': '__BVID__511',
      'SDK': '__BVID__513',
      'SLK': '__BVID__515',
      'SLDK': '__BVID__517'
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
      station: null,
      line: null,
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
      floorMin: null,          // 新增：階数
      keywords: []
    };

    // 提取所有区名（去除前缀符号）
    const cityMatches = text.match(/[・\-\s]*([^\s・\-、。\n]+(?:区|市|町|村))/g);
    if (cityMatches) {
      for (const match of cityMatches) {
        const city = match.replace(/^[・\-\s]+/, '').trim();
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

    // 提取车站名
    const stationMatch = text.match(/([^\s、。・\n]+)駅/);
    if (stationMatch) {
      result.station = stationMatch[1];
    }

    // 提取沿線名
    const lineMatch = text.match(/([^\s、。・\n]+線)/);
    if (lineMatch && !lineMatch[1].includes('沿')) {
      result.line = lineMatch[1];
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

    // 提取方位 - 包括"日当たり良好"
    if (text.includes('日当たり') || text.includes('日当り') || text.includes('陽当たり')) {
      result.direction = '南';  // 日当たり良好 = 南向き
    }

    const directionPatterns = ['南向き', '北向き', '東向き', '西向き', '南東', '南西', '北東', '北西'];
    for (const dir of directionPatterns) {
      if (text.includes(dir)) {
        const cleanDir = dir.replace('向き', '');
        result.direction = cleanDir;
        break;
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

    if (text.includes('ペット可') || text.includes('ペット相談') || text.includes('ペットOK')) {
      result.petAllowed = true;
      result.keywords.push('ペット');
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

    // 提取其他关键词
    const keywordPatterns = [
      'オートロック', 'エアコン', 'バストイレ別', 'バス・トイレ別',
      '駐車場', '宅配ボックス', 'インターネット', 'Wi-Fi', 'ウォークインクローゼット',
      'システムキッチン', 'IH', 'ガスコンロ', '追焚', '浴室乾燥',
      'フローリング', '室内洗濯機', '最上階', '礼金なし', '敷金なし',
      '即入居', 'リノベーション', 'デザイナーズ', 'TVモニター', 'モニター付',
      'インターホン'
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

    // 駅名
    if (parsed.station) {
      fields.textInputs['__BVID__380'] = parsed.station;
    }

    // 駅から徒歩
    if (parsed.walkMinutes) {
      fields.textInputs['__BVID__385'] = parsed.walkMinutes.toString();
    }

    // 賃料 (単位：万円)
    if (parsed.rentMin) {
      fields.textInputs['__BVID__456'] = parsed.rentMin.toString();
    }
    if (parsed.rentMax) {
      fields.textInputs['__BVID__458'] = parsed.rentMax.toString();
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
