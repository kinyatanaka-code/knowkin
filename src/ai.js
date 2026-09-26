import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

// AI_PROVIDER で使うAIを切り替える。none（既定）ならサーバー側でAIを使わず、Claude.aiとの会話の中で整理する。OpenAI・Gemini・DeepSeekはOpenAI互換のAPIで呼ぶ
const PRESETS = {
  none: { keyEnv: null, model: '（AIなし：Claudeとの会話で整理）' },
  anthropic: { keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5-20251001' },
  openai: { keyEnv: 'OPENAI_API_KEY', model: 'gpt-4.1-mini' },
  gemini: { keyEnv: 'GEMINI_API_KEY', model: 'gemini-2.5-flash', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  deepseek: { keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com' },
};

export const provider = (process.env.AI_PROVIDER || 'none').toLowerCase();
const preset = PRESETS[provider];
if (!preset) {
  console.error(`AI_PROVIDER は ${Object.keys(PRESETS).join(' / ')} のどれかにしてください（今は "${provider}"）`);
  process.exit(1);
}
export const apiKeyEnv = preset.keyEnv;
export const aiEnabled = provider !== 'none';
export const model = process.env.AI_MODEL || (provider === 'anthropic' && process.env.CLAUDE_MODEL) || preset.model;

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env[apiKeyEnv];
  client = provider === 'anthropic'
    ? new Anthropic({ apiKey })
    : new OpenAI({ apiKey, baseURL: process.env.AI_BASE_URL || preset.baseURL });
  return client;
}

/** プロンプトを1回投げて、返ってきた文章を返す */
export async function complete(prompt, maxTokens = 4000) {
  if (!aiEnabled) throw new Error('AIなしモードです');
  const c = getClient();
  if (provider === 'anthropic') {
    const msg = await c.messages.create({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const res = await c.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });
  return res.choices?.[0]?.message?.content || '';
}
