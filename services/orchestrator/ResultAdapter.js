/**
 * ResultAdapter - 结果适配器
 * 将 AgentOrchestrator 的输出转换为与旧 aiRequirementsParser 兼容的格式
 */

class ResultAdapter {
  /**
   * 将 Orchestrator 结果转换为 parsedRequirements 格式
   * 保持与 aiRequirementsParser.parse() 输出的兼容性
   */
  static toParsedRequirements(orchestratorResult) {
    if (!orchestratorResult) {
      return null;
    }

    // 处理错误情况
    if (orchestratorResult.type === 'error') {
      return null;
    }

    // 处理需要追问的情况
    if (orchestratorResult.type === 'followUp') {
      return {
        needsMoreInfo: true,
        missingFields: orchestratorResult.intent?.missingInfo || [],
        suggestedQuestions: orchestratorResult.questions?.map(q => q.question) || [],
        partialResult: this.buildPartialResult(orchestratorResult.intent)
      };
    }

    // 处理没有位置信息的情况
    if (orchestratorResult.type === 'noLocation') {
      return {
        needsMoreInfo: true,
        missingFields: ['location'],
        suggestedQuestions: [orchestratorResult.message],
        partialResult: this.buildPartialResult(orchestratorResult.intent)
      };
    }

    // 处理正常的搜索结果
    if (orchestratorResult.type === 'searchReady') {
      const intent = orchestratorResult.intent;
      const locations = orchestratorResult.locations;
      const form = orchestratorResult.form;
      const searchOptions = orchestratorResult.searchOptions || [];

      // 从第一个 location 推荐中提取位置信息
      const firstLocation = locations?.recommendations?.find(r => r.type === 'location');
      const firstLine = locations?.recommendations?.find(r => r.type === 'line');

      // 构建 locations 数组
      const locationsArray = (locations?.recommendations || [])
        .filter(r => r.type === 'location')
        .map(r => ({
          prefecture: r.prefecture,
          city: r.city,
          town: r.town || null,
          detail: r.town || null
        }));

      // 提取 extractedInfo
      const info = intent?.extractedInfo || {};

      return {
        // 多轮对话支持
        needsMoreInfo: false,
        missingFields: [],
        suggestedQuestions: [],

        // 搜索选项（最多10个）
        searchOptions: searchOptions.map((opt, index) => ({
          id: opt.id || index + 1,
          description: opt.description,
          searchMethod: opt.searchMethod,
          prefecture: opt.prefecture,
          city: opt.city,
          town: opt.town || null,
          detail: opt.detail || opt.town || null,
          line: opt.line || null,
          station: opt.station || null,
          walkMinutes: opt.walkMinutes ? parseInt(opt.walkMinutes) : null
        })),

        // 搜索方法
        searchMethod: intent?.searchType || 'location',

        // 位置信息
        locations: locationsArray,
        prefecture: firstLocation?.prefecture || info.prefecture || null,
        cities: firstLocation ? [firstLocation.city] : [],

        // 沿线信息
        line: firstLine?.line || info.explicitLines?.[0] || null,
        station: firstLine?.station || info.explicitStations?.[0] || null,
        stationTo: null,
        walkMinutes: firstLine?.walkMinutes || null,

        // 賃料・面積
        rentMin: info.budgetMin ? Math.round(info.budgetMin / 10000) : null,
        rentMax: info.budgetMax ? Math.round(info.budgetMax / 10000) : null,
        areaMin: info.areaMin || null,
        areaMax: info.areaMax || null,

        // 物件条件
        floorMin: null,
        direction: null,
        propertyType: '03',  // デフォルト：賃貸マンション
        layouts: info.roomTypes || [],
        parking: info.parking || null,
        isNew: false,
        petAllowed: info.petAllowed || false,
        corner: false,

        // 設備・キーワード
        equipment: info.mustHave || [],
        keywords: this.buildKeywords(info),

        // 直接的なフォームフィールド
        formFields: form?.commonFields || null,

        // メタデータ（デバッグ用）
        _orchestratorResult: {
          type: orchestratorResult.type,
          duration: orchestratorResult.duration,
          confidence: intent?.confidence
        }
      };
    }

    return null;
  }

  /**
   * キーワード配列を構築
   * petAllowed を "ペット可" に変換して追加
   */
  static buildKeywords(info) {
    const keywords = [...(info.mustHave || []), ...(info.niceToHave || [])];

    // ペット可を keywords に追加
    if (info.petAllowed && !keywords.includes('ペット可')) {
      keywords.push('ペット可');
    }

    return keywords;
  }

