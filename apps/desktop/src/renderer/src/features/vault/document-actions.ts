import { useState } from 'react';
import { tr } from '../../i18n';
import { api, errorMessage } from '../../lib/api';
import { toast } from '../../store/toast';
import { vaultDict } from './i18n';

/** Opens a saved document with the system's viewer. */
export function openDocument(id: string): void {
  void api.invoke('vault.openDocument', id).catch((err) => toast.error(errorMessage(err)));
}

/** Saves a copy of a saved document to Downloads, with a toast either way. */
export function useDownloadDocument(id: string): { download: () => void; downloading: boolean } {
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      const name = await api.invoke('vault.downloadDocument', id);
      toast.success(tr(vaultDict).documents.downloaded(name));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };
  return { download: () => void download(), downloading };
}
