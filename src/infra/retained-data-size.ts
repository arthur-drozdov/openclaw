/** Bounded structural estimate for owner-held data, never serialization or a heap snapshot. */
export function estimateRetainedDataSize(roots: Iterable<unknown>): {
  approximateBytes: number;
  stringBytes: number;
  objects: number;
  truncated: boolean;
} {
  const seen = new WeakSet<object>();
  let remaining = 100_000;
  let approximateBytes = 0;
  let stringBytes = 0;
  let objects = 0;
  const visit = (value: unknown, depth = 0): void => {
    if (--remaining < 0 || depth > 64) {
      remaining = -1;
      return;
    }
    if (typeof value === "string") {
      approximateBytes += value.length * 2;
      stringBytes += value.length * 2;
    } else if (typeof value === "number" || typeof value === "boolean") {
      approximateBytes += 8;
    } else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      objects++;
      approximateBytes += 16;
      if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        approximateBytes += value.byteLength;
      } else if (value instanceof Map) {
        for (const [key, entry] of value) {
          visit(key, depth + 1);
          visit(entry, depth + 1);
          if (remaining < 0) {
            break;
          }
        }
      } else if (value instanceof Set || Array.isArray(value)) {
        for (const entry of value) {
          approximateBytes += 8;
          visit(entry, depth + 1);
          if (remaining < 0) {
            break;
          }
        }
      } else {
        // Only data descriptors: diagnostics must never invoke plugin accessors.
        for (const key in value) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && "value" in descriptor) {
            approximateBytes += key.length * 2 + 8;
            stringBytes += key.length * 2;
            visit(descriptor.value, depth + 1);
          }
          if (remaining < 0) {
            break;
          }
        }
      }
    }
  };
  for (const root of roots) {
    visit(root);
    if (remaining < 0) {
      break;
    }
  }
  return { approximateBytes, stringBytes, objects, truncated: remaining < 0 };
}
