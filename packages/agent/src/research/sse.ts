const MAX_FRAME_CHARS = 8 * 1024 * 1024;

/** SSE frames may span network chunks, UTF-8 characters, and multiple data lines. */
export async function* events(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      for (;;) {
        const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (frame.length > MAX_FRAME_CHARS)
          throw new Error('Research event exceeded the size limit.');
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split(/\r\n|\n|\r/)) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          if (field === 'data') data.push(value);
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
      if (buffer.length > MAX_FRAME_CHARS)
        throw new Error('Research event exceeded the size limit.');
      if (chunk.done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
