/**
 * LocationAgent - 地区推荐 Agent
 * 负责根据用户条件推荐合适的搜索地区
 */

const BaseAgent = require('./base/BaseAgent');
const reinsCache = require('../reinsCacheService');

class LocationAgent extends BaseAgent {
  constructor() {
    super({
      name: 'LocationAgent',
      model: 'gpt-4o-mini',  // 需要丰富的地理知识
      temperature: 0.3,
      maxTokens: 4000  // 增加以支持更多推荐
    });
  }

  /**
   * 获取系统提示词
   */
  getSystemPrompt(context = {}) {
    return `あなたは日本の地理に詳しい不動産アシスタントです。
指定された施設・地標の周辺にある具体的な「町丁目」レベルの地域を調べて、物件検索用のエリアリストを作成してください。

【重要なルール】
1. 【町丁目レベルで提案】各エリアは「町丁目」単位で提案（例：北8条西、北9条西、北10条西）
2. 都道府県名と市区町村名を必ず含める
3. 【重要】所在地検索オプションを15〜20件提案（施設周辺の町丁目を網羅的に）
4. 沿線検索オプションを3〜5件提案（最寄り駅と周辺駅）
5. 施設から近い順に並べる（徒歩圏内を優先）
6. 各エリアの特徴は省略可（reason のみで十分）

【スコアリング基準】
- 0.9-1.0: 徒歩5分以内、最寄りエリア
- 0.8-0.9: 徒歩10分以内、利便性高い
- 0.7-0.8: 徒歩15分以内、住環境良好
- 0.6-0.7: 徒歩20分以内、静かな住宅街
- 0.5-0.6: 電車1駅隣、アクセス可能

【出力形式】以下のJSON形式で回答（説明不要、JSONのみ）:
{
  "centerPoint": {
    "name": "施設名",
    "prefecture": "都道府県",
    "city": "市区町村",
    "town": "町丁目"
  },
  "recommendations": [
    {"id": 1, "type": "location", "prefecture": "北海道", "city": "札幌市北区", "town": "北8条西", "score": 0.95, "reason": "キャンパス至近"},
    {"id": 2, "type": "location", "prefecture": "北海道", "city": "札幌市北区", "town": "北9条西", "score": 0.93, "reason": "徒歩5分"},
    {"id": 3, "type": "location", "prefecture": "北海道", "city": "札幌市北区", "town": "北10条西", "score": 0.90, "reason": "徒歩7分"},
    ...（15〜20件の所在地を列挙）...,
    {"id": 18, "type": "line", "prefecture": "北海道", "city": "札幌市北区", "line": "札幌市営地下鉄南北線", "station": "北12条駅", "walkMinutes": 5, "score": 0.88, "reason": "最寄り駅"},
    {"id": 19, "type": "line", "prefecture": "北海道", "city": "札幌市北区", "line": "札幌市営地下鉄南北線", "station": "北18条駅", "walkMinutes": 10, "score": 0.82, "reason": "1駅隣"}
  ],
  "searchStrategy": "parallel",
  "totalOptions": 20
}`;
  }

  /**
   * 地区推荐メイン処理
   */
  async process(intentResult, context = {}) {
    this.log('Generating location recommendations...', {
      searchType: intentResult.searchType,
      landmark: intentResult.extractedInfo?.landmark
    });

    // 【優先1】沿線検索（searchType が line の場合）
    if (intentResult.searchType === 'line') {
      // 明示的な駅指定がある場合
      if (intentResult.extractedInfo?.explicitStations?.length > 0) {
        return await this.buildFromStations(intentResult);
      }
      // 駅指定がなくても路線指定がある場合
      if (intentResult.extractedInfo?.explicitLines?.length > 0) {
        return await this.buildFromLines(intentResult);
      }
    }

    // 【優先2】地域検索が不要な場合（明示的な地域指定がある場合）
    if (!intentResult.needsAreaSearch && intentResult.extractedInfo?.explicitLocations?.length > 0) {
      return this.buildFromExplicitLocations(intentResult);
    }

    // 【優先3】ランドマークベースの検索
    if (intentResult.extractedInfo?.landmark) {
      return await this.searchNearbyAreas(intentResult);
    }

    // フォールバック
    return this.getDefaultRecommendations(intentResult);
  }

