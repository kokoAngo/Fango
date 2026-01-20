/**
 * REINS 缓存服务
 * 管理所在地和沿线的本地缓存，通过实际使用逐步完善
 */

const fs = require('fs');
const path = require('path');

class ReinsCacheService {
  constructor() {
    this.dataDir = path.join(__dirname, '..', 'data');
    this.locationCachePath = path.join(this.dataDir, 'reins-location-cache.json');
    this.lineCachePath = path.join(this.dataDir, 'reins-line-cache.json');

    this.locationCache = null;
    this.lineCache = null;

    this.ensureDataDir();
    this.loadCaches();
  }

  ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  loadCaches() {
    try {
      if (fs.existsSync(this.locationCachePath)) {
        this.locationCache = JSON.parse(fs.readFileSync(this.locationCachePath, 'utf-8'));
      } else {
        this.locationCache = this.createEmptyLocationCache();
        this.saveLocationCache();
      }
    } catch (error) {
      console.error('[ReinsCache] Failed to load location cache:', error.message);
      this.locationCache = this.createEmptyLocationCache();
    }

    try {
      if (fs.existsSync(this.lineCachePath)) {
        this.lineCache = JSON.parse(fs.readFileSync(this.lineCachePath, 'utf-8'));
      } else {
        this.lineCache = this.createEmptyLineCache();
        this.saveLineCache();
      }
    } catch (error) {
      console.error('[ReinsCache] Failed to load line cache:', error.message);
      this.lineCache = this.createEmptyLineCache();
    }

    console.log('[ReinsCache] Caches loaded successfully');
  }

  createEmptyLocationCache() {
    return {
      metadata: {
        description: "REINS所在地选项缓存",
        lastUpdated: null,
        version: "1.0"
      },
      structure: {}
    };
  }

  createEmptyLineCache() {
    return {
      metadata: {
        description: "REINS沿線选项缓存",
        lastUpdated: null,
        version: "1.0"
      },
      structure: {}
    };
  }

