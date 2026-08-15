// Auto-inscrição no WABA (WhatsApp Business Account).
// Este é o "fio que faltava": mesmo com o webhook configurado e o app publicado,
// a Meta só repassa as mensagens de um número se o APP estiver INSCRITO naquela
// conta do WhatsApp. Aqui o sistema faz isso sozinho ao subir — assim você não
// precisa mexer em nada manualmente, e vale também pro número de produção depois.
import { config, flags } from '../config.js';

export async function subscribeToWaba() {
  if (!flags.temWhatsapp || !config.whatsapp.wabaId) {
    console.log('[wa] auto-subscribe pulado (falta WABA_ID ou credenciais da Meta).');
    return;
  }
  const url = `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.wabaId}/subscribed_apps`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    });
    const data = await resp.json();
    if (resp.ok && data?.success) {
      console.log('[wa] ✓ app inscrito no WABA — mensagens do número agora chegam no webhook.');
    } else {
      console.warn('[wa] auto-subscribe não confirmado:', JSON.stringify(data));
    }
  } catch (e) {
    console.warn('[wa] erro no auto-subscribe:', e.message);
  }
}
