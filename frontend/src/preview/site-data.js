export function serializeSiteDataMap(map) {
  return [...(map || new Map()).entries()]
    .filter(([key]) => !!key)
    .map(([key, value]) => [String(key), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
}

export function deserializeSiteDataMap(entries) {
  return new Map(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => Array.isArray(entry) && entry.length >= 2 && entry[0])
      .map(([key, value]) => [String(key), String(value)])
  );
}
