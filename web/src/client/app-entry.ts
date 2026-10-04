// Entry point for the app
import './services/push-notification-service.js';
import './utils/offline-notification-manager.js';
import './app.js';

// Monaco (~4.3 MB of JS) is loaded on demand by <monaco-editor> the first time a file is opened;
// loading it at startup made every phone download and parse it before the session list.

// Initialize push notification service
// This will register the service worker and set up push notifications
// The services are initialized automatically when imported

// Handle notification actions from service worker
window.addEventListener('notification-action', ((event: CustomEvent) => {
  const { action, data } = event.detail;

  // Dispatch the action to the main app component
  const app = document.querySelector('vibetunnel-app');
  if (app) {
    app.dispatchEvent(
      new CustomEvent('notification-action', {
        detail: { action, data },
      })
    );
  }
}) as EventListener);
