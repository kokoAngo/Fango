const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
require('dotenv').config();

const reinsService = require('./services/reinsService');
const requirementsParser = require('./services/requirementsParser');
const mbtiData = require('./housing_mbti_presets.json');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

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

    // 解析用户需求
    const parsedRequirements = requirementsParser.parse(userRequirements);
    const reinsFields = requirementsParser.toReinsFields(parsedRequirements);

    console.log('\n=== 解析結果 ===');
    console.log('都道府県:', parsedRequirements.prefecture || '(未指定)');
    console.log('市区町村:', parsedRequirements.cities?.join(', ') || '(未指定)');
    console.log('賃料上限:', parsedRequirements.rentMax ? parsedRequirements.rentMax + '万円' : '(未指定)');
    console.log('面積下限:', parsedRequirements.areaMin ? parsedRequirements.areaMin + '㎡' : '(未指定)');
    console.log('所在階:', parsedRequirements.floorMin ? parsedRequirements.floorMin + '階以上' : '(未指定)');
    console.log('向き:', parsedRequirements.direction || '(未指定)');
    console.log('間取り:', parsedRequirements.layouts?.join(', ') || '(未指定)');
    console.log('設備条件（備考検索）:', parsedRequirements.keywords?.join(', ') || '(なし)');

    // 打印将要填写的表单字段
    requirementsParser.logFields(reinsFields);

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

    // 搜索条件：用户输入为主，MBTI为补充
    const searchConditions = {
      ...mbtiConditions,
      userRequirements: parsedRequirements,
      reinsFields: reinsFields
    };

    // Call REINS service
    const properties = await reinsService.searchProperties(
      username,
      password,
      searchConditions
    );

    res.json({
      success: true,
      mbti_type: mbtiName,
      user_requirements: userRequirements,
      parsed_requirements: parsedRequirements,
      properties: properties
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
