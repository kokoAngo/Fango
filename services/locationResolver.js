/**
 * 位置解析服务
 * 使用 AI API 将地标/车站名转换为具体的都道府県和市区町村
 * 支持 OpenAI (ChatGPT) 和 Anthropic (Claude) API
 */

const OpenAI = require('openai');

class LocationResolver {
  constructor() {
    this.openaiClient = null;
  }

  /**
   * 初始化 OpenAI 客户端
   */
  initClient() {
    if (!this.openaiClient && process.env.OPENAI_API_KEY) {
      this.openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
    return this.openaiClient;
  }

  /**
   * 检查是否需要位置解析
   * 条件：有车站/地标信息，但没有明确的市区町村
   */
  needsResolution(parsedRequirements, originalText) {
    // 已经有明确的市区町村，不需要解析
    if (parsedRequirements.cities && parsedRequirements.cities.length > 0) {
      return false;
    }

    // 有车站名，需要解析
    if (parsedRequirements.station) {
      return true;
    }

    // 检查是否包含地标关键词（大学、キャンパス、駅、商業施設等）
    const landmarkPatterns = [
      /大学/, /キャンパス/, /学校/, /高校/, /中学/,
      /病院/, /公園/, /駅/, /空港/,
      /タワー/, /ビル/, /センター/, /モール/,
      /神社/, /寺/, /城/,
      /付近/, /近く/, /周辺/, /エリア/
    ];

    for (const pattern of landmarkPatterns) {
      if (pattern.test(originalText)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 从文本中提取地标名
   */
  extractLandmark(text) {
    // 提取可能的地标名
    const patterns = [
      // 大学/学校
      /([^\s、。・\n]*(?:大学|キャンパス|学校|高校|中学)[^\s、。・\n]*)/,
      // 駅
      /([^\s、。・\n]+駅)/,
      // 施設
      /([^\s、。・\n]*(?:病院|公園|空港|タワー|ビル|センター|モール|神社|寺|城)[^\s、。・\n]*)/,
      // 付近/近く の前の名詞
      /([^\s、。・\n]+)(?:付近|近く|周辺|エリア)/
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * 使用 OpenAI API 解析位置
   */
  async resolveLocation(landmark) {
    const client = this.initClient();

    if (!client) {
      console.log('[LocationResolver] OpenAI API key not configured, skipping resolution');
      return null;
    }

    try {
      console.log(`[LocationResolver] Resolving location for: ${landmark}`);

      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `「${landmark}」の所在地を教えてください。

以下のJSON形式のみで回答してください（説明不要）:
{"prefecture": "都道府県名", "city": "市区町村名", "detail": "詳細住所（任意）"}

例:
- 東京駅 → {"prefecture": "東京都", "city": "千代田区", "detail": "丸の内"}
- 大岡山駅 → {"prefecture": "東京都", "city": "大田区", "detail": "北千束"}
- 梅田駅 → {"prefecture": "大阪府", "city": "大阪市北区", "detail": ""}

回答:`
        }]
      });

      const content = response.choices[0].message.content.trim();
      console.log(`[LocationResolver] API response: ${content}`);

      // JSON を解析
      const jsonMatch = content.match(/\{[^}]+\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        console.log(`[LocationResolver] Resolved: ${result.prefecture} ${result.city}`);
        return result;
      }

      return null;
    } catch (error) {
      console.error('[LocationResolver] Error:', error.message);
      return null;
    }
  }

  /**
   * メイン処理: テキストから位置を解析し、parsedRequirements を補完
   */
  async enhance(parsedRequirements, originalText) {
    // 解析が必要かチェック
    if (!this.needsResolution(parsedRequirements, originalText)) {
      return parsedRequirements;
    }

    // 地標を抽出
    let landmark = this.extractLandmark(originalText);

    // 地標がなければ駅名を使用
    if (!landmark && parsedRequirements.station) {
      landmark = parsedRequirements.station + '駅';
    }

    if (!landmark) {
      return parsedRequirements;
    }

    // API で位置を解析
    const location = await this.resolveLocation(landmark);

    if (location) {
      // 結果を parsedRequirements にマージ
      const enhanced = { ...parsedRequirements };

      if (location.prefecture && !enhanced.prefecture) {
        enhanced.prefecture = location.prefecture;
      }

      if (location.city) {
        // city が "大阪市北区" のような形式の場合、"北区" だけを抽出
        let cityName = location.city;
        const cityMatch = cityName.match(/([^\s市]+(?:区|市|町|村))$/);
        if (cityMatch) {
          cityName = cityMatch[1];
        }

        if (!enhanced.cities || enhanced.cities.length === 0) {
          enhanced.cities = [cityName];
        }
      }

      console.log('[LocationResolver] Enhanced requirements:', {
        prefecture: enhanced.prefecture,
        cities: enhanced.cities
      });

      return enhanced;
    }

    return parsedRequirements;
  }
}

module.exports = new LocationResolver();
