# 多 Agent 系统设计文档

## 当前架构分析

### 现有代码结构
```
services/
├── aiRequirementsParser.js   # 单一 AI Agent（包含所有功能）
├── locationResolver.js       # 位置解析服务
├── requirementsParser.js     # 规则解析器（非 AI）
├── areaMapping.js            # 地区映射数据
├── lineMapping.js            # 沿线映射数据
└── reinsService.js           # REINS 操作服务
```

### 当前单一 Agent 的问题
1. **职责过重** - 一个 Agent 承担了搜索类型判断、地区推荐、表单映射等多个任务
2. **难以优化** - 每个功能的 prompt 混合在一起，难以针对性优化
3. **缺乏专业化** - 无法针对特定任务选择最合适的模型或参数
4. **扩展性差** - 添加新功能需要修改整个 Agent

---

## 多 Agent 架构设计

### 架构图
```
┌─────────────────────────────────────────────────────────────────────┐
│                         Orchestrator (协调器)                        │
│                    统一管理所有 Agent 的调用流程                       │
└─────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│  Intent Agent │         │ Location Agent│         │  Form Agent   │
│   意图理解     │ ──────▶ │   地区推荐     │ ──────▶ │   表单映射     │
└───────────────┘         └───────────────┘         └───────────────┘
        │                           │                           │
        ▼                           ▼                           ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│ Dialog Agent  │         │ Response Agent│         │ Review Agent  │
│   对话管理     │         │   回复生成     │         │   质量审核     │
└───────────────┘         └───────────────┘         └───────────────┘
```

---

## Agent 详细设计

### 1. Intent Agent（意图理解 Agent）
**职责**: 理解用户自然语言输入，提取核心需求

**输入**:
- 用户原始输入文本
- 担当者评价/备注（可选）
- 对话历史（可选）

**输出**:
```json
{
  "intent": "property_search | question | clarification | feedback",
  "searchType": "location | line | bus | other",
  "confidence": 0.95,
  "extractedInfo": {
    "landmark": "东京工业大学大岡山キャンパス",
    "landmarkType": "university",
    "budgetMax": 150000,
    "budgetMin": null,
    "roomType": "1K-1LDK",
    "mustHave": ["オートロック", "バストイレ別"],
    "niceToHave": ["南向き", "2階以上"],
    "explicitLocations": [],
    "explicitStations": ["大岡山駅"]
  },
  "missingInfo": ["予算下限", "入居時期"],
  "userPersona": "student | family | single_worker | elderly"
}
```

**模型选择**: `gpt-4o-mini`（快速、低成本）
**温度**: 0.1（稳定输出）

---

### 2. Location Agent（地区推荐 Agent）
**职责**: 根据用户条件推荐合适的搜索地区

**输入**:
- Intent Agent 的输出
- 地理知识库

**输出**:
```json
{
  "centerPoint": {
    "name": "东京工业大学大岡山キャンパス",
    "address": "東京都目黒区大岡山2-12-1",
    "coordinates": { "lat": 35.6067, "lng": 139.6869 }
  },
  "recommendations": [
    {
      "id": 1,
      "type": "location",
      "prefecture": "東京都",
      "city": "目黒区",
      "town": "大岡山",
      "distance": "徒歩5分",
      "score": 0.95,
      "reason": "キャンパス所在地、通学最便利"
    },
    {
      "id": 2,
      "type": "location",
      "prefecture": "東京都",
      "city": "目黒区",
      "town": "緑が丘",
      "distance": "徒歩10分",
      "score": 0.88,
      "reason": "閑静な住宅街、スーパー多い"
    },
    {
      "id": 3,
      "type": "line",
      "line": "東急大井町線",
      "station": "大岡山駅",
      "walkMinutes": 5,
      "score": 0.85,
      "reason": "2路線利用可能、渋谷へのアクセス良好"
    }
  ],
  "searchStrategy": "parallel | sequential",
  "maxResults": 10
}
```

**模型选择**: `gpt-4o`（需要丰富的地理知识）
**温度**: 0.3（允许一定创造性）

---

### 3. Form Agent（表单映射 Agent）
**职责**: 将解析后的需求映射到 REINS 表单字段

**输入**:
- Intent Agent 的 extractedInfo
- Location Agent 的 recommendations
- REINS 表单结构 JSON

**输出**:
```json
{
  "formFields": {
    "textInputs": {
      "__BVID__321": "東京都",
      "__BVID__325": "目黒区",
      "__BVID__452": "10",
      "__BVID__454": "15"
    },
    "selects": {
      "__BVID__289": "03",
      "__BVID__521": "5"
    },
    "checkboxes": {
      "__BVID__505": true
    }
  },
  "searchOptions": [
    {
      "id": 1,
      "description": "目黒区 大岡山で所在地検索",
      "fields": { ... }
    }
  ],
  "warnings": ["家賃上限が相場より低い可能性があります"],
  "suggestions": ["2DK以上も検討されてはいかがでしょうか"]
}
```

**模型选择**: `gpt-4o-mini`（结构化任务）
**温度**: 0.0（确定性输出）

---

### 4. Dialog Agent（对话管理 Agent）
**职责**: 管理多轮对话，追问缺失信息

**输入**:
- 当前对话历史
- 缺失信息列表
- 用户上下文

**输出**:
```json
{
  "needsFollowUp": true,
  "followUpType": "clarification | confirmation | suggestion",
  "questions": [
    {
      "field": "budget",
      "question": "ご予算の上限はいくらぐらいをお考えですか？",
      "options": ["10万円以内", "10-15万円", "15-20万円", "20万円以上"],
      "required": true
    }
  ],
  "contextSummary": "大岡山キャンパス周辺で1Kをお探しですね。",
  "nextStep": "wait_for_response | proceed_to_search"
}
```

