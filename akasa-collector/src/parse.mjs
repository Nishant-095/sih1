const FLIGHT = /\bQP\s?(\d{3,4})\b/g;

export function flightCodes(text) {
  return [...String(text).matchAll(FLIGHT)].map(match => `QP${match[1]}`)
    .filter((code, index, all) => all.indexOf(code) === index);
}

export function parseDisplayedPrice(text) {
  const match = String(text).match(/Starting\s*(?:[^₹\n]*\s*)?₹\s*([\d,]+)/i);
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

export function rowTimes(html) {
  const headings = [...String(html).matchAll(/<h2\b([^>]*)>(\d{2}:\d{2})<\/h2>/g)]
    .map(([, attributes, time]) => ({ time, previous: /\bline-through\b/.test(attributes) }));
  const current = [], previousByField = [[], []];
  for (const item of headings) {
    if (!item.previous) current.push(item.time);
    else if (current.length > 0 && current.length <= 2)
      previousByField[current.length - 1].push(item.time);
  }
  return { current, previousByField };
}

function pricedFare(availability, currency) {
  if (!availability || currency !== 'INR') return null;
  const passengers = availability.fares?.map(fare => fare.passengerFares
    ?.find(passenger => passenger.passengerType === 'ADT' && passenger.multiplier === 1));
  if (!passengers?.length || passengers.some(passenger => !passenger)) return null;
  const charges = passengers.flatMap(passenger => passenger.serviceCharges || []);
  if (!Array.isArray(charges) || !charges.length ||
      charges.some(charge => charge.currencyCode !== currency ||
        !Number.isFinite(charge.amount) || charge.amount < 0)) return null;
  const base = charges.filter(charge => charge.type === 'FarePrice')
    .reduce((sum, charge) => sum + charge.amount, 0);
  const extra = charges.filter(charge => charge.code === 'WFE')
    .reduce((sum, charge) => sum + charge.amount, 0);
  const fullTotal = charges.reduce((sum, charge) => sum + charge.amount, 0);
  if (!base || fullTotal !== availability.totals?.fareTotal) return null;
  return { currency, base, includedTaxesAndFees: fullTotal - base - extra,
    additionalWfe: extra, displayedTotal: fullTotal - extra, fullTotal,
    charges: charges.map(({ type, code, amount, currencyCode }) =>
      ({ type, code, amount, currencyCode })) };
}

export function parseSearchResponse(body, query) {
  const payload = typeof body === 'string' ? JSON.parse(body) : body;
  const data = payload?.data;
  if (!data || !Array.isArray(data.results) || !Array.isArray(data.faresAvailable))
    throw new Error('Akasa flight-search response has an unknown shape');
  const availability = new Map(data.faresAvailable.map(item => [item.key, item.value]));
  const journeys = data.results.flatMap(result => result.trips || [])
    .filter(trip => trip.date?.slice(0, 10) === query.travelDate)
    .flatMap(trip => trip.journeysAvailableByMarket || [])
    .filter(market => market.key === `${query.origin}|${query.destination}`)
    .flatMap(market => market.value || []);
  return journeys.map(journey => {
    const flights = journey.segments?.map(segment =>
      `${segment.identifier?.carrierCode || ''}${segment.identifier?.identifier || ''}`) || [];
    const routeMatches = journey.designator?.origin === query.origin &&
      journey.designator?.destination === query.destination &&
      journey.designator?.departure?.slice(0, 10) === query.travelDate &&
      flights.length > 0 && flights.every(flight => /^QP\d{3,4}$/.test(flight));
    const options = journey.fares?.map(fare => ({ key: fare.fareAvailabilityKey,
      price: pricedFare(availability.get(fare.fareAvailabilityKey), data.currencyCode) }))
      .filter(option => option.price) || [];
    options.sort((a, b) => a.price.displayedTotal - b.price.displayedTotal);
    return { journeyKey: journey.journeyKey, flights,
      departureTime: journey.designator?.departure?.slice(11, 16),
      arrivalTime: journey.designator?.arrival?.slice(11, 16),
      stops: journey.stops ?? Math.max(0, flights.length - 1),
      routeMatches, best: options[0] || null };
  });
}

export function matchPageCards(journeys, cards, query, collectedAt) {
  const fares = [];
  const issues = [];
  const used = new Set();
  const exactCards = cards.filter(card => {
    const airports = [...String(card.html).matchAll(/<span>([A-Z]{3})<\/span>/g)]
      .map(match => match[1]);
    return airports[0] === query.origin && airports.at(-1) === query.destination;
  });
  for (const journey of journeys) {
    if (!journey.routeMatches || !journey.best) {
      issues.push({ flight: journey.flights.join(' + '), cause: 'AIRLINE_JOURNEY_UNVERIFIED' });
      continue;
    }
    const matches = exactCards.filter(card => {
      if (used.has(card.index) || flightCodes(card.text).join('|') !== journey.flights.join('|'))
        return false;
      const parsed = rowTimes(card.html);
      const current = parsed.current.length >= 2 ? parsed.current : card.times;
      return current?.length >= 2 &&
        (current[0] === journey.departureTime ||
          parsed.previousByField[0].includes(journey.departureTime)) &&
        (current[1] === journey.arrivalTime ||
          parsed.previousByField[1].includes(journey.arrivalTime));
    });
    if (matches.length !== 1) {
      issues.push({ flight: journey.flights.join(' + '), cause: 'PAGE_ROW_MISSING_OR_AMBIGUOUS' });
      continue;
    }
    const card = matches[0];
    const displayed = parseDisplayedPrice(card.text);
    if (displayed !== journey.best.price.displayedTotal) {
      issues.push({ flight: journey.flights.join(' + '), cause: 'PAGE_RESPONSE_PRICE_MISMATCH',
        displayed, responseCalculated: journey.best.price.displayedTotal });
      continue;
    }
    used.add(card.index);
    const parsedTimes = rowTimes(card.html);
    const currentTimes = parsedTimes.current.length >= 2 ? parsedTimes.current : card.times;
    fares.push({ origin: query.origin, destination: query.destination,
      travelDate: query.travelDate, collectedAt, flight: journey.flights.join(' + '),
      flights: journey.flights, departureTime: currentTimes[0], arrivalTime: currentTimes[1],
      airlineDepartureTime: journey.departureTime, airlineArrivalTime: journey.arrivalTime,
      scheduleDifference: currentTimes[0] !== journey.departureTime ||
        currentTimes[1] !== journey.arrivalTime ? 'PAGE_TIME_DIFFERS_FROM_AIRLINE_RESPONSE' : null,
      stops: journey.stops,
      journeyKey: journey.journeyKey, fareAvailabilityKey: journey.best.key,
      price: journey.best.price, rowIndex: card.index });
  }
  for (const card of exactCards) if (!used.has(card.index))
    issues.push({ rowIndex: card.index, cause: 'PAGE_ROW_UNMATCHED' });
  return { fares, issues, expectedJourneys: journeys.length, pageRows: exactCards.length,
    nearbyRows: cards.length - exactCards.length,
    complete: journeys.length > 0 && fares.length === journeys.length && issues.length === 0 };
}
