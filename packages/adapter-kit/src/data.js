export function snapshotDataRecord(value, allowed, required, code) {
  const snapshot = snapshotDataDictionary(value, allowed.length, code);
  const keys = Object.keys(snapshot);
  if (keys.some((key) => !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(snapshot, key))) {
    throw new Error(code);
  }
  return snapshot;
}

export function snapshotDataDictionary(value, maximumKeys, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(maximumKeys) || maximumKeys < 0) {
    throw new Error(code);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(code);
  }
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > maximumKeys || keys.some((key) => typeof key !== "string")) {
    throw new Error(code);
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(code);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
