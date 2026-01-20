/**
 * FormAgent - 表单映射 Agent
 * 负责将解析后的需求映射到 REINS 表单字段
 */

const BaseAgent = require('./base/BaseAgent');
const fs = require('fs');
const path = require('path');

class FormAgent extends BaseAgent {
  constructor() {
    super({
      name: 'FormAgent',
      model: 'gpt-4o-mini',
      temperature: 0.0,  // 确定性输出
      maxTokens: 1500
    });
    this.formStructure = null;
  }

  /**
   * 加载 REINS 表单结构
   */
  loadFormStructure() {
    if (this.formStructure) return this.formStructure;

    try {
      const structurePath = path.join(__dirname, '..', '..', 'reins-form-structure.json');
      const content = fs.readFileSync(structurePath, 'utf-8');
      this.formStructure = JSON.parse(content);
      this.log('REINS form structure loaded');
      return this.formStructure;
    } catch (error) {
      this.logError('Failed to load form structure', error);
      return null;
    }
  }

  /**
   * 获取系统提示词
   */
  getSystemPrompt(context = {}) {
    const structure = this.loadFormStructure();
    const structureDesc = this.generateStructureDescription(structure);

    return `あなたは不動産検索システムのフォームマッピングエージェントです。
解析された検索条件をREINSの検索フォームに入力できる形式に変換してください。

${structureDesc}

【マッピングルール】
1. 物件種別: 03=賃貸マンション/アパート, 02=賃貸一戸建, 01=賃貸土地
2. 賃料: 万円単位で入力（例: 15万円 → "15"）
3. 方向: 1=北, 2=北東, 3=東, 4=南東, 5=南, 6=南西, 7=西, 8=北西
4. 駐車場: 1=有／空有, 2=無／空無, 3=近隣確保

【出力形式】以下のJSON形式で回答（説明不要、JSONのみ）:
{
  "searchOptions": [
    {
      "id": 1,
      "description": "目黒区 大岡山で所在地検索",
      "searchMethod": "location",
      "formFields": {
        "textInputs": {
          "__BVID__321": "東京都",
          "__BVID__325": "目黒区"
        },
        "selects": {
          "__BVID__289": "03"
        },
        "checkboxes": {}
      }
    }
  ],
  "commonFields": {
    "textInputs": {
      "__BVID__452": "10",
      "__BVID__454": "15"
    },
    "selects": {},
    "checkboxes": {
      "__BVID__505": true
    }
  },
  "warnings": [],
  "suggestions": []
}`;
  }

  /**
   * 表单結構の説明を生成
   */
  generateStructureDescription(structure) {
    if (!structure) return '（表单结构加载失败）';

    let desc = '【REINS フォーム構造】\n\n';

    // 主要テキスト入力
    desc += '■ テキスト入力:\n';
    const textFields = [
      { id: '__BVID__321', label: '都道府県' },
      { id: '__BVID__325', label: '市区町村' },
      { id: '__BVID__372', label: '沿線名' },
      { id: '__BVID__376', label: '駅名（から）' },
      { id: '__BVID__378', label: '駅名（まで）' },
      { id: '__BVID__381', label: '徒歩分数' },
      { id: '__BVID__452', label: '賃料下限（万円）' },
      { id: '__BVID__454', label: '賃料上限（万円）' },
      { id: '__BVID__477', label: '面積下限（㎡）' },
      { id: '__BVID__479', label: '面積上限（㎡）' },
      { id: '__BVID__516', label: '所在階下限' }
    ];
    textFields.forEach(f => {
      desc += `  - ${f.id}: ${f.label}\n`;
    });

    // 主要セレクト
    desc += '\n■ セレクト:\n';
    desc += '  - __BVID__289: 物件種別（03:賃貸マンション, 02:一戸建, 01:土地）\n';
    desc += '  - __BVID__521: 向き（1:北, 2:北東, 3:東, 4:南東, 5:南, 6:南西, 7:西, 8:北西）\n';
    desc += '  - __BVID__542: 駐車場（1:有, 2:無, 3:近隣確保）\n';

    // チェックボックス
    desc += '\n■ チェックボックス:\n';
    desc += '  - __BVID__307: 新築\n';
    desc += '  - __BVID__492: 角部屋\n';
    desc += '  - __BVID__497: ワンルーム\n';
    desc += '  - __BVID__499: K\n';
    desc += '  - __BVID__501: DK\n';
    desc += '  - __BVID__503: LK\n';
    desc += '  - __BVID__505: LDK\n';

    return desc;
  }

  /**
   * フォームマッピングメイン処理
   */
  async process(intentResult, locationResult, context = {}) {
    this.log('Mapping to REINS form fields...', {
      intentSearchType: intentResult.searchType,
      locationCount: locationResult.recommendations?.length || 0
    });

    // AI を使わずに直接マッピング（高速化）
    if (this.canDirectMap(intentResult, locationResult)) {
      return this.directMap(intentResult, locationResult);
    }

    // AI を使ったマッピング
    return await this.aiMap(intentResult, locationResult, context);
  }

