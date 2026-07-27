// zapi.js
// Camada de comunicação com a Z-API (BSP não-oficial de WhatsApp).
// Duas responsabilidades: (1) mandar mensagem de verdade pro WhatsApp do
// cliente quando o vendedor ou a IA responde, e (2) ajudar a interpretar
// o payload que a Z-API manda pro nosso webhook quando chega mensagem nova.
//
// Configuração via variáveis de ambiente (definidas no .env local ou nas
// "Variables" do Railway):
//   ZAPI_INSTANCE_ID   — Instance ID da instância criada no painel Z-API
//   ZAPI_TOKEN         — Token da instância
//   ZAPI_CLIENT_TOKEN  — (opcional) Client-Token de segurança da conta
//
// Se essas variáveis não estiverem definidas, o sistema continua
// funcionando normalmente (modo demo/local) — só não manda nada de
// verdade pro WhatsApp, e avisa no log.

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

const configurado = Boolean(ZAPI_INSTANCE_ID && ZAPI_TOKEN);

if (!configurado) {
  console.log('>> Z-API não configurada (ZAPI_INSTANCE_ID/ZAPI_TOKEN ausentes) — mensagens de saída só serão salvas no banco, não enviadas de verdade.');
}

// Dedupe simples em memória — a Z-API avisa que a mesma mensagem pode
// chegar duplicada no webhook. Guardamos os últimos IDs vistos.
// (Limitação: reinicia o servidor, a lista zera — aceitável, o pior caso
// é processar de novo uma mensagem antiga logo após um restart.)
const mensagensVistas = new Set();
const LIMITE_MEMORIA = 500;

function jaProcessada(messageId) {
  if (!messageId) return false;
  return mensagensVistas.has(messageId);
}

function marcarProcessada(messageId) {
  if (!messageId) return;
  mensagensVistas.add(messageId);
  if (mensagensVistas.size > LIMITE_MEMORIA) {
    const primeiro = mensagensVistas.values().next().value;
    mensagensVistas.delete(primeiro);
  }
}

// Extrai {telefone, nomeCliente, texto, messageId, fromMe} de um payload
// de webhook "ao receber" da Z-API. O texto pode vir em formatos diferentes
// dependendo do tipo de mensagem (texto simples, botão, lista, etc) —
// tentamos os campos mais comuns e caímos num fallback genérico.
// Extrai {telefone, nomeCliente, texto, midiaUrl, midiaTipo, messageId, fromMe}
// de um payload de webhook "ao receber" da Z-API. Baseado na documentação
// oficial (developer.z-api.io/webhooks/on-message-received-examples).
function interpretarWebhook(body) {
  const telefone = body.phone || body.connectedPhone || null;
  const nomeCliente = body.senderName || body.chatName || null;
  const messageId = body.messageId || null;
  const fromMe = Boolean(body.fromMe);

  // Ignora mensagens de GRUPO — só conversa individual (1-a-1) vira lead.
  // Sem isso, qualquer mensagem normal num grupo do WhatsApp onde o número
  // esteja (mesmo sem ser sobre a loja) criaria um lead por engano.
  if (body.isGroup) {
    return { telefone: null, nomeCliente, texto: null, midiaUrl: null, midiaTipo: null, messageId, fromMe };
  }

  let texto = null;
  let midiaUrl = null;
  let midiaTipo = null;

  if (body.text && body.text.message) {
    // Cobre texto simples E mensagem com link/preview (a Z-API manda os dois
    // no mesmo formato text.message, só com description/url/thumbnailUrl extras)
    texto = body.text.message;
  } else if (body.buttonsResponseMessage && body.buttonsResponseMessage.message) {
    texto = body.buttonsResponseMessage.message;
  } else if (body.listResponseMessage && body.listResponseMessage.message) {
    texto = body.listResponseMessage.message;
  } else if (body.image) {
    texto = body.image.caption || '[Imagem]';
    midiaUrl = body.image.imageUrl;
    midiaTipo = 'imagem';
  } else if (body.audio) {
    texto = body.audio.ptt ? '[Áudio]' : '[Áudio]';
    midiaUrl = body.audio.audioUrl;
    midiaTipo = 'audio';
  } else if (body.video) {
    texto = body.video.caption || '[Vídeo]';
    midiaUrl = body.video.videoUrl;
    midiaTipo = 'video';
  } else if (body.document) {
    texto = `[Documento] ${body.document.fileName || body.document.title || ''}`.trim();
    midiaUrl = body.document.documentUrl;
    midiaTipo = 'documento';
  } else if (body.sticker) {
    texto = '[Sticker]';
    midiaUrl = body.sticker.stickerUrl;
    midiaTipo = 'sticker';
  } else if (body.product) {
    // Cliente compartilhou um produto do catálogo (ex: link de produto do site/catálogo)
    texto = `[Produto] ${body.product.title || ''}`.trim();
    if (body.product.productImage) { midiaUrl = body.product.productImage; midiaTipo = 'imagem'; }
  } else if (body.location) {
    texto = `[Localização] ${body.location.address || `${body.location.latitude}, ${body.location.longitude}`}`;
  } else if (body.contact) {
    texto = `[Contato] ${body.contact.displayName || ''}`;
  }

  // Formato não reconhecido — loga o payload inteiro pra investigar depois
  // em vez de simplesmente perder a mensagem em silêncio.
  if (!texto && !fromMe) {
    console.log('>> Webhook Z-API com formato não reconhecido, payload completo:', JSON.stringify(body));
  }

  return { telefone, nomeCliente, texto, midiaUrl, midiaTipo, messageId, fromMe };
}

