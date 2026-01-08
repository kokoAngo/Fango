/**
 * AI 需求解析器
 * 使用 ChatGPT 将用户自然语言转换为 REINS 表单结构
 * 支持多位置选项搜索
 */

const OpenAI = require('openai');

class AIRequirementsParser {
  constructor() {
    this.client = null;
  }

  initClient() {
    if (!this.client && process.env.OPENAI_API_KEY) {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
    return this.client;
  }

  /**
   * 使用 AI 解析用户需求（返回多个位置选项）
   */
  async parse(userInput) {
    const client = this.initClient();

    if (!client) {
      console.log('[AIParser] OpenAI API key not configured');
      return null;
    }

    const systemPrompt = `あなたは不動産検索システムのアシスタントです。
ユーザーの自然言語での希望条件を、REINSの検索フォームに入力できる形式に変換してください。

【重要】大学、駅、施設などの地名は、複数の区・市にまたがることがあります。
該当する可能性のある全ての市区町村を locations 配列に含めてください。

以下のJSON形式で回答してください（説明不要、JSONのみ）:

{
  "locations": [
    {"prefecture": "都道府県名", "city": "市区町村名", "detail": "詳細地名（任意）"},
    {"prefecture": "都道府県名", "city": "市区町村名", "detail": "詳細地名（任意）"}
  ],
  "line": "沿線名（例: 山手線、東急東横線）",
  "station": "駅名（「駅」は不要。例: 渋谷、新宿、大岡山）",
  "walkMinutes": 駅からの徒歩分数（数値）,
  "rentMin": 賃料下限（万円単位の数値）,
  "rentMax": 賃料上限（万円単位の数値）,
  "areaMin": 面積下限（㎡単位の数値）,
  "areaMax": 面積上限（㎡単位の数値）,
  "floorMin": 階数下限（数値、例: 2階以上なら2）,
  "direction": "向き（北/北東/東/南東/南/南西/西/北西）",
  "propertyType": "物件種別（マンション/アパート/一戸建て）",
  "layouts": ["間取り配列（1K/1DK/1LDK/2K/2DK/2LDK/3LDK/ワンルーム等）"],
  "parking": "駐車場（有/無/近隣確保/不要）",
  "isNew": 新築かどうか（true/false）,
  "petAllowed": ペット可かどうか（true/false）,
  "corner": 角部屋かどうか（true/false）,
  "equipment": ["設備条件の配列"],
  "keywords": ["その他のキーワード配列"]
}

注意事項:
1. 不明な項目はnullにしてください
2. 【重要】locations は必ず配列で、近隣エリアを全て含めてください:
   - 例: 「東京工業大学大岡山キャンパス」→ locations: [
       {"prefecture": "東京都", "city": "目黒区", "detail": "大岡山"},
       {"prefecture": "東京都", "city": "大田区", "detail": "北千束"},
       {"prefecture": "東京都", "city": "品川区", "detail": "旗の台"}
     ]
   - 例: 「大岡山駅」→ locations: [
       {"prefecture": "東京都", "city": "大田区", "detail": "北千束"},
       {"prefecture": "東京都", "city": "目黒区", "detail": "大岡山"}
     ]
   - 例: 「渋谷駅」→ locations: [
       {"prefecture": "東京都", "city": "渋谷区", "detail": "渋谷"}
     ]
3. 「日当たり良好」などは direction に変換しないでください
4. 設備条件の例: オートロック、宅配ボックス、バストイレ別、エアコン、追焚、浴室乾燥、床暖房、
   システムキッチン、IH、食洗機、インターネット無料、Wi-Fi、CATV、BS/CS、
   フローリング、室内洗濯機置場、ウォークインクローゼット
5. ペットを飼いたい場合は petAllowed: true
6. 駐車場が必要な場合は parking: "有"
7. 一人暮らしの場合は layouts に ["1K", "1DK", "1LDK", "ワンルーム"] を推奨`;

    try {
      console.log('[AIParser] Parsing user requirements...');
      console.log('[AIParser] Input:', userInput);

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 800,
        temperature: 0.1,  // 低めの温度で一貫性を保つ
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userInput }
        ]
      });

      const content = response.choices[0].message.content.trim();
      console.log('[AIParser] Raw response:', content);

      // JSON を抽出
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        console.log('[AIParser] Parsed result:', JSON.stringify(parsed, null, 2));
        return this.normalize(parsed);
      }

      return null;
    } catch (error) {
      console.error('[AIParser] Error:', error.message);
      return null;
    }
  }

  /**
   * AI の出力を正規化して REINS フォーム用に変換
   * locations 配列をサポート（複数エリア検索用）
   */
  normalize(parsed) {
    // locations 配列から位置情報を抽出
    let locations = [];
    if (parsed.locations && Array.isArray(parsed.locations)) {
      locations = parsed.locations.map(loc => ({
        prefecture: loc.prefecture,
        city: this.extractCityName(loc.city),
        detail: loc.detail || null
      }));
    } else if (parsed.prefecture || parsed.city) {
      // 旧形式との互換性
      locations = [{
        prefecture: parsed.prefecture,
        city: this.extractCityName(parsed.city),
        detail: null
      }];
    }

    const result = {
      locations: locations,  // 複数位置オプション
      prefecture: locations.length > 0 ? locations[0].prefecture : null,
      cities: locations.length > 0 ? [locations[0].city] : [],
      line: parsed.line || null,
      station: parsed.station || null,
      walkMinutes: parsed.walkMinutes || null,
      rentMin: parsed.rentMin || null,
      rentMax: parsed.rentMax || null,
      areaMin: parsed.areaMin || null,
      areaMax: parsed.areaMax || null,
      floorMin: parsed.floorMin || null,
      direction: parsed.direction || null,
      propertyType: this.mapPropertyType(parsed.propertyType),
      layouts: parsed.layouts || [],
      parking: this.mapParking(parsed.parking),
      isNew: parsed.isNew || false,
      petAllowed: parsed.petAllowed || false,
      corner: parsed.corner || false,
      keywords: []
    };

    // 設備条件を keywords に追加
    if (parsed.equipment && Array.isArray(parsed.equipment)) {
      result.keywords.push(...parsed.equipment);
    }

    // その他のキーワードを追加
    if (parsed.keywords && Array.isArray(parsed.keywords)) {
      result.keywords.push(...parsed.keywords);
    }

    // ペット可を keywords に追加
    if (result.petAllowed && !result.keywords.includes('ペット可')) {
      result.keywords.push('ペット可');
    }

    return result;
  }

  /**
   * 市区町村名から最後の区/市/町/村部分を抽出
   */
  extractCityName(city) {
    if (!city) return null;
    // "大阪市北区" → "北区", "横浜市西区" → "西区"
    const match = city.match(/([^\s市]+(?:区|市|町|村))$/);
    return match ? match[1] : city;
  }

  /**
   * 物件種別をREINSコードに変換
   */
  mapPropertyType(type) {
    if (!type) return null;
    const mapping = {
      'マンション': '03',
      'アパート': '03',
      '一戸建て': '02',
      '一戸建': '02',
      '戸建て': '02',
      '戸建': '02'
    };
    return mapping[type] || null;
  }

  /**
   * 駐車場をREINSコードに変換
   */
  mapParking(parking) {
    if (!parking) return null;
    const mapping = {
      '有': '1',
      '有り': '1',
      'あり': '1',
      '必要': '1',
      '無': '2',
      '無し': '2',
      'なし': '2',
      '不要': '2',
      '近隣確保': '3',
      '近隣': '3'
    };
    return mapping[parking] || null;
  }

  /**
   * 解析結果を REINS フォームフィールドに変換
   */
  toReinsFields(parsed) {
    if (!parsed) return null;

    // 方位マッピング
    const directionMapping = {
      '北': '1', '北東': '2', '東': '3', '南東': '4',
      '南': '5', '南西': '6', '西': '7', '北西': '8'
    };

    // 間取りマッピング
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

    const fields = {
      textInputs: {},
      selects: {},
      checkboxes: {},
      keywords: parsed.keywords || []
    };

    // テキスト入力
    if (parsed.prefecture) fields.textInputs['__BVID__325'] = parsed.prefecture;
    if (parsed.cities?.length > 0) fields.textInputs['__BVID__329'] = parsed.cities[0];
    if (parsed.line) fields.textInputs['__BVID__376'] = parsed.line;
    if (parsed.station) fields.textInputs['__BVID__380'] = parsed.station;
    if (parsed.walkMinutes) fields.textInputs['__BVID__385'] = parsed.walkMinutes.toString();
    if (parsed.rentMin) fields.textInputs['__BVID__452'] = parsed.rentMin.toString();
    if (parsed.rentMax) fields.textInputs['__BVID__454'] = parsed.rentMax.toString();
    if (parsed.areaMin) fields.textInputs['__BVID__481'] = parsed.areaMin.toString();
    if (parsed.areaMax) fields.textInputs['__BVID__483'] = parsed.areaMax.toString();
    if (parsed.floorMin) fields.textInputs['__BVID__520'] = parsed.floorMin.toString();

    // セレクト
    if (parsed.propertyType) fields.selects['__BVID__293'] = parsed.propertyType;
    if (parsed.direction && directionMapping[parsed.direction]) {
      fields.selects['__BVID__525'] = directionMapping[parsed.direction];
    }
    if (parsed.parking) fields.selects['__BVID__542'] = parsed.parking;

    // チェックボックス
    if (parsed.isNew) fields.checkboxes['__BVID__311'] = true;
    if (parsed.corner) fields.checkboxes['__BVID__496'] = true;

    // 間取り
    for (const layout of parsed.layouts || []) {
      const checkboxId = layoutMapping[layout];
      if (checkboxId) {
        fields.checkboxes[checkboxId] = true;
      }
    }

    return fields;
  }
}

module.exports = new AIRequirementsParser();