  /**
   * 直接マッピング可能かチェック
   */
  canDirectMap(intentResult, locationResult) {
    // 単純なケースは直接マッピング
    return locationResult.recommendations?.length > 0;
  }

  /**
   * 直接マッピング（AI なし）
   */
  directMap(intentResult, locationResult) {
    const info = intentResult.extractedInfo;
    const recommendations = locationResult.recommendations || [];

    // 共通フィールド
    const commonFields = {
      textInputs: {},
      selects: {},
      checkboxes: {}
    };

    // 賃料
    if (info.budgetMin) {
      commonFields.textInputs['__BVID__452'] = Math.round(info.budgetMin / 10000).toString();
    }
    if (info.budgetMax) {
      commonFields.textInputs['__BVID__454'] = Math.round(info.budgetMax / 10000).toString();
    }

    // 面積
    if (info.areaMin) commonFields.textInputs['__BVID__477'] = info.areaMin.toString();
    if (info.areaMax) commonFields.textInputs['__BVID__479'] = info.areaMax.toString();

    // 物件種別（デフォルト：賃貸マンション）
    commonFields.selects['__BVID__289'] = '03';

    // 間取り
    const layoutMapping = {
      'ワンルーム': '__BVID__497', '1R': '__BVID__497',
      'K': '__BVID__499', '1K': '__BVID__499', '2K': '__BVID__499',
      'DK': '__BVID__501', '1DK': '__BVID__501', '2DK': '__BVID__501',
      'LK': '__BVID__503', '1LK': '__BVID__503',
      'LDK': '__BVID__505', '1LDK': '__BVID__505', '2LDK': '__BVID__505', '3LDK': '__BVID__505'
    };
    for (const roomType of info.roomTypes || []) {
      const checkboxId = layoutMapping[roomType];
      if (checkboxId) {
        commonFields.checkboxes[checkboxId] = true;
      }
    }

    // 各推薦エリアの検索オプション
    const searchOptions = recommendations.map((rec, index) => {
      const option = {
        id: rec.id || index + 1,
        description: this.buildDescription(rec),
        searchMethod: rec.type,
        formFields: {
          textInputs: {},
          selects: {},
          checkboxes: {}
        }
      };

      if (rec.type === 'location') {
        option.formFields.textInputs['__BVID__321'] = rec.prefecture;
        option.formFields.textInputs['__BVID__325'] = rec.city;
        // Store for ResultAdapter
        option.prefecture = rec.prefecture;
        option.city = rec.city;
        // 町丁目があれば追加
        if (rec.town) {
          option.town = rec.town;
          option.detail = rec.town;
        }
      } else if (rec.type === 'line') {
        // Set prefecture for line search to provide location context (fixes Chiyoda-ku default issue)
        if (rec.prefecture) {
          option.formFields.textInputs['__BVID__321'] = rec.prefecture;
        }
        option.formFields.textInputs['__BVID__372'] = rec.line;
        option.formFields.textInputs['__BVID__376'] = rec.station;
        if (rec.walkMinutes) {
          option.formFields.textInputs['__BVID__381'] = rec.walkMinutes.toString();
        }
        // Store city for ResultAdapter
        if (rec.city) {
          option.city = rec.city;
        }
        if (rec.prefecture) {
          option.prefecture = rec.prefecture;
        }
      }

      return option;
    });

    this.log('Direct mapping completed', {
      optionsCount: searchOptions.length
    });

    return {
      searchOptions: searchOptions,
      commonFields: commonFields,
      warnings: [],
      suggestions: this.generateSuggestions(intentResult, locationResult)
    };
  }

  /**
   * AI マッピング
   */
  async aiMap(intentResult, locationResult, context) {
    const systemPrompt = this.getSystemPrompt(context);

    const userPrompt = `以下の検索条件をREINSフォームにマッピングしてください。

【意図分析結果】
${JSON.stringify(intentResult, null, 2)}

【推薦エリア】
${JSON.stringify(locationResult.recommendations, null, 2)}`;

    try {
      const response = await this.callAI([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      const parsed = this.parseJSON(response);
      if (!parsed) {
        return this.directMap(intentResult, locationResult);
      }

      return parsed;
    } catch (error) {
      this.logError('AI mapping failed, falling back to direct mapping', error);
      return this.directMap(intentResult, locationResult);
    }
  }

  /**
   * 検索オプションの説明を生成
   */
  buildDescription(rec) {
    if (rec.type === 'location') {
      const town = rec.town ? ` ${rec.town}` : '';
      return `${rec.city}${town}で所在地検索`;
    } else {
      return `${rec.line} ${rec.station}駅で沿線検索`;
    }
  }

  /**
   * サジェスションを生成
   */
  generateSuggestions(intentResult, locationResult) {
    const suggestions = [];
    const info = intentResult.extractedInfo;

    // 予算が低い場合
    if (info.budgetMax && info.budgetMax < 80000) {
      suggestions.push('予算が低めです。エリアを広げることをお勧めします。');
    }

    // 条件が多い場合
    if ((info.mustHave?.length || 0) > 3) {
      suggestions.push('必須条件が多いため、該当物件が少ない可能性があります。');
    }

    return suggestions;
  }
}

module.exports = new FormAgent();
