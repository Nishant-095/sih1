import crypto from 'node:crypto';

// Forward the browser's own requests with Playwright's HTTP/1.1 client.
// The URL, method, body, session cookies and server response are preserved.
// This is fresh HTTPS retrieval, with no cached or synthesized page content.
export async function installHttpTransport(context, { accepts, record }) {
  const handler = async route => {
    const request = route.request();
    if (!accepts(request.url())) return route.continue();
    let response;
    try {
      response = await route.fetch({ timeout: 15000, maxRedirects: 0, maxRetries: 0 });
      const body = await response.body();
      await record({ url: request.url(), method: request.method(), status: response.status(),
        resourceType: request.resourceType(), bytes: body.length,
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        transport: 'playwright-http1-forwarder' });
      // The response status, headers and body are copied without editing.
      await route.fulfill({ response, body });
    } catch (error) {
      await record({ url: request.url(), method: request.method(),
        resourceType: request.resourceType(), failed: error.message.split('\n')[0],
        transport: 'playwright-http1-forwarder' });
      await route.abort('connectionfailed').catch(() => {});
    } finally { await response?.dispose().catch(() => {}); }
  };
  await context.route('**/*', handler);
  return () => context.unroute('**/*', handler);
}
