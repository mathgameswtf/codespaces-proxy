import express from 'express';
import { createProxyMiddleware } from 'express-http-proxy';

const app = express();
const PORT = 3000;

// Serve static files
app.use(express.static('public'));

// Proxy requests to google.com
app.use('/proxy', createProxyMiddleware({
    target: 'https://www.google.com',
    changeOrigin: true,
    pathRewrite: {
        '^/proxy': ''
    }
}));

app.listen(PORT, () => {
    console.log(`Proxy server running on http://localhost:${PORT}`);
});