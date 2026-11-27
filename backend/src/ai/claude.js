import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client;
let override = null;
/** Tests / offline dev can inject a fake: fn({system, prompt}) => string */
export function setAiOverride(fn) { override = fn; }
export const aiAvailable = () => Boolean(override || config.ai.apiKey);

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start < 0) throw new Error('AI did not return JSON');
  const open = raw[start]; const close = open === '{' ? '}' : ']';
  const end = raw.lastIndexOf(close);
  return JSON.parse(raw.slice(start, end + 1));
}

export async function askJson({ system, prompt, maxTokens = 2000, images = [] }) {
  if (override) return extractJson(await override({ system, prompt, images }));
  if (!config.ai.apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  if (!client) client = new Anthropic({ apiKey: config.ai.apiKey });
  const content = [
    ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } })),
    { type: 'text', text: prompt },
  ];
  const res = await client.messages.create({
    model: config.ai.model,
    max_tokens: maxTokens,
    system: `${system}\nReply with JSON only, no prose.`,
    messages: [{ role: 'user', content }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJson(text);
}
