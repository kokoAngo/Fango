const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const reinsService = require('./services/reinsService');
const requirementsParser = require('./services/requirementsParser');
const aiRequirementsParser = require('./services/aiRequirementsParser');
const mbtiData = require('./housing_mbti_presets.json');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get all MBTI types
app.get('/api/mbti-types', (req, res) => {
  const types = mbtiData.types.map(type => ({
    type_id: type.type_id,
    display_name_ja: type.display_name_ja,
    description: type.description || ''
  }));
  res.json(types);
});

// Search properties based on user requirements (primary) and optional MBTI type
app.post('/api/search', async (req, res) => {
  try {
    const { typeId, userRequirements, agentNotes } = req.body;
    const username = process.env.REINS_USERNAME;
    const password = process.env.REINS_PASSWORD;

    // 用户输入是必须的
    if (!userRequirements || !userRequirements.trim()) {
      return res.status(400).json({
        error: '希望条件を入力してください'
      });
    }

    if (!username || !password) {
      return res.status(500).json({
        error: 'Server credentials not configured'
      });
    }

    console.log('='.repeat(60));
    console.log('User requirements:', userRequirements);
    if (agentNotes) {
      console.log('Agent notes:', agentNotes);
    }

    // AI で需求を解析（位置情報も含めて一括解析、担当者コメントも考慮）
    let parsedRequirements = await aiRequirementsParser.parse(userRequirements, {}, agentNotes || '');
    let reinsFields;

    if (parsedRequirements) {
      // AI 解析成功
      console.log('\n[AI Parser] 解析成功');
      reinsFields = aiRequirementsParser.toReinsFields(parsedRequirements);
    } else {
      // AI 解析失敗時は従来のパーサーにフォールバック
      console.log('\n[AI Parser] 解析失敗、従来パーサーにフォールバック');
      parsedRequirements = requirementsParser.parse(userRequirements);
      reinsFields = requirementsParser.toReinsFields(parsedRequirements);
    }

    // 複数検索オプションをログ出力
    const searchOptions = parsedRequirements.searchOptions || [];
    const locations = parsedRequirements.locations || [];
    console.log('\n=== 解析結果 ===');
    console.log('【検索オプション】', searchOptions.length, '件');
    searchOptions.forEach((opt, i) => {
      const townInfo = opt.town ? ` [町丁目: ${opt.town}]` : '';
      console.log(`  [${opt.id}] ${opt.description} (${opt.searchMethod})${townInfo}`);
    });
    console.log('【位置情報】候補地:', locations.length, '件');
    locations.forEach((loc, i) => {
      console.log(`  [${i + 1}] ${loc.prefecture} ${loc.city}${loc.detail ? ' (' + loc.detail + ')' : ''}`);
    });
    console.log('【沿線・駅】');
    console.log('  沿線:', parsedRequirements.line || '(未指定)');
    console.log('  駅:', parsedRequirements.station || '(未指定)');
    console.log('【賃料・面積】');
    console.log('  賃料:',
      (parsedRequirements.rentMin ? parsedRequirements.rentMin + '万円' : '') +
      (parsedRequirements.rentMin && parsedRequirements.rentMax ? ' ～ ' : '') +
      (parsedRequirements.rentMax ? parsedRequirements.rentMax + '万円' : '') || '(未指定)');
    console.log('  面積下限:', parsedRequirements.areaMin ? parsedRequirements.areaMin + '㎡' : '(未指定)');
    console.log('【その他条件】');
    console.log('  所在階:', parsedRequirements.floorMin ? parsedRequirements.floorMin + '階以上' : '(未指定)');
    console.log('  向き:', parsedRequirements.direction || '(未指定)');
    console.log('  間取り:', parsedRequirements.layouts?.join(', ') || '(未指定)');
    console.log('  駐車場:', parsedRequirements.parking === '1' ? '有／空有' :
                            parsedRequirements.parking === '2' ? '無／空無' :
                            parsedRequirements.parking === '3' ? '近隣確保' : '(未指定)');
    console.log('  ペット可:', parsedRequirements.petAllowed ? 'はい' : 'いいえ');
    console.log('  設備条件:', parsedRequirements.keywords?.join(', ') || '(なし)');

    // 如果选择了MBTI类型，获取其基础条件（作为补充）
    let mbtiConditions = {};
    let mbtiName = null;
    if (typeId) {
      const type = mbtiData.types.find(t => t.type_id === typeId);
      if (type) {
        mbtiConditions = type.basic_conditions || {};
        mbtiName = type.display_name_ja;
        console.log('MBTI type:', mbtiName);
      }
    }

    // 複数位置で順次検索（100件以上見つかるまで、最大10回まで）
    const MAX_SEARCH_ATTEMPTS = 10;  // 最大検索オプション数
    let allProperties = [];
    let searchedLocations = [];
    let allPdfPaths = [];  // 複数PDFを収集
    let allPropertyIds = [];  // 物件IDを収集
    let totalPdfCount = 0;

    // 検索専用フォルダを作成（時間+キーワード）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // キーワードを生成（最初の検索オプションまたは位置から）
    const keyword = searchOptions.length > 0
      ? searchOptions[0].description.substring(0, 20).replace(/[\\/:*?"<>|]/g, '_')
      : locations.length > 0
        ? `${locations[0].prefecture}_${locations[0].city}`.replace(/[\\/:*?"<>|]/g, '_')
        : (parsedRequirements.station || parsedRequirements.line || 'search').replace(/[\\/:*?"<>|]/g, '_');
    const searchFolderName = `${timestamp}_${keyword}`;
    const searchDownloadDir = path.join(DOWNLOADS_DIR, searchFolderName);

    // フォルダ作成
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
    fs.mkdirSync(searchDownloadDir, { recursive: true });
    console.log(`検索専用フォルダを作成: ${searchFolderName}`);

    // searchOptions を使用して検索（優先）
    const itemsToSearch = searchOptions.length > 0 ? searchOptions : locations.map((loc, i) => ({
      id: i + 1,
      description: `${loc.prefecture} ${loc.city}で所在地検索`,
      searchMethod: 'location',
      prefecture: loc.prefecture,
      city: loc.city,
      town: loc.town || null,
      detail: loc.town || loc.detail || null
    }));

    // 基本条件（各並列検索で共有）
    const baseConditions = {
      ...mbtiConditions,
      ...parsedRequirements,
      downloadDir: searchDownloadDir
    };

    // 並列検索を使用（最大5並列）
    const MAX_CONCURRENT = 5;
    const optionsToSearch = itemsToSearch.slice(0, Math.min(itemsToSearch.length, MAX_SEARCH_ATTEMPTS));

    console.log(`\n⚡ 並列検索を開始: ${optionsToSearch.length}件の検索オプション（最大${MAX_CONCURRENT}並列）`);

    const concurrentResult = await reinsService.searchConcurrent(
      username,
      password,
      baseConditions,
      optionsToSearch,
      { maxConcurrent: MAX_CONCURRENT }
    );

    // 並列検索の結果を集計
    if (concurrentResult) {
      // PDF ファイルを収集
      if (concurrentResult.pdfFiles && concurrentResult.pdfFiles.length > 0) {
        allPdfPaths.push(...concurrentResult.pdfFiles);
        totalPdfCount = concurrentResult.uniquePropertyCount || concurrentResult.pdfFiles.length;
      }

      // 物件を収集
      if (concurrentResult.properties && concurrentResult.properties.length > 0) {
        allProperties.push(...concurrentResult.properties);
      }

      // 検索済み位置を記録
      if (concurrentResult.rounds) {
        for (const round of concurrentResult.rounds) {
          if (round.success && round.option) {
            searchedLocations.push({ option: round.option.description, ...round.option });
          }
          // 物件IDを収集
          if (round.propertyIds && round.propertyIds.length > 0) {
            const newIds = round.propertyIds.filter(id => !allPropertyIds.includes(id));
            allPropertyIds.push(...newIds);
          }
        }
      }

      console.log(`\n✓ 並列検索完了: ${concurrentResult.completedRounds}/${concurrentResult.totalRounds} 成功`);
      console.log(`  発見物件数: ${concurrentResult.uniquePropertyCount || allProperties.length}件`);
      console.log(`  PDFファイル数: ${allPdfPaths.length}件`);
    }

    // 収集したPDFを合併して返す
    if (allPdfPaths.length > 0) {
      console.log(`\n=== PDF合併処理 ===`);
      console.log(`収集したPDF: ${allPdfPaths.length}件, 物件数: ${totalPdfCount}件`);

      let finalPdfPath;
      if (allPdfPaths.length === 1) {
        finalPdfPath = allPdfPaths[0];
      } else {
        // 複数PDFを合併（検索専用フォルダに保存）
        const mergeTimestamp = Date.now();
        finalPdfPath = path.join(searchDownloadDir, `merged_${mergeTimestamp}.pdf`);
        await reinsService.mergePDFs(allPdfPaths, finalPdfPath);
      }

      const pdfFilename = path.basename(finalPdfPath);
      console.log(`✓ 最終PDF: ${pdfFilename}`);
      console.log(`✓ 物件ID: ${allPropertyIds.length}件`);
      if (allPropertyIds.length > 0) {
        allPropertyIds.forEach((id, i) => console.log(`  [${i + 1}] ${id}`));
      }

      return res.json({
        success: true,
        type: 'pdf',
        mbti_type: mbtiName,
        user_requirements: userRequirements,
        parsed_requirements: parsedRequirements,
        searched_locations: searchedLocations,
        pdfUrl: `/downloads/${searchFolderName}/${pdfFilename}`,
        count: totalPdfCount,
        propertyIds: allPropertyIds
      });
    }

    // 位置がない場合は従来の検索
    if (locations.length === 0) {
      console.log('\n【位置指定なしで検索】');
      const searchConditions = {
        ...mbtiConditions,
        userRequirements: parsedRequirements,
        reinsFields: reinsFields,
        downloadDir: searchDownloadDir  // 検索専用フォルダを指定
      };
      const result = await reinsService.searchProperties(
        username,
        password,
        searchConditions
      );

      // 結果タイプを確認
      if (result && result.type === 'pdf') {
        const pdfFilename = path.basename(result.pdfPath);
        return res.json({
          success: true,
          type: 'pdf',
          mbti_type: mbtiName,
          user_requirements: userRequirements,
          parsed_requirements: parsedRequirements,
          pdfUrl: `/downloads/${pdfFilename}`,
          count: result.count
        });
      } else if (result && result.type === 'properties') {
        allProperties = result.properties || [];
      } else if (Array.isArray(result)) {
        allProperties = result;
      }
    }

    console.log(`\n=== 検索完了: 合計 ${allProperties.length} 件 ===`);

    res.json({
      success: true,
      type: 'properties',
      mbti_type: mbtiName,
      user_requirements: userRequirements,
      parsed_requirements: parsedRequirements,
      searched_locations: searchedLocations,
      properties: allProperties
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Failed to search properties',
      message: error.message
    });
  }
});

/**
 * 解析用户需求，返回多个搜索选项供用户选择
 * POST /api/parse-requirements
 */
app.post('/api/parse-requirements', async (req, res) => {
  try {
    const { userRequirements, context, agentNotes } = req.body;

    if (!userRequirements || !userRequirements.trim()) {
      return res.status(400).json({
        error: '希望条件を入力してください'
      });
    }

    console.log('='.repeat(60));
    console.log('🔍 AI解析リクエスト');
    console.log('='.repeat(60));
    console.log('User requirements:', userRequirements);
    if (agentNotes) {
      console.log('Agent notes:', agentNotes);
    }

    // AI で需求を解析（担当者コメントも考慮）
    const parsedRequirements = await aiRequirementsParser.parse(userRequirements, context || {}, agentNotes || '');

    if (!parsedRequirements) {
      return res.status(400).json({
        error: '解析に失敗しました。もう少し具体的な条件を入力してください。'
      });
    }

    // 如果需要更多信息
    if (parsedRequirements.needsMoreInfo) {
      return res.json({
        success: true,
        needsMoreInfo: true,
        missingFields: parsedRequirements.missingFields,
        suggestedQuestions: parsedRequirements.suggestedQuestions,
        partialResult: parsedRequirements.partialResult
      });
    }

    // 返回解析结果，包含searchOptions
    console.log('\n【解析結果】');
    console.log('  searchOptions:', parsedRequirements.searchOptions?.length || 0, '件');
    if (parsedRequirements.searchOptions) {
      parsedRequirements.searchOptions.forEach((opt, i) => {
        console.log(`    [${opt.id}] ${opt.description} (${opt.searchMethod})`);
      });
    }

    res.json({
      success: true,
      needsMoreInfo: false,
      parsedRequirements: parsedRequirements,
      searchOptions: parsedRequirements.searchOptions || []
    });

  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({
      error: '解析に失敗しました',
      message: error.message
    });
  }
});

/**
 * 多轮搜索 - 根据用户选择的搜索选项进行多轮搜索
 * POST /api/search-multi-round
 */
app.post('/api/search-multi-round', async (req, res) => {
  try {
    const { parsedRequirements, selectedOptionIds, maxRounds } = req.body;
    const username = process.env.REINS_USERNAME;
    const password = process.env.REINS_PASSWORD;

    if (!parsedRequirements) {
      return res.status(400).json({
        error: '解析結果がありません。先に /api/parse-requirements を呼び出してください。'
      });
    }

    if (!parsedRequirements.searchOptions || parsedRequirements.searchOptions.length === 0) {
      return res.status(400).json({
        error: '検索オプションがありません。'
      });
    }

    if (!username || !password) {
      return res.status(500).json({
        error: 'Server credentials not configured'
      });
    }

    console.log('='.repeat(60));
    console.log('🔄 多轮検索リクエスト');
    console.log('='.repeat(60));
    console.log('  選択されたオプション:', selectedOptionIds || 'all');
    console.log('  最大ラウンド数:', maxRounds || 5);

    // 検索専用フォルダを作成
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const keyword = parsedRequirements.searchOptions[0]?.description?.substring(0, 20)?.replace(/[\\/:*?"<>|]/g, '_') || 'multi-search';
    const searchFolderName = `${timestamp}_${keyword}`;
    const searchDownloadDir = path.join(DOWNLOADS_DIR, searchFolderName);

    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
    fs.mkdirSync(searchDownloadDir, { recursive: true });

    // 基本条件（賃料、面積、間取り等）
    const baseConditions = {
      rentMin: parsedRequirements.rentMin,
      rentMax: parsedRequirements.rentMax,
      areaMin: parsedRequirements.areaMin,
      areaMax: parsedRequirements.areaMax,
      layouts: parsedRequirements.layouts,
      floorMin: parsedRequirements.floorMin,
      direction: parsedRequirements.direction,
      propertyType: parsedRequirements.propertyType,
      parking: parsedRequirements.parking,
      isNew: parsedRequirements.isNew,
      petAllowed: parsedRequirements.petAllowed,
      corner: parsedRequirements.corner,
      equipment: parsedRequirements.equipment,
      keywords: parsedRequirements.keywords,
      downloadDir: searchDownloadDir
    };

    // 执行多轮搜索
    const result = await reinsService.searchMultipleRounds(
      username,
      password,
      baseConditions,
      parsedRequirements.searchOptions,
      {
        maxRounds: maxRounds || 5,
        selectedOptions: selectedOptionIds
      }
    );

    // 如果有PDF文件，合并它们
    let finalPdfUrl = null;
    if (result.pdfFiles && result.pdfFiles.length > 0) {
      let finalPdfPath;
      if (result.pdfFiles.length === 1) {
        finalPdfPath = result.pdfFiles[0];
      } else {
        // 合并多个PDF
        const mergeTimestamp = Date.now();
        finalPdfPath = path.join(searchDownloadDir, `merged_${mergeTimestamp}.pdf`);
        await reinsService.mergePDFs(result.pdfFiles, finalPdfPath);
      }
      const pdfFilename = path.basename(finalPdfPath);
      finalPdfUrl = `/downloads/${searchFolderName}/${pdfFilename}`;
    }

    res.json({
      success: true,
      type: 'multiRoundSearch',
      totalRounds: result.totalRounds,
      completedRounds: result.completedRounds,
      rounds: result.rounds.map(r => ({
        round: r.round,
        optionId: r.option?.id,
        description: r.option?.description,
        success: r.success,
        propertiesCount: r.propertiesCount,
        error: r.error
      })),
      properties: result.properties,
      uniquePropertyCount: result.uniquePropertyCount,
      pdfUrl: finalPdfUrl,
      errors: result.errors
    });

  } catch (error) {
    console.error('Multi-round search error:', error);
    res.status(500).json({
      error: 'マルチ検索に失敗しました',
      message: error.message
    });
  }
});

/**
 * 并发搜索 - 同时启动多个浏览器进行搜索，然后合并结果
 * POST /api/search-concurrent
 */
app.post('/api/search-concurrent', async (req, res) => {
  try {
    const { parsedRequirements, selectedOptionIds, maxConcurrent } = req.body;
    const username = process.env.REINS_USERNAME;
    const password = process.env.REINS_PASSWORD;

    if (!parsedRequirements) {
      return res.status(400).json({
        error: '解析結果がありません。先に /api/parse-requirements を呼び出してください。'
      });
    }

    if (!parsedRequirements.searchOptions || parsedRequirements.searchOptions.length === 0) {
      return res.status(400).json({
        error: '検索オプションがありません。'
      });
    }

    if (!username || !password) {
      return res.status(500).json({
        error: 'Server credentials not configured'
      });
    }

    console.log('='.repeat(60));
    console.log('⚡ 並列検索リクエスト');
    console.log('='.repeat(60));
    console.log('  選択されたオプション:', selectedOptionIds || 'all');
    console.log('  最大並列数:', maxConcurrent || 3);

    // 検索専用フォルダを作成
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const keyword = parsedRequirements.searchOptions[0]?.description?.substring(0, 20)?.replace(/[\\/:*?"<>|]/g, '_') || 'concurrent-search';
    const searchFolderName = `${timestamp}_${keyword}`;
    const searchDownloadDir = path.join(DOWNLOADS_DIR, searchFolderName);

    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
    fs.mkdirSync(searchDownloadDir, { recursive: true });

    // 基本条件
    const baseConditions = {
      rentMin: parsedRequirements.rentMin,
      rentMax: parsedRequirements.rentMax,
      areaMin: parsedRequirements.areaMin,
      areaMax: parsedRequirements.areaMax,
      layouts: parsedRequirements.layouts,
      floorMin: parsedRequirements.floorMin,
      direction: parsedRequirements.direction,
      propertyType: parsedRequirements.propertyType,
      parking: parsedRequirements.parking,
      isNew: parsedRequirements.isNew,
      petAllowed: parsedRequirements.petAllowed,
      corner: parsedRequirements.corner,
      equipment: parsedRequirements.equipment,
      keywords: parsedRequirements.keywords,
      downloadDir: searchDownloadDir
    };

    // 执行并发搜索
    const result = await reinsService.searchConcurrent(
      username,
      password,
      baseConditions,
      parsedRequirements.searchOptions,
      {
        maxConcurrent: maxConcurrent || 3,
        selectedOptions: selectedOptionIds
      }
    );

    // 合并 PDF 文件
    let finalPdfUrl = null;
    if (result.pdfFiles && result.pdfFiles.length > 0) {
      let finalPdfPath;
      if (result.pdfFiles.length === 1) {
        finalPdfPath = result.pdfFiles[0];
      } else {
        // 合并多个 PDF（去重后）
        const uniquePdfFiles = [...new Set(result.pdfFiles)];
        const mergeTimestamp = Date.now();
        finalPdfPath = path.join(searchDownloadDir, `merged_concurrent_${mergeTimestamp}.pdf`);

        console.log(`\n📄 PDF合併処理: ${uniquePdfFiles.length}件のPDFを合併中...`);
        await reinsService.mergePDFs(uniquePdfFiles, finalPdfPath);
        console.log(`✓ 合併完了: ${path.basename(finalPdfPath)}`);
      }
      const pdfFilename = path.basename(finalPdfPath);
      finalPdfUrl = `/downloads/${searchFolderName}/${pdfFilename}`;
    }

    res.json({
      success: true,
      type: 'concurrentSearch',
      totalRounds: result.totalRounds,
      completedRounds: result.completedRounds,
      duration: result.duration,
      rounds: result.rounds.map(r => ({
        round: r.round,
        optionId: r.option?.id,
        description: r.option?.description,
        success: r.success,
        propertiesCount: r.propertiesCount,
        error: r.error
      })),
      properties: result.properties,
      uniquePropertyCount: result.uniquePropertyCount,
      pdfUrl: finalPdfUrl,
      errors: result.errors
    });

  } catch (error) {
    console.error('Concurrent search error:', error);
    res.status(500).json({
      error: '並列検索に失敗しました',
      message: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});
