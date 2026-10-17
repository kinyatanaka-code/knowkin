// LINE連携：knowkinのLINE公式アカウントに送ったメッセージ・写真・音声を、未整理のメモとして残す
import crypto from 'node:crypto';
import { pool } from './db.js';
import { addMemo, addPhoto, addVoice } from './brain.js';
import { canSummarizeAudio } from './audio.js';
import { periodOf } from './period.js';

const { LINE_CHANNEL_SECRET = '', LINE_CHANNEL_ACCESS_TOKEN = '', LINE_ADD_URL = '' } = process.env;
export const lineEnabled = Boolean(LINE_CHANNEL_SECRET && LINE_CHANNEL_ACCESS_TOKEN);
export const lineAddUrl = LINE_ADD_URL;

export function verifySignature(raw, signature) {
  if (!lineEnabled || !signature) return false;
  const mac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(raw).digest('base64');
  const a = Buffer.from(mac), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function reply(token, text) {
  if (!token) return;
  try {
    await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ replyToken: token, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
    });
  } catch (e) { console.error('LINE reply', e.message); }
}

async function content(messageId) {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`LINEから受け取れませんでした（${r.status}）`);
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || '' };
}

// ---- アカウントとの紐づけ ----
export async function issueCode(uid) {
  const code = String(crypto.randomInt(100000, 1000000));
  await pool.query(`UPDATE users SET line_code = $1, line_code_expires = now() + interval '15 minutes' WHERE id = $2`, [code, uid]);
  return code;
}
export async function lineStatus(uid) {
  const { rows } = await pool.query('SELECT line_user_id FROM users WHERE id = $1', [uid]);
  return { enabled: lineEnabled, linked: Boolean(rows[0]?.line_user_id), addUrl: lineAddUrl };
}
export async function unlinkLine(uid) {
  await pool.query('UPDATE users SET line_user_id = NULL, line_code = NULL WHERE id = $1', [uid]);
}
async function userByLine(lineId) {
  const { rows } = await pool.query('SELECT id FROM users WHERE line_user_id = $1', [lineId]);
  return rows[0]?.id || null;
}
async function linkByCode(lineId, code) {
  const { rows } = await pool.query(
    `UPDATE users SET line_user_id = $1, line_code = NULL
     WHERE line_code = $2 AND line_code_expires > now() RETURNING id`, [lineId, code]);
  return rows[0]?.id || null;
}

// ---- 「タスク」と送られたときの返事 ----
async function tasksText(uid) {
  const today = periodOf('day');
  const { rows } = await pool.query(
    `SELECT content, to_char(due, 'MM/DD') AS d, due < $2::date AS late FROM units
     WHERE user_id = $1 AND type = 'task' AND NOT done
       AND ((due IS NOT NULL AND due <= $2::date) OR (scope = 'day' AND period <= $3) OR (scope = 'week' AND period = $4))
     ORDER BY due NULLS LAST, created_at LIMIT 10`, [uid, today, today, periodOf('week')]);
  if (!rows.length) return '今日と今週のタスクはありません。';
  return ['今日・今週のタスク', ...rows.map((t) => `・${t.content}${t.d ? `（${t.d}${t.late ? ' 期限切れ' : ''}）` : ''}`)].join('\n');
}

const HELP = 'knowkinのLINEです。\n・メッセージ・写真を送ると、knowkinに未整理のメモとして残ります\n・「タスク」と送ると、今日と今週のタスクを返します';

export async function handleEvents(events = []) {
  for (const ev of events) {
    try {
      const lineId = ev.source?.userId;
      if (!lineId) continue;
      if (ev.type === 'follow') {
        await reply(ev.replyToken, 'knowkinとつなぐには、knowkinのアカウント画面で「LINEの連携コードを出す」を押し、表示された6桁の数字をここに送ってください。');
        continue;
      }
      if (ev.type !== 'message') continue;
      const m = ev.message || {};
      let uid = await userByLine(lineId);
      if (!uid) {
        const code = m.type === 'text' ? String(m.text || '').trim() : '';
        if (/^\d{6}$/.test(code) && (uid = await linkByCode(lineId, code))) await reply(ev.replyToken, `knowkinとつながりました。\n${HELP}`);
        else await reply(ev.replyToken, 'まだknowkinとつながっていません。knowkinのアカウント画面で連携コードを出し、6桁の数字を送ってください。');
        continue;
      }
      if (m.type === 'text') {
        const t = String(m.text || '').trim();
        if (!t) continue;
        if (/^(タスク|今日|今日のタスク)$/.test(t)) { await reply(ev.replyToken, await tasksText(uid)); continue; }
        if (/^(ヘルプ|使い方)$/.test(t)) { await reply(ev.replyToken, HELP); continue; }
        const r = await addMemo(uid, t, 'line', null, `line:${m.id}`);
        await reply(ev.replyToken, r?.duplicate ? 'このメッセージはもう残っています。' : '📝 knowkinに残しました');
      } else if (m.type === 'image') {
        const { buffer, mime } = await content(m.id);
        await addPhoto(uid, buffer, mime, '（LINEから送った写真）');
        await reply(ev.replyToken, '📷 写真をknowkinに残しました。次の整理で読み取ります');
      } else if (m.type === 'audio') {
        if (!canSummarizeAudio) { await reply(ev.replyToken, '音声はまだ受け取れません（knowkinにAIのキーが入っていないため）。文字で送るか、ボイスメモの文字起こしを送ってください。'); continue; }
        await reply(ev.replyToken, '🎙 受け取りました。文字起こしして、knowkinに残します');
        const { buffer, mime } = await content(m.id);
        await addVoice(uid, buffer, 'line.m4a', mime || 'audio/m4a');
      } else {
        await reply(ev.replyToken, 'この種類はまだ受け取れません。文字か写真で送ってください。');
      }
    } catch (e) {
      console.error('LINE event', e);
      await reply(ev.replyToken, `うまく残せませんでした：${e.message}`);
    }
  }
}
