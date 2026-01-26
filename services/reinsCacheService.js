/**
 * REINS 缓存服务 (SQLite/Knex版)
 * 管理所在地和沿线的本地缓存
 *
 * 结构: 地方(東日本/中部圏/近畿圏/西日本) → 都道府県 → 地域区分 → 市区町村 → 町丁目
 */

const path = require('path');
const fs = require('fs');
const { db, initDatabase } = require('../db/connection');

// 4地方制の都道府県マッピング
const REGION_PREFECTURES = {
  '東日本': ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
             '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
             '新潟県', '山梨県', '長野県'],
  '中部圏': ['富山県', '石川県', '福井県', '岐阜県', '静岡県', '愛知県', '三重県'],
  '近畿圏': ['滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'],
  '西日本': ['鳥取県', '島根県', '岡山県', '広島県', '山口県',
             '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
             '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
};

// 都道府県から地方を逆引き
const PREFECTURE_TO_REGION = {};
for (const [region, prefectures] of Object.entries(REGION_PREFECTURES)) {
  for (const pref of prefectures) {
    PREFECTURE_TO_REGION[pref] = region;
  }
}

// 路線名エイリアス（ユーザー入力 → REINS正式名）
const LINE_ALIASES = {
  // 名古屋市営地下鉄
  '名古屋市営東山線': '東山線',
  '名古屋市営地下鉄東山線': '東山線',
  '名古屋地下鉄東山線': '東山線',
  '名古屋市営桜通線': '桜通線',
  '名古屋市営地下鉄桜通線': '桜通線',
  '名古屋市営鶴舞線': '鶴舞線',
  '名古屋市営地下鉄鶴舞線': '鶴舞線',
  '名古屋市営名城線': '名城線',
  '名古屋市営地下鉄名城線': '名城線',
  '名古屋市営名港線': '名港線',
  '名古屋市営地下鉄名港線': '名港線',
  '名古屋市営上飯田線': '上飯田線',
  '名古屋市営地下鉄上飯田線': '上飯田線',
  // 大阪メトロ
  '大阪メトロ御堂筋線': '御堂筋線',
  '大阪市営御堂筋線': '御堂筋線',
  '大阪市営地下鉄御堂筋線': '御堂筋線',
  '大阪メトロ谷町線': '谷町線',
  '大阪市営谷町線': '谷町線',
  '大阪メトロ四つ橋線': '四つ橋線',
  '大阪市営四つ橋線': '四つ橋線',
  '大阪メトロ中央線': '中央線',
  '大阪市営中央線': '中央線',
  '大阪メトロ千日前線': '千日前線',
  '大阪市営千日前線': '千日前線',
  '大阪メトロ堺筋線': '堺筋線',
  '大阪市営堺筋線': '堺筋線',
  '大阪メトロ長堀鶴見緑地線': '長堀鶴見緑地線',
  '大阪市営長堀鶴見緑地線': '長堀鶴見緑地線',
  '大阪メトロ今里筋線': '今里筋線',
  '大阪市営今里筋線': '今里筋線',
  // 札幌市営地下鉄
  '札幌市営南北線': '南北線',
  '札幌市営地下鉄南北線': '南北線',
  '札幌市営東西線': '東西線',
  '札幌市営地下鉄東西線': '東西線',
  '札幌市営東豊線': '東豊線',
  '札幌市営地下鉄東豊線': '東豊線',
  // 東京メトロ
  '東京メトロ銀座線': '銀座線',
  '東京メトロ丸ノ内線': '丸ノ内線',
  '東京メトロ日比谷線': '日比谷線',
  '東京メトロ東西線': '東西線',
  '東京メトロ千代田線': '千代田線',
  '東京メトロ有楽町線': '有楽町線',
  '東京メトロ半蔵門線': '半蔵門線',
  '東京メトロ南北線': '南北線',
  '東京メトロ副都心線': '副都心線',
  // 福岡市営地下鉄
  '福岡市営空港線': '空港線',
  '福岡市営地下鉄空港線': '空港線',
  '福岡市営箱崎線': '箱崎線',
  '福岡市営地下鉄箱崎線': '箱崎線',
  '福岡市営七隈線': '七隈線',
  '福岡市営地下鉄七隈線': '七隈線'
};

