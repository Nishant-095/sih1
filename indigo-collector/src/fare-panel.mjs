export async function openFareDetails(page) {
  const dialog = page.getByRole('dialog');
  const details = page.getByRole('button', { name: 'View details' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const litePopup = page.locator('#liteFarePopup');
    if (await litePopup.isVisible().catch(() => false))
      await litePopup.locator('#changeFare').click({ timeout: 5000 });
    try {
      await details.click({ timeout: 8000 });
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      return;
    } catch (error) {
      if (page.isClosed()) throw Object.assign(new Error('Results page closed while opening fare details'),
        { code: 'PAGE_CLOSED' });
      if (attempt === 1) throw Object.assign(new Error(
        `Fare details did not open after two clicks; Lite popup visible: ${await litePopup.isVisible().catch(() => false)}`),
        { code: 'FARE_DETAILS_UNAVAILABLE', cause: error });
    }
  }
}
