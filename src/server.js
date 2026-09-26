import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { migrate } from './db.js';
import { BUILD_TAG } from './build.js';
import { apiKeyEnv, provider, model, aiEnabled } from './ai.js';
import {
  addMemo, addVoice, classifyMemoById, deleteUnit, getState, growCore, growCoreIfChanged, updateUnit, coreText, getCore, getOpenTasks,
} from './brain.js';
import { buildMcpServer } from './mcp.js';

const { APP_TOKEN, MCP_SECRET, PORT = 3000 } = process.env;
for (const k of ['DATABASE_URL', apiKeyEnv, 'APP_TOKEN', 'MCP_SECRET'].filter(Boolean)) {
  if (!process.env[k]) { console.error(`環境変数 ${k} が設定されていません`); process.exit(1); }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
const dir = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(dir, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, build: BUILD_TAG }));

// ---- 認証（Web画面・API用） ----
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!safeEqual(token, APP_TOKEN)) return res.status(401).json({ error: 'トークンが違います' });
  next();
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message || 'サーバーでエラーが起きました' });
});

// ---- REST API ----
const api = express.Router();
api.use(auth);
api.get('/state', wrap(async (_req, res) => res.json({ ...(await getState()), aiEnabled })));
api.post('/memos', wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '内容が空です' });
  res.json(await addMemo(text, 'text'));
}));
api.post('/memos/:id/classify', wrap(async (req, res) => res.json(await classifyMemoById(Number(req.params.id)))));
api.patch('/units/:id', wrap(async (req, res) => {
  const u = await updateUnit(Number(req.params.id), req.body || {});
  if (!u) return res.status(404).json({ error: '見つかりません' });
  res.json(u);
}));
api.delete('/units/:id', wrap(async (req, res) => { await deleteUnit(Number(req.params.id)); res.json({ ok: true }); }));
api.post('/core/grow', wrap(async (_req, res) => {
  const core = await growCore();
  if (!core) return res.status(400).json({ error: '教訓・判断・価値観などが3つ以上たまってから育ててください' });
  res.json(core);
}));
api.get('/handoff', wrap(async (_req, res) => res.type('text/plain').send(coreText(await getCore(), await getOpenTasks()))));

// 録音・ボイスメモ（Web画面やiPhoneショートカットから multipart の "file" で送る）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
api.post('/voice', (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ファイルが大きすぎます（100MBまで）' : 'ファイルを受け取れませんでした' });
  next();
}), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '音声ファイル（file）がありません' });
  res.json(await addVoice(req.file.buffer, req.file.originalname || 'memo.m4a', req.file.mimetype));
}));
app.use('/api', api);

// ---- MCP（Claude.aiのコネクタ用）: URLの秘密の文字列で保護 ----
const mcpPath = `/mcp/${MCP_SECRET}`;
app.post(mcpPath, async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
app.get(mcpPath, notAllowed);
app.delete(mcpPath, notAllowed);

// ---- 夜間バッチ：毎日3時（日本時間）に核を育て直す ----
cron.schedule('0 3 * * *', () => {
  growCoreIfChanged().then((c) => c && console.log('核を更新しました')).catch((e) => console.error('夜間バッチ失敗', e));
}, { timezone: 'Asia/Tokyo' });

await migrate();
app.listen(PORT, () => console.log(`knowkin listening on :${PORT}（AI: ${provider} / ${model} / build ${BUILD_TAG}）`));
