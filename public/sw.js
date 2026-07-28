// sw.js
// Service Worker — roda em background, separado da aba do navegador.
// É ele que recebe o push mesmo com o app fechado (ou o celular no bolso)
// e decide o que mostrar. Sem isso, notificação simplesmente não existe.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Chega um push do servidor (via web-push) — mostra a notificação do
// sistema operacional. O "payload" é o JSON que o server.js mandou.
self.addEventListener('push', (event) => {
  let dados = { titulo: 'Depósito Santo Antônio', corpo: 'Você tem uma atualização.', leadId: null };
  try {
    if (event.data) dados = { ...dados, ...event.data.json() };
  } catch {
    // payload não veio em JSON — usa os valores padrão acima
  }

  const opcoes = {
    body: dados.corpo,
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: dados.leadId ? `lead-${dados.leadId}` : 'geral', // evita empilhar 10 notificações do mesmo lead
    renotify: true,
    data: { leadId: dados.leadId || null },
  };

  event.waitUntil(self.registration.showNotification(dados.titulo, opcoes));
});

// Vendedor clicou na notificação — abre (ou foca) a aba do sistema já na
// conversa certa, em vez de só abrir a tela inicial.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const leadId = event.notification.data && event.notification.data.leadId;
  const destino = leadId ? `/?abrir_lead=${leadId}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if ('focus' in janela) {
          janela.focus();
          if (leadId && 'postMessage' in janela) {
            janela.postMessage({ tipo: 'abrir_lead', leadId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(destino);
      }
    })
  );
});
