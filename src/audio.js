import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const AUDIO_MODEL = process.env.AUDIO_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
export const canSummarizeAudio = Boolean(GEMINI_KEY);

/** どんな形式の音声でも 16kHz・モノラル・32kbps のmp3にする（1分あたり約0.24MB） */
export async function toMp3(buffer) {
  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `${id}.in`);
  const outPath = path.join(os.tmpdir(), `${id}.mp3`);
  await fs.writeFile(inPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-y', '-i', inPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', outPath]);
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('音声ファイルを読み込めませんでした（形式を確認してください）\n' + err.slice(-300)))));
    });
    return await fs.readFile(outPath);
  } finally {
    await fs.rm(inPath, { force: true });
    await fs.rm(outPath, { force: true });
  }
}

/** 音声をGeminiに渡し、プロンプトに従ったJSONを返す */
export async function askAudioJSON(buffer, prompt, onStage = () => {}) {
  if (!canSummarizeAudio) throw new Error('録音の要約には GEMINI_API_KEY の設定が必要です');
  onStage('convert');
  const mp3 = await toMp3(buffer);
  if (mp3.length > 19 * 1024 * 1024) throw new Error('録音が長すぎます（目安は80分まで）。分けてアップロードしてください');
  onStage('ai', { minutes: Math.max(1, Math.round(mp3.length / (0.24 * 1024 * 1024))) });
  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${AUDIO_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/mp3', data: mp3.toString('base64') } }, { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = res.status === 400 || res.status === 403 ? 'GEMINI_API_KEY が正しいか確認してください'
      : res.status === 429 ? '利用上限に達しました。少し時間をおいてから試してください'
        : (body?.error?.message || '');
    throw new Error(`要約に失敗しました（Gemini ${res.status}）。${why}`);
  }
  const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('要約の結果を読み取れませんでした');
  return JSON.parse(m[0]);
}
