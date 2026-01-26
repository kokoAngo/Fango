/**
 * Knex 配置文件
 * 支持开发环境(SQLite)和生产环境(PostgreSQL)切换
 */

const path = require('path');

module.exports = {
  // 开发环境 - SQLite
  development: {
    client: 'better-sqlite3',
    connection: {
      filename: path.join(__dirname, 'data', 'reins-cache.db')
    },
    useNullAsDefault: true,
    migrations: {
      directory: path.join(__dirname, 'db', 'migrations')
    },
    seeds: {
      directory: path.join(__dirname, 'db', 'seeds')
    }
  },

  // 生产环境 - PostgreSQL (Docker部署时使用)
  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'fango',
      password: process.env.DB_PASSWORD || 'fango',
      database: process.env.DB_NAME || 'fango'
    },
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      directory: path.join(__dirname, 'db', 'migrations')
    },
    seeds: {
      directory: path.join(__dirname, 'db', 'seeds')
    }
  },

  // 测试环境 - 内存SQLite
  test: {
    client: 'better-sqlite3',
    connection: {
      filename: ':memory:'
    },
    useNullAsDefault: true,
    migrations: {
      directory: path.join(__dirname, 'db', 'migrations')
    }
  }
};
