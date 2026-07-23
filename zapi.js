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
function interpretarWebhook(body) {
  const telefone = body.phone || body.connectedPhone || null;
  const nomeCliente = body.senderName || body.chatName || null;
  const messageId = body.messageId || null;
  const fromMe = Boolean(body.fromMe);

  let texto = null;
  if (body.text && body.text.message) {
    texto = body.text.message;
  } else if (body.buttonsResponseMessage && body.buttonsResponseMessage.message) {
    texto = body.buttonsResponseMessage.message;
  } else if (body.listResponseMessage && body.listResponseMessage.message) {
    texto = body.listResponseMessage.message;
  } else if (body.image || body.video || body.audio || body.document || body.sticker) {
    texto = '[mídia recebida — abra o WhatsApp pra ver o conteúdo]';
  }

  return { telefone, nomeCliente, texto, messageId, fromMe };
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
    return { enviado: true };
  } catch (err) {
    console.error('>> Erro de rede ao chamar a Z-API:', err.message);
    return { enviado: false, motivo: 'erro_rede' };
  }
}

module.exports = { interpretarWebhook, enviarMensagemWhatsapp, jaProcessada, marcarProcessada, configurado };
