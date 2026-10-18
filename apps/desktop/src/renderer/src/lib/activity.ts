import { type CredentialKind, personalFieldDef } from '@sa/shared';
import {
  ArrowLeft,
  BookOpen,
  Braces,
  ClipboardList,
  Clock,
  Database,
  FileDown,
  FileUp,
  Globe,
  Hand,
  IdCard,
  Inbox,
  Keyboard,
  KeyRound,
  type LucideIcon,
  MessageSquareText,
  MousePointerClick,
  PanelTop,
  PhoneCall,
  Rocket,
  Save,
  ScanEye,
  Search,
  Send,
  Share2,
  ShieldCheck,
  SquareCheck,
  SquareMousePointer,
  ThumbsUp,
  Users,
  X,
} from 'lucide-react';
import type { Lang } from '../i18n';
import { hostOf, truncate } from './format';

/**
 * Turns an agent tool call (tool name + args) into a short, friendly, localized label for the
 * procedure status and events. Tool names are normalized, so "browser_open", "browser.open" and
 * "browserOpen" are the same. Unknown tools get a generic label.
 */

export interface ActivityLabel {
  text: string;
  icon: LucideIcon;
  /** Host involved, if any. */
  host?: string;
  /** The step typed a secret (shown with a lock). */
  secret?: boolean;
}

export interface ActivityContext {
  lang: Lang;
  /** Used to name the credential used by browser_fill_from_vault. */
  credentialKind?: (credentialId: string) => CredentialKind | undefined;
}

export function normalizeTool(tool: string): string {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.\-\s/]+/g, '_')
    .toLowerCase()
    .replace(/^(sa|spain_assist|mcp)_+/, '');
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

const q = (lang: Lang, text: string) =>
  lang === 'es' ? `«${truncate(text, 60)}»` : `“${truncate(text, 60)}”`;

const CREDENTIAL_NAME: Record<CredentialKind, { es: string; en: string }> = {
  clave_permanente: { es: 'Cl@ve', en: 'Cl@ve' },
  clave_movil: { es: 'Cl@ve Móvil', en: 'Cl@ve Móvil' },
  dnie: { es: 'DNIe', en: 'DNIe' },
  certificate: { es: 'certificado', en: 'certificate' },
};

