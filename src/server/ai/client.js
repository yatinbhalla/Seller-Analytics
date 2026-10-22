import { GoogleGenerativeAI } from '@google/generative-ai';

// Same fallback strategy as the listers' src/ai/client.js: free-tier model
// availability varies by account and region, so try the list in order and cache the
// first that works. The two marked verified were called successfully on the seller's
// key on 2026-10-20 (per the Flipkart lister).
const MODEL_FALLBACK = [
  'gemini-3.5-flash-lite', // verified
  'gemini-flash-lite-latest',
  'gemini-flash-latest', // verified
  'gemini-2.0-flash',
];

const MAX_RETRIES = 2;
const MAX_TOOL_ROUNDS = 6;
let _client = null;
let _workingModel = null;

export function aiConfigured() {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key !== 'your_gemini_api_key_here');
}

function getClient() {
  if (!aiConfigured()) {
    const err = new Error('No Gemini API key. Put GEMINI_API_KEY in .env — get one at https://aistudio.google.com/app/apikey');
    err.code = 'NO_KEY';
    throw err;
  }
  if (!_client) _client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return _client;
}

function candidates() {
  const list = [];
  if (_workingModel) list.push(_workingModel);
  if (process.env.GEMINI_MODEL && !list.includes(process.env.GEMINI_MODEL)) list.push(process.env.GEMINI_MODEL);
  for (const m of MODEL_FALLBACK) if (!list.includes(m)) list.push(m);
  return list;
}

/** One JSON answer from a prompt — for the digest and the return-reason themes. */
export async function callGeminiJSON(prompt, opts = {}) {
  const client = getClient();
  for (const modelName of candidates()) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction: opts.system,
        generationConfig: { responseMimeType: 'application/json', temperature: opts.temperature ?? 0.3 },
      });
      const result = await withRetry(() => model.generateContent(prompt));
      _workingModel = modelName;
      return parseJSON(result.response.text());
    } catch (err) {
      if (err.code === 'MODEL_NOT_ACCESSIBLE') continue;
      throw new Error(friendly(err));
    }
  }
  throw new Error(`No accessible Gemini model for this key. Tried: ${candidates().join(', ')}`);
}

/**
 * A chat turn with function calling. Gemini may call the given tools (the app's own
 * metric functions) as many times as it needs, up to MAX_TOOL_ROUNDS; their results go
 * back to it and it writes the answer from them. It is told never to state a number
 * that did not come from a tool — the AI explains, the app calculates.
 *
 * tools: { name: { description, parameters (JSON schema), run(args) } }
 */
export async function chatWithTools({ system, history = [], message, tools }) {
  const client = getClient();
  const declarations = Object.entries(tools).map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }));
  for (const modelName of candidates()) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction: system,
        tools: [{ functionDeclarations: declarations }],
        generationConfig: { temperature: 0.2 },
      });
      const chat = model.startChat({ history });
      let result = await withRetry(() => chat.sendMessage(message));
      const used = [];
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const calls = result.response.functionCalls() || [];
        if (!calls.length) break;
        const responses = [];
        for (const call of calls) {
          const tool = tools[call.name];
          let output;
          try {
            output = tool ? await tool.run(call.args || {}) : { error: `Unknown tool ${call.name}` };
          } catch (err) {
            output = { error: err.message };
          }
          used.push({ name: call.name, args: call.args });
          responses.push({ functionResponse: { name: call.name, response: { result: output } } });
        }
        result = await withRetry(() => chat.sendMessage(responses));
      }
      _workingModel = modelName;
      return { text: result.response.text(), toolsUsed: used, model: modelName };
    } catch (err) {
      if (err.code === 'MODEL_NOT_ACCESSIBLE') continue;
      throw new Error(friendly(err));
    }
  }
  throw new Error(`No accessible Gemini model for this key. Tried: ${candidates().join(', ')}`);
}

async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      if (msg.includes('404') || /not found/i.test(msg) || /limit:\s*0/.test(msg)) {
        const tagged = new Error(msg);
        tagged.code = 'MODEL_NOT_ACCESSIBLE';
        throw tagged;
      }
      const is429 = msg.includes('429') || /quota|rate/i.test(msg);
      if (!is429 || attempt === MAX_RETRIES) break;
      const m = msg.match(/retry in ([\d.]+)s/i);
      const delay = m ? Math.min(parseFloat(m[1]) + 0.5, 30) : 2 ** (attempt + 1);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
  throw lastErr;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
  }
}

function friendly(err) {
  const msg = String(err.message || err);
  if (err.code === 'NO_KEY') return msg;
  if (/API key|401|403/.test(msg)) return 'Gemini API key is invalid or unauthorized. Check GEMINI_API_KEY in .env.';
  if (/429|quota/i.test(msg)) return 'Gemini rate limit hit and retries exhausted. Wait a minute and retry.';
  return msg;
}