  saveLocationCache() {
    try {
      this.locationCache.metadata.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.locationCachePath, JSON.stringify(this.locationCache, null, 2), 'utf-8');
    } catch (error) {
      console.error('[ReinsCache] Failed to save location cache:', error.message);
    }
  }

  saveLineCache() {
    try {
      this.lineCache.metadata.lastUpdated = new Date().toISOString();
      fs.writeFileSync(this.lineCachePath, JSON.stringify(this.lineCache, null, 2), 'utf-8');
    } catch (error) {
      console.error('[ReinsCache] Failed to save line cache:', error.message);
    }
  }

  // ========== 所在地缓存操作 ==========

  /**
   * 获取指定都道府县的所有市区町村
   */
  getCities(prefecture) {
    const prefData = this.locationCache.structure[prefecture];
    if (!prefData || !prefData.regions) return [];
    return Object.keys(prefData.regions);
  }

  /**
   * 获取指定市的所有区（政令指定都市用）
   */
  getWards(prefecture, city) {
    const prefData = this.locationCache.structure[prefecture];
    if (!prefData || !prefData.regions || !prefData.regions[city]) return [];
    const cityData = prefData.regions[city];
    if (!cityData.wards) return [];
    return Object.keys(cityData.wards);
  }

  /**
   * 获取指定区的所有町丁目
   */
  getTowns(prefecture, city, ward) {
    const prefData = this.locationCache.structure[prefecture];
    if (!prefData || !prefData.regions || !prefData.regions[city]) return [];
    const cityData = prefData.regions[city];
    if (!cityData.wards || !cityData.wards[ward]) return [];
    return cityData.wards[ward].towns || [];
  }

  /**
   * 获取某个都道府县下的所有町丁目（扁平化）
   */
  getAllTownsInPrefecture(prefecture) {
    const result = [];
    const prefData = this.locationCache.structure[prefecture];
    if (!prefData || !prefData.regions) return result;

    for (const [city, cityData] of Object.entries(prefData.regions)) {
      if (cityData.wards) {
        for (const [ward, wardData] of Object.entries(cityData.wards)) {
          if (wardData.towns) {
            for (const town of wardData.towns) {
              result.push({
                prefecture,
                city,
                ward,
                town,
                fullPath: `${prefecture} ${ward} ${town}`
              });
            }
          }
        }
      }
    }
    return result;
  }

  /**
   * 添加町丁目到缓存
   */
  addTowns(prefecture, city, ward, towns) {
    if (!this.locationCache.structure[prefecture]) {
      this.locationCache.structure[prefecture] = { regions: {} };
    }
    if (!this.locationCache.structure[prefecture].regions[city]) {
      this.locationCache.structure[prefecture].regions[city] = { wards: {} };
    }
    if (!this.locationCache.structure[prefecture].regions[city].wards[ward]) {
      this.locationCache.structure[prefecture].regions[city].wards[ward] = { towns: [] };
    }

    const existingTowns = this.locationCache.structure[prefecture].regions[city].wards[ward].towns;
    const newTowns = towns.filter(t => !existingTowns.includes(t));

    if (newTowns.length > 0) {
      existingTowns.push(...newTowns);
      existingTowns.sort();
      this.saveLocationCache();
      console.log(`[ReinsCache] Added ${newTowns.length} towns to ${prefecture} ${ward}`);
    }

    return newTowns.length;
  }

  /**
   * 批量添加区到缓存
   */
  addWards(prefecture, city, wards) {
    if (!this.locationCache.structure[prefecture]) {
      this.locationCache.structure[prefecture] = { regions: {} };
    }
    if (!this.locationCache.structure[prefecture].regions[city]) {
      this.locationCache.structure[prefecture].regions[city] = { wards: {} };
    }

    let addedCount = 0;
    for (const ward of wards) {
      if (!this.locationCache.structure[prefecture].regions[city].wards[ward]) {
        this.locationCache.structure[prefecture].regions[city].wards[ward] = { towns: [] };
        addedCount++;
      }
    }

    if (addedCount > 0) {
      this.saveLocationCache();
      console.log(`[ReinsCache] Added ${addedCount} wards to ${prefecture} ${city}`);
    }

    return addedCount;
  }

  // ========== 沿线缓存操作 ==========

  /**
   * 获取指定都道府县的所有路线
   */
  getLines(prefecture) {
    const prefData = this.lineCache.structure[prefecture];
    if (!prefData || !prefData.lines) return [];
    return Object.keys(prefData.lines);
  }

  /**
   * 获取指定路线的所有车站
   */
  getStations(prefecture, line) {
    const prefData = this.lineCache.structure[prefecture];
    if (!prefData || !prefData.lines || !prefData.lines[line]) return [];
    return prefData.lines[line].stations || [];
  }

  /**
   * 获取某个都道府县下的所有车站（扁平化）
   */
  getAllStationsInPrefecture(prefecture) {
    const result = [];
    const prefData = this.lineCache.structure[prefecture];
    if (!prefData || !prefData.lines) return result;

    for (const [line, lineData] of Object.entries(prefData.lines)) {
      if (lineData.stations) {
        for (const station of lineData.stations) {
          result.push({
            prefecture,
            line,
            station,
            fullPath: `${line} ${station}駅`
          });
        }
      }
    }
    return result;
  }

  /**
   * 添加路线和车站到缓存
   */
  addLine(prefecture, line, stations) {
    if (!this.lineCache.structure[prefecture]) {
      this.lineCache.structure[prefecture] = { lines: {} };
    }
    if (!this.lineCache.structure[prefecture].lines[line]) {
      this.lineCache.structure[prefecture].lines[line] = { stations: [] };
    }

    const existingStations = this.lineCache.structure[prefecture].lines[line].stations;
    const newStations = stations.filter(s => !existingStations.includes(s));

    if (newStations.length > 0) {
      existingStations.push(...newStations);
      this.saveLineCache();
      console.log(`[ReinsCache] Added ${newStations.length} stations to ${line}`);
    }

    return newStations.length;
  }

  // ========== AI推荐用的格式化输出 ==========

  /**
   * 生成给AI参考的所在地选项摘要
   */
  generateLocationSummaryForAI(prefecture) {
    const towns = this.getAllTownsInPrefecture(prefecture);
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
  generateLineSummaryForAI(prefecture) {
    const stations = this.getAllStationsInPrefecture(prefecture);
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

  getStats() {
    let totalTowns = 0;
    let totalWards = 0;
    let totalPrefectures = 0;

    for (const [pref, prefData] of Object.entries(this.locationCache.structure)) {
      totalPrefectures++;
      if (prefData.regions) {
        for (const [city, cityData] of Object.entries(prefData.regions)) {
          if (cityData.wards) {
            for (const [ward, wardData] of Object.entries(cityData.wards)) {
              totalWards++;
              if (wardData.towns) {
                totalTowns += wardData.towns.length;
              }
            }
          }
        }
      }
    }

    let totalLines = 0;
    let totalStations = 0;

    for (const [pref, prefData] of Object.entries(this.lineCache.structure)) {
      if (prefData.lines) {
        for (const [line, lineData] of Object.entries(prefData.lines)) {
          totalLines++;
          if (lineData.stations) {
            totalStations += lineData.stations.length;
          }
        }
      }
    }

    return {
      location: {
        prefectures: totalPrefectures,
        wards: totalWards,
        towns: totalTowns
      },
      line: {
        lines: totalLines,
        stations: totalStations
      }
    };
  }
}

// 单例模式
const instance = new ReinsCacheService();
module.exports = instance;
