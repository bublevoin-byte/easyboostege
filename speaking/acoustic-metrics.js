export function boundedAcousticMetric(value, { minimum = 0, maximum = 100 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < minimum || value > maximum) return null;
  return value;
}

export function finiteAcousticAverage(values, bounds = undefined) {
  const available = (Array.isArray(values) ? values : [])
    .map((value) => boundedAcousticMetric(value, bounds))
    .filter((value) => value !== null);
  return available.length
    ? available.reduce((sum, value) => sum + value, 0) / available.length
    : null;
}
