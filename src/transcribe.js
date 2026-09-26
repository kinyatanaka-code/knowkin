import OpenAI, { toFile } from 'openai';

export const canTranscribe = Boolean(process.env.OPENAI_API_KEY);

export async function transcribe(buffer, filename = 'memo.m4a', mimetype = 'audio/m4a') {
  if (!canTranscribe) throw new Error('OPENAI_API_KEY が設定されていないため、文字起こしできません');
  const client = new OpenAI();
  const file = await toFile(buffer, filename, { type: mimetype });
  const res = await client.audio.transcriptions.create({
    file,
    model: process.env.TRANSCRIBE_MODEL || 'whisper-1',
    language: 'ja',
  });
  return (res.text || '').trim();
}
