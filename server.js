
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const atbbService = require('./services/atbbService');
const itandiService = require('./services/itandiService');
const ierabuService = require('./services/ierabuService');
const searchCoordinator = require('./services/searchCoordinator');
const reinsService = require('./services/reinsService');
const requirementsParser = require('./services/requirementsParser');
const mbtiData = require('./housing_mbti_presets.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/downloads', express.static('downloads')); // 暴露下载文件夹供前端访问PDF

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

// Multi-platform search - searches across ATBB, ITANDI, and いえらぶBB
app.post('/api/search', async (req, res) => {
  try {
    const { userRequirements, tantousha } = req.body;

    // 用户输入是必须的
    if (!userRequirements || !userRequirements.trim()) {
      return res.status(400).json({
        error: '希望条件を入力してください'
      });
    }

    console.log('='.repeat(60));
    console.log('[マルチプラットフォーム検索開始]');
    console.log('ユーザー希望条件:', userRequirements);
    console.log('担当者希望条件:', tantousha || '(なし)');
    console.log('='.repeat(60));

    // 先创建文件夹结构，获取各平台下载目录
    console.log('[Coordinator] 创建搜索会话文件夹...');
    const session = await searchCoordinator.createSearchSession(userRequirements);
    console.log('[Coordinator] 会话文件夹已创建:', session.sessionPath);

    // 并行搜索三个平台，传递下载目录
    const searchPromises = [
      atbbService.search(userRequirements, tantousha, session.folders.atbb).catch(err => ({
        success: false,
        platform: 'ATBB',
        error: err.message
      })),
      itandiService.search(userRequirements, tantousha, session.folders.itandi).catch(err => ({
        success: false,
        platform: 'ITANDI',
        error: err.message
      })),
      ierabuService.search(userRequirements, tantousha, session.folders.ierube_bb).catch(err => ({
        success: false,
        platform: 'いえらぶBB',
        error: err.message
      }))
    ];

    console.log('[検索] 3つのプラットフォームで並列検索中...');
    const [atbbResult, itandiResult, ierabuResult] = await Promise.all(searchPromises);

    console.log('[検索完了]');
    console.log('- ATBB:', atbbResult.success ? '成功' : '失敗', 'PDFs:', atbbResult.downloadedPdfs?.length || 0);
    console.log('- ITANDI:', itandiResult.success ? '成功' : '失敗', 'PDFs:', itandiResult.downloadedPdfs?.length || 0);
    console.log('- いえらぶBB:', ierabuResult.success ? '成功' : '失敗', 'PDFs:', ierabuResult.downloadedPdfs?.length || 0);

    // 协调搜索结果，创建文件夹结构和合并PDF
    const searchResults = {
      atbb: atbbResult,
      itandi: itandiResult,
      ierube_bb: ierabuResult
    };

    console.log('[Coordinator] 合并PDF文件...');
    const coordination = await searchCoordinator.coordinateSearch(
      userRequirements,
      tantousha,
      searchResults,
      session  // 传递现有session，避免重复创建文件夹
    );

    // 调试：输出合并后的PDF路径
    console.log('[Server] coordination.mergedPdfs:', JSON.stringify(coordination.mergedPdfs, null, 2));

    // 将文件路径转换为URL
    const pathToUrl = (filePath) => {
      if (!filePath) return null;
      // 从downloads文件夹开始的相对路径
      const relativePath = filePath.replace(/\\/g, '/').split('/downloads/')[1];
      return relativePath ? `/downloads/${relativePath}` : null;
    };

    // 构建前端需要的platforms格式
    // 优先使用合并后的PDF，如果有多个PDF则显示合并后的
    const getMergedOrFirstPdf = (downloadedPdfs, mergedPdf) => {
      // 如果有合并后的PDF，优先使用
      if (mergedPdf) {
        return pathToUrl(mergedPdf);
      }
      // 否则使用第一个下载的PDF
      if (downloadedPdfs?.length > 0) {
        return pathToUrl(downloadedPdfs[0]);
      }
      return null;
    };

    const platforms = {
      atbb: {
        success: atbbResult.success,
        pdfUrl: getMergedOrFirstPdf(atbbResult.downloadedPdfs, coordination.mergedPdfs?.atbb),
        pdfUrls: atbbResult.downloadedPdfs?.map(p => pathToUrl(p)).filter(Boolean) || [],
        mergedPdfUrl: coordination.mergedPdfs?.atbb ? pathToUrl(coordination.mergedPdfs.atbb) : null,
        count: atbbResult.downloadedPdfs?.length || 0,
        screenshotUrl: atbbResult.screenshotPath ? pathToUrl(atbbResult.screenshotPath) : null,
        message: atbbResult.message
      },
      itandi: {
        success: itandiResult.success,
        pdfUrl: getMergedOrFirstPdf(itandiResult.downloadedPdfs, coordination.mergedPdfs?.itandi),
        pdfUrls: itandiResult.downloadedPdfs?.map(p => pathToUrl(p)).filter(Boolean) || [],
        mergedPdfUrl: coordination.mergedPdfs?.itandi ? pathToUrl(coordination.mergedPdfs.itandi) : null,
        count: itandiResult.downloadedPdfs?.length || 0,
        screenshotUrl: itandiResult.screenshotPath ? pathToUrl(itandiResult.screenshotPath) : null,
        message: itandiResult.message
      },
      ierabu: {
        success: ierabuResult.success,
        pdfUrl: getMergedOrFirstPdf(ierabuResult.downloadedPdfs, coordination.mergedPdfs?.ierube_bb),
        pdfUrls: ierabuResult.downloadedPdfs?.map(p => pathToUrl(p)).filter(Boolean) || [],
        mergedPdfUrl: coordination.mergedPdfs?.ierube_bb ? pathToUrl(coordination.mergedPdfs.ierube_bb) : null,
        count: ierabuResult.downloadedPdfs?.length || 0,
        screenshotUrl: ierabuResult.screenshotPath ? pathToUrl(ierabuResult.screenshotPath) : null,
        message: ierabuResult.message
      }
    };

    // 调试：输出发送给前端的platforms对象
    console.log('[Server] platforms to send:', JSON.stringify({
      itandi: { mergedPdfUrl: platforms.itandi.mergedPdfUrl, pdfUrl: platforms.itandi.pdfUrl, count: platforms.itandi.count },
      atbb: { mergedPdfUrl: platforms.atbb.mergedPdfUrl, pdfUrl: platforms.atbb.pdfUrl, count: platforms.atbb.count },
      ierabu: { mergedPdfUrl: platforms.ierabu.mergedPdfUrl, pdfUrl: platforms.ierabu.pdfUrl, count: platforms.ierabu.count }
    }, null, 2));

    res.json({
      success: true,
      user_requirements: userRequirements,
      tantousha_requirements: tantousha,
      platforms: platforms,  // 前端需要的格式
      results: searchResults,
      session: {
        sessionPath: coordination.sessionPath,
        sessionName: coordination.sessionName,
        folders: coordination.folders,
        mergedPdfs: coordination.mergedPdfs
      },
      summary: {
        total_platforms: 3,
        successful_platforms: [atbbResult, itandiResult, ierabuResult].filter(r => r.success).length,
        failed_platforms: [atbbResult, itandiResult, ierabuResult].filter(r => !r.success).length,
        total_pdfs_downloaded: (atbbResult.downloadedPdfs?.length || 0) +
                              (itandiResult.downloadedPdfs?.length || 0) +
                              (ierabuResult.downloadedPdfs?.length || 0)
      }
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Failed to search properties',
      message: error.message
    });
  }
});

