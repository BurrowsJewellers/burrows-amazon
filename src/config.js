'use strict';
require('dotenv').config();

const need = (key) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing ${key} in .env`);
  return v;
};

module.exports = {
  port: Number(process.env.PORT || 3200),
  basePath: process.env.BASE_PATH || '/amazon',

  // Nothing is ever written to Amazon while this is false.
  channelEnabled: String(process.env.AMAZON_CHANNEL_ENABLED || 'false') === 'true',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: need('DB_DATABASE'),
    user: need('DB_USERNAME'),
    password: process.env.DB_PASSWORD || '',
  },

  amazon: {
    clientId: need('AMAZON_LWA_CLIENT_ID'),
    clientSecret: need('AMAZON_LWA_CLIENT_SECRET'),
    refreshToken: need('AMAZON_REFRESH_TOKEN'),
    marketplaceId: process.env.AMAZON_MARKETPLACE_ID || 'A39IBJ37TRP1C6', // Amazon.com.au
    sellerId: process.env.AMAZON_SELLER_ID || '',
    endpoint: process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-fe.amazon.com',
  },

  // A listing that cannot clear this margin after Amazon's cut is not listed.
  // Set by the owner; zero means the floor is not yet agreed and pushing stays off.
  minMarginPct: Number(process.env.AMAZON_MIN_MARGIN_PCT || 0),
};