export function activityLabel(
  tool: string,
  args: Record<string, unknown>,
  ctx: ActivityContext,
): ActivityLabel {
  const { lang } = ctx;
  const es = lang === 'es';
  const name = normalizeTool(tool);
  const query = str(args.query);
  const url = str(args.url);

  switch (name) {
    case 'web_search':
    case 'exa_search':
    case 'search': {
      const lead = es ? 'Buscando en internet' : 'Searching the web';
      return { text: query ? `${lead}: ${q(lang, query)}` : lead, icon: Search };
    }
    case 'fetch_url':
    case 'exa_fetch':
    case 'read_url':
    case 'web_fetch': {
      // exa_fetch reads several pages (`urls`): name the first one.
      const page = url ?? (Array.isArray(args.urls) ? str(args.urls[0]) : undefined);
      const host = page ? hostOf(page) : undefined;
      return {
        text: host
          ? es
            ? `Leyendo ${host}`
            : `Reading ${host}`
          : es
            ? 'Leyendo una página'
            : 'Reading a page',
        icon: Globe,
        host,
      };
    }
    case 'web_research': {
      return { text: es ? 'Investigando el trámite' : 'Researching the procedure', icon: BookOpen };
    }
    case 'feedback_search': {
      const lead = es
        ? 'Buscando experiencias de otras personas'
        : 'Looking at other people’s experiences';
      return { text: query ? `${lead}: ${q(lang, query)}` : lead, icon: Users };
    }
    case 'feedback_submit':
      return {
        text: es ? 'Compartiendo un aprendizaje anónimo' : 'Sharing an anonymous learning',
        icon: Share2,
      };
    case 'feedback_vote':
      return {
        text: es ? 'Valorando una experiencia de otra persona' : 'Rating someone else’s experience',
        icon: ThumbsUp,
      };
    case 'run_script':
      return { text: es ? 'Procesando datos' : 'Working with data', icon: Braces };
    case 'procedure_update':
      return { text: es ? 'Actualizando el plan' : 'Updating the plan', icon: ClipboardList };
    case 'procedure_get':
      return { text: es ? 'Repasando el trámite' : 'Reviewing the procedure', icon: ClipboardList };
    // --- the assistant (orchestrator) ---
    case 'procedure_start': {
      const title = str(args.title);
      return {
        text: title
          ? es
            ? `Empiezo el trámite ${q(lang, title)}`
            : `Starting ${q(lang, title)}`
          : es
            ? 'Empiezo un trámite'
            : 'Starting a procedure',
        icon: Rocket,
      };
    }
    case 'procedure_message':
      return {
        text: es ? 'Paso la información al trámite' : 'Passing it on to the procedure',
        icon: Send,
      };
    case 'procedure_list':
      return {
        text: es ? 'Repasando tus trámites' : 'Reviewing your procedures',
        icon: ClipboardList,
      };
    case 'procedure_resume':
      return { text: es ? 'Retomando el trámite' : 'Resuming the procedure', icon: Rocket };
    case 'procedure_respond':
      return {
        text: es ? 'Pasando tu respuesta al trámite' : 'Passing your answer to the procedure',
        icon: Send,
      };
    case 'procedure_read':
      return {
        text: es ? 'Mirando la tarjeta del trámite' : 'Checking the procedure card',
        icon: ClipboardList,
      };
    case 'procedure_stop':
      return {
        text: es ? 'Parando el trabajo del trámite' : 'Stopping work on the procedure',
        icon: X,
      };
    case 'procedure_cancel':
      return { text: es ? 'Cancelando el trámite' : 'Cancelling the procedure', icon: X };
    case 'procedure_report': {
      const title = str(args.title);
      return {
        text: title
          ? es
            ? `Novedades de ${q(lang, title)}`
            : `News from ${q(lang, title)}`
          : es
            ? 'Novedades de un trámite'
            : 'News from a procedure',
        icon: Inbox,
      };
    }
    case 'vault_read':
      return { text: es ? 'Consultando tus datos' : 'Checking your data', icon: Database };
    case 'vault_save': {
      const items = Array.isArray(args.items) ? args.items.length : 0;
      return {
        text: es
          ? items > 1
            ? `Guardando ${items} datos en Mis datos`
            : 'Guardando un dato en Mis datos'
          : items > 1
            ? `Saving ${items} items to My data`
            : 'Saving to My data',
        icon: Save,
      };
    }
    case 'download_save': {
      const name = str(args.name);
      return {
        text: name
          ? es
            ? `Guardando ${q(lang, name)} en Mis datos`
            : `Saving ${q(lang, name)} to My data`
          : es
            ? 'Guardando un documento en Mis datos'
            : 'Saving a document to My data',
        icon: FileDown,
      };
    }
    case 'ask_user':
    case 'prompt_form':
      return {
        text: es ? 'Preguntándote unos datos' : 'Asking you for some details',
        icon: MessageSquareText,
      };
    case 'confirm_action':
    case 'prompt_confirm':
      return { text: es ? 'Pidiéndote confirmación' : 'Asking for your confirmation', icon: Hand };
    case 'request_user_action':
    case 'prompt_user_action':
      return {
        text: es ? 'Esperando a que hagas un paso' : 'Waiting for you to do a step',
        icon: Hand,
      };
    case 'request_credential':
      return args.credential === 'dnie'
        ? { text: es ? 'Pidiéndote tu DNIe' : 'Asking for your DNIe', icon: IdCard }
        : {
            text: es ? 'Pidiéndote tu Cl@ve Permanente' : 'Asking for your Cl@ve Permanente',
            icon: KeyRound,
          };
    case 'request_phone_call':
      return {
        text: es ? 'Pidiéndote que hagas una llamada' : 'Asking you to make a phone call',
        icon: PhoneCall,
      };
    case 'browser_open': {
      const host = url ? hostOf(url) : undefined;
      return {
        text: host
          ? es
            ? `Abriendo ${host}`
            : `Opening ${host}`
          : es
            ? 'Abriendo el navegador'
            : 'Opening the browser',
        icon: PanelTop,
        host,
      };
    }
    case 'browser_snapshot':
      return { text: es ? 'Mirando la página' : 'Looking at the page', icon: ScanEye };
    case 'browser_click': {
      const element = str(args.element);
      return {
        text: element
          ? es
            ? `Pulsando ${q(lang, element)}`
            : `Clicking ${q(lang, element)}`
          : es
            ? 'Pulsando en la página'
            : 'Clicking on the page',
        icon: MousePointerClick,
      };
    }
    case 'browser_type': {
      const text = str(args.text);
      return {
        text: text
          ? es
            ? `Escribiendo ${q(lang, text)}`
            : `Typing ${q(lang, text)}`
          : es
            ? 'Escribiendo en la página'
            : 'Typing on the page',
        icon: Keyboard,
      };
    }
    case 'browser_fill_from_vault':
      return fillFromVaultLabel(args, ctx);
    case 'browser_login_clave':
      return {
        text: es ? 'Entrando con tu Cl@ve Permanente' : 'Logging in with your Cl@ve Permanente',
        icon: KeyRound,
      };
    case 'browser_fill_from_user': {
      const label = str(args.label);
      return {
        text: label
          ? es
            ? `Escribiendo lo que me des: ${label.toLowerCase()} (oculto)`
            : `Typing what you give me: ${label.toLowerCase()} (hidden)`
          : es
            ? 'Escribiendo un código que me des (oculto)'
            : 'Typing a code you give me (hidden)',
        icon: KeyRound,
        secret: true,
      };
    }
    case 'browser_select': {
      const values = Array.isArray(args.values)
        ? args.values.filter((v) => typeof v === 'string')
        : [];
      return {
        text: values.length
          ? es
            ? `Eligiendo ${q(lang, values.join(', '))}`
            : `Choosing ${q(lang, values.join(', '))}`
          : es
            ? 'Eligiendo una opción'
            : 'Choosing an option',
        icon: SquareMousePointer,
      };
    }
    case 'browser_check':
      return {
        text:
          args.checked === false
            ? es
              ? 'Desmarcando una casilla'
              : 'Unticking a box'
            : es
              ? 'Marcando una casilla'
              : 'Ticking a box',
        icon: SquareCheck,
      };
    case 'browser_press': {
      const key = str(args.key);
      return {
        text: key
          ? es
            ? `Pulsando la tecla ${key}`
            : `Pressing ${key}`
          : es
            ? 'Pulsando una tecla'
            : 'Pressing a key',
        icon: Keyboard,
      };
    }
    case 'browser_wait': {
      const text = str(args.text);
      return {
        text: text
          ? es
            ? `Esperando a que aparezca ${q(lang, text)}`
            : `Waiting for ${q(lang, text)}`
          : es
            ? 'Esperando a que cargue la página'
            : 'Waiting for the page to load',
        icon: Clock,
      };
    }
    case 'browser_back':
      return { text: es ? 'Volviendo atrás' : 'Going back', icon: ArrowLeft };
    case 'browser_tabs':
      return { text: es ? 'Cambiando de pestaña' : 'Switching tabs', icon: PanelTop };
    case 'browser_screenshot':
      return { text: es ? 'Haciendo una captura' : 'Taking a screenshot', icon: ScanEye };
    case 'browser_upload': {
      const n = Array.isArray(args.documentIds) ? args.documentIds.length : 1;
      return {
        text: es
          ? n > 1
            ? `Subiendo ${n} documentos`
            : 'Subiendo un documento'
          : n > 1
            ? `Uploading ${n} documents`
            : 'Uploading a document',
        icon: FileUp,
      };
    }
    case 'browser_use_certificate':
      return {
        text: es ? 'Preparando tu certificado digital' : 'Getting your digital certificate ready',
        icon: ShieldCheck,
      };
    case 'browser_close':
      return { text: es ? 'Cerrando el navegador' : 'Closing the browser', icon: X };
    default: {
      return {
        text: es ? 'Trabajando en tu solicitud' : 'Working on your request',
        icon: ClipboardList,
      };
    }
  }
}

