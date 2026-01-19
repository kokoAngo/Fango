/**
 * AI 需求解析器 v3
 * 使用 ChatGPT 将用户自然语言转换为 REINS 表单结构
 * 基于完整的 reins-form-structure.json 进行智能映射
 * 支持多位置选项搜索和多轮询问
 *
 * v3 新功能:
 * - 第一步判断搜索类型（所在地、沿線、バス路線、その他の交通手段）
 * - 联网搜索查询周边地区
 * - 生成最多10个提案
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

class AIRequirementsParser {
  constructor() {
    this.client = null;
    this.formStructure = null;
    this.structureSummary = null;
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
   * Step 1: 判断搜索类型和识别地标
   * @param {string} userInput - 用户输入
   * @param {string} agentNotes - 中介备注
   * @returns {object} - 搜索类型和地标信息
   */
  async determineSearchType(userInput, agentNotes = '') {
    const client = this.initClient();
    if (!client) return null;

    const agentNotesSection = agentNotes ? `
【担当者コメント】
${agentNotes}
` : '';

    const systemPrompt = `あなたは不動産検索システムのアシスタントです。
ユーザーの希望条件を分析して、以下の4つの検索タイプから最も適切なものを判定してください。

【検索タイプ】
1. location（所在地検索）- 特定の区・市・町で探す場合、または大学・施設などの周辺エリアで探す場合
2. line（沿線検索）- 特定の路線や駅で探す場合
3. bus（バス路線検索）- バス路線で探す場合
4. other（その他の交通手段）- その他の交通手段で探す場合

【判定のポイント】
- 「〇〇区」「〇〇市」などの地名が明確に指定されている場合 → location
- 「〇〇大学」「〇〇キャンパス」「〇〇病院」など施設名が指定されている場合 → location（周辺エリア検索）
- 「〇〇線」「〇〇駅」など鉄道が指定されている場合 → line
- 「バス」「バス停」などバスが指定されている場合 → bus
- 施設名の場合、その施設の周辺にある具体的な町名を調べる必要があります

${agentNotesSection}

以下のJSON形式で回答してください（説明不要、JSONのみ）:
{
  "searchType": "location/line/bus/other",
  "confidence": 0.0-1.0,
  "reasoning": "判定理由（簡潔に）",
  "landmark": "地標・施設名（該当する場合）",
  "landmarkType": "university/hospital/station/company/shopping/park/other",
  "prefecture": "都道府県（推測できる場合）",
  "explicitLocations": ["明確に指定された市区町村"],
  "explicitLines": ["明確に指定された路線"],
  "explicitStations": ["明確に指定された駅"],
  "needsAreaSearch": true/false,
  "areaSearchKeyword": "周辺エリア検索に使うキーワード"
}`;

    try {
      console.log('[AIParser] Step 1: 検索タイプを判定中...');

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userInput }
        ]
      });

      const content = response.choices[0].message.content.trim();
      console.log('[AIParser] Search type analysis:', content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return null;
    } catch (error) {
      console.error('[AIParser] Error in determineSearchType:', error.message);
      return null;
    }
  }

  /**
   * Step 2: 联网搜索周边地区（使用 GPT 的知识库）
   * @param {string} landmark - 地标名
   * @param {string} prefecture - 都道府县
   * @param {string} searchKeyword - 搜索关键词
   * @returns {object} - 周边地区信息
   */
  async searchNearbyAreas(landmark, prefecture, searchKeyword) {
    const client = this.initClient();
    if (!client) return null;

    const systemPrompt = `あなたは日本の地理に詳しい不動産アシスタントです。
指定された施設・地標の周辺にある具体的な「町丁目」レベルの地域を調べて、物件検索用のエリアリストを作成してください。

【重要なルール】
1. 【町丁目レベルで提案】各エリアは「町丁目」単位で提案してください（例：大岡山1丁目、緑が丘、石川台など）
2. 都道府県名と市区町村名も必ず含めてください
3. 最大10件のエリアを提案してください
4. 施設から近い順に並べてください（徒歩圏内を優先）
5. 各エリアについて、施設からの距離感や特徴を簡潔に説明してください
6. 沿線検索も2〜3件提案に含めてください（最寄り駅と路線名）

【例】東京工業大学大岡山キャンパスの周辺を検索する場合:
- 目黒区 大岡山（キャンパス所在地、徒歩圏）
- 目黒区 緑が丘（キャンパス北側、徒歩10分）
- 大田区 石川台（キャンパス南側、徒歩8分）
- 大田区 北千束（キャンパス西側、徒歩12分）
- 目黒区 洗足（閑静な住宅街、徒歩15分）
- 東急大井町線 大岡山駅（キャンパス最寄り駅）
- 東急目黒線 大岡山駅（キャンパス最寄り駅）
- 東急池上線 石川台駅（キャンパス南側）

以下のJSON形式で回答してください（説明不要、JSONのみ）:
{
  "centerLocation": {
    "name": "施設名",
    "address": "住所（わかる範囲で）",
    "prefecture": "都道府県",
    "city": "市区町村",
    "town": "町丁目"
  },
  "nearbyAreas": [
    {
      "type": "location/line",
      "prefecture": "都道府県",
      "city": "市区町村",
      "town": "町丁目（locationの場合、例：大岡山、緑が丘、石川台）",
      "line": "路線名（lineの場合）",
      "station": "駅名（lineの場合）",
      "distance": "施設からの距離感（徒歩5分/徒歩10分/徒歩15分など具体的に）",
      "description": "エリアの特徴（簡潔に）"
    }
  ]
}`;

    const userPrompt = `「${landmark}」${prefecture ? `（${prefecture}）` : ''}の周辺で物件を探したいです。
${searchKeyword ? `検索キーワード: ${searchKeyword}` : ''}

この施設の周辺にある具体的な「町丁目」と、最寄りの沿線・駅を教えてください。
町丁目レベルで近い順に提案してください（例：大岡山、緑が丘、石川台、北千束など）。`;

    try {
      console.log('[AIParser] Step 2: 周辺エリアを検索中...');
      console.log('[AIParser] Landmark:', landmark, 'Prefecture:', prefecture);

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 1000,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      });

      const content = response.choices[0].message.content.trim();
      console.log('[AIParser] Nearby areas result:', content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return null;
    } catch (error) {
      console.error('[AIParser] Error in searchNearbyAreas:', error.message);
      return null;
    }
  }

  /**
   * 加载 REINS 表单结构
   */
  loadFormStructure() {
    if (this.formStructure) return this.formStructure;

    try {
      const structurePath = path.join(__dirname, '..', 'reins-form-structure.json');
      const content = fs.readFileSync(structurePath, 'utf-8');
      this.formStructure = JSON.parse(content);
      console.log('[AIParser] Loaded REINS form structure');
      return this.formStructure;
    } catch (error) {
      console.error('[AIParser] Failed to load form structure:', error.message);
      return null;
    }
  }

  /**
   * 生成表单结构摘要供 GPT 使用
   * 精简版本，只包含关键字段
   */
  generateStructureSummary() {
    if (this.structureSummary) return this.structureSummary;

    const structure = this.loadFormStructure();
    if (!structure) return null;

    // 提取关键 SELECT 字段
    const keySelects = [];
    for (const select of structure.selects || []) {
      const options = (select.options || [])
        .filter(o => o.text && o.text.trim())
        .slice(0, 10)
        .map(o => ({ value: o.value, text: o.text }));

      if (options.length > 0) {
        keySelects.push({
          id: select.id,
          label: select.label || select.parentSection?.join(' > ') || '',
          optionCount: select.optionCount,
          sampleOptions: options
        });
      }
    }

    // 提取关键 TEXT INPUT 字段
    const keyInputs = [];
    for (const input of structure.textInputs || []) {
      if (input.label && input.label.trim()) {
        keyInputs.push({
          id: input.id,
          label: input.label.trim().substring(0, 50),
          parentSection: input.parentSection?.join(' > ') || ''
        });
      }
    }

    // 提取 CHECKBOX 字段
    const keyCheckboxes = [];
    for (const cb of structure.checkboxes || []) {
      keyCheckboxes.push({
        id: cb.id,
        label: cb.label || '',
        value: cb.value
      });
    }

    // 提取 RADIO 按钮组
    const radioGroups = {};
    for (const radio of structure.radioButtons || []) {
      const groupName = radio.attributes?.name || 'unnamed';
      if (!radioGroups[groupName]) {
        radioGroups[groupName] = {
          name: groupName,
          options: []
        };
      }
      radioGroups[groupName].options.push({
        id: radio.id,
        label: radio.label || '',
        value: radio.value
      });
    }

    this.structureSummary = {
      selects: keySelects.slice(0, 30),  // 限制数量
      textInputs: keyInputs.slice(0, 40),
      checkboxes: keyCheckboxes,
      radioGroups: Object.values(radioGroups)
    };

    return this.structureSummary;
  }

  /**
   * 生成供 GPT 使用的表单描述
   */
  generateFormDescription() {
    const summary = this.generateStructureSummary();
    if (!summary) {
      return '（表单结构加载失败，使用默认字段）';
    }

    let desc = `【REINS 賃貸物件検索フォーム構造】\n\n`;

    // 关键选择框
    desc += `■ 主要な選択項目（SELECT）:\n`;
    const importantSelects = summary.selects.filter(s =>
      s.label.includes('物件種別') ||
      s.label.includes('方向') ||
      s.label.includes('用途') ||
      s.label.includes('駐車場') ||
      s.label.includes('接道') ||
      s.optionCount > 5
    );
    for (const select of importantSelects.slice(0, 15)) {
      desc += `  - ${select.id}: ${select.label} (${select.optionCount}個の選択肢)\n`;
      desc += `    選択肢例: ${select.sampleOptions.map(o => `${o.text}(${o.value})`).join(', ')}\n`;
    }

    // 关键输入框
    desc += `\n■ 主要な入力項目（TEXT）:\n`;
    const importantInputs = summary.textInputs.filter(t =>
      t.label.includes('都道府県') ||
      t.label.includes('所在地') ||
      t.label.includes('沿線') ||
      t.label.includes('駅') ||
      t.label.includes('賃料') ||
      t.label.includes('面積') ||
      t.label.includes('徒歩') ||
      t.label.includes('建物')
    );
    for (const input of importantInputs.slice(0, 20)) {
      desc += `  - ${input.id}: ${input.label}\n`;
    }

    // 复选框
    desc += `\n■ チェックボックス:\n`;
    for (const cb of summary.checkboxes) {
      desc += `  - ${cb.id}: ${cb.label}\n`;
    }

    return desc;
  }

  /**
   * 使用 AI 解析用户需求（返回多个位置选项）
   * v3: 两步解析流程 - 先判断类型，再搜索周边地区
   * @param {string} userInput - 用户输入
   * @param {object} context - 上下文（用于多轮对话）
   * @param {string} agentNotes - 中介评价/备注（可选）
   */
  async parse(userInput, context = {}, agentNotes = '') {
    const client = this.initClient();

    if (!client) {
      console.log('[AIParser] OpenAI API key not configured');
      return null;
    }

    console.log('[AIParser] Parsing user requirements...');
    console.log('[AIParser] Input:', userInput);
    if (agentNotes) {
      console.log('[AIParser] Agent notes:', agentNotes);
    }

    // ============================================
    // Step 1: 判断搜索类型
    // ============================================
    const searchTypeResult = await this.determineSearchType(userInput, agentNotes);

    if (!searchTypeResult) {
      console.log('[AIParser] Failed to determine search type, falling back to legacy parse');
      return await this.legacyParse(userInput, context, agentNotes);
    }

    console.log('[AIParser] Search type determined:', searchTypeResult.searchType);
    console.log('[AIParser] Needs area search:', searchTypeResult.needsAreaSearch);

    // ============================================
    // Step 2: 如果需要，搜索周边地区
    // ============================================
    let nearbyAreasResult = null;
    if (searchTypeResult.needsAreaSearch && searchTypeResult.landmark) {
      nearbyAreasResult = await this.searchNearbyAreas(
        searchTypeResult.landmark,
        searchTypeResult.prefecture,
        searchTypeResult.areaSearchKeyword
      );

      if (nearbyAreasResult) {
        console.log('[AIParser] Found', nearbyAreasResult.nearbyAreas?.length || 0, 'nearby areas');
      }
    }

    // ============================================
    // Step 3: 生成最终的搜索选项（最多10个）
    // ============================================
    return await this.generateFinalSearchOptions(
      userInput,
      agentNotes,
      searchTypeResult,
      nearbyAreasResult,
      context
    );
  }

  /**
   * Step 3: 生成最终的搜索选项
   */
  async generateFinalSearchOptions(userInput, agentNotes, searchTypeResult, nearbyAreasResult, context) {
    const client = this.initClient();
    const formDesc = this.generateFormDescription();

    // 构建周边地区信息
    let nearbyAreasInfo = '';
    if (nearbyAreasResult && nearbyAreasResult.nearbyAreas) {
      nearbyAreasInfo = `

【周辺エリア検索結果（町丁目レベル）】
施設: ${nearbyAreasResult.centerLocation?.name || searchTypeResult.landmark}
住所: ${nearbyAreasResult.centerLocation?.address || '不明'}

以下の周辺エリアが見つかりました。これらを searchOptions に含めてください：
${nearbyAreasResult.nearbyAreas.map((area, i) => {
  if (area.type === 'location') {
    const townInfo = area.town ? ` ${area.town}` : '';
    return `${i + 1}. ${area.prefecture} ${area.city}${townInfo}（${area.distance}）- ${area.description}`;
  } else {
    return `${i + 1}. ${area.line} ${area.station}駅（${area.distance}）- ${area.description}`;
  }
}).join('\n')}
`;
    }

    // 构建中介评价部分
    const agentNotesSection = agentNotes ? `

【担当者コメント】
${agentNotes}
` : '';

    const systemPrompt = `あなたは不動産検索システムのアシスタントです。
ユーザーの自然言語での希望条件を、REINSの検索フォームに入力できる形式に変換してください。

${agentNotesSection}
${nearbyAreasInfo}
${formDesc}

【検索タイプ分析結果】
- 検索タイプ: ${searchTypeResult.searchType}
- 判定理由: ${searchTypeResult.reasoning || ''}
- 地標・施設: ${searchTypeResult.landmark || 'なし'}
${searchTypeResult.explicitLocations?.length ? `- 明示された地域: ${searchTypeResult.explicitLocations.join(', ')}` : ''}
${searchTypeResult.explicitLines?.length ? `- 明示された路線: ${searchTypeResult.explicitLines.join(', ')}` : ''}
${searchTypeResult.explicitStations?.length ? `- 明示された駅: ${searchTypeResult.explicitStations.join(', ')}` : ''}

【重要なルール】
1. 【最大10件の検索オプションを生成（町丁目レベル）】
   searchOptions 配列に、最大10件の検索オプションを含めてください。
   周辺エリア検索結果がある場合は、それを優先的に searchOptions に含めてください。
   - 所在地検索オプション（町丁目単位で指定、例：大岡山、緑が丘、石川台）
   - 沿線検索オプション（路線・駅単位）
   を組み合わせて提案してください。

2. 【検索タイプに応じた処理】
   - location: 所在地（町丁目）での検索を中心に提案
   - line: 沿線・駅での検索を中心に提案
   - 両方を組み合わせるのが理想的です

3. 情報が不足している場合は、needsMoreInfo を true にしてください。

4. 設備条件（オートロック等）は equipment 配列に入れてください。

5. 【物件種別の判定ルール】
   - デフォルトは「03」（賃貸マンション/アパート）
   - 「一人暮らし」「2LDK」などの場合は通常マンション/アパート（03）
   - 「一戸建てでも構いません」「戸建ても可」は「アパートが優先だが戸建ても可」という意味なので、propertyType は「03」のままにする
   - 「一戸建てを希望」「戸建てで探したい」など明確に一戸建てを希望する場合のみ「02」を使用

以下のJSON形式で回答してください（説明不要、JSONのみ）:

{
  "needsMoreInfo": false,
  "missingFields": [],
  "suggestedQuestions": [],

  "searchOptions": [
    {
      "id": 1,
      "description": "検索オプションの説明（例：目黒区 大岡山で所在地検索）",
      "searchMethod": "location/line",
      "prefecture": "都道府県名",
      "city": "市区町村名",
      "town": "町丁目名（locationの場合、例：大岡山、緑が丘、石川台）",
      "line": "沿線名（lineの場合）",
      "station": "駅名（lineの場合）",
      "walkMinutes": 徒歩分数（任意）
    }
  ],

  "searchMethod": "location/line/bus/other",
  "locations": [{"prefecture": "都道府県名", "city": "市区町村名", "town": "町丁目名"}],
  "line": "沿線名",
  "station": "駅名",

  "rentMin": 賃料下限（万円）,
  "rentMax": 賃料上限（万円）,
  "areaMin": 面積下限（㎡）,
  "areaMax": 面積上限（㎡）,

  "propertyType": "物件種別コード（03:賃貸マンション, 02:賃貸一戸建, 01:賃貸土地）",
  "layouts": ["間取り"],
  "floorMin": 階数下限,
  "direction": "向き",

  "parking": "駐車場",
  "isNew": true/false,
  "corner": true/false,
  "petAllowed": true/false,

  "equipment": ["設備条件の配列"],
  "keywords": ["キーワード"],

  "formFields": {
    "textInputs": {},
    "selects": {},
    "checkboxes": {}
  }
}`;

    try {
      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      if (context.previousParsed) {
        messages.push({
          role: 'assistant',
          content: `前回の解析結果:\n${JSON.stringify(context.previousParsed, null, 2)}`
        });
      }

      messages.push({ role: 'user', content: userInput });

      console.log('[AIParser] Step 3: 最終検索オプションを生成中...');

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 1500,
        temperature: 0.2,
        messages: messages
      });

      const content = response.choices[0].message.content.trim();
      console.log('[AIParser] Raw response:', content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        console.log('[AIParser] Parsed result:', JSON.stringify(parsed, null, 2));

        // 检查是否需要更多信息
        if (parsed.needsMoreInfo) {
          return {
            needsMoreInfo: true,
            missingFields: parsed.missingFields || [],
            suggestedQuestions: parsed.suggestedQuestions || [],
            partialResult: this.normalize(parsed)
          };
        }

        // 确保 searchOptions 最多10个
        if (parsed.searchOptions && parsed.searchOptions.length > 10) {
          parsed.searchOptions = parsed.searchOptions.slice(0, 10);
        }

        return this.normalize(parsed);
      }

      return null;
    } catch (error) {
      console.error('[AIParser] Error in generateFinalSearchOptions:', error.message);
      return null;
    }
  }

  /**
   * 旧版解析方法（作为 fallback）
   */
  async legacyParse(userInput, context = {}, agentNotes = '') {
    const client = this.initClient();
    const formDesc = this.generateFormDescription();

    const agentNotesSection = agentNotes ? `

【担当者コメント】
${agentNotes}
` : '';

    const systemPrompt = `あなたは不動産検索システムのアシスタントです。
ユーザーの自然言語での希望条件を、REINSの検索フォームに入力できる形式に変換してください。
${agentNotesSection}
${formDesc}

【重要なルール】
1. 大学、駅、施設などの地名は、複数の区・市にまたがることがあります。
   該当する可能性のある全ての市区町村を locations 配列に含めてください。

2. 【所在地・沿線の入力ルール】
   REINSの「所在地・沿線」セクションでは、以下の4項目から1つだけ選んで入力します：
   - 所在地（都道府県・市区町村）
   - 沿線（路線・駅）
   - バス路線
   - その他の交通手段

3. 複数の検索オプションを searchOptions 配列に含めてください（最大10件）。

以下のJSON形式で回答してください（説明不要、JSONのみ）:
{
  "needsMoreInfo": false,
  "missingFields": [],
  "searchOptions": [
    {
      "id": 1,
      "description": "検索オプションの説明",
      "searchMethod": "location/line",
      "prefecture": "都道府県名",
      "city": "市区町村名",
      "line": "沿線名",
      "station": "駅名"
    }
  ],
  "searchMethod": "location/line/bus/other",
  "locations": [{"prefecture": "都道府県名", "city": "市区町村名"}],
  "line": "沿線名",
  "station": "駅名",
  "rentMin": 賃料下限,
  "rentMax": 賃料上限,
  "propertyType": "物件種別コード",
  "layouts": ["間取り"],
  "petAllowed": true/false,
  "equipment": ["設備条件"]
}`;

    try {
      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      if (context.previousParsed) {
        messages.push({
          role: 'assistant',
          content: `前回の解析結果:\n${JSON.stringify(context.previousParsed, null, 2)}`
        });
      }

      messages.push({ role: 'user', content: userInput });

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 1200,
        temperature: 0.1,
        messages: messages
      });

      const content = response.choices[0].message.content.trim();
      console.log('[AIParser] Legacy response:', content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        if (parsed.needsMoreInfo) {
          return {
            needsMoreInfo: true,
            missingFields: parsed.missingFields || [],
            suggestedQuestions: parsed.suggestedQuestions || [],
            partialResult: this.normalize(parsed)
          };
        }

        return this.normalize(parsed);
      }

      return null;
    } catch (error) {
      console.error('[AIParser] Legacy parse error:', error.message);
      return null;
    }
  }

  /**
   * AI の出力を正規化して REINS フォーム用に変換
   */
  normalize(parsed) {
    // locations 配列から位置情報を抽出
    let locations = [];
    if (parsed.locations && Array.isArray(parsed.locations)) {
      locations = parsed.locations.map(loc => ({
        prefecture: loc.prefecture,
        city: this.extractCityName(loc.city),
        town: loc.town || null,  // 町丁目
        detail: loc.detail || loc.town || null  // town を detail として使用
      }));
    } else if (parsed.prefecture || parsed.city) {
      locations = [{
        prefecture: parsed.prefecture,
        city: this.extractCityName(parsed.city),
        town: parsed.town || null,
        detail: parsed.town || null
      }];
    }

    // 自動判定 searchMethod（GPT が指定しない場合）
    let searchMethod = parsed.searchMethod || null;
    if (!searchMethod) {
      // 駅が明確に指定されている場合は沿線優先
      if (parsed.station || parsed.line) {
        searchMethod = 'line';
      } else if (locations.length > 0) {
        searchMethod = 'location';
      }
    }

    // searchOptions の正規化
    let searchOptions = [];
    if (parsed.searchOptions && Array.isArray(parsed.searchOptions)) {
      searchOptions = parsed.searchOptions.map(opt => ({
        id: opt.id,
        description: opt.description,
        searchMethod: opt.searchMethod,
        prefecture: opt.prefecture,
        city: this.extractCityName(opt.city),
        town: opt.town || null,  // 町丁目
        detail: opt.detail || opt.town || null,  // town を detail として使用
        line: opt.line || null,
        station: opt.station || null,
        stationTo: opt.stationTo || null,
        walkMinutes: opt.walkMinutes || null
      }));
    }

    const result = {
      // 多轮对话支持
      needsMoreInfo: parsed.needsMoreInfo || false,
      missingFields: parsed.missingFields || [],
      suggestedQuestions: parsed.suggestedQuestions || [],

      // 複数の検索オプション
      searchOptions: searchOptions,

      // 検索方法（location/line/bus/other）- デフォルト
      searchMethod: searchMethod,

      // 位置信息
      locations: locations,
      prefecture: locations.length > 0 ? locations[0].prefecture : null,
      cities: locations.length > 0 ? [locations[0].city] : [],

      // 沿線信息
      line: parsed.line || null,
      station: parsed.station || null,
      stationTo: parsed.stationTo || null,
      walkMinutes: parsed.walkMinutes || null,

      // 賃料・面積
      rentMin: parsed.rentMin || null,
      rentMax: parsed.rentMax || null,
      areaMin: parsed.areaMin || null,
      areaMax: parsed.areaMax || null,

      // 物件条件
      floorMin: parsed.floorMin || null,
      direction: parsed.direction || null,
      propertyType: this.mapPropertyType(parsed.propertyType),
      layouts: parsed.layouts || [],
      parking: this.mapParking(parsed.parking),
      isNew: parsed.isNew || false,
      petAllowed: parsed.petAllowed || false,
      corner: parsed.corner || false,

      // 設備・キーワード
      equipment: parsed.equipment || [],
      keywords: [],

      // 直接的なフォームフィールド（GPT が生成した場合）
      formFields: parsed.formFields || null
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
    const match = city.match(/([^\s市]+(?:区|市|町|村))$/);
    return match ? match[1] : city;
  }

  /**
   * 物件種別をREINSコードに変換
   */
  mapPropertyType(type) {
    if (!type) return null;
    // 既にコードの場合
    if (['01', '02', '03', '04', '05'].includes(type)) return type;

    const mapping = {
      'マンション': '03',
      '賃貸マンション': '03',
      'アパート': '03',
      '一戸建て': '02',
      '賃貸一戸建': '02',
      '一戸建': '02',
      '戸建て': '02',
      '戸建': '02',
      '土地': '01',
      '賃貸土地': '01'
    };
    return mapping[type] || null;
  }

  /**
   * 駐車場をREINSコードに変換
   */
  mapParking(parking) {
    if (!parking) return null;
    // 既にコードの場合
    if (['1', '2', '3'].includes(parking)) return parking;

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
   * 動的に form structure から ID を取得
   */
  toReinsFields(parsed) {
    if (!parsed) return null;

    const structure = this.loadFormStructure();

    // フォームフィールドが直接指定されている場合
    if (parsed.formFields) {
      return {
        textInputs: parsed.formFields.textInputs || {},
        selects: parsed.formFields.selects || {},
        checkboxes: parsed.formFields.checkboxes || {},
        keywords: parsed.keywords || []
      };
    }

    // 方位マッピング
    const directionMapping = {
      '北': '1', '北東': '2', '東': '3', '南東': '4',
      '南': '5', '南西': '6', '西': '7', '北西': '8',
      '1': '1', '2': '2', '3': '3', '4': '4',
      '5': '5', '6': '6', '7': '7', '8': '8'
    };

    // 間取りマッピング（動的に取得を試みる）
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

    // structure から checkbox の ID を動的に取得
    if (structure && structure.checkboxes) {
      for (const cb of structure.checkboxes) {
        if (cb.label === 'ワンルーム') layoutMapping['ワンルーム'] = cb.id;
        if (cb.label === 'Ｋ') layoutMapping['K'] = cb.id;
        if (cb.label === 'ＤＫ') layoutMapping['DK'] = cb.id;
        if (cb.label === 'ＬＫ') layoutMapping['LK'] = cb.id;
        if (cb.label === 'ＬＤＫ') layoutMapping['LDK'] = cb.id;
      }
    }

    const fields = {
      textInputs: {},
      selects: {},
      checkboxes: {},
      keywords: parsed.keywords || []
    };

    // テキスト入力（フォールバック ID を使用）
    if (parsed.prefecture) fields.textInputs['__BVID__321'] = parsed.prefecture;
    if (parsed.cities?.length > 0) fields.textInputs['__BVID__325'] = parsed.cities[0];
    if (parsed.line) fields.textInputs['__BVID__372'] = parsed.line;
    if (parsed.station) fields.textInputs['__BVID__376'] = parsed.station;
    if (parsed.stationTo) fields.textInputs['__BVID__378'] = parsed.stationTo;
    if (parsed.walkMinutes) fields.textInputs['__BVID__381'] = parsed.walkMinutes.toString();
    if (parsed.rentMin) fields.textInputs['__BVID__452'] = parsed.rentMin.toString();
    if (parsed.rentMax) fields.textInputs['__BVID__454'] = parsed.rentMax.toString();
    if (parsed.areaMin) fields.textInputs['__BVID__477'] = parsed.areaMin.toString();
    if (parsed.areaMax) fields.textInputs['__BVID__479'] = parsed.areaMax.toString();
    if (parsed.floorMin) fields.textInputs['__BVID__516'] = parsed.floorMin.toString();

    // セレクト
    if (parsed.propertyType) fields.selects['__BVID__289'] = parsed.propertyType;
    if (parsed.direction && directionMapping[parsed.direction]) {
      fields.selects['__BVID__521'] = directionMapping[parsed.direction];
    }
    if (parsed.parking) fields.selects['__BVID__542'] = parsed.parking;

    // チェックボックス
    if (parsed.isNew) fields.checkboxes['__BVID__307'] = true;
    if (parsed.corner) fields.checkboxes['__BVID__492'] = true;

    // 間取り
    for (const layout of parsed.layouts || []) {
      const checkboxId = layoutMapping[layout];
      if (checkboxId) {
        fields.checkboxes[checkboxId] = true;
      }
    }

    return fields;
  }

  /**
   * 多轮对话：检查是否需要追问
   */
  checkNeedsFollowUp(parsed) {
    if (!parsed) return { needsFollowUp: true, questions: ['検索条件を教えてください'] };

    const questions = [];

    // 检查是否缺少位置信息
    const hasLocation = (parsed.locations && parsed.locations.length > 0) ||
                       parsed.prefecture ||
                       (parsed.cities && parsed.cities.length > 0);
    const hasLine = parsed.line || parsed.station;

    if (!hasLocation && !hasLine) {
      questions.push('どのエリアで探されていますか？所在地（例：渋谷区）または沿線・駅（例：山手線渋谷駅）を教えてください。');
    }

    // 检查是否缺少賃料范围
    if (!parsed.rentMin && !parsed.rentMax) {
      questions.push('ご予算（賃料の上限）はございますか？');
    }

    return {
      needsFollowUp: questions.length > 0,
      questions: questions
    };
  }
}

module.exports = new AIRequirementsParser();
