export const PROVIDERS = {
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  gemini: { name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  mistral: { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' }
} as const;
export type Provider = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];
export function providerId(value: unknown): Provider {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value) ? value as Provider : 'openrouter';
}
export type ModelInfo = { id: string; name?: string; context_length?: number; supported_parameters?: string[]; pricing?: { prompt?: string; completion?: string; [key: string]: string | undefined } };

// Explicit chat models with free input/output in Google's pricing table, verified 2026-10-14.
// Intersect with live discovery so retired or inaccessible IDs are never manufactured.
// https://ai.google.dev/gemini-api/docs/pricing
const GEMINI_FREE_CHAT = new Set(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);

export function normalizeModels(provider: Provider, body: any): ModelInfo[] {
  const data = Array.isArray(body) ? body : body?.data || body?.models || [];
  if (!Array.isArray(data)) throw new Error('Provider returned an invalid model catalog.');
  const models = data.filter((model: any) => {
    if (typeof model?.id !== 'string' || !model.id.trim() || model.active === false || model.archived === true) return false;
    if (model.capabilities?.completion_chat === false || /whisper|(?:^|[-/])tts(?:[-/]|$)|embedding|moderation|rerank/i.test(model.id)) return false;
    if (provider === 'gemini') return GEMINI_FREE_CHAT.has(model.id.replace(/^models\//, ''));
    if (provider !== 'openrouter') return true; // Free-tier account quotas apply; these catalogs do not expose account pricing.
    return model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined && Object.values(model.pricing).every(price => typeof price === 'string' && price.trim() !== '' && Number(price) === 0);
  }).map((model: any): ModelInfo => ({
    id: provider === 'gemini' ? model.id.replace(/^models\//, '') : model.id,
    name: String(model.name || model.id),
    context_length: model.context_length || model.max_context_length || model.inputTokenLimit,
    supported_parameters: model.supported_parameters || (typeof model.capabilities?.function_calling === 'boolean' ? (model.capabilities.function_calling ? ['tools'] : []) : undefined),
    pricing: model.pricing
  }));
  return [...new Map(models.map(model => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function messagesForProvider(provider: Provider, messages: any[], model?: string): any[] {
  const ids = new Map<string, string>();
  const used = new Set<string>(messages.flatMap(message => (message.tool_calls || []).map((call: any) => call.id)));
  const callId = (id: string) => {
    if (provider !== 'mistral' || /^[a-z0-9]{9}$/i.test(id)) return id;
    if (!ids.has(id)) {
      let index = ids.size + 1;
      let mapped = 't' + index.toString(36).padStart(8, '0');
      while (used.has(mapped)) mapped = 't' + (++index).toString(36).padStart(8, '0');
      ids.set(id, mapped); used.add(mapped);
    }
    return ids.get(id)!;
  };
  const mapped = messages.map(message => {
    if (message.role === 'tool') return { ...message, tool_call_id: callId(message.tool_call_id) };
    if (!message.tool_calls) return { ...message };
    return { ...message, tool_calls: message.tool_calls.map((call: any) => {
      const { extra_content, __sourceModel, __sourceProvider, ...standard } = call;
      standard.id = callId(standard.id);
      const sameModel = !__sourceModel || (__sourceProvider === provider && __sourceModel === model);
      return provider === 'gemini' ? { ...standard, extra_content: sameModel && extra_content?.google?.thought_signature ? extra_content : { google: { thought_signature: 'skip_thought_signature_validator' } } } : standard;
    }) };
  });
  if (provider !== 'mistral') return mapped;
  const system = mapped.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  return [...(system ? [{ role: 'system', content: system }] : []), ...mapped.filter(message => message.role !== 'system')];
}