class ReinsCacheService {
  constructor() {
    this.initialized = false;
    this.dataDir = path.join(__dirname, '..', 'data');
  }

  /**
   * 初始化数据库
   */
  async initialize() {
    if (this.initialized) return;

    try {
      await initDatabase();
      this.initialized = true;
      console.log('[ReinsCache] Database initialized');

      // 检查是否需要从JSON迁移
      await this.migrateFromJsonIfNeeded();
    } catch (error) {
      console.error('[ReinsCache] Initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * 都道府県から地方を取得
   */
  getRegionForPrefecture(prefecture) {
    return PREFECTURE_TO_REGION[prefecture] || '東日本';
  }

  // ========== 所在地缓存操作 ==========

  /**
   * 获取指定都道府县的所有市区町村
   */
  async getCities(prefecture) {
    const region = this.getRegionForPrefecture(prefecture);
    const rows = await db('locations')
      .where({ region, prefecture })
      .whereNotNull('city')
      .distinct('city')
      .orderBy('city');
    return rows.map(r => r.city);
  }

  /**
   * 获取指定市的所有区
   */
  async getWards(prefecture, city) {
    const region = this.getRegionForPrefecture(prefecture);
    const rows = await db('locations')
      .where({ region, prefecture, city })
      .whereNotNull('ward')
      .distinct('ward')
      .orderBy('ward');
    return rows.map(r => r.ward);
  }

  /**
   * 获取指定区的所有町丁目
   */
  async getTowns(prefecture, city, ward) {
    const region = this.getRegionForPrefecture(prefecture);
    const rows = await db('locations')
      .where({ region, prefecture, city, ward })
      .whereNotNull('town')
      .distinct('town')
      .orderBy('town');
    return rows.map(r => r.town);
  }

  /**
   * 获取某个都道府县下的所有町丁目（扁平化）
   */
  async getAllTownsInPrefecture(prefecture) {
    const region = this.getRegionForPrefecture(prefecture);
    const rows = await db('locations')
      .where({ region, prefecture })
      .whereNotNull('town')
      .select('prefecture', 'city', 'ward', 'town')
      .orderBy(['city', 'ward', 'town']);

    return rows.map(r => ({
      prefecture: r.prefecture,
      city: r.city,
      ward: r.ward,
      town: r.town,
      fullPath: `${r.prefecture} ${r.ward} ${r.town}`
    }));
  }

  /**
   * 添加町丁目到缓存
   */
  async addTowns(prefecture, city, ward, towns) {
    const region = this.getRegionForPrefecture(prefecture);
    let addedCount = 0;

    for (const town of towns) {
      try {
        await db('locations').insert({
          region,
          prefecture,
          city,
          ward,
          town
        });
        addedCount++;
      } catch (error) {
        // 忽略唯一约束冲突（已存在的记录）
        if (!error.message.includes('UNIQUE constraint') && !error.message.includes('duplicate')) {
          console.error('[ReinsCache] Failed to add town:', error.message);
        }
      }
    }

    if (addedCount > 0) {
      console.log(`[ReinsCache] Added ${addedCount} towns to ${prefecture} ${ward}`);
    }

    return addedCount;
  }

  /**
   * 批量添加区到缓存
   */
  async addWards(prefecture, city, wards) {
    const region = this.getRegionForPrefecture(prefecture);
    let addedCount = 0;

    for (const ward of wards) {
      try {
        await db('locations').insert({
          region,
          prefecture,
          city,
          ward,
          town: null
        });
        addedCount++;
      } catch (error) {
        if (!error.message.includes('UNIQUE constraint') && !error.message.includes('duplicate')) {
          console.error('[ReinsCache] Failed to add ward:', error.message);
        }
      }
    }

    if (addedCount > 0) {
      console.log(`[ReinsCache] Added ${addedCount} wards to ${prefecture} ${city}`);
    }

    return addedCount;
  }

  // ========== 沿线缓存操作 ==========

  /**
   * 获取指定都道府县的所有路线
   */
  async getLines(prefecture) {
    const region = this.getRegionForPrefecture(prefecture);
    const rows = await db('lines')
      .where({ region, prefecture })
      .distinct('line_name')
      .orderBy('line_name');
    return rows.map(r => r.line_name);
  }

  /**
   * 路線名のエイリアスを解決
   * @param {string} lineName ユーザー入力の路線名
   * @returns {string} REINS正式名
   */
  resolveLineAlias(lineName) {
    // 完全一致
    if (LINE_ALIASES[lineName]) {
      return LINE_ALIASES[lineName];
    }
    // 部分一致（○○線 → ○○線）を試す
    for (const [alias, canonical] of Object.entries(LINE_ALIASES)) {
      if (lineName.includes(canonical)) {
        return canonical;
      }
    }
    return lineName;
  }

  /**
   * 获取指定路线的所有车站（エイリアス対応）
   */
  async getStations(prefecture, lineName) {
    const region = this.getRegionForPrefecture(prefecture);
    // エイリアスを解決
    const resolvedName = this.resolveLineAlias(lineName);

    const rows = await db('lines')
      .where({ region, prefecture, line_name: resolvedName })
      .whereNotNull('station')
      .orderBy('station_order')
      .select('station');

    // 見つからない場合、元の名前でも試す
    if (rows.length === 0 && resolvedName !== lineName) {
      const fallbackRows = await db('lines')
        .where({ region, prefecture, line_name: lineName })
        .whereNotNull('station')
        .orderBy('station_order')
        .select('station');
      return fallbackRows.map(r => r.station);
    }

    return rows.map(r => r.station);
  }

  /**
   * 获取某个都道府县下的所有车站（扁平化）
   */
  async getAllStationsInPrefecture(prefecture) {
    const region = this.getRegionForPrefecture(prefecture);
    const rows = await db('lines')
      .where({ region, prefecture })
      .whereNotNull('station')
      .select('prefecture', 'line_name', 'station')
      .orderBy(['line_name', 'station_order']);

    return rows.map(r => ({
      prefecture: r.prefecture,
      line: r.line_name,
      station: r.station,
      fullPath: `${r.line_name} ${r.station}駅`
    }));
  }

  /**
   * 添加路线和车站到缓存
   */
  async addLine(prefecture, lineName, stations) {
    const region = this.getRegionForPrefecture(prefecture);
    let addedCount = 0;

    for (let i = 0; i < stations.length; i++) {
      const station = stations[i];
      try {
        await db('lines').insert({
          region,
          prefecture,
          line_name: lineName,
          station,
          station_order: i
        });
        addedCount++;
      } catch (error) {
        if (!error.message.includes('UNIQUE constraint') && !error.message.includes('duplicate')) {
          console.error('[ReinsCache] Failed to add station:', error.message);
        }
      }
    }

    if (addedCount > 0) {
      console.log(`[ReinsCache] Added ${addedCount} stations to ${lineName}`);
    }

    return addedCount;
  }

  /**
   * 查找站点属于哪条线路（在指定的候选线路中）
   * @param {string} prefecture - 都道府县
   * @param {string} station - 站点名
   * @param {string[]} candidateLines - 候选线路列表
   * @returns {string|null} - 匹配的线路名，未找到返回 null
   */
  async findLineForStation(prefecture, station, candidateLines) {
    if (!station || !candidateLines || candidateLines.length === 0) {
      return null;
    }

    const region = this.getRegionForPrefecture(prefecture);

    // 清理站名（去除"駅"后缀）
    const cleanStation = station.replace(/駅$/, '');

    // 在候选线路中查找该站点
    const row = await db('lines')
      .where({ region, prefecture, station: cleanStation })
      .whereIn('line_name', candidateLines)
      .first('line_name');

    if (row) {
      return row.line_name;
    }

    // 如果精确匹配失败，尝试模糊匹配
    const fuzzyRow = await db('lines')
      .where({ region, prefecture })
      .where('station', 'like', `%${cleanStation}%`)
      .whereIn('line_name', candidateLines)
      .first('line_name');

    return fuzzyRow ? fuzzyRow.line_name : null;
  }

  // ========== AI推荐用的格式化输出 ==========

  /**
   * 生成给AI参考的所在地选项摘要
   */
  async generateLocationSummaryForAI(prefecture) {
    const towns = await this.getAllTownsInPrefecture(prefecture);
    if (towns.length === 0) {
      return `【${prefecture}の町丁目キャッシュ】\nキャッシュが空です。REINSから取得した選択肢を使用してください。`;
    }

    // 按区分组
    const byWard = {};
    for (const t of towns) {
      if (!byWard[t.ward]) byWard[t.ward] = [];
      byWard[t.ward].push(t.town);
    }

    let summary = `【${prefecture}の町丁目キャッシュ】（${towns.length}件）\n`;
    summary += `以下はREINSで実際に選択可能な町丁目です。推薦する際はこのリストから選んでください。\n\n`;

    for (const [ward, wardTowns] of Object.entries(byWard)) {
      summary += `■ ${ward}\n`;
      summary += `  ${wardTowns.slice(0, 30).join(', ')}`;
      if (wardTowns.length > 30) {
        summary += ` ... 他${wardTowns.length - 30}件`;
      }
      summary += '\n';
    }

    return summary;
  }

  /**
   * 生成给AI参考的沿线选项摘要
   */
  async generateLineSummaryForAI(prefecture) {
    const stations = await this.getAllStationsInPrefecture(prefecture);
    if (stations.length === 0) {
      return `【${prefecture}の沿線キャッシュ】\nキャッシュが空です。REINSから取得した選択肢を使用してください。`;
    }

    // 按路线分组
    const byLine = {};
    for (const s of stations) {
      if (!byLine[s.line]) byLine[s.line] = [];
      byLine[s.line].push(s.station);
    }

    let summary = `【${prefecture}の沿線キャッシュ】（${Object.keys(byLine).length}路線、${stations.length}駅）\n`;
    summary += `以下はREINSで実際に選択可能な沿線・駅です。推薦する際はこのリストから選んでください。\n\n`;

    for (const [line, lineStations] of Object.entries(byLine)) {
      summary += `■ ${line}\n`;
      summary += `  ${lineStations.join(', ')}\n`;
    }

    return summary;
  }

  // ========== 统计信息 ==========

  async getStats() {
    const locationStats = await db('locations')
      .select(
        db.raw('COUNT(DISTINCT region) as regions'),
        db.raw('COUNT(DISTINCT prefecture) as prefectures'),
        db.raw('COUNT(DISTINCT ward) as wards'),
        db.raw('COUNT(DISTINCT town) as towns')
      )
      .first();

    const lineStats = await db('lines')
      .select(
        db.raw('COUNT(DISTINCT line_name) as lines'),
        db.raw('COUNT(DISTINCT station) as stations')
      )
      .first();

    return {
      location: {
        regions: locationStats?.regions || 0,
        prefectures: locationStats?.prefectures || 0,
        wards: locationStats?.wards || 0,
        towns: locationStats?.towns || 0
      },
      line: {
        lines: lineStats?.lines || 0,
        stations: lineStats?.stations || 0
      }
    };
  }

  // ========== JSON迁移 ==========

  /**
   * 从JSON文件迁移数据（如果需要）
   */
  async migrateFromJsonIfNeeded() {
    // 检查是否已迁移
    const migrated = await db('metadata')
      .where({ key: 'json_migrated' })
      .first();

    if (migrated) {
      return;
    }

    const locationJsonPath = path.join(this.dataDir, 'reins-location-cache.json');
    const lineJsonPath = path.join(this.dataDir, 'reins-line-cache.json');

    let migratedAny = false;

    // 迁移所在地缓存
    if (fs.existsSync(locationJsonPath)) {
      console.log('[ReinsCache] Migrating location data from JSON...');
      try {
        const data = JSON.parse(fs.readFileSync(locationJsonPath, 'utf-8'));
        await this.migrateLocationJson(data);
        migratedAny = true;
      } catch (error) {
        console.error('[ReinsCache] Location migration failed:', error.message);
      }
    }

    // 迁移沿線缓存
    if (fs.existsSync(lineJsonPath)) {
      console.log('[ReinsCache] Migrating line data from JSON...');
      try {
        const data = JSON.parse(fs.readFileSync(lineJsonPath, 'utf-8'));
        await this.migrateLineJson(data);
        migratedAny = true;
      } catch (error) {
        console.error('[ReinsCache] Line migration failed:', error.message);
      }
    }

    if (migratedAny) {
      // 标记迁移完成
      await db('metadata').insert({
        key: 'json_migrated',
        value: new Date().toISOString()
      });
      console.log('[ReinsCache] JSON migration completed');

      // 备份并删除旧文件
      if (fs.existsSync(locationJsonPath)) {
        fs.renameSync(locationJsonPath, locationJsonPath + '.bak');
      }
      if (fs.existsSync(lineJsonPath)) {
        fs.renameSync(lineJsonPath, lineJsonPath + '.bak');
      }
      console.log('[ReinsCache] Old JSON files backed up');
    }
  }

  /**
   * 迁移所在地JSON数据
   */
  async migrateLocationJson(data) {
    const structure = data.structure || {};

    // 处理v2.0格式（4地方制）
    for (const [regionOrPref, regionData] of Object.entries(structure)) {
      if (['東日本', '中部圏', '近畿圏', '西日本'].includes(regionOrPref)) {
        // v2.0格式
        for (const [prefecture, prefData] of Object.entries(regionData)) {
          await this.migratePrefectureData(regionOrPref, prefecture, prefData);
        }
      } else {
        // v1.0格式（旧格式）
        const region = this.getRegionForPrefecture(regionOrPref);
        await this.migratePrefectureData(region, regionOrPref, regionData);
      }
    }
  }

  /**
   * 迁移单个都道府县数据
   */
  async migratePrefectureData(region, prefecture, prefData) {
    if (!prefData || !prefData.regions) return;

    for (const [city, cityData] of Object.entries(prefData.regions)) {
      if (!cityData || !cityData.wards) continue;

      for (const [ward, wardData] of Object.entries(cityData.wards)) {
        if (wardData && wardData.towns && wardData.towns.length > 0) {
          await this.addTowns(prefecture, city, ward, wardData.towns);
        } else {
          // 没有町丁目的区也要记录
          await this.addWards(prefecture, city, [ward]);
        }
      }
    }
  }

  /**
   * 迁移沿線JSON数据
   */
  async migrateLineJson(data) {
    const structure = data.structure || {};

    for (const [prefecture, prefData] of Object.entries(structure)) {
      if (!prefData || !prefData.lines) continue;

      for (const [lineName, lineData] of Object.entries(prefData.lines)) {
        if (lineData && lineData.stations && lineData.stations.length > 0) {
          await this.addLine(prefecture, lineName, lineData.stations);
        }
      }
    }
  }
}

// 单例模式
const instance = new ReinsCacheService();

// 导出前初始化
module.exports = {
  // 异步初始化
  async initialize() {
    await instance.initialize();
    return instance;
  },

  // 同步方法（用于获取region）
  getRegionForPrefecture: (pref) => instance.getRegionForPrefecture(pref),
  resolveLineAlias: (line) => instance.resolveLineAlias(line),

  // 异步方法代理
  getCities: (...args) => instance.getCities(...args),
  getWards: (...args) => instance.getWards(...args),
  getTowns: (...args) => instance.getTowns(...args),
  getAllTownsInPrefecture: (...args) => instance.getAllTownsInPrefecture(...args),
  addTowns: (...args) => instance.addTowns(...args),
  addWards: (...args) => instance.addWards(...args),
  getLines: (...args) => instance.getLines(...args),
  getStations: (...args) => instance.getStations(...args),
  getAllStationsInPrefecture: (...args) => instance.getAllStationsInPrefecture(...args),
  addLine: (...args) => instance.addLine(...args),
  findLineForStation: (...args) => instance.findLineForStation(...args),
  generateLocationSummaryForAI: (...args) => instance.generateLocationSummaryForAI(...args),
  generateLineSummaryForAI: (...args) => instance.generateLineSummaryForAI(...args),
  getStats: (...args) => instance.getStats(...args)
};
