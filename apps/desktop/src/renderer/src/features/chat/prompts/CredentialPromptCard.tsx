import type { CredentialPrompt, PromptItem } from '@sa/shared';
import { IdCard, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { useT } from '../../../i18n';
import { api, errorMessage } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { reloadVault } from '../../../store/sync';
import { toast } from '../../../store/toast';
import { ClaveDialog } from '../../vault/CredentialsSection';
import { vaultDict } from '../../vault/i18n';
import { chatDict } from '../i18n';
import { Markdown } from '../Markdown';
import { PromptShell } from './PromptShell';

/**
 * The agent needs a login method that isn't saved: the user adds it here, to the vault. A Cl@ve
 * Permanente through the app's own form (or corrects the saved one when the site rejected it);
 * the DNIe in one click (the phone is paired later, by the login's own card).
 */
export function CredentialPromptCard({
  item,
  prompt,
  embedded,
}: {
  item: PromptItem;
  prompt: CredentialPrompt;
  /** Shown on the procedure's card. */
  embedded?: boolean;
}) {
  const t = useT(chatDict);
  const tv = useT(vaultDict);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const dnie = prompt.credential === 'dnie';
  const fix = !dnie && !!prompt.replaceId;

  const respond = async (credentialId?: string) => {
    setBusy(true);
    try {
      await api.invoke('chat.respond', item.id, { kind: 'credential', credentialId });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const addDnie = async () => {
    setBusy(true);
    try {
      const credential = await api.invoke('vault.addDnie');
      await reloadVault();
      await api.invoke('chat.respond', item.id, {
        kind: 'credential',
        credentialId: credential.id,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const response = item.response?.kind === 'credential' ? item.response : undefined;
  const answered = response?.credentialId
    ? dnie
      ? t.prompt.dnieAdded
      : fix
        ? t.prompt.claveFixed
        : t.prompt.claveSaved
    : dnie
      ? t.prompt.noDnieAnswer
      : fix
        ? t.prompt.noFixAnswer
        : t.prompt.noClaveAnswer;

  return (
    <PromptShell
      item={item}
      icon={dnie ? IdCard : KeyRound}
      kicker={`${dnie ? t.prompt.dnieKicker : t.prompt.credentialKicker} · ${t.prompt.needsYou.toLowerCase()}`}
      title={prompt.title}
      embedded={embedded}
      answeredSummary={
        response ? (
          <span
            className={cn(
              'font-medium',
              response.credentialId ? 'text-st-done-fg' : 'text-fg-muted',
            )}
          >
            {answered}
          </span>
        ) : null
      }
    >
      <Markdown text={prompt.message} className="text-[14px] text-fg" />
      {dnie ? <p className="mt-2 text-[13px] text-fg-muted">{t.prompt.dnieHint}</p> : null}
      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void respond()}>
          {dnie ? t.prompt.noDnie : fix ? t.prompt.notNow : t.prompt.noClave}
        </Button>
        {dnie ? (
          <Button variant="primary" icon={IdCard} loading={busy} onClick={() => void addDnie()}>
            {t.prompt.addDnie}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={KeyRound}
            loading={busy}
            onClick={() => setDialogOpen(true)}
          >
            {fix ? t.prompt.fixClave : tv.credentials.clave.add}
          </Button>
        )}
      </div>
      {dnie ? null : (
        <ClaveDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSaved={(credential) => respond(credential.id)}
          replaceId={prompt.replaceId}
        />
      )}
    </PromptShell>
  );
}
