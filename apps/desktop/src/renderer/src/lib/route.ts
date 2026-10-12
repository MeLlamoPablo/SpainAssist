import { useAppStore, type VaultTab } from '../store/app';
import { useProcedureStore } from '../store/procedures';

/**
 * Optional deep links for the standalone preview and screenshots:
 * ?p=<procedureId> (highlight its card) · ?view=vault|settings|procedures · ?tab=<vault tab>
 * · ?archived (show archived cards).
 */
export function applyInitialRoute(): void {
  const params = new URLSearchParams(window.location.search);
  const { navigate, focusProcedure } = useAppStore.getState();
  const view = params.get('view');
  if (view === 'vault')
    navigate({ kind: 'vault', tab: (params.get('tab') as VaultTab) ?? undefined });
  else if (view === 'settings') navigate({ kind: 'settings' });
  const p = params.get('p');
  if (p && useProcedureStore.getState().byId[p]) focusProcedure(p);
  if (params.has('archived')) useAppStore.getState().setShowArchived(true);
}
