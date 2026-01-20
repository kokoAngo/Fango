/**
 * BaseAgent - 所有 AI Agent 的基类
 * 提供通用的初始化、调用、日志和错误处理功能
 */

const OpenAI = require('openai');

class BaseAgent {
  constructor(config = {}) {
    this.name = config.name || 'BaseAgent';
    this.model = config.model || 'gpt-4o-mini';
    this.temperature = config.temperature ?? 0.1;
    this.maxTokens = config.maxTokens || 1000;
    this.client = null;
    this.metrics = {
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      totalTime: 0
    };
  }

  /**
   * 初始化 OpenAI 客户端
   */
  initClient() {
    if (!this.client && process.env.OPENAI_API_KEY) {
      this.client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY
      });
    }
    return this.client;
  }

  /**
   * 获取系统提示词 - 子类需要重写
   */
  getSystemPrompt(context = {}) {
    throw new Error('Subclass must implement getSystemPrompt()');
  }

  /**
   * 处理输入 - 子类需要重写
   */
  async process(input, context = {}) {
    throw new Error('Subclass must implement process()');
  }

  /**
   * 调用 AI API
   */
  async callAI(messages, options = {}) {
    const client = this.initClient();
    if (!client) {
      throw new Error(`[${this.name}] OpenAI API key not configured`);
    }

    const startTime = Date.now();
    this.metrics.totalCalls++;

    try {
      this.log('Calling AI...', { model: this.model, messageCount: messages.length });

      const response = await client.chat.completions.create({
        model: options.model || this.model,
        max_tokens: options.maxTokens || this.maxTokens,
        temperature: options.temperature ?? this.temperature,
        messages: messages
      });

      const endTime = Date.now();
      const duration = endTime - startTime;

      // 更新指标
      this.metrics.successCalls++;
      this.metrics.totalTime += duration;
      if (response.usage) {
        this.metrics.totalTokens += response.usage.total_tokens;
      }

      this.log(`AI response received`, {
        duration: `${duration}ms`,
        tokens: response.usage?.total_tokens
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      this.metrics.failedCalls++;
      this.logError('AI call failed', error);
      throw error;
    }
  }

  /**
   * 解析 JSON 响应
   */
  parseJSON(content) {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return null;
    } catch (error) {
      this.logError('JSON parse failed', error);
      return null;
    }
  }

  /**
   * 日志输出
   */
  log(message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${this.name}]`;
    if (data) {
      console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2));
    } else {
      console.log(`${prefix} ${message}`);
    }
  }

  /**
   * 错误日志
   */
  logError(message, error) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${this.name}] ERROR: ${message}`, error.message);
  }

  /**
   * 获取性能指标
   */
  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.totalCalls > 0
        ? (this.metrics.successCalls / this.metrics.totalCalls * 100).toFixed(2) + '%'
        : 'N/A',
      avgTime: this.metrics.successCalls > 0
        ? Math.round(this.metrics.totalTime / this.metrics.successCalls) + 'ms'
        : 'N/A',
      avgTokens: this.metrics.successCalls > 0
        ? Math.round(this.metrics.totalTokens / this.metrics.successCalls)
        : 'N/A'
    };
  }

  /**
   * 重置指标
   */
  resetMetrics() {
    this.metrics = {
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      totalTokens: 0,
      totalTime: 0
    };
  }
}

module.exports = BaseAgent;
