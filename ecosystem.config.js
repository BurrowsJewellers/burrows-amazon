// pm2 config, matching how ring-builder-api and dropship-sync already run on the droplet.
module.exports = {
  apps: [
    {
      name: 'burrows-amazon',
      cwd: '/opt/burrows-amazon',
      script: 'src/server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
