/**
 * 数据库连接管理
 * 根据环境自动选择 SQLite 或 PostgreSQL
 */

const knex = require('knex');
const config = require('../knexfile');

const environment = process.env.NODE_ENV || 'development';
const connectionConfig = config[environment];

if (!connectionConfig) {
  throw new Error(`Database configuration not found for environment: ${environment}`);
}

const db = knex(connectionConfig);

// 初始化数据库（运行迁移）
async function initDatabase() {
  try {
    // 检查并运行迁移
    const [batchNo, log] = await db.migrate.latest();
    if (log.length > 0) {
      console.log(`[Database] Migrations run: ${log.join(', ')}`);
    } else {
      console.log('[Database] Database is up to date');
    }
    return true;
  } catch (error) {
    console.error('[Database] Migration failed:', error.message);
    throw error;
  }
}

// 关闭数据库连接
async function closeDatabase() {
  await db.destroy();
}

module.exports = {
  db,
  initDatabase,
  closeDatabase
};
