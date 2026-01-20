/**
 * AgentOrchestrator - Agent 协调器
 * 统一管理所有 Agent 的调用流程
 */

const IntentAgent = require('../agents/IntentAgent');
const LocationAgent = require('../agents/LocationAgent');
const FormAgent = require('../agents/FormAgent');

class AgentOrchestrator {
  constructor() {
    this.agents = {
      intent: IntentAgent,
      location: LocationAgent,
      form: FormAgent
    };

    this.metrics = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalTime: 0
    };
  }

  /**
   * 主要的请求处理入口
   */
  async processRequest(userInput, context = {}) {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    console.log('\n' + '='.repeat(60));
    console.log('[Orchestrator] Processing request...');
    console.log('='.repeat(60));

    try {
      // ============================================
      // Step 1: 意图理解
      // ============================================
      console.log('\n[Step 1] Intent Analysis');
      console.log('-'.repeat(40));

      const intentResult = await this.agents.intent.process(userInput, context);

      if (!intentResult || intentResult.confidence === 0) {
        return this.handleError('Intent analysis failed', context);
      }

      console.log(`  Search Type: ${intentResult.searchType}`);
      console.log(`  Confidence: ${intentResult.confidence}`);
      console.log(`  Missing Info: ${intentResult.missingInfo.join(', ') || 'None'}`);

      // 检查是否需要追问
      if (this.needsFollowUp(intentResult)) {
        return {
          type: 'followUp',
          intent: intentResult,
          questions: this.generateFollowUpQuestions(intentResult)
        };
      }

      // ============================================
      // Step 2: 地区推荐
      // ============================================
      console.log('\n[Step 2] Location Recommendation');
      console.log('-'.repeat(40));

      const locationResult = await this.agents.location.process(intentResult, context);

      console.log(`  Recommendations: ${locationResult.recommendations?.length || 0}`);
      console.log(`  Strategy: ${locationResult.searchStrategy}`);

      if (locationResult.recommendations?.length === 0 && !intentResult.extractedInfo.explicitLocations?.length) {
        return {
          type: 'noLocation',
          intent: intentResult,
          message: 'エリアを特定できませんでした。具体的な地域や駅を教えてください。'
        };
      }

      // ============================================
      // Step 3: 表单映射
      // ============================================
      console.log('\n[Step 3] Form Mapping');
      console.log('-'.repeat(40));

      const formResult = await this.agents.form.process(intentResult, locationResult, context);

      console.log(`  Search Options: ${formResult.searchOptions?.length || 0}`);
      console.log(`  Warnings: ${formResult.warnings?.length || 0}`);

      // ============================================
      // 结果汇总
      // ============================================
      const endTime = Date.now();
      const duration = endTime - startTime;
      this.metrics.successRequests++;
      this.metrics.totalTime += duration;

      console.log('\n' + '='.repeat(60));
      console.log(`[Orchestrator] Request completed in ${duration}ms`);
      console.log('='.repeat(60) + '\n');

      return {
        type: 'searchReady',
        intent: intentResult,
        locations: locationResult,
        form: formResult,
        searchOptions: this.buildSearchOptions(formResult, locationResult),
        duration: duration
      };

    } catch (error) {
      this.metrics.failedRequests++;
      console.error('[Orchestrator] Error:', error.message);
      return this.handleError(error.message, context);
    }
  }

  /**
   * 判断是否需要追问
   */
  needsFollowUp(intentResult) {
    // 信心度太低
    if (intentResult.confidence < 0.5) {
      return true;
    }

    // 缺少关键信息（位置和预算都没有）
    const hasLocation = intentResult.extractedInfo.explicitLocations?.length > 0 ||
                       intentResult.extractedInfo.landmark ||
                       intentResult.extractedInfo.explicitStations?.length > 0;
    const hasBudget = intentResult.extractedInfo.budgetMax || intentResult.extractedInfo.budgetMin;

    if (!hasLocation && !hasBudget) {
      return true;
    }

    return false;
  }

  /**
   * 生成追问问题
   */
  generateFollowUpQuestions(intentResult) {
    const questions = [];

    const hasLocation = intentResult.extractedInfo.explicitLocations?.length > 0 ||
                       intentResult.extractedInfo.landmark ||
                       intentResult.extractedInfo.explicitStations?.length > 0;

    if (!hasLocation) {
      questions.push({
        field: 'location',
        question: 'どのエリアで探されていますか？区・市名、駅名、または施設名（大学など）を教えてください。',
        required: true
      });
    }

    if (!intentResult.extractedInfo.budgetMax) {
      questions.push({
        field: 'budget',
        question: 'ご予算（賃料の上限）はいくらぐらいをお考えですか？',
        options: ['8万円以内', '10万円以内', '15万円以内', '20万円以内', '特に上限なし'],
        required: false
      });
    }

    return questions;
  }

  /**
   * 构建最终的搜索选项
   */
  buildSearchOptions(formResult, locationResult) {
    const options = formResult.searchOptions || [];

    return options.map(opt => ({
      id: opt.id,
      description: opt.description,
      searchMethod: opt.searchMethod,
      prefecture: opt.formFields?.textInputs?.['__BVID__321'],
      city: opt.formFields?.textInputs?.['__BVID__325'],
      town: opt.town || null,
      detail: opt.detail || opt.town || null,
      line: opt.formFields?.textInputs?.['__BVID__372'],
      station: opt.formFields?.textInputs?.['__BVID__376'],
      walkMinutes: opt.formFields?.textInputs?.['__BVID__381'],
      formFields: opt.formFields,
      commonFields: formResult.commonFields
    }));
  }

  /**
   * 错误处理
   */
  handleError(message, context) {
    return {
      type: 'error',
      message: message,
      suggestions: [
        '検索条件を具体的に教えてください',
        '例：「目黒区で家賃10万円以下の1K」'
      ]
    };
  }

  /**
   * 获取所有 Agent 的性能指标
   */
  getMetrics() {
    return {
      orchestrator: {
        ...this.metrics,
        successRate: this.metrics.totalRequests > 0
          ? (this.metrics.successRequests / this.metrics.totalRequests * 100).toFixed(2) + '%'
          : 'N/A',
        avgTime: this.metrics.successRequests > 0
          ? Math.round(this.metrics.totalTime / this.metrics.successRequests) + 'ms'
          : 'N/A'
      },
      agents: {
        intent: this.agents.intent.getMetrics(),
        location: this.agents.location.getMetrics(),
        form: this.agents.form.getMetrics()
      }
    };
  }

  /**
   * 重置所有指标
   */
  resetMetrics() {
    this.metrics = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalTime: 0
    };
    Object.values(this.agents).forEach(agent => agent.resetMetrics());
  }
}

module.exports = new AgentOrchestrator();
