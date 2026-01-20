/**
 * IntentAgent - 意图理解 Agent
 * 负责理解用户自然语言输入，提取核心需求
 */

const BaseAgent = require('./base/BaseAgent');

class IntentAgent extends BaseAgent {
  constructor() {
    super({
      name: 'IntentAgent',
      model: 'gpt-4o-mini',
      temperature: 0.1,
      maxTokens: 800
    });
  }

  /**
   * 获取系统提示词
   */
  getSystemPrompt(context = {}) {
    const agentNotes = context.agentNotes || '';
    const agentSection = agentNotes ? `\n【担当者コメント】\n${agentNotes}\n` : '';

    return `あなたは不動産検索システムの意図理解エージェントです。
ユーザーの希望条件を分析して、検索に必要な情報を抽出してください。
${agentSection}

【分析項目】
1. 検索タイプ判定（所在地/沿線/バス/その他）
2. 地標・施設の識別
3. 予算（賃料上限/下限）
4. 間取り・面積
5. 必須条件と希望条件の区別
6. 不足情報の特定

【検索タイプ判定ルール】
- 「〇〇区」「〇〇市」→ location（所在地検索）
- 「〇〇大学」「〇〇キャンパス」「〇〇病院」→ location（周辺エリア検索）
- 「〇〇線」「〇〇駅」→ line（沿線検索）
- 「バス」「バス停」→ bus（バス路線検索）

【出力形式】以下のJSON形式で回答してください（説明不要、JSONのみ）:
{
  "intent": "property_search",
  "searchType": "location/line/bus/other",
  "confidence": 0.0-1.0,
  "reasoning": "判定理由（簡潔に）",
  "extractedInfo": {
    "landmark": "地標・施設名（該当する場合）",
    "landmarkType": "university/hospital/station/company/other",
    "prefecture": "都道府県（推測できる場合）",
    "explicitLocations": ["明確に指定された市区町村"],
    "explicitLines": ["明確に指定された路線"],
    "explicitStations": ["明確に指定された駅"],
    "budgetMin": null,
    "budgetMax": 150000,
    "roomTypes": ["1K", "1DK", "1LDK"],
    "areaMin": null,
    "areaMax": null,
    "mustHave": ["必須条件リスト"],
    "niceToHave": ["希望条件リスト"],
    "petAllowed": false,
    "parking": null
  },
  "missingInfo": ["不足している情報のリスト"],
  "needsAreaSearch": true,
  "areaSearchKeyword": "周辺エリア検索に使うキーワード",
  "userPersona": "student/family/single_worker/elderly/unknown"
}`;
  }

  /**
   * ユーザー入力を分析して意図を抽出
   */
  async process(userInput, context = {}) {
    this.log('Processing user input...', { inputLength: userInput.length });

    const systemPrompt = this.getSystemPrompt(context);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput }
    ];

    // 対話履歴がある場合は追加
    if (context.conversationHistory && context.conversationHistory.length > 0) {
      const historyMessages = context.conversationHistory.map(h => ({
        role: h.role,
        content: h.content
      }));
      messages.splice(1, 0, ...historyMessages);
    }

    try {
      const response = await this.callAI(messages);
      const parsed = this.parseJSON(response);

      if (!parsed) {
        this.logError('Failed to parse intent response', new Error('JSON parse failed'));
        return this.getDefaultIntent();
      }

      this.log('Intent extracted', {
        searchType: parsed.searchType,
        confidence: parsed.confidence,
        missingInfo: parsed.missingInfo?.length || 0
      });

      return this.normalizeIntent(parsed);
    } catch (error) {
      this.logError('Intent processing failed', error);
      return this.getDefaultIntent();
    }
  }

  /**
   * 意図データを正規化
   */
  normalizeIntent(parsed) {
    return {
      intent: parsed.intent || 'property_search',
      searchType: parsed.searchType || 'location',
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || '',
      extractedInfo: {
        landmark: parsed.extractedInfo?.landmark || null,
        landmarkType: parsed.extractedInfo?.landmarkType || null,
        prefecture: parsed.extractedInfo?.prefecture || null,
        explicitLocations: parsed.extractedInfo?.explicitLocations || [],
        explicitLines: parsed.extractedInfo?.explicitLines || [],
        explicitStations: parsed.extractedInfo?.explicitStations || [],
        budgetMin: this.parseBudget(parsed.extractedInfo?.budgetMin),
        budgetMax: this.parseBudget(parsed.extractedInfo?.budgetMax),
        roomTypes: parsed.extractedInfo?.roomTypes || [],
        areaMin: parsed.extractedInfo?.areaMin || null,
        areaMax: parsed.extractedInfo?.areaMax || null,
        mustHave: parsed.extractedInfo?.mustHave || [],
        niceToHave: parsed.extractedInfo?.niceToHave || [],
        petAllowed: parsed.extractedInfo?.petAllowed || false,
        parking: parsed.extractedInfo?.parking || null
      },
      missingInfo: parsed.missingInfo || [],
      needsAreaSearch: parsed.needsAreaSearch || false,
      areaSearchKeyword: parsed.areaSearchKeyword || null,
      userPersona: parsed.userPersona || 'unknown'
    };
  }

  /**
   * 予算を正規化（万円単位 → 円単位）
   */
  parseBudget(value) {
    if (!value) return null;
    if (typeof value === 'number') {
      // 1000以下なら万円単位と判断
      return value <= 1000 ? value * 10000 : value;
    }
    return null;
  }

  /**
   * デフォルトの意図（エラー時のフォールバック）
   */
  getDefaultIntent() {
    return {
      intent: 'property_search',
      searchType: 'unknown',
      confidence: 0,
      reasoning: 'Failed to parse user intent',
      extractedInfo: {
        landmark: null,
        landmarkType: null,
        prefecture: null,
        explicitLocations: [],
        explicitLines: [],
        explicitStations: [],
        budgetMin: null,
        budgetMax: null,
        roomTypes: [],
        areaMin: null,
        areaMax: null,
        mustHave: [],
        niceToHave: [],
        petAllowed: false,
        parking: null
      },
      missingInfo: ['location', 'budget'],
      needsAreaSearch: false,
      areaSearchKeyword: null,
      userPersona: 'unknown'
    };
  }
}

module.exports = new IntentAgent();