**模型选择**: `gpt-4o`（需要理解语境）
**温度**: 0.5（自然对话）

---

### 5. Response Agent（回复生成 Agent）
**职责**: 生成面向用户的自然语言回复

**输入**:
- 搜索结果
- 用户偏好
- 对话上下文

**输出**:
```json
{
  "summary": "大岡山周辺で5件の物件が見つかりました。",
  "highlights": [
    "家賃10万円台の物件が3件あります",
    "オートロック付きが4件あります"
  ],
  "recommendations": "特に物件ID: R123456は駅徒歩3分でおすすめです。",
  "nextActions": [
    "詳細を見る",
    "条件を変更する",
    "別のエリアを探す"
  ]
}
```

**模型选择**: `gpt-4o`（自然语言生成）
**温度**: 0.7（创造性回复）

---

### 6. Review Agent（质量审核 Agent）
**职责**: 审核其他 Agent 的输出质量

**输入**:
- 各 Agent 的输出
- 质量标准

**输出**:
```json
{
  "overallQuality": 0.92,
  "issues": [
    {
      "agent": "LocationAgent",
      "issue": "推荐地区超出了用户预算范围",
      "severity": "warning",
      "suggestion": "过滤掉平均房租超过15万的地区"
    }
  ],
  "approved": true,
  "corrections": []
}
```

**模型选择**: `gpt-4o-mini`
**温度**: 0.0

---

## Orchestrator（协调器）设计

### 工作流程
```javascript
class AgentOrchestrator {
  async processRequest(userInput, context) {
    // Step 1: 意图理解
    const intent = await this.intentAgent.analyze(userInput, context);

    // Step 2: 检查是否需要追问
    if (intent.missingInfo.length > 0 && intent.confidence < 0.7) {
      const dialog = await this.dialogAgent.generateFollowUp(intent);
      return { type: 'followUp', data: dialog };
    }

    // Step 3: 地区推荐
    const locations = await this.locationAgent.recommend(intent);

    // Step 4: 表单映射
    const formData = await this.formAgent.mapToReins(intent, locations);

    // Step 5: 质量审核
    const review = await this.reviewAgent.check({
      intent, locations, formData
    });

    if (!review.approved) {
      // 根据审核意见调整
      return await this.handleCorrections(review.corrections);
    }

    // Step 6: 执行搜索
    const results = await this.reinsService.search(formData);

    // Step 7: 生成回复
    const response = await this.responseAgent.generate(results, context);

    return { type: 'results', data: response };
  }
}
```

---

## 实现计划

### Phase 1: 基础架构（1周）
- [ ] 创建 Agent 基类和接口定义
- [ ] 实现 Orchestrator 协调器
- [ ] 设置 Agent 配置系统

### Phase 2: 核心 Agent（2周）
- [ ] 实现 Intent Agent（从现有代码重构）
- [ ] 实现 Location Agent（从现有代码重构）
- [ ] 实现 Form Agent（从现有代码重构）

### Phase 3: 辅助 Agent（1周）
- [ ] 实现 Dialog Agent
- [ ] 实现 Response Agent
- [ ] 实现 Review Agent

### Phase 4: 集成测试（1周）
- [ ] 端到端测试
- [ ] 性能优化
- [ ] 错误处理

---

## 文件结构

```
services/
├── agents/
│   ├── base/
│   │   ├── BaseAgent.js          # Agent 基类
│   │   └── AgentConfig.js        # Agent 配置
│   ├── IntentAgent.js            # 意图理解
│   ├── LocationAgent.js          # 地区推荐
│   ├── FormAgent.js              # 表单映射
│   ├── DialogAgent.js            # 对话管理
│   ├── ResponseAgent.js          # 回复生成
│   └── ReviewAgent.js            # 质量审核
├── orchestrator/
│   ├── AgentOrchestrator.js      # 主协调器
│   ├── WorkflowManager.js        # 工作流管理
│   └── ContextManager.js         # 上下文管理
├── prompts/
│   ├── intent.prompt.js          # Intent Agent 提示词
│   ├── location.prompt.js        # Location Agent 提示词
│   ├── form.prompt.js            # Form Agent 提示词
│   ├── dialog.prompt.js          # Dialog Agent 提示词
│   ├── response.prompt.js        # Response Agent 提示词
│   └── review.prompt.js          # Review Agent 提示词
└── utils/
    ├── AgentLogger.js            # Agent 日志
    └── AgentMetrics.js           # Agent 指标
```

---

## Agent 通信协议

### 消息格式
```typescript
interface AgentMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  timestamp: number;
  type: 'request' | 'response' | 'error';
  payload: any;
  metadata: {
    requestId: string;
    traceId: string;
    priority: 'high' | 'normal' | 'low';
  };
}
```

### 错误处理
```typescript
interface AgentError {
  code: string;
  message: string;
  agent: string;
  recoverable: boolean;
  fallbackAction?: string;
}
```

---

## 性能考虑

### 并行执行
- Intent Agent 完成后，Location Agent 和 Dialog Agent 可并行执行
- Review Agent 可异步执行，不阻塞主流程

### 缓存策略
- Location Agent 结果缓存（地理信息变化不频繁）
- Form Agent 的表单结构缓存
- Intent 模式识别结果缓存

### 成本优化
- 简单任务使用 `gpt-4o-mini`
- 复杂推理使用 `gpt-4o`
- 高频调用考虑使用 `gpt-3.5-turbo`

---

## 监控和日志

### 每个 Agent 记录
- 输入/输出
- 执行时间
- Token 使用量
- 错误信息

### 整体监控
- 请求成功率
- 平均响应时间
- Agent 调用链路追踪
