import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const PORT = 3000;

app.use(express.static('public'));

app.use('/', createProxyMiddleware({
  target: 'https://duckduckgo.com',
  changeOrigin: true,
  pathRewrite: { '^/proxy': '' },
  selfHandleResponse: false,
  on: {
    proxyRes: (proxyRes) => {
      // Remove security headers that block loading
      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['x-frame-options'];
    }
  }
}));

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
});