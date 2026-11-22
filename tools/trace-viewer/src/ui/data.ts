/** Where the UI gets its files, screenshots and the Playwright trace viewer's URL. */
import { useEffect, useState } from 'react';
import { type Loaded, loadSource, type Source, sourceFromBytes } from '../lib/load';
import type { BrowserTrace, Frame } from '../lib/model';

export interface Opened extends Loaded {
  name: string;
  source: Source;
}

/** What the CLI opened, if anything. */
export async function openServerSource(): Promise<Opened | undefined> {
  const res = await fetch('/api/source');
  if (!res.ok) throw new Error(await res.text());
  const info = (await res.json()) as {
    name: string | null;
    kind?: 'dir' | 'file';
    files?: string[];
  };
  if (!info.name || !info.files) return undefined;
  const fileUrl = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;
  const read = async (path: string) => {
    const r = await fetch(fileUrl(path));
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };
  let source: Source;
  if (info.kind === 'file') {
    const [file] = info.files as [string];
    const bytes = await read(file);
    source = { ...sourceFromBytes(info.name, bytes) };
    // A trace.zip opened by itself: the viewer can fetch it from the server.
    if (source.files.length === 1 && source.files[0] === file) source.url = () => fileUrl(file);
  } else {
    source = { name: info.name, files: info.files, read, url: fileUrl };
  }
  return { name: info.name, source, ...(await loadSource(source)) };
}

export async function openFile(file: File): Promise<Opened> {
  const source = sourceFromBytes(file.name, new Uint8Array(await file.arrayBuffer()));
  return { name: file.name, source, ...(await loadSource(source)) };
}

/**
 * Opens a Playwright trace in Playwright's own trace viewer (served from playwright-core under
 * /playwright/). A trace the server can't name by URL (it came from a dropped zip) is uploaded
 * to it first, kept in memory on this machine.
 */
export async function openInPlaywright(browser: BrowserTrace, source: Source): Promise<void> {
  // Open the tab now: a popup opened after an await is blocked.
  const tab = window.open('about:blank', '_blank');
  try {
    let url = source.files.includes(browser.path) ? source.url?.(browser.path) : undefined;
    if (!url) {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: (await browser.read()) as BlobPart,
      });
      url = ((await res.json()) as { url: string }).url;
    }
    const trace = new URL(url, location.href).href;
    const target = `/playwright/index.html?trace=${encodeURIComponent(trace)}`;
    if (tab) tab.location.href = target;
    else window.open(target, '_blank');
  } catch (err) {
    tab?.close();
    throw err;
  }
}

const frameUrls = new WeakMap<Frame, Promise<string>>();

function frameUrl(frame: Frame): Promise<string> {
  let url = frameUrls.get(frame);
  if (!url) {
    url = frame
      .read()
      .then((bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' })));
    frameUrls.set(frame, url);
  }
  return url;
}

export function useFrameUrl(frame: Frame | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    setUrl(undefined);
    if (frame) void frameUrl(frame).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [frame]);
  return url;
}

/** The last frame at or before `at` (else the first one after it). */
export function frameAt(frames: Frame[], at: number): Frame | undefined {
  if (!frames.length) return undefined;
  let lo = 0;
  let hi = frames.length - 1;
  if (frames[0]!.at > at) return frames[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.at <= at) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo];
}
