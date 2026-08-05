// zapi.js
// Camada de comunicação com a Z-API (BSP não-oficial de WhatsApp).
// Duas responsabilidades: (1) mandar mensagem de verdade pro WhatsApp do
// cliente quando o vendedor ou a IA responde, e (2) ajudar a interpretar
// o payload que a Z-API manda pro nosso webhook quando chega mensagem nova.
//
// Suporta 1 instância Z-API POR SETOR (Vendas/Financeiro/Expedição), cada
// setor com seu próprio número de WhatsApp. Configuração via variáveis de
// ambiente (definidas no .env local ou nas "Variables" do Railway):
//
//   Vendas (nomes de sempre, sem mudar — é o que já está em produção):
//     ZAPI_INSTANCE_ID / ZAPI_TOKEN / ZAPI_CLIENT_TOKEN
//   Financeiro:
//     ZAPI_FINANCEIRO_INSTANCE_ID / ZAPI_FINANCEIRO_TOKEN / ZAPI_FINANCEIRO_CLIENT_TOKEN
//   Expedição:
//     ZAPI_EXPEDICAO_INSTANCE_ID / ZAPI_EXPEDICAO_TOKEN / ZAPI_EXPEDICAO_CLIENT_TOKEN
//
// Se as variáveis de um setor não estiverem definidas, esse setor
// continua funcionando normalmente (modo demo/local) — só não manda nada
// de verdade pro WhatsApp dele, e avisa no log. Os outros setores não são
// afetados — cada um é independente.

const CREDENCIAIS_POR_SETOR = {
  vendas: {
    instanceId: process.env.ZAPI_INSTANCE_ID,
    token: process.env.ZAPI_TOKEN,
    clientToken: process.env.ZAPI_CLIENT_TOKEN,
  },
  financeiro: {
    instanceId: process.env.ZAPI_FINANCEIRO_INSTANCE_ID,
    token: process.env.ZAPI_FINANCEIRO_TOKEN,
    clientToken: process.env.ZAPI_FINANCEIRO_CLIENT_TOKEN,
  },
  expedicao: {
    instanceId: process.env.ZAPI_EXPEDICAO_INSTANCE_ID,
    token: process.env.ZAPI_EXPEDICAO_TOKEN,
    clientToken: process.env.ZAPI_EXPEDICAO_CLIENT_TOKEN,
  },
};

function configuradoPara(setor) {
  const c = CREDENCIAIS_POR_SETOR[setor];
  return Boolean(c && c.instanceId && c.token);
}

// Compatibilidade: `configurado` (sem parâmetro) continua existindo e
// reflete só o Vendas, pra não quebrar nada que já lia essa propriedade.
const configurado = configuradoPara('vendas');

for (const setor of Object.keys(CREDENCIAIS_POR_SETOR)) {
  if (!configuradoPara(setor)) {
    console.log(`>> Z-API do setor "${setor}" não configurada — mensagens de saída desse setor só serão salvas no banco, não enviadas de verdade.`);
  }
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
  // Em grupo, o "telefone" (phone) é o ID do próprio grupo — é isso que
  // queremos usar como identificador da conversa (1 conversa por grupo,
  // não 1 por pessoa dentro dele). chatName é o nome do grupo; senderName
  // é quem escreveu essa mensagem especificamente dentro do grupo.
  const telefone = body.phone || body.connectedPhone || null;
  const nomeCliente = body.isGroup ? (body.chatName || 'Grupo') : (body.senderName || body.chatName || null);
  const messageId = body.messageId || null;
  const fromMe = Boolean(body.fromMe);

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

  // Numa conversa de grupo, várias pessoas diferentes escrevem na MESMA
  // conversa — sem identificar quem é quem, fica impossível saber quem
  // pediu o quê. senderName é o participante que mandou essa mensagem
  // específica (diferente de chatName, que é o nome do grupo todo).
  if (body.isGroup && texto && !fromMe && body.senderName) {
    texto = `*${body.senderName}:*\n${texto}`;
  }

  return { telefone, nomeCliente, texto, midiaUrl, midiaTipo, messageId, fromMe, isGrupo: Boolean(body.isGroup) };
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
async function enviarMensagemWhatsapp(telefone, texto, setor = 'vendas') {
  const cred = CREDENCIAIS_POR_SETOR[setor];
  if (!configuradoPara(setor)) {
    console.log(`>> [Z-API "${setor}" não configurada] mensagem NÃO enviada de verdade pra ${telefone}: "${texto}"`);
    return { enviado: false, motivo: 'zapi_nao_configurada' };
  }

  const url = `https://api.z-api.io/instances/${cred.instanceId}/token/${cred.token}/send-text`;
  const headers = { 'Content-Type': 'application/json' };
  if (cred.clientToken) headers['Client-Token'] = cred.clientToken;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: telefone, message: texto }),
    });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Falha ao enviar mensagem via Z-API [${setor}] (status ${res.status}): ${erro}`);
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
    console.error(`>> Erro de rede ao chamar a Z-API [${setor}]:`, err.message);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

// Manda mídia (imagem, áudio, vídeo ou documento) de verdade pro WhatsApp
// do cliente. Aceita tanto link quanto Base64 (a Z-API aceita os dois —
// usamos Base64 aqui porque o arquivo vem direto do navegador do vendedor,
// sem precisar hospedar em lugar nenhum antes).
async function enviarMidiaWhatsapp(telefone, midiaTipo, dataUri, nomeArquivo, legenda, setor = 'vendas') {
  const cred = CREDENCIAIS_POR_SETOR[setor];
  if (!configuradoPara(setor)) {
    console.log(`>> [Z-API "${setor}" não configurada] mídia (${midiaTipo}) NÃO enviada de verdade pra ${telefone}`);
    return { enviado: false, motivo: 'zapi_nao_configurada' };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (cred.clientToken) headers['Client-Token'] = cred.clientToken;
  const base = `https://api.z-api.io/instances/${cred.instanceId}/token/${cred.token}`;

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
    const extensao = (nomeArquivo && nomeArquivo.includes('.')) ? nomeArquivo.split('.').pop().toLowerCase().trim() : 'pdf';
    url = `${base}/send-document/${extensao}`;
    body = { phone: telefone, document: dataUri, fileName: nomeArquivo || `arquivo.${extensao}`, caption: legenda || '' };
  }

  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const erro = await res.text().catch(() => '');
      console.error(`>> Falha ao enviar mídia via Z-API [${setor}] (status ${res.status}): ${erro}`);
      return { enviado: false, motivo: 'erro_zapi', status: res.status };
    }
    return { enviado: true };
  } catch (err) {
    console.error(`>> Erro de rede ao enviar mídia pela Z-API [${setor}]:`, err.message);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

module.exports = { interpretarWebhook, enviarMensagemWhatsapp, enviarMidiaWhatsapp, jaProcessada, marcarProcessada, foiEnviadaPorNos, configurado, configuradoPara };