  /**
   * ランドマーク周辺エリアを検索
   */
  async searchNearbyAreas(intentResult) {
    const landmark = intentResult.extractedInfo.landmark;
    const prefecture = intentResult.extractedInfo.prefecture;
    const keyword = intentResult.areaSearchKeyword;

    // キャッシュから町丁目リストを取得
    let cacheInfo = '';
    if (prefecture) {
      const locationSummary = await reinsCache.generateLocationSummaryForAI(prefecture);
      const lineSummary = await reinsCache.generateLineSummaryForAI(prefecture);

      const stats = await reinsCache.getStats();
      if (stats.location.towns > 0 || stats.line.stations > 0) {
        cacheInfo = `
【REINSキャッシュ情報】
以下はREINSシステムで実際に選択可能なオプションです。推薦する際は可能な限りこのリストから選んでください。

${locationSummary}

${lineSummary}

※キャッシュにない町丁目も提案可能ですが、REINSで選択できない可能性があります。
`;
        this.log('Using cached REINS data', {
          towns: stats.location.towns,
          stations: stats.line.stations
        });
      }
    }

    const systemPrompt = this.getSystemPrompt() + cacheInfo;
    const userPrompt = `「${landmark}」${prefecture ? `（${prefecture}）` : ''}の周辺で物件を探したいです。
${keyword ? `検索キーワード: ${keyword}` : ''}

この施設の周辺にある具体的な「町丁目」と、最寄りの沿線・駅を教えてください。
町丁目レベルで近い順に提案してください。
${cacheInfo ? '可能な限りキャッシュリストにある町丁目を優先してください。' : ''}`;

    try {
      const response = await this.callAI([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      const parsed = this.parseJSON(response);
      if (!parsed) {
        return this.getDefaultRecommendations(intentResult);
      }

      this.log('Location recommendations generated', {
        count: parsed.recommendations?.length || 0
      });

      return this.normalizeRecommendations(parsed, intentResult);
    } catch (error) {
      this.logError('Nearby area search failed', error);
      return this.getDefaultRecommendations(intentResult);
    }
  }

  /**
   * 明示的な地域指定から推薦リストを構築
   */
  buildFromExplicitLocations(intentResult) {
    const locations = intentResult.extractedInfo.explicitLocations;
    const prefecture = intentResult.extractedInfo.prefecture || '東京都';

    const recommendations = locations.map((city, index) => ({
      id: index + 1,
      type: 'location',
      prefecture: prefecture,
      city: city,
      town: null,
      distance: null,
      score: 0.9 - (index * 0.05),
      reason: 'ユーザー指定エリア',
      features: []
    }));

    return {
      centerPoint: null,
      recommendations: recommendations,
      searchStrategy: recommendations.length > 3 ? 'parallel' : 'sequential',
      totalOptions: recommendations.length,
      source: 'explicit'
    };
  }

  /**
   * 駅指定から推薦リストを構築
   * データベースを使用して駅が属する路線を正確に特定
   */
  async buildFromStations(intentResult) {
    const stations = intentResult.extractedInfo.explicitStations;
    const lines = intentResult.extractedInfo.explicitLines;
    const prefecture = intentResult.extractedInfo.prefecture || '東京都';

    this.log('Building from stations with DB lookup', {
      stations,
      lines,
      prefecture
    });

    const recommendations = [];

    for (let index = 0; index < stations.length; index++) {
      const station = stations[index];

      // データベースで駅が属する路線を検索
      let matchedLine = null;
      if (lines.length > 0) {
        matchedLine = await reinsCache.findLineForStation(prefecture, station, lines);
      }

      // 見つからない場合は最初の路線をフォールバックとして使用
      const finalLine = matchedLine || lines[0] || null;

      if (matchedLine) {
        this.log(`Station matched: ${station} → ${matchedLine}`);
      } else if (lines.length > 0) {
        this.log(`Station not found in DB, using fallback: ${station} → ${finalLine}`);
      }

      recommendations.push({
        id: index + 1,
        type: 'line',
        prefecture: prefecture,
        city: null,
        line: finalLine,
        station: station,
        walkMinutes: 10,
        score: 0.9 - (index * 0.02),
        reason: matchedLine ? `${matchedLine}の駅` : 'ユーザー指定駅',
        features: []
      });
    }

    return {
      centerPoint: null,
      recommendations: recommendations,
      searchStrategy: recommendations.length > 3 ? 'parallel' : 'sequential',
      totalOptions: recommendations.length,
      source: 'explicit_stations'
    };
  }

  /**
   * 路線指定から推薦リストを構築（駅指定がない場合）
   */
  async buildFromLines(intentResult) {
    const lines = intentResult.extractedInfo.explicitLines || [];
    const prefecture = intentResult.extractedInfo.prefecture || '東京都';
    const stations = intentResult.extractedInfo.explicitStations || [];

    this.log('Building from lines', { lines, prefecture, stations });

    const recommendations = [];
    let id = 1;

    for (const lineName of lines) {
      // 【優先1】ユーザー指定の駅がある場合はそれを使用
      if (stations.length > 0) {
        for (const stationName of stations) {
          recommendations.push({
            id: id++,
            type: 'line',
            prefecture: prefecture,
            city: null,
            line: lineName,
            station: stationName,
            walkMinutes: 10,
            score: 0.9,
            reason: 'ユーザー指定駅',
            features: []
          });
        }
      } else {
        // 【優先2】ユーザー指定がない場合、キャッシュから取得
        const cachedStations = await reinsCache.getStations(prefecture, lineName);

        if (cachedStations && cachedStations.length > 0) {
          // キャッシュから最大5駅まで追加
          const stationsToAdd = cachedStations.slice(0, 5);
          for (const stationName of stationsToAdd) {
            recommendations.push({
              id: id++,
              type: 'line',
              prefecture: prefecture,
              city: null,
              line: lineName,
              station: stationName,
              walkMinutes: 10,
              score: 0.85,
              reason: `${lineName}の駅`,
              features: []
            });
          }
        } else {
          // キャッシュも駅指定もない場合、路線名のみで1件追加
          recommendations.push({
            id: id++,
            type: 'line',
            prefecture: prefecture,
            city: null,
            line: lineName,
            station: null,  // 駅未指定
            walkMinutes: 10,
            score: 0.8,
            reason: 'ユーザー指定路線',
            features: []
          });
        }
      }
    }

    this.log('Built line recommendations', { count: recommendations.length });

    return {
      centerPoint: null,
      recommendations: recommendations,
      searchStrategy: recommendations.length > 3 ? 'parallel' : 'sequential',
      totalOptions: recommendations.length,
      source: 'explicit_lines'
    };
  }

  /**
   * 推薦結果を正規化
   */
  normalizeRecommendations(parsed, intentResult) {
    const recommendations = (parsed.recommendations || []).map((rec, index) => {
      if (rec.type === 'location') {
        return {
          id: rec.id || index + 1,
          type: 'location',
          prefecture: rec.prefecture,
          city: rec.city,
          town: rec.town || null,
          distance: rec.distance || null,
          score: rec.score || 0.5,
          reason: rec.reason || '',
          avgRent: rec.avgRent || null,
          features: rec.features || []
        };
      } else {
        return {
          id: rec.id || index + 1,
          type: 'line',
          prefecture: rec.prefecture || parsed.centerPoint?.prefecture || null,
          city: rec.city || parsed.centerPoint?.city || null,
          line: rec.line,
          station: rec.station,
          walkMinutes: rec.walkMinutes || 10,
          score: rec.score || 0.5,
          reason: rec.reason || '',
          features: rec.features || []
        };
      }
    });

    return {
      centerPoint: parsed.centerPoint || null,
      recommendations: recommendations.slice(0, 25),  // 最大25件まで許可
      searchStrategy: parsed.searchStrategy || 'parallel',
      totalOptions: recommendations.length,
      source: 'ai_generated'
    };
  }

  /**
   * デフォルトの推薦（フォールバック）
   */
  getDefaultRecommendations(intentResult) {
    this.log('Using default recommendations');

    return {
      centerPoint: null,
      recommendations: [],
      searchStrategy: 'sequential',
      totalOptions: 0,
      source: 'fallback',
      error: 'No specific location information available'
    };
  }
}

module.exports = new LocationAgent();
