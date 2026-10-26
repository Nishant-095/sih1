const sessionRequest = url => /\/(?:login\/v\d+\/token\/validate|v\d+\/token\/refresh)(?:$|\?)/.test(url);

// Wait for the booking session, not unrelated advertising/network activity.
export async function waitForBookingSession(page, pending, checkFault,
  { timeoutMs = 15000, pollMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fault = await checkFault();
    if (fault) throw Object.assign(new Error(fault.detail), { code: fault.code });
    const documentState = await page.evaluate(() => document.readyState);
    const requests = [...pending.values()].filter(item => sessionRequest(item.url));
    if (documentState === 'complete' && !requests.length)
      return { documentState, pendingSessionRequests: 0 };
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw Object.assign(new Error('Booking session initialization did not settle before submission'),
    { code: 'SESSION_NOT_READY' });
}

export async function browserEnvironment(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { userAgent: navigator.userAgent, webdriver: navigator.webdriver,
      language: navigator.language, languages: [...navigator.languages],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
      hardwareConcurrency: navigator.hardwareConcurrency,
      webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
  });
}
