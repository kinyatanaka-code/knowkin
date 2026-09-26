import express from 'express';
import multer from 'multer';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { migrate } from './db.js';
import { BUILD_TAG } from './build.js';
import { apiKeyEnv, provider, model, aiEnabled } from './ai.js';
import {
  addMemo, addVoice, classifyMemoById, deleteUnit, getState, growCore, growCoresIfChanged, updateUnit, coreText, getCore, getOpenTasks,
} from './brain.js';
import {
  changePassword, clearFailures, createSession, createUser, destroySession, firstUser, getLinkToken, login, noteFailure,
  rotateLinkToken, signupState, tooManyAttempts, userFromLinkToken, userFromSession,
} from './auth.js';
import { buildMcpServer } from './mcp.js';

const { MCP_SECRET, PORT = 3000 } = process.env;
for (const k of ['DATABASE_URL', apiKeyEnv].filter(Boolean)) {
  if (!process.env[k]) { console.error(`環境変数 ${k} が設定されていません`); process.exit(1); }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
const dir = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(dir, '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, build: BUILD_TAG }));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message || 'サーバーでエラーが起きました' });
});

// ---- セッション（クッキー） ----
const COOKIE = 'kk_session';
function readCookie(req, name) {
  const m = (req.get('cookie') || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function setSessionCookie(req, res, token, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
async function currentUser(req) {
  const h = req.get('authorization') || '';
  if (h.startsWith('Bearer ')) return userFromLinkToken(h.slice(7));
  return userFromSession(readCookie(req, COOKIE));
}

// ---- アカウント ----
const authApi = express.Router();
authApi.get('/status', wrap(async (req, res) => {
  const user = await currentUser(req);
  res.json({ user, signup: await signupState() });
}));
authApi.post('/signup', wrap(async (req, res) => {
  try {
    const user = await createUser(req.body || {});
    const s = await createSession(user.id);
    setSessionCookie(req, res, s.token, s.maxAge);
    res.json({ user });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
authApi.post('/login', wrap(async (req, res) => {
  if (tooManyAttempts(req.ip)) return res.status(429).json({ error: 'ログインの失敗が続いたため、15分ほど待ってからお試しください' });
  const user = await login(req.body?.email, req.body?.password);
  if (!user) { noteFailure(req.ip); return res.status(401).json({ error: 'メールアドレスかパスワードが違います' }); }
  clearFailures(req.ip);
  const s = await createSession(user.id);
  setSessionCookie(req, res, s.token, s.maxAge);
  res.json({ user });
}));
authApi.post('/logout', wrap(async (req, res) => {
  await destroySession(readCookie(req, COOKIE));
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
}));
app.use('/api/auth', authApi);

// ---- ログインが必要なAPI ----
const api = express.Router();
api.use((req, res, next) => {
  currentUser(req).then((user) => {
    if (!user) return res.status(401).json({ error: 'ログインしてください' });
    req.user = user; req.uid = user.id;
    next();
  }).catch(next);
});
api.get('/state', wrap(async (req, res) => res.json({ ...(await getState(req.uid)), aiEnabled, user: req.user })));
api.post('/memos', wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '内容が空です' });
  const source = req.body?.source === 'voice' ? 'voice' : 'text';
  res.json(await addMemo(req.uid, text, source));
}));
api.post('/memos/:id/classify', wrap(async (req, res) => res.json(await classifyMemoById(req.uid, Number(req.params.id)))));
api.patch('/units/:id', wrap(async (req, res) => {
  const u = await updateUnit(req.uid, Number(req.params.id), req.body || {});
  if (!u) return res.status(404).json({ error: '見つかりません' });
  res.json(u);
}));
api.delete('/units/:id', wrap(async (req, res) => { await deleteUnit(req.uid, Number(req.params.id)); res.json({ ok: true }); }));
api.post('/core/grow', wrap(async (req, res) => {
  const core = await growCore(req.uid);
  if (!core) return res.status(400).json({ error: '教訓・判断・価値観などが3つ以上たまってから育ててください' });
  res.json(core);
}));
api.get('/handoff', wrap(async (req, res) => res.type('text/plain').send(coreText(await getCore(req.uid), await getOpenTasks(req.uid)))));
api.get('/account', wrap(async (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  const key = await getLinkToken(req.uid);
  res.json({ user: req.user, mcpUrl: `${base}/mcp/${key}`, voiceUrl: `${base}/api/voice`, key });
}));
api.post('/account/rotate', wrap(async (req, res) => { await rotateLinkToken(req.uid); res.json({ ok: true }); }));
api.post('/account/password', wrap(async (req, res) => {
  try { await changePassword(req.uid, req.body?.current, req.body?.next); } catch (e) { return res.status(400).json({ error: e.message }); }
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
}));

// 録音・ボイスメモ（Web画面から、またはショートカットから Bearer <連携キー> で送る）
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
api.post('/voice', (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ファイルが大きすぎます（100MBまで）' : 'ファイルを受け取れませんでした' });
  next();
}), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '音声ファイル（file）がありません' });
  res.json(await addVoice(req.uid, req.file.buffer, req.file.originalname || 'memo.m4a', req.file.mimetype));
}));
app.use('/api', api);

// ---- MCP（Claude.aiのコネクタ用）: URLの連携キーでアカウントを特定 ----
async function mcpUser(key) {
  if (MCP_SECRET && key === MCP_SECRET) return firstUser(); // アカウント機能を入れる前に登録したコネクタURL
  return userFromLinkToken(key);
}
app.post('/mcp/:key', async (req, res) => {
  try {
    const user = await mcpUser(req.params.key);
    if (!user) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown connector URL' }, id: null });
    const server = buildMcpServer(user.id);
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
app.get('/mcp/:key', notAllowed);
app.delete('/mcp/:key', notAllowed);

// ---- 夜間バッチ：毎日3時（日本時間）に核を育て直す（サーバー側のAIを使う場合のみ） ----
cron.schedule('0 3 * * *', () => {
  growCoresIfChanged().then((n) => n && console.log(`${n}人の核を更新しました`)).catch((e) => console.error('夜間バッチ失敗', e));
}, { timezone: 'Asia/Tokyo' });

await migrate();
app.listen(PORT, () => console.log(`knowkin listening on :${PORT}（AI: ${provider} / ${model} / build ${BUILD_TAG}）`));
