import { useEffect, useState } from 'react';
import { api } from './api';

/** Media (screenshots) are immutable: cache data URLs per id for the session. */
const cache = new Map<string, Promise<string | null>>();

function loadMedia(id: string): Promise<string | null> {
  let pending = cache.get(id);
  if (!pending) {
    pending = api.invoke('media.get', id).catch(() => null);
    cache.set(id, pending);
  }
  return pending;
}

export function useMedia(id: string | undefined): { url: string | null; loading: boolean } {
  const [state, setState] = useState<{ id?: string; url: string | null; loading: boolean }>({
    url: null,
    loading: Boolean(id),
  });
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setState({ id, url: null, loading: true });
    void loadMedia(id).then((url) => {
      if (alive) setState({ id, url, loading: false });
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return state.id === id ? state : { url: null, loading: Boolean(id) };
}
