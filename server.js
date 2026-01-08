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
    const { typeId, userRequirements } = req.body;
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

    // AI で需求を解析（位置情報も含めて一括解析）
    let parsedRequirements = await aiRequirementsParser.parse(userRequirements);
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

    // 複数位置オプションをログ出力
    const locations = parsedRequirements.locations || [];
    console.log('\n=== 解析結果 ===');
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

    // 複数位置で順次検索（5件以上見つかるまで、最大10回まで）
    const MIN_PROPERTIES = 5;
    const MAX_SEARCH_ATTEMPTS = 10;
    let allProperties = [];
    let searchedLocations = [];
    let allPdfPaths = [];  // 複数PDFを収集
    let totalPdfCount = 0;
    let searchAttempts = 0;

    // 検索専用フォルダを作成（時間+キーワード）
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    // キーワードを生成（最初の位置または条件から）
    const keyword = locations.length > 0
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

    for (let i = 0; i < locations.length && allProperties.length < MIN_PROPERTIES && searchAttempts < MAX_SEARCH_ATTEMPTS; i++) {
      searchAttempts++;
      const location = locations[i];
      console.log(`\n【検索 ${searchAttempts}/${MAX_SEARCH_ATTEMPTS}】${location.prefecture} ${location.city}`);

      // この位置用の条件を作成
      const locationRequirements = {
        ...parsedRequirements,
        prefecture: location.prefecture,
        cities: [location.city]
      };

      const locationReinsFields = aiRequirementsParser.toReinsFields(locationRequirements);

      const searchConditions = {
        ...mbtiConditions,
        userRequirements: locationRequirements,
        reinsFields: locationReinsFields,
        downloadDir: searchDownloadDir  // 検索専用フォルダを指定
      };

      try {
        const result = await reinsService.searchProperties(
          username,
          password,
          searchConditions
        );

        // 結果タイプを確認
        if (result && result.type === 'pdf') {
          // PDFダウンロード成功 - 収集して続行
          console.log(`  → PDF生成成功: ${path.basename(result.pdfPath)}`);
          allPdfPaths.push(result.pdfPath);
          totalPdfCount += result.count || 1;
          searchedLocations.push(location);

          // 5件以上収集したら終了
          if (totalPdfCount >= MIN_PROPERTIES) {
            console.log(`\n${totalPdfCount}件以上のPDFを収集したため検索終了`);
            break;
          }
        } else if (result && result.type === 'properties' && result.properties) {
          // プロパティリスト（フォールバック）
          const properties = result.properties;
          if (properties.length > 0) {
            properties.forEach(p => {
              p.searchLocation = `${location.prefecture} ${location.city}`;
            });
            allProperties.push(...properties);
            searchedLocations.push(location);
            console.log(`  → ${properties.length}件 見つかりました (累計: ${allProperties.length}件)`);
          } else {
            console.log(`  → 0件`);
          }
        } else if (Array.isArray(result)) {
          // 旧形式（配列）
          if (result.length > 0) {
            result.forEach(p => {
              p.searchLocation = `${location.prefecture} ${location.city}`;
            });
            allProperties.push(...result);
            searchedLocations.push(location);
            console.log(`  → ${result.length}件 見つかりました (累計: ${allProperties.length}件)`);
          } else {
            console.log(`  → 0件`);
          }
        } else {
          console.log(`  → 0件`);
        }
      } catch (err) {
        console.log(`  → 検索エラー: ${err.message}`);
      }

      // 5件以上見つかったら終了
      if (allProperties.length >= MIN_PROPERTIES || totalPdfCount >= MIN_PROPERTIES) {
        console.log(`\n${MIN_PROPERTIES}件以上見つかったため検索終了`);
        break;
      }
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

      return res.json({
        success: true,
        type: 'pdf',
        mbti_type: mbtiName,
        user_requirements: userRequirements,
        parsed_requirements: parsedRequirements,
        searched_locations: searchedLocations,
        pdfUrl: `/downloads/${searchFolderName}/${pdfFilename}`,
        count: totalPdfCount
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

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});