  /**
   * 部分結果を構築（追問が必要な場合）
   */
  static buildPartialResult(intent) {
    if (!intent) return null;

    const info = intent.extractedInfo || {};

    return {
      searchMethod: intent.searchType || null,
      locations: info.explicitLocations?.map(city => ({
        prefecture: info.prefecture,
        city: city
      })) || [],
      rentMin: info.budgetMin ? Math.round(info.budgetMin / 10000) : null,
      rentMax: info.budgetMax ? Math.round(info.budgetMax / 10000) : null,
      layouts: info.roomTypes || [],
      petAllowed: info.petAllowed || false,
      equipment: info.mustHave || []
    };
  }

  /**
   * 将 parsedRequirements 转换为 REINS 表单字段
   * 与 aiRequirementsParser.toReinsFields() 兼容
   */
  static toReinsFields(parsedRequirements) {
    if (!parsedRequirements) return null;

    // 如果已经有 formFields，直接使用
    if (parsedRequirements.formFields) {
      return {
        textInputs: parsedRequirements.formFields.textInputs || {},
        selects: parsedRequirements.formFields.selects || {},
        checkboxes: parsedRequirements.formFields.checkboxes || {},
        keywords: parsedRequirements.keywords || []
      };
    }

    // 方位マッピング
    const directionMapping = {
      '北': '1', '北東': '2', '東': '3', '南東': '4',
      '南': '5', '南西': '6', '西': '7', '北西': '8'
    };

    // 間取りマッピング
    const layoutMapping = {
      'ワンルーム': '__BVID__497', '1R': '__BVID__497',
      'K': '__BVID__499', '1K': '__BVID__499', '2K': '__BVID__499',
      'DK': '__BVID__501', '1DK': '__BVID__501', '2DK': '__BVID__501', '3DK': '__BVID__501',
      'LK': '__BVID__503', '1LK': '__BVID__503', '2LK': '__BVID__503',
      'LDK': '__BVID__505', '1LDK': '__BVID__505', '2LDK': '__BVID__505', '3LDK': '__BVID__505', '4LDK': '__BVID__505'
    };

    const fields = {
      textInputs: {},
      selects: {},
      checkboxes: {},
      keywords: parsedRequirements.keywords || []
    };

    // テキスト入力
    if (parsedRequirements.prefecture) fields.textInputs['__BVID__321'] = parsedRequirements.prefecture;
    if (parsedRequirements.cities?.length > 0) fields.textInputs['__BVID__325'] = parsedRequirements.cities[0];
    if (parsedRequirements.line) fields.textInputs['__BVID__372'] = parsedRequirements.line;
    if (parsedRequirements.station) fields.textInputs['__BVID__376'] = parsedRequirements.station;
    if (parsedRequirements.stationTo) fields.textInputs['__BVID__378'] = parsedRequirements.stationTo;
    if (parsedRequirements.walkMinutes) fields.textInputs['__BVID__381'] = parsedRequirements.walkMinutes.toString();
    if (parsedRequirements.rentMin) fields.textInputs['__BVID__452'] = parsedRequirements.rentMin.toString();
    if (parsedRequirements.rentMax) fields.textInputs['__BVID__454'] = parsedRequirements.rentMax.toString();
    if (parsedRequirements.areaMin) fields.textInputs['__BVID__477'] = parsedRequirements.areaMin.toString();
    if (parsedRequirements.areaMax) fields.textInputs['__BVID__479'] = parsedRequirements.areaMax.toString();
    if (parsedRequirements.floorMin) fields.textInputs['__BVID__516'] = parsedRequirements.floorMin.toString();

    // セレクト
    if (parsedRequirements.propertyType) fields.selects['__BVID__289'] = parsedRequirements.propertyType;
    if (parsedRequirements.direction && directionMapping[parsedRequirements.direction]) {
      fields.selects['__BVID__521'] = directionMapping[parsedRequirements.direction];
    }
    if (parsedRequirements.parking) fields.selects['__BVID__542'] = parsedRequirements.parking;

    // チェックボックス
    if (parsedRequirements.isNew) fields.checkboxes['__BVID__307'] = true;
    if (parsedRequirements.corner) fields.checkboxes['__BVID__492'] = true;

    // 間取り
    for (const layout of parsedRequirements.layouts || []) {
      const checkboxId = layoutMapping[layout];
      if (checkboxId) {
        fields.checkboxes[checkboxId] = true;
      }
    }

    return fields;
  }
}

module.exports = ResultAdapter;
