'use strict';
const { Pool } = require('pg');
const config = require('./config');

/**
 * One pool, shared. This database belongs to the Laravel sync app: the store mirror
 * (shopify_products, shopify_product_variants, shopify_inventory_levels) is READ ONLY
 * to us. We write only to our own amazon_* tables.
 */
const pool = new Pool({ ...config.db, max: 8, idleTimeoutMillis: 30000 });

pool.on('error', (err) => console.error('[db] idle client error', err.message));

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
