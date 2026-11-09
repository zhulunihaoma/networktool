export const TEXT_PREVIEW_SIZE = 64 * 1024;

/** Keep neighbouring pages contiguous without splitting a UTF-16 character. */
export function textPreviewPage(text: string, page: number) {
  const pages = Math.max(1, Math.ceil(text.length / TEXT_PREVIEW_SIZE));
  const current = Math.max(0, Math.min(pages - 1, page));
  const boundary = (position: number) => {
    const end = Math.min(text.length, position);
    return end > 0 &&
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
      ? end - 1
      : end;
  };
  const start = boundary(current * TEXT_PREVIEW_SIZE);
  const end = boundary((current + 1) * TEXT_PREVIEW_SIZE);
  return { current, pages, start, end, text: text.slice(start, end) };
}
