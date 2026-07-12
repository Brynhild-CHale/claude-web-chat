// Mark the page so components know the embed helper is active.
// Using a <meta> tag (visible to all shadow roots / iframes via document.head).
try {
  const m = document.createElement('meta');
  m.name = 'claude-web-chat-embed-helper';
  m.content = chrome?.runtime?.getManifest?.()?.version || '0.1.0';
  (document.head || document.documentElement).appendChild(m);
} catch (e) {}
