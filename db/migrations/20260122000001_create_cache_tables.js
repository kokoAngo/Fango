/**
 * REINS缓存表迁移
 *
 * 所在地缓存: locations
 * 沿線缓存: lines
 */

exports.up = function(knex) {
  return knex.schema
    // 所在地缓存表
    .createTable('locations', (table) => {
      table.increments('id').primary();
      table.string('region', 20).notNullable();        // 地方: 東日本/中部圏/近畿圏/西日本
      table.string('prefecture', 20).notNullable();    // 都道府県
      table.string('city', 50);                         // 地域区分/市
      table.string('ward', 50);                         // 区
      table.string('town', 100);                        // 町丁目
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      // 索引
      table.index('region');
      table.index('prefecture');
      table.index(['prefecture', 'city']);
      table.index(['prefecture', 'city', 'ward']);

      // 唯一约束 - 防止重复
      table.unique(['region', 'prefecture', 'city', 'ward', 'town']);
    })

    // 沿線缓存表
    .createTable('lines', (table) => {
      table.increments('id').primary();
      table.string('region', 20).notNullable();        // 地方
      table.string('prefecture', 20).notNullable();    // 都道府県
      table.string('line_name', 100).notNullable();    // 路線名
      table.string('station', 50);                      // 駅名
      table.integer('station_order');                   // 駅の順序
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      // 索引
      table.index('region');
      table.index('prefecture');
      table.index('line_name');
      table.index(['prefecture', 'line_name']);

      // 唯一约束
      table.unique(['region', 'prefecture', 'line_name', 'station']);
    })

    // 元数据表
    .createTable('metadata', (table) => {
      table.string('key', 50).primary();
      table.text('value');
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('metadata')
    .dropTableIfExists('lines')
    .dropTableIfExists('locations');
};
