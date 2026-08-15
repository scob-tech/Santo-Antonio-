// Centraliza a leitura de variáveis de ambiente e alguns flags derivados.
// Assim o resto do código não fica cheio de process.env espalhado.

export const config = {
  port: process.env.PORT || 3000,
  tz: process.env.TZ || 'America/Sao_Paulo',

  databaseUrl: process.env.DATABASE_URL || '',

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.PHONE_NUMBER_ID || '',
    // ID da conta do WhatsApp Business (WABA) — usado pra o app se inscrever
    // sozinho e receber as mensagens. Fica na tela "Configuração da API" da Meta.
    wabaId: process.env.WABA_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    verifyToken: process.env.VERIFY_TOKEN || 'troque-por-uma-senha-sua',
    graphVersion: 'v20.0',
  },

  llm: {
    provider: (process.env.LLM_PROVIDER || 'anthropic').toLowerCase(),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || '',
  },

  painelSenha: process.env.PAINEL_SENHA || 'dandy2026',
};

// Flags que o sistema usa pra decidir se roda "de verdade" ou em modo demo.
// A ideia é: sem credencial, nada quebra — o sistema roda em modo simulado
// pra você conseguir ver o painel funcionando antes da Meta destravar.
export const flags = {
  temBanco: Boolean(config.databaseUrl),
  temWhatsapp: Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId),
  temIA: Boolean(config.llm.apiKey),
};

export function resumoAmbiente() {
  return {
    banco: flags.temBanco ? 'conectado' : 'MODO DEMO (sem DATABASE_URL)',
    whatsapp: flags.temWhatsapp ? 'conectado' : 'MODO DEMO (sem credenciais Meta)',
    ia: flags.temIA ? `ativa (${config.llm.provider})` : 'MODO SIMULADO (sem LLM_API_KEY)',
  };
}
