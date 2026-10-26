const SEARCH_HOST = 'api-prod-flight-skyplus6e.goindigo.in';

export function isFlightSearchResponse(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === SEARCH_HOST &&
      parsed.pathname === '/v2/flight/search';
  } catch {
    return false;
  }
}

export function verifiedResponseFares(payload, query) {
  const trips = payload?.data?.trips;
  if (!Array.isArray(trips)) throw new Error('IndiGo flight-search response has no trips array');
  if (payload.data.currencyCode !== 'INR')
    throw new Error('IndiGo flight-search response did not confirm INR currency');
  const matchingTrip = trips.find(trip => trip.origin === query.origin &&
    trip.destination === query.destination);
  if (!matchingTrip || !Array.isArray(matchingTrip.journeysAvailable))
    throw new Error('IndiGo flight-search response does not match the requested route');

  const byJourneyKey = new Map();
  for (const journey of matchingTrip.journeysAvailable) {
    const designator = journey?.designator;
    if (!journey?.journeyKey || designator?.origin !== query.origin ||
        designator?.destination !== query.destination ||
        designator?.departure?.slice(0, 10) !== query.travelDate ||
        !Array.isArray(journey.segments) || !journey.segments.length) continue;
    const flights = journey.segments.map(segment => segment.identifier)
      .filter(id => id?.carrierCode === '6E' && /^\d{2,4}$/.test(String(id.identifier)))
      .map(id => `${id.carrierCode} ${id.identifier}`);
    if (flights.length !== journey.segments.length) continue;
    const offers = (Array.isArray(journey.passengerFares) ? journey.passengerFares : [])
      .filter(fare => fare?.isActive !== false &&
        Number.isFinite(fare.totalFareAmount) && fare.totalFareAmount > 0 &&
        Number.isFinite(fare.totalPublishFare) && fare.totalPublishFare > 0 &&
        Number.isFinite(fare.totalTax) && fare.totalTax >= 0 &&
        Math.abs(fare.totalPublishFare + fare.totalTax - fare.totalFareAmount) <= 1)
      .map(fare => ({ productClass: fare.productClass || null,
        base: fare.totalPublishFare, taxesAndFees: fare.totalTax,
        total: fare.totalFareAmount, currency: payload.data.currencyCode }));
    if (offers.length) byJourneyKey.set(journey.journeyKey, { flights, offers });
  }
  return byJourneyKey;
}
