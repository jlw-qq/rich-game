import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // 只监听本机，不暴露到局域网
    host: 'localhost',
    port: 5173,
  },
  test: {
    // 逻辑层是纯 JS，用 node 环境跑即可，无需 DOM
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
