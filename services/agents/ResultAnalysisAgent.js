/**
 * ResultAnalysisAgent - 搜索结果分析 Agent
 * 分析下载的 PDF 结果，与用户需求和 AI 推荐进行对比，生成符合度报告
 */

const BaseAgent = require('./base/BaseAgent');
const fs = require('fs');
const path = require('path');

// pdf.js-extract のインポート
const PDFExtract = require('pdf.js-extract').PDFExtract;
const pdfExtract = new PDFExtract();

class ResultAnalysisAgent extends BaseAgent {
  constructor() {
    super({
      name: 'ResultAnalysisAgent',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 2000
    });
  }

  /**
   * 获取系统提示词
   */
  getSystemPrompt() {
    return `あなたは不動産検索結果を分析する専門エージェントです。
検索結果のPDFから抽出した物件情報を、ユーザーの希望条件と比較分析してください。

【分析の観点】
1. 条件適合度: 各物件がユーザー条件をどの程度満たしているか
2. 推奨物件: 最も条件に合う物件TOP3
3. 条件外物件: なぜ条件に合わない物件が含まれているか
4. 検索改善提案: より良い結果を得るための検索条件の調整案

【出力形式】以下のJSON形式で回答（説明不要、JSONのみ）:
{
  "summary": {
    "totalProperties": 件数,
    "matchingCount": 条件に合致する物件数,
    "partialMatchCount": 部分的に合致する物件数,
    "mismatchCount": 条件に合わない物件数,
    "overallMatchRate": "XX%"
  },
  "topRecommendations": [
    {
      "rank": 1,
      "propertyName": "物件名",
      "address": "所在地",
      "rent": "賃料",
      "layout": "間取り",
      "area": "面積",
      "matchScore": 0.95,
      "matchedConditions": ["条件1", "条件2"],
      "unmatchedConditions": ["条件3"],
      "recommendation": "推薦理由"
    }
  ],
  "issues": [
    {
      "type": "location_mismatch/rent_over/area_under/missing_equipment",
      "description": "問題の説明",
      "affectedCount": 件数,
      "suggestion": "改善提案"
    }
  ],
  "searchImprovements": [
    {
      "aspect": "改善点",
      "currentSetting": "現在の設定",
      "suggestedSetting": "推奨設定",
      "reason": "理由"
    }
  ],
  "conclusion": "総合評価（2-3文）"
}`;
  }

  /**
   * PDF からテキストを抽出
   */
  async extractPdfText(pdfPath) {
    try {
      if (!fs.existsSync(pdfPath)) {
        this.log(`PDF not found: ${pdfPath}`);
        return null;
      }

      const data = await pdfExtract.extract(pdfPath, {});

      // ページごとのテキストを結合
      let fullText = '';
      for (const page of data.pages) {
        const pageText = page.content
          .map(item => item.str)
          .join(' ');
        fullText += pageText + '\n';
      }

      this.log(`PDF extracted: ${data.pages.length} pages, ${fullText.length} chars`);
      return fullText;
    } catch (error) {
      this.logError('PDF extraction failed', error);
      return null;
    }
  }

  /**
   * PDF テキストから物件情報を抽出
   */
  parsePropertyInfo(pdfText) {
    if (!pdfText) return [];

    const properties = [];

    // REINS PDF の一般的なパターンで物件を分割
    // 物件は通常「物件番号」や「所在地」で始まる
    const lines = pdfText.split('\n').filter(line => line.trim());

    let currentProperty = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // 賃料パターン
      const rentMatch = trimmed.match(/(\d+(?:,\d+)?(?:\.\d+)?)\s*万円/);
      if (rentMatch && currentProperty) {
        currentProperty.rent = parseFloat(rentMatch[1].replace(',', ''));
      }

      // 面積パターン
      const areaMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*[㎡m²]/);
      if (areaMatch && currentProperty) {
        currentProperty.area = parseFloat(areaMatch[1]);
      }

      // 間取りパターン
      const layoutMatch = trimmed.match(/([1-9][SLDK]+|ワンルーム)/);
      if (layoutMatch && currentProperty) {
        currentProperty.layout = layoutMatch[1];
      }

      // 所在地パターン（都道府県から始まる）
      const addressMatch = trimmed.match(/(東京都|北海道|(?:京都|大阪)府|.{2,3}県).+/);
      if (addressMatch) {
        if (currentProperty && currentProperty.address) {
          properties.push(currentProperty);
        }
        currentProperty = {
          address: addressMatch[0].substring(0, 50),
          rent: null,
          area: null,
          layout: null,
          walkMinutes: null,
          features: []
        };
      }

      // 徒歩分数
      const walkMatch = trimmed.match(/徒歩\s*(\d+)\s*分/);
      if (walkMatch && currentProperty) {
        currentProperty.walkMinutes = parseInt(walkMatch[1]);
      }

