// Cliente único de LLM. Fala com Claude (Anthropic) OU OpenAI, conforme
// LLM_PROVIDER. Sem chave, entra em modo simulado (respostas de exemplo) —
// assim o sistema roda inteiro antes de você plugar a IA de verdade.
import { config, flags } from '../config.js';

const MODELOS_PADRAO = {
  anthropic: 'claude-3-5-sonnet-20241022',
  openai: 'gpt-4o-mini',
};

// Recebe um "prompt de sistema" + a mensagem do usuário e devolve texto.
export async function completar({ sistema, usuario, maxTokens = 500 }) {
  if (!flags.temIA) {
    return simulado(usuario);
  }
  if (config.llm.provider === 'openai') return chamarOpenAI({ sistema, usuario, maxTokens });
  return chamarAnthropic({ sistema, usuario, maxTokens });
}

async function chamarAnthropic({ sistema, usuario, maxTokens }) {
  const model = config.llm.model || MODELOS_PADRAO.anthropic;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.llm.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: sistema,
      messages: [{ role: 'user', content: usuario }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('Anthropic: ' + (data?.error?.message || resp.status));
  return (data.content?.[0]?.text || '').trim();
}

async function chamarOpenAI({ sistema, usuario, maxTokens }) {
  const model = config.llm.model || MODELOS_PADRAO.openai;
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.llm.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: sistema },
        { role: 'user', content: usuario },
      ],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('OpenAI: ' + (data?.error?.message || resp.status));
  return (data.choices?.[0]?.message?.content || '').trim();
}

// Modo simulado: devolve algo plausível pra você ver a tela funcionando.
function simulado(usuario = '') {
  const t = usuario.toLowerCase();
  if (t.includes('valor') || t.includes('plano') || t.includes('preço')) {
    return '[IA simulada] Sugestão: "Oi! Nosso plano único dá acesso a todas as ' +
      'modalidades (musculação, natação, pilates, dança, lutas e bike). Quer que eu ' +
      'te mande as condições da unidade mais perto de você?"';
  }
  if (t.includes('renov') || t.includes('vence') || t.includes('contrato')) {
    return '[IA simulada] Sugestão: "Oi! Seu contrato está próximo do vencimento. ' +
      'Posso já deixar a renovação encaminhada pra você não perder o acesso. Pode ser?"';
  }
  return '[IA simulada] Sugestão: "Oi! Tudo bem? Como posso te ajudar hoje? 😊" ' +
    '(Configure LLM_API_KEY pra ativar a IA de verdade.)';
}
