/**
 * register-sw.js
 * Registers the service worker and listens for sync-complete messages.
 */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      console.log('[App] Service Worker registered:', registration.scope);

      // Listen for messages from the SW (e.g., sync complete notifications)
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'SYNC_COMPLETE') {
          const { synced, total } = event.data;
          if (synced > 0) {
            showToast(`✅ Back online! ${synced} queued report${synced > 1 ? 's' : ''} sent successfully.`, 'success');
            // Refresh queue count badge if it exists
            if (typeof updateQueueBadge === 'function') updateQueueBadge();
          }
        }
      });
    } catch (err) {
      console.warn('[App] Service Worker registration failed:', err.message);
    }
  });
}
