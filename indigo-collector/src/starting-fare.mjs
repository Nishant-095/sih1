export function displayedStartingFare(label) {
  const value = String(label || '').match(/fare starts at\s*(?:₹|INR\s*)([\d,]+(?:\.\d{1,2})?)/i)?.[1];
  return value ? Number(value.replaceAll(',', '')) : null;
}