      // 設備キーワード
      const equipmentKeywords = ['オートロック', 'エアコン', '宅配BOX', 'バストイレ別', '独立洗面', '2口コンロ', 'ペット可', '駐車場'];
      for (const keyword of equipmentKeywords) {
        if (trimmed.includes(keyword) && currentProperty) {
          if (!currentProperty.features.includes(keyword)) {
            currentProperty.features.push(keyword);
          }
        }
      }
    }

    // 最後の物件を追加
    if (currentProperty && currentProperty.address) {
      properties.push(currentProperty);
    }

    this.log(`Parsed ${properties.length} properties from PDF`);
    return properties;
  }

  /**
   * メイン処理: 結果を分析してレポートを生成
   */
  async process(input) {
    const { pdfPath, userRequirements, aiRecommendations, searchOptions } = input;

    this.log('Starting result analysis...', {
      pdfPath,
      hasUserReq: !!userRequirements,
      hasAiRec: !!aiRecommendations
    });

    // 1. PDF からテキスト抽出
    let pdfText = '';
    let properties = [];

    if (pdfPath && fs.existsSync(pdfPath)) {
      pdfText = await this.extractPdfText(pdfPath);
      properties = this.parsePropertyInfo(pdfText);
    }

    // 2. AI に分析を依頼
    const analysisPrompt = this.buildAnalysisPrompt(
      properties,
      userRequirements,
      aiRecommendations,
      searchOptions,
      pdfText
    );

    const messages = [
      { role: 'system', content: this.getSystemPrompt() },
      { role: 'user', content: analysisPrompt }
    ];

    try {
      const response = await this.callAI(messages);
      const analysis = this.parseJSON(response);

      if (analysis) {
        return {
          success: true,
          analysis,
          extractedProperties: properties,
          rawPdfText: pdfText?.substring(0, 1000) + '...' // 先頭1000文字のみ
        };
      }

      return {
        success: false,
        error: 'Failed to parse AI response',
        rawResponse: response
      };
    } catch (error) {
      this.logError('Analysis failed', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 分析プロンプトを構築
   */
  buildAnalysisPrompt(properties, userRequirements, aiRecommendations, searchOptions, pdfText) {
    let prompt = '【検索結果分析依頼】\n\n';

    // ユーザー要件
    prompt += '■ ユーザーの希望条件:\n';
    if (userRequirements) {
      if (typeof userRequirements === 'string') {
        prompt += userRequirements + '\n';
      } else {
        prompt += JSON.stringify(userRequirements, null, 2) + '\n';
      }
    } else {
      prompt += '(指定なし)\n';
    }
    prompt += '\n';

    // AI 推奨
    if (aiRecommendations) {
      prompt += '■ AIが推奨した検索条件:\n';
      prompt += JSON.stringify(aiRecommendations, null, 2) + '\n\n';
    }

    // 検索オプション
    if (searchOptions) {
      prompt += '■ 実際に使用した検索オプション:\n';
      const optionsSummary = searchOptions.map(opt => ({
        description: opt.description,
        searchMethod: opt.searchMethod,
        prefecture: opt.prefecture,
        city: opt.city,
        line: opt.line,
        station: opt.station
      }));
      prompt += JSON.stringify(optionsSummary, null, 2) + '\n\n';
    }

    // 抽出した物件情報
    prompt += '■ PDFから抽出した物件情報:\n';
    if (properties.length > 0) {
      prompt += `合計 ${properties.length} 件の物件を検出\n`;
      properties.slice(0, 20).forEach((prop, i) => {
        prompt += `\n[物件${i + 1}]\n`;
        prompt += `  所在地: ${prop.address || '不明'}\n`;
        prompt += `  賃料: ${prop.rent ? prop.rent + '万円' : '不明'}\n`;
        prompt += `  面積: ${prop.area ? prop.area + '㎡' : '不明'}\n`;
        prompt += `  間取り: ${prop.layout || '不明'}\n`;
        prompt += `  徒歩: ${prop.walkMinutes ? prop.walkMinutes + '分' : '不明'}\n`;
        prompt += `  設備: ${prop.features.length > 0 ? prop.features.join(', ') : 'なし'}\n`;
      });
      if (properties.length > 20) {
        prompt += `\n... 他 ${properties.length - 20} 件省略\n`;
      }
    } else {
      prompt += '物件情報を抽出できませんでした。\n';
      if (pdfText) {
        prompt += '\nPDFテキスト（先頭2000文字）:\n';
        prompt += pdfText.substring(0, 2000) + '\n';
      }
    }

    prompt += '\n上記の情報を分析し、指定のJSON形式でレポートを生成してください。';

    return prompt;
  }

  /**
   * 簡易レポートを生成（AI を使わない高速版）
   */
  generateQuickReport(properties, userRequirements) {
    const report = {
      timestamp: new Date().toISOString(),
      totalProperties: properties.length,
      summary: {
        rentRange: this.calcRange(properties.map(p => p.rent).filter(Boolean)),
        areaRange: this.calcRange(properties.map(p => p.area).filter(Boolean)),
        layouts: [...new Set(properties.map(p => p.layout).filter(Boolean))],
        avgWalkMinutes: this.calcAverage(properties.map(p => p.walkMinutes).filter(Boolean))
      },
      conditionCheck: []
    };

    // 条件チェック
    if (userRequirements) {
      if (userRequirements.budgetMax) {
        const overBudget = properties.filter(p => p.rent && p.rent > userRequirements.budgetMax / 10000);
        report.conditionCheck.push({
          condition: `賃料上限 ${userRequirements.budgetMax / 10000}万円`,
          passed: properties.length - overBudget.length,
          failed: overBudget.length
        });
      }

      if (userRequirements.areaMin) {
        const underArea = properties.filter(p => p.area && p.area < userRequirements.areaMin);
        report.conditionCheck.push({
          condition: `面積下限 ${userRequirements.areaMin}㎡`,
          passed: properties.length - underArea.length,
          failed: underArea.length
        });
      }
    }

    return report;
  }

  calcRange(values) {
    if (values.length === 0) return { min: null, max: null };
    return {
      min: Math.min(...values),
      max: Math.max(...values)
    };
  }

  calcAverage(values) {
    if (values.length === 0) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }
}

module.exports = ResultAnalysisAgent;