// Single platform search endpoints (for individual testing)
app.post('/api/search/atbb', async (req, res) => {
  try {
    const { userRequirements, tantousha } = req.body;
    const result = await atbbService.search(userRequirements, tantousha);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/search/itandi', async (req, res) => {
  try {
    const { userRequirements, tantousha } = req.body;
    const result = await itandiService.search(userRequirements, tantousha);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/search/ierube', async (req, res) => {
  try {
    const { userRequirements, tantousha } = req.body;
    const result = await ierabuService.search(userRequirements, tantousha);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get search history
app.get('/api/search/history', async (req, res) => {
  try {
    const history = await searchCoordinator.getSearchHistory();
    res.json({
      success: true,
      history,
      count: history.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get platform status
app.get('/api/platforms/status', (req, res) => {
  res.json({
    success: true,
    platforms: [
      {
        name: 'ATBB',
        status: 'active',
        searchUrl: 'https://members.athome.jp/portal',
        features: ['流通物件検索', '所在地検索', '沿線検索']
      },
      {
        name: 'ITANDI BB',
        status: 'active',
        searchUrl: 'https://itandibb.com/rent_rooms/list',
        features: ['所在地で絞り込み', '路線・駅で絞り込み', '詳細条件検索']
      },
      {
        name: 'いえらぶBB',
        status: 'active',
        searchUrl: 'https://bb.ielove.jp/ielovebb/rent/searchmenu/',
        features: ['市区町村から探す', '路線・駅から探す', '地図から探す']
      }
    ]
  });
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('  Multi-Platform Property Search System');
  console.log('='.repeat(60));
  console.log('  Server running on: http://localhost:' + PORT);
  console.log('  Platforms: ATBB, ITANDI BB, いえらぶBB');
  console.log('='.repeat(60));
});
