import { parseHTML } from 'linkedom';

const fail = detail => { throw Object.assign(new Error(detail), { code: 'AIRLINE_SCHEMA_UNVERIFIED' }); };
const amount = value => Number.isSafeInteger(value) && value >= 0;

// null means this JSON is an unrelated request. [] means a valid flight reply
// contained no exact-airport offers for the requested route/date.
export function parseSearchResponse(body, query) {
  let data;
  try { data = JSON.parse(body); }
  catch { return null; }
  const payload = data?.responsePayload?.[0];
  if (!Array.isArray(payload?.airBoundGroups)) return null;
  if (data.status !== 'SUCCESS' || data.hasError !== false ||
      !data.dictionaries?.flight) fail('Air India flight reply was not a successful offer response');

  const fares = [];
  for (const group of payload.airBoundGroups) {
    const details = group?.boundDetails;
    if (details?.originLocationCode !== query.origin ||
        details?.destinationLocationCode !== query.destination) continue;
    if (!Array.isArray(details.segments) || !details.segments.length)
      fail('An exact-route offer has no segments');
    const segments = details.segments.map(item => data.dictionaries.flight[item?.flightId]);
    if (segments.some(segment => !segment?.departure?.dateTime || !segment?.arrival?.dateTime))
      fail('An offer segment is missing from the flight dictionary');
    const first = segments[0];
    const last = segments.at(-1);
    if (first.departure.locationCode !== query.origin ||
        last.arrival.locationCode !== query.destination ||
        !first.departure.dateTime.startsWith(query.travelDate))
      fail('An offer segment does not match the requested airport and date');
    if (segments.some(segment => !['AI', 'IX'].includes(segment.marketingAirlineCode) ||
        !/^\d{1,4}$/.test(String(segment.marketingFlightNumber))))
      fail('An offer flight number is missing or unexpected');
    const bounds = (group.airBounds || []).filter(bound =>
      amount(bound?.aiUnitPrice?.value) && bound?.aiUnitPrice?.currencyCode === 'INR');
    if (!bounds.length) fail('An exact-route flight has no INR fare');
    const best = bounds.reduce((left, right) =>
      right.aiUnitPrice.value < left.aiUnitPrice.value ? right : left);
    const prices = best.prices?.totalPrices;
    if (!Array.isArray(prices) || prices.length !== 1)
      fail('An exact-route fare has no single total-price breakdown');
    const price = prices[0];
    const displayedTotal = best.aiUnitPrice.value;
    if (price.currencyCode !== 'INR' || !amount(price.base) ||
        !amount(price.totalTaxes) || !amount(price.total) ||
        price.base + price.totalTaxes !== displayedTotal || price.total < displayedTotal)
      fail('Air India display amount does not reconcile with base fare and taxes');
    const taxComponents = Array.isArray(price.taxes) ? price.taxes.map(tax => {
      if (!amount(tax.value) || tax.currencyCode !== 'INR') fail('A tax component is malformed');
      return { code: tax.code || null, amount: tax.value };
    }) : [];
    const itemized = taxComponents.reduce((sum, tax) => sum + tax.amount, 0);
    if (itemized > price.totalTaxes) fail('Itemized taxes exceed the reported total');
    fares.push({
      flight: segments.map(segment => `${segment.marketingAirlineCode} ${segment.marketingFlightNumber}`).join(' + '),
      origin: query.origin, destination: query.destination, travelDate: query.travelDate,
      departureTime: first.departure.dateTime.slice(11, 16),
      arrivalTime: last.arrival.dateTime.slice(11, 16),
      departureDateTime: first.departure.dateTime, arrivalDateTime: last.arrival.dateTime,
      operatingAirline: [...new Set(segments.map(segment => segment.operatingAirlineCode))].join(' + '),
      stops: segments.length - 1 + segments.reduce((count, segment) =>
        count + (Array.isArray(segment.stops) ? segment.stops.length : 0), 0),
      fareFamilyCode: best.fareFamilyCode || null,
      price: { currency: 'INR', displayedTotal, base: price.base,
        taxesAndFees: price.totalTaxes, taxComponents,
        unitemizedTaxesAndFees: price.totalTaxes - itemized,
        fullTotal: price.total,
        additionalUnitemizedAmount: price.total - displayedTotal }
    });
  }
  const keys = fares.map(fare => `${fare.flight}|${fare.departureTime}`);
  if (new Set(keys).size !== keys.length) fail('Duplicate exact-route flight in airline response');
  return fares;
}

export function extractCardsFromHtml(html) {
  const { document } = parseHTML(html);
  return [...document.querySelectorAll('.ai-pb-flight-item')].map(item => {
    const value = selector => item.querySelector(selector)?.textContent?.trim() || '';
    return {
      flight: [...item.querySelectorAll('.ai-pb-flight-id')].map(node =>
        node.textContent.trim().replace(/\s+/g, ' ')).join(' + '),
      origin: value('.ai-pb-departure-city-code'),
      destination: value('.ai-pb-actual-arrival-city') || value('.ai-pb-arrival-city-code'),
      departureTime: value('.ai-pb-departure-time'),
      arrivalTime: value('.ai-pb-arrival-time'),
      currency: value('.ai-pb-currency-code'),
      displayedTotal: Number(value('.ai-pb-price').replace(/[^0-9]/g, ''))
    };
  });
}

export async function extractPageCards(page) {
  return extractCardsFromHtml(await page.content());
}

export function matchFaresToCards(fares, cards, query) {
  const scoped = cards.filter(card => card.origin === query.origin &&
    card.destination === query.destination);
  if (scoped.length !== fares.length)
    throw Object.assign(new Error(`Airline returned ${fares.length} exact-route flights; page showed ${scoped.length}`),
      { code: 'RESULTS_UNVERIFIED' });
  for (const fare of fares) {
    const card = scoped.find(item => item.flight === fare.flight &&
      item.departureTime === fare.departureTime &&
      item.arrivalTime === fare.arrivalTime && item.currency === fare.price.currency &&
      item.displayedTotal === fare.price.displayedTotal);
    if (!card) throw Object.assign(new Error(`Airline fare and page card differ for ${fare.flight}`),
      { code: 'RESULTS_UNVERIFIED' });
  }
  return true;
}