function fillFromVaultLabel(args: Record<string, unknown>, ctx: ActivityContext): ActivityLabel {
  const es = ctx.lang === 'es';
  // Older procedures logged `value: {source, key | credentialId + field}`.
  const value = (args.value ?? { source: 'personal', key: args.key }) as Record<string, unknown>;
  if (value.source === 'credential') {
    const kind =
      typeof value.credentialId === 'string' ? ctx.credentialKind?.(value.credentialId) : undefined;
    const credName = kind ? CREDENTIAL_NAME[kind][ctx.lang] : es ? 'Cl@ve' : 'Cl@ve';
    if (value.field === 'password') {
      return {
        text: es
          ? `Rellenando tu contraseña de ${credName} (oculta)`
          : `Filling in your ${credName} password (hidden)`,
        icon: KeyRound,
        secret: true,
      };
    }
    return {
      text: es ? `Rellenando tu usuario de ${credName}` : `Filling in your ${credName} username`,
      icon: KeyRound,
    };
  }
  if (value.source === 'personal' && typeof value.key === 'string') {
    const def = personalFieldDef(value.key);
    const label = def
      ? def.label[ctx.lang].toLowerCase()
      : value.key.replace(/^custom\./, '').replace(/[-_]/g, ' ');
    return {
      text: es ? `Rellenando tu ${label}` : `Filling in your ${label}`,
      icon: Keyboard,
    };
  }
  return { text: es ? 'Rellenando con tus datos' : 'Filling in with your data', icon: Keyboard };
}
