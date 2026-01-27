module.exports = {
  apps: [
    {
      name: 'elevator-fm',
      script: 'src/index.js',
      cwd: '/root/projects/discord-music-bot',
      watch: false,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
