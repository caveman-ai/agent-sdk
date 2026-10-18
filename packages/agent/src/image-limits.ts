import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Enforces the hard request limits in the model's pi-ai `inputLimits`:
 * images per message, images per request, and request bytes. A violation is
 * refused before any reservation or provider traffic. Undeclared limits are
 * not checked.
 *
 * `inputLimits.images.resize` is not a limit: it is Pi's cache-safe resize
 * target for new images. The SDK ships no image codec, so images pass through
 * byte for byte, and bytes already in history are never touched, keeping the
 * cache prefix stable.
 */
export function imageInputLimitViolation(
  model: Model<Api>,
  messages: readonly unknown[],
): string | undefined {
  const limits = model.inputLimits;
  if (limits === undefined) return undefined;
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    const inMessage = content.filter((block: { type?: unknown } | null) => block?.type === "image").length;
    if (inMessage > (limits.images?.maxPerMessage ?? Infinity)) return "images_per_message";
    total += inMessage;
  }
  if (total > (limits.images?.maxPerRequest ?? Infinity)) return "images_per_request";
  // The serialized transcript stands in for the provider request, which is
  // built later; images dominate both as the same base64 text.
  if (limits.maxRequestBytes !== undefined &&
      Buffer.byteLength(JSON.stringify(messages), "utf8") > limits.maxRequestBytes) {
    return "request_bytes";
  }
  return undefined;
}
