const failClosedHttpProvider = 'http://127.0.0.1:9/provider-disabled';
const failClosedWebSocketProvider = 'ws://127.0.0.1:9/provider-disabled';
const dynamicIdentifierPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;

function normalizeRequestPath(value) {
  const raw = String(value || '');
  let pathname = raw.split('?', 1)[0];
  try { pathname = new URL(raw).pathname; } catch {}
  return pathname.replace(dynamicIdentifierPattern, ':id');
}

function redactDiagnostic(value) {
  return String(value || '')
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, (url) => {
      try { return new URL(url).origin; } catch { return url; }
    })
    .replace(dynamicIdentifierPattern, ':id')
    .replace(/\b(token|ticket|key|secret)=([^&\s]+)/giu, '$1=<redacted>')
    .replace(/([?&][^=&\s]+)=([^&\s]+)/gu, '$1=<redacted>');
}

export function createReleaseServerEnvironment(applicationEnvironment, inheritedEnvironment = process.env) {
  return {
    ...inheritedEnvironment,
    ...applicationEnvironment,
    TELEGRAM_BOT_TOKEN: '',
    ADMIN_TELEGRAM_ID: '',
    MONITORING_TOKEN: '',
    XAI_API_KEY: '',
    XAI_API_URL: failClosedHttpProvider,
    XAI_RULE_SEARCH_URL: failClosedHttpProvider,
    XAI_VOICE_REALTIME_URL: failClosedWebSocketProvider,
    GROQ_API_KEY: '',
    GROQ_API_URL: failClosedHttpProvider,
    AZURE_SPEECH_KEY: '',
    AZURE_SPEECH_REGION: '',
    XAI_ENABLED: 'false',
    GROQ_ENABLED: 'false',
    VOICE_TUTOR_ENABLED: 'false',
    VOICE_TUTOR_RULE_SEARCH_ENABLED: 'false',
    SPEAKING_PRONUNCIATION_ENABLED: 'false',
  };
}

export function createReleaseNetworkGuard({ allowedHttpResponses = [] } = {}) {
  let offline = false;
  const failures = [];
  const allowedResponses = new Set(allowedHttpResponses.map(({ method, path, status }) => (
    `${method} ${path} ${status}`
  )));
  return {
    failures,
    setOffline(value) {
      offline = Boolean(value);
    },
    recordConsoleError(message) {
      // Chromium also emits this generic console line for failures that are classified below with
      // their exact request URL, method and status. Keeping only the structured event avoids a
      // duplicate, context-free finding without hiding a missing chunk or online request failure.
      if (message.startsWith('Failed to load resource:')) return;
      failures.push(`console: ${redactDiagnostic(message)}`);
    },
    recordRequestFailure(method, requestPath, errorText, { external = false } = {}) {
      if (offline && !external) return;
      let requestLabel = normalizeRequestPath(requestPath);
      if (external) {
        try { requestLabel = new URL(requestPath).origin; } catch {}
      }
      failures.push(`requestfailed: ${method} ${requestLabel} (${redactDiagnostic(errorText || 'unknown error')})`);
    },
    recordHttpResponse(method, requestPath, status) {
      if (offline || status < 400) return;
      const normalizedPath = normalizeRequestPath(requestPath);
      if (allowedResponses.has(`${method} ${normalizedPath} ${status}`)) return;
      failures.push(`http: ${method} ${normalizedPath} -> ${status}`);
    },
  };
}

export function attachReleaseBrowserGuards(context, { applicationOrigin, networkGuard }) {
  const browserFailures = [];
  const paidBoundaryCalls = [];
  const observedApiRoutes = new Set();
  const attachedPages = new WeakSet();
  const attachPage = (page) => {
    if (attachedPages.has(page)) return;
    attachedPages.add(page);
    page.on('pageerror', (error) => browserFailures.push(`pageerror: ${redactDiagnostic(error.message)}`));
    page.on('console', (message) => {
      if (message.type() === 'error') networkGuard.recordConsoleError(message.text());
    });
    page.on('websocket', (socket) => paidBoundaryCalls.push(`WS ${new URL(socket.url()).origin}`));
  };
  for (const page of context.pages()) attachPage(page);
  context.on('page', attachPage);
  context.on('requestfailed', (request) => {
    const requestUrl = new URL(request.url());
    const requestLabel = requestUrl.origin === applicationOrigin
      ? requestUrl.pathname : requestUrl.origin;
    networkGuard.recordRequestFailure(
      request.method(), requestLabel, request.failure()?.errorText,
      { external: requestUrl.origin !== applicationOrigin },
    );
  });
  context.on('response', (response) => {
    const responseUrl = new URL(response.url());
    networkGuard.recordHttpResponse(
      response.request().method(), responseUrl.pathname, response.status(),
    );
  });
  context.on('request', (request) => {
    const requestUrl = new URL(request.url());
    const pathname = normalizeRequestPath(requestUrl.pathname);
    if (pathname.startsWith('/api/v1/ege-mocks/attempts/')) observedApiRoutes.add(pathname);
    if (pathname === '/api/v1/adaptive-learning/overview') observedApiRoutes.add(pathname);
    if ((pathname.startsWith('/api/v1/voice-tutor/') && request.method() !== 'GET')
      || /(?:api\.)?x\.ai|api\.groq\.com/iu.test(requestUrl.hostname)) {
      paidBoundaryCalls.push(`${request.method()} ${requestUrl.origin}`);
    }
  });
  return { browserFailures, observedApiRoutes, paidBoundaryCalls };
}

export async function prepareReleaseBrowserBoundary(context, {
  allowedHttpResponses = [], applicationOrigin,
  networkGuard = createReleaseNetworkGuard({ allowedHttpResponses }),
} = {}) {
  const exactApplicationOrigin = new URL(applicationOrigin).origin;
  await context.route('**/*', (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === exactApplicationOrigin) return route.continue();
    if (requestUrl.origin === 'https://fonts.googleapis.com') {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    if (requestUrl.origin === 'https://fonts.gstatic.com') {
      return route.fulfill({ status: 200, contentType: 'font/woff2', body: '' });
    }
    return route.abort('blockedbyclient');
  });
  return {
    networkGuard,
    ...attachReleaseBrowserGuards(context, {
      applicationOrigin: exactApplicationOrigin, networkGuard,
    }),
  };
}
