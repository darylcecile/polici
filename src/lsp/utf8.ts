/** Strict UTF-8 validation for protocol and manifest inputs. */
export function isValidUtf8(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index++) {
    const first = bytes[index]!;
    if (first <= 0x7f) continue;
    const second = bytes[index + 1];
    if (
      first >= 0xc2 &&
      first <= 0xdf &&
      second !== undefined &&
      second >= 0x80 &&
      second <= 0xbf
    ) {
      index++;
      continue;
    }
    const third = bytes[index + 2];
    if (
      third !== undefined &&
      third >= 0x80 &&
      third <= 0xbf &&
      ((first === 0xe0 && second !== undefined && second >= 0xa0 && second <= 0xbf) ||
        (first >= 0xe1 &&
          first <= 0xec &&
          second !== undefined &&
          second >= 0x80 &&
          second <= 0xbf) ||
        (first === 0xed && second !== undefined && second >= 0x80 && second <= 0x9f) ||
        (first >= 0xee &&
          first <= 0xef &&
          second !== undefined &&
          second >= 0x80 &&
          second <= 0xbf))
    ) {
      index += 2;
      continue;
    }
    const fourth = bytes[index + 3];
    if (
      third !== undefined &&
      third >= 0x80 &&
      third <= 0xbf &&
      fourth !== undefined &&
      fourth >= 0x80 &&
      fourth <= 0xbf &&
      ((first === 0xf0 && second !== undefined && second >= 0x90 && second <= 0xbf) ||
        (first >= 0xf1 &&
          first <= 0xf3 &&
          second !== undefined &&
          second >= 0x80 &&
          second <= 0xbf) ||
        (first === 0xf4 && second !== undefined && second >= 0x80 && second <= 0x8f))
    ) {
      index += 3;
      continue;
    }
    return false;
  }
  return true;
}

export function decodeUtf8(bytes: Uint8Array): string | undefined {
  return isValidUtf8(bytes) ? new TextDecoder().decode(bytes) : undefined;
}
