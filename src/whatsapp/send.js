// Envio de mensagens pela WhatsApp Cloud API (Graph API da Meta).
// Duas formas:
//   - texto livre  -> só funciona DENTRO da janela de 24h. É de graça.
//   - template     -> funciona a qualquer hora, mas é cobrado por categoria.
// Sem credencial da Meta, cai em modo demo: só loga e devolve um id falso.
import { config, flags } from '../config.js';

const base = () =>
  `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`;

async function postGraph(body) {
  if (!flags.temWhatsapp) {
    console.log('[wa][demo] enviaria:', JSON.stringify(body));
    return { demo: true, messages: [{ id: 'demo-' + Math.round(performance.now()) }] };
  }
  const resp = await fetch(base(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  // log de diagnóstico: mostra o que a Meta respondeu (id da mensagem ou erro)
  if (resp.ok) {
    console.log('[wa] enviado ok →', JSON.stringify(data?.messages || data));
  } else {
    console.error('[wa] Graph API erro', resp.status, '→', JSON.stringify(data?.error || data));
  }
  if (!resp.ok) {
    const e = data?.error || {};
    throw new Error('Graph API: ' + (e.message || resp.status) + (e.code ? ` (code ${e.code})` : ''));
  }
  return data;
}

// Texto livre (grátis, exige janela de 24h aberta).
export function enviarTexto(telefone, texto) {
  return postGraph({
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'text',
    text: { preview_url: false, body: texto },
  });
}

// Template aprovado na Meta. `componentes` é opcional (variáveis).
export function enviarTemplate(telefone, nomeTemplate, idioma = 'pt_BR', componentes = []) {
  return postGraph({
    messaging_product: 'whatsapp',
    to: telefone,
    type: 'template',
    template: {
      name: nomeTemplate,
      language: { code: idioma },
      ...(componentes.length ? { components: componentes } : {}),
    },
  });
}