// Rastreia messageIds das mensagens que NÓS mandamos via API — assim,
// quando a Z-API notifica um evento "fromMe: true", conseguimos distinguir
// entre (a) eco da nossa própria mensagem enviada pela API e (b) o vendedor
// respondendo manualmente direto pelo WhatsApp no celular conectado.
const mensagensEnviadasPorNos = new Set();
function foiEnviadaPorNos(messageId) {
  if (!messageId) return false;
  return mensagensEnviadasPorNos.has(messageId);
}

// Manda uma mensagem de texto de verdade pro WhatsApp do cliente.
// Não lança erro pro chamador — só loga — pra nunca travar o fluxo interno
// (salvar no banco) por causa de uma falha externa da Z-API.
async function enviarMensagemWhatsapp(telefone, texto) {
  if (!configurado) {
    console.log(`>> [Z-API não configurada] mensagem NÃO enviada de verdade pra ${telefone}: "${texto}"`);
    return { enviado: false, motivo: 'zapi_nao_configurada' };
  }

  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: telefone, message: texto }),
    });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Falha ao enviar mensagem via Z-API (status ${res.status}): ${erro}`);
      return { enviado: false, motivo: 'erro_zapi', status: res.status };
    }
    const data = await res.json().catch(() => null);
    if (data && data.messageId) {
      mensagensEnviadasPorNos.add(data.messageId);
      if (mensagensEnviadasPorNos.size > LIMITE_MEMORIA) {
        const primeiro = mensagensEnviadasPorNos.values().next().value;
        mensagensEnviadasPorNos.delete(primeiro);
      }
    }
    return { enviado: true };
  } catch (err) {
    console.error('>> Erro de rede ao chamar a Z-API:', err.message);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

// Manda mídia (imagem, áudio, vídeo ou documento) de verdade pro WhatsApp
// do cliente. Aceita tanto link quanto Base64 (a Z-API aceita os dois —
// usamos Base64 aqui porque o arquivo vem direto do navegador do vendedor,
// sem precisar hospedar em lugar nenhum antes).
async function enviarMidiaWhatsapp(telefone, midiaTipo, dataUri, nomeArquivo, legenda) {
  if (!configurado) {
    console.log(`>> [Z-API não configurada] mídia (${midiaTipo}) NÃO enviada de verdade pra ${telefone}`);
    return { enviado: false, motivo: 'zapi_nao_configurada' };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (ZAPI_CLIENT_TOKEN) headers['Client-Token'] = ZAPI_CLIENT_TOKEN;
  const base = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}`;

  let url;
  let body;
  if (midiaTipo === 'imagem') {
    url = `${base}/send-image`;
    body = { phone: telefone, image: dataUri, caption: legenda || '' };
  } else if (midiaTipo === 'audio') {
    url = `${base}/send-audio`;
    body = { phone: telefone, audio: dataUri };
  } else if (midiaTipo === 'video') {
    url = `${base}/send-video`;
    body = { phone: telefone, video: dataUri, caption: legenda || '' };
  } else {
    const extensao = (nomeArquivo && nomeArquivo.includes('.')) ? nomeArquivo.split('.').pop() : 'pdf';
    url = `${base}/send-document/${extensao}`;
    body = { phone: telefone, document: dataUri, fileName: nomeArquivo || `arquivo.${extensao}` };
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Falha ao enviar mídia via Z-API (status ${res.status}): ${erro}`);
      return { enviado: false, motivo: 'erro_zapi', status: res.status };
    }
    return { enviado: true };
  } catch (err) {
    console.error('>> Erro de rede ao enviar mídia pela Z-API:', err.message);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

module.exports = { interpretarWebhook, enviarMensagemWhatsapp, enviarMidiaWhatsapp, jaProcessada, marcarProcessada, foiEnviadaPorNos, configurado };
