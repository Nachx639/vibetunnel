// Entry point for the app
import { initializeMonaco } from './utils/monaco-loader.js';
import './services/push-notification-service.js';
import './utils/offline-notification-manager.js';
import './app.js';
import { lazyViews } from './utils/lazy-views.js';
import { startShellBuildCheck } from './utils/shell-build-check.js';

// This bundle and the stylesheet must come from one build; reloads once if not
// (utils/shell-build-check.ts).
startShellBuildCheck();

// logs.html runs this bundle for its <log-viewer>, which is a chunk of its own.
if (document.querySelector('log-viewer')) void lazyViews.logViewer.require();

// Initialize Monaco Editor on startup
initializeMonaco().catch(console.error);

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
