export type LlmProvider = 'openai' | 'anthropic' | 'gemini';

export type LlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export type LlmMessage = { role: 'system' | 'user'; content: string };

type LlmResult = { text: string } | null;

async function callOpenAI(
  apiKey: string,
  messages: LlmMessage[],
  fetchImpl: typeof fetch
): Promise<LlmResult> {
  const resp = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o', temperature: 0.2, max_tokens: 1200, messages }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  return text ? { text } : null;
}

async function callAnthropic(
  apiKey: string,
  messages: LlmMessage[],
  fetchImpl: typeof fetch
): Promise<LlmResult> {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const userMessages = messages
    .filter((m) => m.role === 'user')
    .map((m) => ({ role: 'user' as const, content: m.content }));

  const resp = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: system || undefined,
      messages: userMessages,
    }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((block) => block.type === 'text')?.text ?? '';
  return text ? { text } : null;
}

async function callGemini(
  apiKey: string,
  messages: LlmMessage[],
  fetchImpl: typeof fetch
): Promise<LlmResult> {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const userContent = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n\n');

  const combined = system ? `${system}\n\n${userContent}` : userContent;

  const resp = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: combined }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
      }),
    }
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return text ? { text } : null;
}

export async function callLlm(
  config: LlmConfig,
  messages: LlmMessage[]
): Promise<LlmResult> {
  const fetchImpl = config.fetchImpl ?? fetch;
  try {
    switch (config.provider) {
      case 'openai':
        return await callOpenAI(config.apiKey, messages, fetchImpl);
      case 'anthropic':
        return await callAnthropic(config.apiKey, messages, fetchImpl);
      case 'gemini':
        return await callGemini(config.apiKey, messages, fetchImpl);
    }
  } catch {
    return null;
  }
}
