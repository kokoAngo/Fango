/**
 * Multi-Agent Parser
 * 提供与 aiRequirementsParser 相同的接口，内部使用 AgentOrchestrator
 * 可以无缝替换现有的 AI 解析器
 */

const AgentOrchestrator = require('./orchestrator/AgentOrchestrator');
const ResultAdapter = require('./orchestrator/ResultAdapter');

class MultiAgentParser {
  constructor() {
    this.orchestrator = AgentOrchestrator;
    this.enabled = process.env.USE_MULTI_AGENT === 'true';
  }

  /**
   * 检查是否启用多 Agent 系统
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * 设置是否启用
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[MultiAgentParser] ${enabled ? 'Enabled' : 'Disabled'}`);
  }

  /**
   * 解析用户需求（与 aiRequirementsParser.parse 接口兼容）
   * @param {string} userInput - 用户输入
   * @param {object} context - 上下文（用于多轮对话）
   * @param {string} agentNotes - 中介评价/备注（可选）
   * @returns {object} - 解析结果（与旧格式兼容）
   */
  async parse(userInput, context = {}, agentNotes = '') {
    console.log('\n[MultiAgentParser] Processing request...');

    try {
      // 构建上下文
      const orchestratorContext = {
        ...context,
        agentNotes: agentNotes
      };

      // 调用 Orchestrator
      const result = await this.orchestrator.processRequest(userInput, orchestratorContext);

      // 转换为兼容格式
      const parsedRequirements = ResultAdapter.toParsedRequirements(result);

      if (!parsedRequirements) {
        console.log('[MultiAgentParser] Conversion failed');
        return null;
      }

      console.log('[MultiAgentParser] Parse completed');
      console.log(`  Type: ${result.type}`);
      console.log(`  SearchOptions: ${parsedRequirements.searchOptions?.length || 0}`);
      console.log(`  Duration: ${result.duration || 'N/A'}ms`);

      return parsedRequirements;
    } catch (error) {
      console.error('[MultiAgentParser] Error:', error.message);
      return null;
    }
  }

  /**
   * 将解析结果转换为 REINS 表单字段（与 aiRequirementsParser.toReinsFields 接口兼容）
   */
  toReinsFields(parsedRequirements) {
    return ResultAdapter.toReinsFields(parsedRequirements);
  }

  /**
   * 获取性能指标
   */
  getMetrics() {
    return this.orchestrator.getMetrics();
  }

  /**
   * 重置性能指标
   */
  resetMetrics() {
    this.orchestrator.resetMetrics();
  }
}

module.exports = new MultiAgentParser();
