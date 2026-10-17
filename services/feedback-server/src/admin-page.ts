import { createHash } from 'node:crypto';
import { HUMAN_AUTHOR, ThinkingLevel } from '@sa/shared';
import { MARKDOWN_JS } from './admin-markdown';

/**
 * The learnings admin page (`GET /admin`): one self-contained HTML page with inline CSS and JS,
 * in the style of the key server's voucher page. It holds no data: everything is fetched from
 * the admin API with the token the maintainer pastes (or passes in the URL fragment,
 * `#token=…`, which never reaches the server). The token lives in sessionStorage only. All
 * data is rendered with textContent, never as HTML.
 */

const STYLE = `
:root {
  color-scheme: light;
  --bg: #f7f3ef; --surface: #fff; --surface-2: #fcfbf9; --line: #e5e1dc; --line-strong: #d4cec8;
  --fg: #28211d; --muted: #605954; --subtle: #79736e;
  --accent: #b04e35; --accent-hover: #913d2b; --accent-soft: #fef5f0; --accent-line: #fcd0bd;
  --ring: rgba(206, 100, 69, 0.5); --danger: #c52c2a; --danger-hover: #ac1a1c;
  --ok-fg: #0a693c; --ok-bg: #e6faec; --ok-line: #b9e4c6;
  --info-fg: #2158a7; --info-bg: #ecf5ff; --info-line: #c7ddf9;
  --warn-fg: #884d01; --warn-bg: #fff5db; --warn-line: #f4d397;
  --off-fg: #4d5969; --off-bg: #eff3f7; --off-line: #d4dbe5;
  --bad-fg: #b02b27; --bad-bg: #ffefee; --bad-line: #facfca;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
[hidden] { display: none !important; }
header { display: flex; align-items: center; gap: 12px; padding: 12px 24px; min-height: 57px;
  border-bottom: 1px solid var(--line); background: var(--surface); position: sticky; top: 0;
  z-index: 2; }
header h1 { font-size: 16px; margin: 0; font-weight: 600; white-space: nowrap; }
header h1 span + span { color: var(--subtle); font-weight: 400; }
.header-stats { flex: 1; color: var(--subtle); font-size: 13px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
main { padding: 0; }
h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
h3 { font-size: 13px; margin: 0 0 8px; font-weight: 600; color: var(--muted); }
p.hint { margin: 0 0 16px; color: var(--muted); }
label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); min-width: 0; }
input, select, textarea { font: inherit; color: var(--fg); background: var(--surface);
  border: 1px solid var(--line-strong); border-radius: 8px; min-width: 0; width: 100%; }
input, select { height: 36px; padding: 0 10px; }
textarea { padding: 8px 10px; resize: vertical; line-height: 1.5; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible,
a:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
button { font: inherit; height: 36px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--line-strong); background: var(--surface); color: var(--fg);
  white-space: nowrap; }
button:hover { background: var(--surface-2); }
button:disabled { opacity: 0.6; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
button.primary:hover { background: var(--accent-hover); }
button.danger { background: var(--danger); border-color: var(--danger); color: #fff; }
button.danger:hover { background: var(--danger-hover); }
button.small { height: 28px; padding: 0 10px; font-size: 13px; }
button.link { border: 0; background: none; color: var(--accent); padding: 0 4px; height: auto; }
button.up { color: var(--ok-fg); border-color: var(--ok-line); background: var(--ok-bg); }
button.up:hover { border-color: var(--ok-fg); }
button.down { color: var(--bad-fg); border-color: var(--bad-line); background: var(--bad-bg); }
button.down:hover { border-color: var(--bad-fg); }
a { color: var(--accent); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.spacer { flex: 1; }
.error { margin: 12px 0 0; color: var(--danger); }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
.login { max-width: 460px; margin: 48px auto 0; width: calc(100% - 32px); }
.login form { display: grid; gap: 12px; }

/* layout: list on the left, entry on the right */
#app { display: grid; grid-template-columns: minmax(340px, 420px) minmax(0, 1fr);
  height: calc(100vh - 57px); }
.pane-list { border-right: 1px solid var(--line); background: var(--surface); display: flex;
  flex-direction: column; min-height: 0; }
.pane-detail { overflow-y: auto; min-width: 0; }
.tabs { display: flex; gap: 4px; padding: 12px 16px 0; border-bottom: 1px solid var(--line); }
.tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none;
  color: var(--muted); padding: 0 10px; height: 36px; }
.tabs button[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent);
  font-weight: 500; }
.filters { padding: 12px 16px; display: grid; gap: 8px; border-bottom: 1px solid var(--line); }
.filters .two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.filters select, .filters input { height: 32px; font-size: 13px; }
.list-meta { display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 16px; color: var(--subtle); font-size: 12px; border-bottom: 1px solid var(--line); }
.list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 0; }
.list li { border-bottom: 1px solid var(--line); }
.item { display: grid; gap: 4px; width: 100%; height: auto; text-align: left; padding: 10px 16px;
  border: 0; border-radius: 0; background: none; border-left: 3px solid transparent; }
.item:hover { background: var(--surface-2); }
.item[aria-current="true"] { background: var(--accent-soft); border-left-color: var(--accent); }
.item-top { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--subtle); }
.item-top time { margin-left: auto; }
.item-title { font-weight: 500; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; white-space: normal; }
.item-sub { color: var(--subtle); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.list-foot { padding: 12px 16px; text-align: center; }
.empty { padding: 32px 16px; text-align: center; color: var(--subtle); }
.keys { padding: 8px 16px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 12px; }
kbd { font: 11px var(--mono); border: 1px solid var(--line-strong); border-bottom-width: 2px;
  border-radius: 4px; padding: 0 4px; background: var(--surface-2); color: var(--muted); }

.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid;
  font-size: 12px; font-weight: 500; white-space: nowrap; }
.k-tip, .w-up { color: var(--ok-fg); background: var(--ok-bg); border-color: var(--ok-line); }
.k-friction { color: var(--warn-fg); background: var(--warn-bg); border-color: var(--warn-line); }
.k-gotcha, .w-down { color: var(--bad-fg); background: var(--bad-bg); border-color: var(--bad-line); }
.score { color: var(--info-fg); background: var(--info-bg); border-color: var(--info-line); }
.w-zero, .edited, .author { color: var(--off-fg); background: var(--off-bg); border-color: var(--off-line); }
.author { max-width: 160px; overflow: hidden; text-overflow: ellipsis; font-weight: 400; }
.reviewed { color: var(--accent-hover); font-weight: 500; }

/* entry */
.detail { max-width: 860px; margin: 0 auto; padding: 20px 24px 64px; display: grid; gap: 16px;
  grid-template-columns: minmax(0, 1fr); }
.detail-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.back { display: none; }
.entry-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.entry-title { font-size: 20px; line-height: 1.3; margin: 0 0 6px; }
.entry-where { color: var(--muted); margin: 0 0 16px; }
.entry-where .link { padding: 0; font: inherit; }
.facts .link { padding: 0; font: inherit; text-align: left; }
.entry-body { overflow-wrap: anywhere; font-size: 15px; line-height: 1.6; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p, .md ul, .md ol, .md pre, .md blockquote { margin: 0 0 12px; }
.md ul, .md ol { padding-left: 22px; }
.md li + li { margin-top: 2px; }
.md h4 { margin: 16px 0 6px; font-size: 15px; font-weight: 600; }
.md h4.md-h1 { font-size: 18px; }
.md h4.md-h2 { font-size: 16px; }
.md code { font: 13px var(--mono); background: var(--surface-2); border: 1px solid var(--line);
  border-radius: 4px; padding: 0 4px; }
.md pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px;
  padding: 10px 12px; overflow-x: auto; }
.md pre code { border: 0; padding: 0; background: none; white-space: pre; }
.md blockquote { border-left: 3px solid var(--line-strong); padding-left: 12px; color: var(--muted); }
.md hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; margin: 16px 0 0;
  font-size: 13px; }
.facts dt { color: var(--subtle); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { height: 24px; padding: 0 8px; border-radius: 999px; font-size: 12px; background: var(--surface-2); }
.links { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.mono { font-family: var(--mono); font-size: 12px; }
.serve-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
  flex-wrap: wrap; }
.serve-pct { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.meter { position: relative; height: 8px; background: var(--off-bg); border-radius: 999px;
  margin: 10px 0 6px; overflow: hidden; }
.meter span { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 999px; }
.meter-scale { display: flex; justify-content: space-between; color: var(--subtle); font-size: 12px; }
.serve-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 16px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { background: var(--surface-2); color: var(--subtle); font-weight: 500; }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
td.muted { color: var(--subtle); }
td.actions { text-align: right; }
.confirm { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.confirm span { color: var(--danger); font-weight: 500; }

/* edit form */
.edit { display: grid; gap: 12px; }
.edit .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.author-row { flex-wrap: nowrap; }
.author-row input { flex: 1; }
.counter { font-size: 12px; color: var(--subtle); justify-self: end; }
.counter.over { color: var(--danger); }
.field-hint { font-size: 12px; color: var(--subtle); }

/* overview */
.stats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px;
  text-align: left; height: auto; display: grid; gap: 2px; }
button.stat:hover { border-color: var(--line-strong); background: var(--surface); }
.stat b { font-size: 24px; font-variant-numeric: tabular-nums; font-weight: 600; }
.stat span { color: var(--subtle); font-size: 13px; white-space: normal; }
.bars { display: grid; gap: 6px; }
.bar-row { display: grid; grid-template-columns: minmax(0, 1fr) 40px; gap: 8px; align-items: center;
  font-size: 13px; height: auto; padding: 4px 8px; border: 0; text-align: left; background: none; }
.bar-row .label { position: relative; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 2px 8px; border-radius: 6px; z-index: 0; }
.bar-row .label i { position: absolute; inset: 0 auto 0 0; background: var(--accent-soft);
  border-radius: 6px; z-index: -1; }
.bar-row .n { text-align: right; color: var(--subtle); font-variant-numeric: tabular-nums; }
ul.plain { margin: 0; padding-left: 18px; color: var(--muted); display: grid; gap: 4px; }

.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 5;
  background: var(--fg); color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 13px; }

@media (max-width: 860px) {
  header { padding: 10px 16px; }
  .header-stats { display: none; }
  #app { display: block; height: auto; }
  .pane-list { border-right: 0; min-height: calc(100vh - 57px); }
  .list { overflow: visible; }
  #app.has-detail .pane-list { display: none; }
  #app:not(.has-detail) .pane-detail { display: none; }
  .back { display: inline-block; }
  .detail { padding: 16px 16px 48px; }
}
`;

const SCRIPT = `
'use strict';
${MARKDOWN_JS}
const T = {
  es: {
    title: 'Aprendizajes', lang: 'English', logout: 'Salir',
    loginTitle: 'Entra con el token de administración',
    loginHint: 'Es feedback_admin_token en terraform.tfvars. Se guarda solo en esta pestaña.',
    token: 'Token', enter: 'Entrar', badToken: 'Ese token no vale.',
    tabBrowse: 'Explorar', tabSearch: 'Probar búsqueda',
    searchPh: 'Busca en el texto, el trámite, las etiquetas… o pega un id',
    kind: 'Tipo', votes: 'Votos', review: 'Revisión', sort: 'Orden', procedure: 'Trámite', tag: 'Etiqueta',
    author: 'Autor', a_human: 'Persona', a_unknown: 'No se sabe',
    authorHint: '«human» si lo escribió una persona, o «modelo · nivel», p. ej. gpt-6-luna · high. Vacío: no se sabe.',
    badAuthor: 'El autor tiene que ser «human» o «modelo · nivel», p. ej. gpt-6-luna · high.',
    all: 'Todos', allF: 'Todas', any: 'Cualquiera',
    k_tip: 'Consejo', k_friction: 'Problema', k_gotcha: 'Trampa',
    v_up: 'Positivos', v_down: 'Negativos', v_neutral: 'Neutros',
    r_no: 'Sin revisar', r_yes: 'Revisados',
    s_newest: 'Más nuevos', s_oldest: 'Más antiguos', s_votes: 'Más votados', s_edited: 'Editados hace poco',
    clear: 'Quitar filtros', refresh: 'Actualizar', more: 'Cargar más', loading: 'Cargando…',
    count: (n, total) => (n < total ? n + ' de ' + total : String(total)) + (total === 1 ? ' aprendizaje' : ' aprendizajes'),
    empty: 'No hay aprendizajes con estos filtros.',
    searchHint: 'Lo mismo que buscan los agentes, en orden de relevancia y sin sorteo: ves todos los candidatos con su puntuación y su probabilidad de salir.',
    searchQ: 'Búsqueda', searchQPh: 'p. ej. cita previa renovar dni', limit: 'Resultados', search: 'Buscar',
    searchEmpty: 'Ningún resultado para esta búsqueda.', searchShort: 'Escribe al menos 2 letras.',
    reviewedMark: 'revisado',
    keys: 'Teclas', keyNav: 'moverse', keyFind: 'buscar', keyEdit: 'editar', keyVote: 'votar',
    back: 'Lista', edit: 'Editar', del: 'Borrar', delAsk: '¿Borrar para siempre?', delYes: 'Sí, borrar',
    cancel: 'Cancelar', deleted: 'Aprendizaje borrado',
    edited: 'Editado', fTags: 'Etiquetas', fUrls: 'Enlaces', none: '—',
    serveTitle: 'Cuántas veces se sirve',
    serveText: (w, x) => 'Peso neto ' + w + '. Con +' + x + ' sale siempre; con −' + x + ', nunca; con 0, la mitad de las veces.',
    voteUp: 'Es útil', voteDown: 'No es útil',
    voteHint: (x) => 'Tu voto vale ' + x + ' (como ' + x + ' agentes) y pierde valor con el tiempo, como todos.',
    votedUp: 'Voto positivo guardado', votedDown: 'Voto negativo guardado',
    votesTitle: 'Votos', noVotes: 'Nadie ha votado todavía.',
    c_when: 'Cuándo', c_who: 'Quién', c_vote: 'Voto', c_worth: 'Vale ahora',
    agent: 'Agente', human: 'Persona', up: '▲ Útil', down: '▼ No útil', remove: 'Quitar',
    voteRemoved: 'Voto quitado',
    dataTitle: 'Datos', id: 'Id', created: 'Creado', updated: 'Editado', appVersion: 'Versión de la app',
    never: 'Nunca', copy: 'Copiar', copied: 'Copiado',
    editTitle: 'Editar aprendizaje',
    editHint: 'Al guardar, el servidor vuelve a quitar los datos personales, como con los envíos de la app.',
    newEntry: 'Nueva entrada', newTitle: 'Nuevo aprendizaje',
    newHint: 'Escribe lo que conviene saber del trámite. Al guardar, el servidor quita los datos personales, como con los envíos de la app.',
    newAuthorHint: '«human» si lo escribes tú, o «modelo · nivel», p. ej. gpt-6-luna · high. Vacío: «human».',
    savedNew: 'Aprendizaje creado', keyNew: 'nueva',
    administration: 'Administración', region: 'Región', fTitle: 'Título', body: 'Texto',
    tagsHint: 'Separadas por comas. Hasta 10.', urlsHint: 'Una por línea. Hasta 5. Sin parámetros.',
    save: 'Guardar', saving: 'Guardando…', saved: 'Guardado',
    savedScrubbed: (n) => 'Guardado. El servidor ha quitado ' + n + (n === 1 ? ' dato personal.' : ' datos personales.'),
    unsaved: 'Guarda o cancela la edición primero.',
    tooManyTags: 'Pon 10 etiquetas como mucho.', tooManyUrls: 'Pon 5 enlaces como mucho.',
    overviewTitle: 'Resumen', overviewHint: 'Elige un aprendizaje de la lista para verlo, votarlo o editarlo.',
    st_total: 'aprendizajes', st_unreviewed: 'sin revisar', st_up: 'con votos positivos', st_down: 'con votos negativos',
    byKind: 'Por tipo', topProcedures: 'Trámites con más aprendizajes', topTags: 'Etiquetas más usadas',
    topAuthors: 'Quién los escribe',
    policyTitle: 'Cómo funcionan los votos',
    policy: (p) => [
      'Los votos deciden cuántas veces se sirve un aprendizaje, no su posición.',
      'Sin votos se sirve la mitad de las veces; con +' + p.threshold + ', siempre; con −' + p.threshold + ', nunca.',
      'Un voto de agente vale 1; un voto tuyo vale ' + p.threshold + '.',
      'Cada voto vale entero ' + p.decayStartDays + ' días y deja de contar a los ' + p.decayEndDays + '.',
    ],
    notFound: 'Ese aprendizaje ya no existe.', failed: 'Algo ha fallado: ',
  },
  en: {
    title: 'Learnings', lang: 'Español', logout: 'Sign out',
    loginTitle: 'Sign in with the admin token',
    loginHint: 'It is feedback_admin_token in terraform.tfvars. It is kept in this tab only.',
    token: 'Token', enter: 'Sign in', badToken: 'That token is not valid.',
    tabBrowse: 'Browse', tabSearch: 'Try a search',
    searchPh: 'Search text, procedure, tags… or paste an id',
    kind: 'Kind', votes: 'Votes', review: 'Review', sort: 'Sort', procedure: 'Procedure', tag: 'Tag',
    author: 'Author', a_human: 'Human', a_unknown: 'Unknown',
    authorHint: '“human” if a person wrote it, or “model · level”, e.g. gpt-6-luna · high. Empty: unknown.',
    badAuthor: 'The author must be “human” or “model · level”, e.g. gpt-6-luna · high.',
    all: 'All', allF: 'All', any: 'Any',
    k_tip: 'Tip', k_friction: 'Friction', k_gotcha: 'Gotcha',
    v_up: 'Positive', v_down: 'Negative', v_neutral: 'Neutral',
    r_no: 'Not reviewed', r_yes: 'Reviewed',
    s_newest: 'Newest', s_oldest: 'Oldest', s_votes: 'Most voted', s_edited: 'Recently edited',
    clear: 'Clear filters', refresh: 'Refresh', more: 'Load more', loading: 'Loading…',
    count: (n, total) => (n < total ? n + ' of ' + total : String(total)) + (total === 1 ? ' learning' : ' learnings'),
    empty: 'No learnings match these filters.',
    searchHint: 'The same search agents run, in relevance order and without the draw: you see every candidate with its score and its chance of being served.',
    searchQ: 'Query', searchQPh: 'e.g. cita previa renovar dni', limit: 'Results', search: 'Search',
    searchEmpty: 'No results for this search.', searchShort: 'Type at least 2 letters.',
    reviewedMark: 'reviewed',
    keys: 'Keys', keyNav: 'move', keyFind: 'search', keyEdit: 'edit', keyVote: 'vote',
    back: 'List', edit: 'Edit', del: 'Delete', delAsk: 'Delete for good?', delYes: 'Yes, delete',
    cancel: 'Cancel', deleted: 'Learning deleted',
    edited: 'Edited', fTags: 'Tags', fUrls: 'Links', none: '—',
    serveTitle: 'How often it is served',
    serveText: (w, x) => 'Net weight ' + w + '. At +' + x + ' it is always served; at −' + x + ', never; at 0, half of the time.',
    voteUp: 'Useful', voteDown: 'Not useful',
    voteHint: (x) => 'Your vote weighs ' + x + ' (like ' + x + ' agents) and fades over time, like every vote.',
    votedUp: 'Up vote saved', votedDown: 'Down vote saved',
    votesTitle: 'Votes', noVotes: 'Nobody has voted yet.',
    c_when: 'When', c_who: 'Who', c_vote: 'Vote', c_worth: 'Worth now',
    agent: 'Agent', human: 'Human', up: '▲ Useful', down: '▼ Not useful', remove: 'Remove',
    voteRemoved: 'Vote removed',
    dataTitle: 'Details', id: 'Id', created: 'Created', updated: 'Edited', appVersion: 'App version',
    never: 'Never', copy: 'Copy', copied: 'Copied',
    editTitle: 'Edit learning',
    editHint: 'When you save, the server removes personal data again, as it does with submissions from the app.',
    newEntry: 'New entry', newTitle: 'New learning',
    newHint: 'Write what is worth knowing about the procedure. When you save, the server removes personal data, as it does with submissions from the app.',
    newAuthorHint: '“human” if you write it, or “model · level”, e.g. gpt-6-luna · high. Empty: “human”.',
    savedNew: 'Learning created', keyNew: 'new',
    administration: 'Administration', region: 'Region', fTitle: 'Title', body: 'Text',
    tagsHint: 'Comma separated. Up to 10.', urlsHint: 'One per line. Up to 5. No parameters.',
    save: 'Save', saving: 'Saving…', saved: 'Saved',
    savedScrubbed: (n) => 'Saved. The server removed ' + n + (n === 1 ? ' piece' : ' pieces') + ' of personal data.',
    unsaved: 'Save or cancel the edit first.',
    tooManyTags: 'Use 10 tags at most.', tooManyUrls: 'Use 5 links at most.',
    overviewTitle: 'Overview', overviewHint: 'Pick a learning from the list to read, vote on or edit it.',
    st_total: 'learnings', st_unreviewed: 'not reviewed', st_up: 'with positive votes', st_down: 'with negative votes',
    byKind: 'By kind', topProcedures: 'Procedures with most learnings', topTags: 'Most used tags',
    topAuthors: 'Who wrote them',
    policyTitle: 'How votes work',
    policy: (p) => [
      'Votes decide how often a learning is served, not where it ranks.',
      'With no votes it is served half of the time; at +' + p.threshold + ', always; at −' + p.threshold + ', never.',
      'An agent vote weighs 1; your vote weighs ' + p.threshold + '.',
      'Each vote keeps its full value for ' + p.decayStartDays + ' days and stops counting after ' + p.decayEndDays + '.',
    ],
    notFound: 'That learning no longer exists.', failed: 'Something went wrong: ',
  },
};
const KINDS = ['tip', 'friction', 'gotcha'];
const HUMAN = '${HUMAN_AUTHOR}';
const AUTHOR_RE = /^(?:${HUMAN_AUTHOR}|[A-Za-z0-9][\\w.:\\/@+-]{0,99} · (?:${ThinkingLevel.options.join('|')}))$/;
const PAGE = 50;
const TOKEN_KEY = 'sa-admin-token';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const $ = (id) => document.getElementById(id);
const store = {
  get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
  set(area, key, value) { try { window[area].setItem(key, value); } catch {} },
  del(area, key) { try { window[area].removeItem(key); } catch {} },
};

let lang = store.get('localStorage', 'sa-admin-lang') === 'en' ? 'en' : 'es';
let token = store.get('sessionStorage', TOKEN_KEY);
let tab = 'browse';
let stats = null;
let entries = [];
let total = 0;
let results = null; // "try a search" results
let selectedId = null;
let detail = null; // { entry, votes }
let mode = 'view'; // view | edit | new | delete
let confirmVote = null; // vote id awaiting removal
let listSeq = 0;
let detailSeq = 0;

// The fragment carries a sign-in token (#token=…, removed at once) or the open entry (#id=…).
function readFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromUrl = params.get('token');
  if (fromUrl) {
    token = fromUrl;
    store.set('sessionStorage', TOKEN_KEY, token);
    params.delete('token');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
  }
  const id = params.get('id');
  return { signedIn: Boolean(fromUrl), id: id && UUID.test(id) ? id.toLowerCase() : null };
}
const initial = readFragment();

const t = (key) => T[lang][key];
const locale = () => (lang === 'es' ? 'es-ES' : 'en-GB');

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

function applyText() {
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = t(node.dataset.t);
  for (const node of document.querySelectorAll('[data-ph]')) node.placeholder = t(node.dataset.ph);
  document.title = t('title') + ' · Spain Assist';
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: Object.assign(
      { authorization: 'Bearer ' + token },
      body ? { 'content-type': 'application/json' } : {},
    ),
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { signOut(t('badToken')); throw new ApiError(401, t('badToken')); }
  if (!res.ok) throw new ApiError(res.status, (data.error && data.error.message) || 'HTTP ' + res.status);
  return data;
}

let toastTimer;
function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
}
function fail(err) { if (err.status !== 401) toast(t('failed') + err.message); }

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch (err) { fail(err); }
}

// --- formatting -------------------------------------------------------------------------------

function fmtDate(iso) {
  if (!iso) return t('never');
  return new Intl.DateTimeFormat(locale(), {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}
function fmtAgo(iso) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: 'short' });
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, 'minute');
}
function fmtWeight(w) {
  const n = new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(Math.abs(w));
  return w > 0 ? '+' + n : w < 0 ? '−' + n : '0';
}
function fmtPct(p) {
  return new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(p);
}
function weightClass(w) { return w >= 0.005 ? 'w-up' : w <= -0.005 ? 'w-down' : 'w-zero'; }
/** "human" in the page's language; agents as sent ("<model id> · <reasoning level>"). */
function authorLabel(author) { return author === 'human' ? t('a_human') : author || t('a_unknown'); }
function authorBadge(e) {
  return e.author ? el('span', { class: 'badge author', title: t('author') + ': ' + authorLabel(e.author) }, authorLabel(e.author)) : null;
}
function kindBadge(kind) { return el('span', { class: 'badge k-' + kind }, t('k_' + kind)); }
function weightBadge(e) {
  return el('span', { class: 'badge ' + weightClass(e.votes), title: t('votes') },
    fmtWeight(e.votes) + ' · ' + fmtPct(e.chance));
}

// --- sign in ----------------------------------------------------------------------------------

function showSignedIn(on) {
  $('login').hidden = on;
  $('app').hidden = !on;
  $('logout').hidden = !on;
  $('new').hidden = !on;
  $('header-stats').hidden = !on;
}

function signOut(message) {
  token = null;
  store.del('sessionStorage', TOKEN_KEY);
  entries = []; results = null; stats = null; detail = null; selectedId = null; mode = 'view';
  showSignedIn(false);
  $('login-error').textContent = message || '';
  $('login-error').hidden = !message;
  $('token').focus();
}

async function start() {
  try {
    await Promise.all([loadStats(), loadList(false)]);
  } catch (err) {
    if (err.status !== 401) {
      $('login-error').textContent = t('failed') + err.message;
      $('login-error').hidden = false;
    }
    return;
  }
  showSignedIn(true);
  const { id } = readFragment();
  if (id) select(id); else renderDetail();
}

// --- stats and filters ------------------------------------------------------------------------

async function loadStats() {
  stats = await api('GET', '/admin/feedback/stats');
  renderFilters();
  renderHeaderStats();
  if (!selectedId && mode !== 'new') renderDetail(); // keep a new entry's draft
}

function renderHeaderStats() {
  if (!stats) return;
  $('header-stats').textContent = stats.total + ' ' + t('st_total') + ' · ' +
    (stats.total - stats.reviewed) + ' ' + t('st_unreviewed');
}

function options(select, items, allLabel) {
  const value = select.value;
  select.replaceChildren(el('option', { value: '' }, allLabel),
    ...items.map(([v, label]) => el('option', { value: v }, label)));
  select.value = items.some(([v]) => v === value) ? value : '';
}

function renderFilters() {
  const k = stats ? stats.kinds : {};
  options($('f-kind'), KINDS.map((kind) => [kind, t('k_' + kind) + (stats ? ' (' + k[kind] + ')' : '')]), t('all'));
  options($('s-kind'), KINDS.map((kind) => [kind, t('k_' + kind)]), t('any'));
  const v = stats ? stats.votes : {};
  options($('f-votes'), ['up', 'down', 'neutral'].map((x) => [x, t('v_' + x) + (stats ? ' (' + v[x] + ')' : '')]), t('all'));
  const reviewed = stats ? stats.reviewed : 0;
  options($('f-review'), [
    ['no', t('r_no') + (stats ? ' (' + (stats.total - reviewed) + ')' : '')],
    ['yes', t('r_yes') + (stats ? ' (' + reviewed + ')' : '')],
  ], t('allF'));
  const sort = $('f-sort').value || 'newest';
  $('f-sort').replaceChildren(...['newest', 'oldest', 'votes', 'edited'].map((s) => el('option', { value: s }, t('s_' + s))));
  $('f-sort').value = sort;
  options($('f-author'), (stats ? stats.authors : []).map((a) => [a.value, authorLabel(a.value) + ' (' + a.count + ')']), t('all'));
  if (stats) {
    $('procedures').replaceChildren(...stats.procedures.map((p) => el('option', { value: p.value })));
    $('tags').replaceChildren(...stats.tags.map((p) => el('option', { value: p.value })));
    const authors = [HUMAN].concat(stats.authors.map((x) => x.value).filter((v) => v !== HUMAN));
    $('authors').replaceChildren(...authors.map((v) => el('option', { value: v })));
  }
}

function filterQuery(offset) {
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort: $('f-sort').value || 'newest' });
  const pairs = [['q', 'f-q'], ['kind', 'f-kind'], ['votes', 'f-votes'], ['reviewed', 'f-review'],
    ['procedure', 'f-procedure'], ['tag', 'f-tag'], ['author', 'f-author']];
  for (const [name, id] of pairs) {
    const value = $(id).value.trim();
    if (value) params.set(name, value);
  }
  return params;
}

function setFilter(id, value) {
  if (!guardEdit()) return;
  setTab('browse');
  for (const f of ['f-q', 'f-kind', 'f-votes', 'f-review', 'f-procedure', 'f-tag', 'f-author']) $(f).value = '';
  const target = id && $(id);
  if (target instanceof HTMLSelectElement && ![...target.options].some((o) => o.value === value)) {
    target.append(el('option', { value }, id === 'f-author' ? authorLabel(value) : value));
  }
  if (target) target.value = value;
  loadList(false).catch(fail);
}

// --- list -------------------------------------------------------------------------------------

async function loadList(append) {
  const seq = ++listSeq;
  const offset = append ? entries.length : 0;
  $('list-status').textContent = t('loading');
  const data = await api('GET', '/admin/feedback?' + filterQuery(offset));
  if (seq !== listSeq) return;
  entries = append ? entries.concat(data.results) : data.results;
  total = data.total;
  renderList();
}

function itemNode(e, withScore) {
  const button = el('button', {
    type: 'button', class: 'item', 'data-id': e.id,
    'aria-current': e.id === selectedId ? 'true' : 'false',
    onclick: () => select(e.id),
  },
    el('span', { class: 'item-top' },
      kindBadge(e.kind),
      weightBadge(e),
      withScore && typeof e.score === 'number' ? el('span', { class: 'badge score' }, e.score.toFixed(2)) : null,
      e.humanVotes > 0 ? el('span', { class: 'reviewed' }, '✓ ' + t('reviewedMark')) : null,
      authorBadge(e),
      el('time', { datetime: e.createdAt, title: fmtDate(e.createdAt) }, fmtAgo(e.createdAt))),
    el('span', { class: 'item-title' }, e.title),
    el('span', { class: 'item-sub' }, [e.procedure, e.region].filter(Boolean).join(' · ')));
  return el('li', {}, button);
}

function renderList() {
  const searching = tab === 'search';
  const shown = searching ? results || [] : entries;
  $('list').replaceChildren(...shown.map((e) => itemNode(e, searching)));
  $('list-empty').hidden = shown.length > 0 || (searching && results === null);
  $('list-empty').textContent = searching ? t('searchEmpty') : t('empty');
  $('more').hidden = searching || entries.length >= total;
  $('list-status').textContent = searching
    ? (results ? t('count')(results.length, results.length) : '')
    : t('count')(entries.length, total);
}

function markSelected() {
  for (const node of document.querySelectorAll('.item')) {
    node.setAttribute('aria-current', node.dataset.id === selectedId ? 'true' : 'false');
  }
}

function replaceEntry(entry) {
  const swap = (list) => list && list.map((e) => (e.id === entry.id ? Object.assign({}, entry, { score: e.score }) : e));
  entries = swap(entries);
  results = swap(results);
  renderList();
}

function dropEntry(id) {
  const had = entries.some((e) => e.id === id);
  entries = entries.filter((e) => e.id !== id);
  if (had) total = Math.max(0, total - 1);
  if (results) results = results.filter((e) => e.id !== id);
  renderList();
}

// --- try a search -----------------------------------------------------------------------------

async function runSearch(event) {
  if (event) event.preventDefault();
  const q = $('s-q').value.trim();
  if (q.length < 2) { toast(t('searchShort')); return; }
  const params = new URLSearchParams({ q, limit: $('s-limit').value });
  if ($('s-procedure').value.trim()) params.set('procedure', $('s-procedure').value.trim());
  if ($('s-kind').value) params.set('kind', $('s-kind').value);
  const seq = ++listSeq;
  $('list-status').textContent = t('loading');
  try {
    const data = await api('GET', '/admin/feedback/search?' + params);
    if (seq !== listSeq) return;
    results = data.results;
    renderList();
  } catch (err) { fail(err); renderList(); }
}

function setTab(next) {
  tab = next;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('browse-filters').hidden = tab !== 'browse';
  $('search-form').hidden = tab !== 'search';
  renderList();
}

// --- entry ------------------------------------------------------------------------------------

function guardEdit() {
  if ((mode === 'edit' || mode === 'new') && $('edit-form') && $('edit-form').dataset.dirty === '1') {
    toast(t('unsaved'));
    return false;
  }
  return true;
}

function setHash() {
  history.replaceState(null, '', location.pathname + location.search + (selectedId ? '#id=' + selectedId : ''));
}

async function select(id) {
  if (id === selectedId && detail && mode !== 'edit') { $('app').classList.add('has-detail'); return; }
  if (!guardEdit()) return;
  selectedId = id;
  mode = 'view';
  confirmVote = null;
  setHash();
  markSelected();
  $('app').classList.add('has-detail');
  await loadDetail();
}

async function loadDetail() {
  const seq = ++detailSeq;
  const id = selectedId;
  try {
    const data = await api('GET', '/admin/feedback/' + encodeURIComponent(id));
    if (seq !== detailSeq) return;
    detail = data;
    replaceEntry(data.entry);
  } catch (err) {
    if (seq !== detailSeq) return;
    detail = null;
    if (err.status === 404) {
      toast(t('notFound'));
      dropEntry(id);
      closeDetail();
      return;
    }
    fail(err);
  }
  renderDetail();
}

function closeDetail() {
  if (!guardEdit()) return;
  selectedId = null; detail = null; mode = 'view';
  setHash();
  markSelected();
  $('app').classList.remove('has-detail');
  renderDetail();
}

function renderDetail() {
  const pane = $('detail');
  if (mode === 'new') pane.replaceChildren(editView(null));
  else if (!selectedId || !detail) { pane.replaceChildren(overview()); return; }
  else pane.replaceChildren(mode === 'edit' ? editView(detail.entry) : entryView(detail));
  if (mode === 'edit' || mode === 'new') { const first = pane.querySelector('[name="title"]'); if (first) first.focus(); }
}

function entryView(d) {
  const e = d.entry;
  const bar = el('div', { class: 'detail-bar' },
    el('button', { type: 'button', class: 'small back', onclick: closeDetail }, '← ' + t('back')),
    el('span', { class: 'spacer' }));
  if (mode === 'delete') {
    const no = el('button', { type: 'button', class: 'small', onclick: () => { mode = 'view'; renderDetail(); } }, t('cancel'));
    const yes = el('button', { type: 'button', class: 'small danger' }, t('delYes'));
    yes.addEventListener('click', () => removeEntry(yes));
    bar.append(el('span', { class: 'confirm' }, el('span', {}, t('delAsk')), yes, no));
    queueMicrotask(() => no.focus({ preventScroll: true }));
  } else {
    bar.append(
      el('button', { type: 'button', class: 'small', onclick: startEdit }, t('edit')),
      el('button', { type: 'button', class: 'small', onclick: () => { mode = 'delete'; renderDetail(); } }, t('del')));
  }

  const facts = el('dl', { class: 'facts' });
  if (e.tags.length) {
    facts.append(el('dt', {}, t('fTags')), el('dd', {}, el('div', { class: 'chips' },
      ...e.tags.map((tag) => el('button', { type: 'button', class: 'chip', onclick: () => setFilter('f-tag', tag) }, tag)))));
  }
  if (e.urls.length) {
    facts.append(el('dt', {}, t('fUrls')), el('dd', {}, el('ul', { class: 'links' },
      ...e.urls.map((url) => el('li', {}, /^https?:/i.test(url)
        ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url)
        : url)))));
  }

  const article = el('article', { class: 'card' },
    el('div', { class: 'entry-badges' },
      kindBadge(e.kind),
      e.updatedAt ? el('span', { class: 'badge edited', title: fmtDate(e.updatedAt) }, t('edited')) : null),
    el('h2', { class: 'entry-title' }, e.title),
    el('p', { class: 'entry-where' },
      el('button', { type: 'button', class: 'link', onclick: () => setFilter('f-procedure', e.procedure) }, e.procedure),
      [e.administration, e.region].filter(Boolean).map((x) => ' · ' + x).join('')),
    el('div', { class: 'entry-body md' }, ...markdown(e.body, el)),
    facts.childNodes.length ? facts : null);

  return el('div', { class: 'detail' }, bar, article, serveCard(e), votesCard(d), dataCard(e));
}

function serveCard(e) {
  const x = stats ? stats.policy.threshold : 5;
  const fill = el('span');
  fill.style.width = Math.round(e.chance * 100) + '%';
  const up = el('button', { type: 'button', class: 'up' }, '▲ ' + t('voteUp'));
  const down = el('button', { type: 'button', class: 'down' }, '▼ ' + t('voteDown'));
  up.addEventListener('click', () => vote('up', up));
  down.addEventListener('click', () => vote('down', down));
  return el('section', { class: 'card' },
    el('div', { class: 'serve-head' },
      el('h3', {}, t('serveTitle')),
      el('span', { class: 'badge ' + weightClass(e.votes) }, fmtWeight(e.votes))),
    el('div', { class: 'serve-pct' }, fmtPct(e.chance)),
    el('div', { class: 'meter', role: 'img', 'aria-label': fmtPct(e.chance) }, fill),
    el('div', { class: 'meter-scale' }, el('span', {}, '−' + x), el('span', {}, '0'), el('span', {}, '+' + x)),
    el('p', { class: 'hint' }, t('serveText')(fmtWeight(e.votes), x)),
    el('div', { class: 'serve-actions' }, up, down,
      el('span', { class: 'field-hint' }, t('voteHint')(x))));
}

function votesCard(d) {
  const section = el('section', { class: 'card' }, el('h3', {}, t('votesTitle') + ' (' + d.votes.length + ')'));
  if (!d.votes.length) { section.append(el('p', { class: 'hint' }, t('noVotes'))); return section; }
  const rows = d.votes.map((v) => {
    const cell = el('td', { class: 'actions' });
    if (confirmVote === v.id) {
      const yes = el('button', { type: 'button', class: 'small danger' }, t('remove'));
      yes.addEventListener('click', () => removeVote(v.id, yes));
      cell.append(el('span', { class: 'confirm' }, yes,
        el('button', { type: 'button', class: 'small', onclick: () => { confirmVote = null; renderDetail(); } }, t('cancel'))));
    } else {
      cell.append(el('button', { type: 'button', class: 'small', onclick: () => { confirmVote = v.id; renderDetail(); } }, t('remove')));
    }
    return el('tr', {},
      el('td', { class: 'muted' }, fmtDate(v.createdAt)),
      el('td', {}, v.voter === 'human' ? el('strong', {}, t('human')) : t('agent')),
      el('td', {}, el('span', { class: 'badge ' + (v.vote === 'up' ? 'w-up' : 'w-down') }, t(v.vote))),
      el('td', { class: 'num' }, fmtWeight(v.weight)),
      cell);
  });
  section.append(el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, t('c_when')), el('th', {}, t('c_who')), el('th', {}, t('c_vote')),
      el('th', { class: 'num' }, t('c_worth')), el('th'))),
    el('tbody', {}, ...rows))));
  return section;
}

function dataCard(e) {
  return el('section', { class: 'card' }, el('h3', {}, t('dataTitle')),
    el('dl', { class: 'facts' },
      el('dt', {}, t('id')), el('dd', { class: 'row' }, el('span', { class: 'mono' }, e.id),
        el('button', { type: 'button', class: 'small', onclick: () => copy(e.id) }, t('copy'))),
      el('dt', {}, t('author')), el('dd', {}, e.author
        ? el('button', { type: 'button', class: 'link', onclick: () => setFilter('f-author', e.author) }, authorLabel(e.author))
        : t('a_unknown')),
      el('dt', {}, t('created')), el('dd', {}, fmtDate(e.createdAt)),
      el('dt', {}, t('updated')), el('dd', {}, e.updatedAt ? fmtDate(e.updatedAt) : t('never')),
      el('dt', {}, t('appVersion')), el('dd', {}, e.appVersion || t('none'))));
}

// --- actions ----------------------------------------------------------------------------------

async function refreshAfterChange() {
  await Promise.all([loadDetail(), loadStats().catch(fail)]);
}

async function vote(direction, button) {
  if (!selectedId) return;
  if (button) button.disabled = true;
  try {
    await api('POST', '/admin/feedback/' + encodeURIComponent(selectedId) + '/vote', { vote: direction });
    toast(direction === 'up' ? t('votedUp') : t('votedDown'));
    await refreshAfterChange();
  } catch (err) { fail(err); if (button) button.disabled = false; }
}

async function removeVote(voteId, button) {
  button.disabled = true;
  try {
    await api('DELETE', '/admin/feedback/' + encodeURIComponent(selectedId) + '/votes/' + encodeURIComponent(voteId));
    confirmVote = null;
    toast(t('voteRemoved'));
    await refreshAfterChange();
  } catch (err) { fail(err); button.disabled = false; }
}

async function removeEntry(button) {
  button.disabled = true;
  const id = selectedId;
  try {
    await api('DELETE', '/admin/feedback/' + encodeURIComponent(id));
    toast(t('deleted'));
  } catch (err) {
    if (err.status !== 404) { fail(err); button.disabled = false; return; }
  }
  // Move to the next entry in the list, so a review session can go on.
  const list = tab === 'search' ? results || [] : entries;
  const index = list.findIndex((e) => e.id === id);
  const next = list[index + 1] || list[index - 1];
  dropEntry(id);
  mode = 'view';
  loadStats().catch(fail);
  if (next) { selectedId = null; select(next.id); } else closeDetail();
}

function startEdit() { mode = 'edit'; renderDetail(); }

/** Opens the editor empty, written by a person; saving creates the entry. */
function startNew() {
  if (mode === 'new' || !guardEdit()) return;
  selectedId = null; detail = null; confirmVote = null; mode = 'new';
  setHash();
  markSelected();
  $('app').classList.add('has-detail');
  renderDetail();
}

function counted(input, max) {
  const counter = el('span', { class: 'counter' });
  const update = () => {
    counter.textContent = input.value.length + ' / ' + max;
    counter.classList.toggle('over', input.value.length > max);
  };
  input.addEventListener('input', update);
  update();
  return counter;
}

function field(label, control, extra) {
  return el('label', {}, el('span', {}, label), control, extra || null);
}

/** The entry editor; with no entry, an empty one for a new entry by a person. */
function editView(entry) {
  const e = entry || { kind: 'tip', title: '', body: '', procedure: '', tags: [], urls: [], author: HUMAN };
  const input = (name, value, attrs) => el('input', Object.assign({ name, value: value || '', autocomplete: 'off' }, attrs));
  const kind = el('select', { name: 'kind' }, ...KINDS.map((k) => el('option', { value: k }, t('k_' + k))));
  kind.value = e.kind;
  const title = input('title', e.title, { required: true, minlength: 5, maxlength: 200 });
  const body = el('textarea', { name: 'body', rows: 10, required: true, minlength: 10, maxlength: 4000 });
  body.value = e.body;
  const procedure = input('procedure', e.procedure, { required: true, minlength: 3, maxlength: 200, list: 'procedures' });
  const tags = input('tags', e.tags.join(', '), { maxlength: 450 });
  const urls = el('textarea', { name: 'urls', rows: 3, spellcheck: 'false' });
  urls.value = e.urls.join('\\n');
  const author = input('author', e.author, { maxlength: 120, list: 'authors', spellcheck: 'false' });
  const asHuman = el('button', { type: 'button', class: 'small', onclick: () => {
    author.value = HUMAN; form.dataset.dirty = '1'; author.focus();
  } }, t('a_human'));
  const error = el('p', { class: 'error', role: 'alert', hidden: true });
  const save = el('button', { type: 'submit', class: 'primary' }, t('save'));

  const form = el('form', { class: 'card edit', id: 'edit-form', autocomplete: 'off' },
    el('div', {}, el('h2', {}, t(entry ? 'editTitle' : 'newTitle')), el('p', { class: 'hint' }, t(entry ? 'editHint' : 'newHint'))),
    field(t('kind'), kind),
    field(t('fTitle'), title, counted(title, 200)),
    field(t('body'), body, counted(body, 4000)),
    el('div', { class: 'grid' },
      field(t('procedure'), procedure),
      field(t('administration'), input('administration', e.administration, { maxlength: 200 })),
      field(t('region'), input('region', e.region, { maxlength: 100 }))),
    field(t('fTags'), tags, el('span', { class: 'field-hint' }, t('tagsHint'))),
    field(t('fUrls'), urls, el('span', { class: 'field-hint' }, t('urlsHint'))),
    el('label', {}, el('span', {}, t('author')), el('span', { class: 'row author-row' }, author, asHuman),
      el('span', { class: 'field-hint' }, t(entry ? 'authorHint' : 'newAuthorHint'))),
    error,
    el('div', { class: 'row' }, save,
      el('button', { type: 'button', onclick: cancelEdit }, t('cancel')),
      el('span', { class: 'spacer' }),
      el('span', { class: 'field-hint' }, '⌘/Ctrl + Enter · Esc')));
  form.addEventListener('input', () => { form.dataset.dirty = '1'; });
  form.addEventListener('submit', (event) => { event.preventDefault(); saveEdit(form, save, error); });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); form.requestSubmit(); }
    if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
  });
  return el('div', { class: 'detail' },
    el('div', { class: 'detail-bar' },
      el('button', { type: 'button', class: 'small back', onclick: cancelEdit }, '← ' + t('back'))),
    form);
}

function cancelEdit() {
  if (mode === 'new') { mode = 'view'; closeDetail(); return; }
  mode = 'view'; renderDetail();
}

async function saveEdit(form, button, error) {
  error.hidden = true;
  const value = (name) => form.elements[name].value.trim();
  const tags = value('tags').split(',').map((s) => s.trim()).filter(Boolean);
  const urls = value('urls').split('\\n').map((s) => s.trim()).filter(Boolean);
  const author = value('author');
  const problem = tags.length > 10 ? t('tooManyTags') : urls.length > 5 ? t('tooManyUrls')
    : author && !AUTHOR_RE.test(author) ? t('badAuthor') : '';
  if (problem) { error.textContent = problem; error.hidden = false; return; }
  const body = {
    kind: value('kind'), procedure: value('procedure'), title: value('title'), body: value('body'),
    tags, urls,
  };
  for (const name of ['administration', 'region', 'author']) if (value(name)) body[name] = value(name);
  button.disabled = true;
  button.textContent = t('saving');
  const creating = mode === 'new';
  try {
    const res = creating
      ? await api('POST', '/admin/feedback', body)
      : await api('PUT', '/admin/feedback/' + encodeURIComponent(selectedId), body);
    toast(res.redactions > 0 ? t('savedScrubbed')(res.redactions) : t(creating ? 'savedNew' : 'saved'));
    form.dataset.dirty = '';
    mode = 'view';
    if (creating) {
      // Show the new entry, and list it (newest first by default).
      selectedId = res.entry.id;
      setHash();
      await Promise.all([refreshAfterChange(), loadList(false).catch(fail)]);
      markSelected();
      $('detail').scrollTop = 0;
    } else await refreshAfterChange();
  } catch (err) {
    if (err.status !== 401) { error.textContent = t('failed') + err.message; error.hidden = false; }
    button.disabled = false;
    button.textContent = t('save');
  }
}

// --- overview (nothing selected) --------------------------------------------------------------

function bars(items, onPick) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return el('div', { class: 'bars' }, ...items.map((i) => {
    const fill = el('i');
    fill.style.width = Math.round((i.count / max) * 100) + '%';
    return el('button', { type: 'button', class: 'bar-row', onclick: () => onPick(i.value) },
      el('span', { class: 'label' }, fill, i.label || i.value), el('span', { class: 'n' }, String(i.count)));
  }));
}

function overview() {
  const wrap = el('div', { class: 'detail' },
    el('div', {}, el('h2', {}, t('overviewTitle')), el('p', { class: 'hint' }, t('overviewHint'))));
  if (!stats) return wrap;
  const stat = (n, label, onclick) => el('button', { type: 'button', class: 'stat', onclick }, el('b', {}, String(n)), el('span', {}, label));
  wrap.append(
    el('div', { class: 'stats' },
      stat(stats.total, t('st_total'), () => setFilter()),
      stat(stats.total - stats.reviewed, t('st_unreviewed'), () => setFilter('f-review', 'no')),
      stat(stats.votes.up, t('st_up'), () => setFilter('f-votes', 'up')),
      stat(stats.votes.down, t('st_down'), () => setFilter('f-votes', 'down'))),
    el('section', { class: 'card' }, el('h3', {}, t('byKind')),
      bars(KINDS.map((k) => ({ value: k, label: t('k_' + k), count: stats.kinds[k] })), (k) => setFilter('f-kind', k))));
  if (stats.procedures.length) {
    wrap.append(el('section', { class: 'card' }, el('h3', {}, t('topProcedures')),
      bars(stats.procedures.slice(0, 8), (p) => setFilter('f-procedure', p))));
  }
  if (stats.tags.length) {
    wrap.append(el('section', { class: 'card' }, el('h3', {}, t('topTags')),
      el('div', { class: 'chips' }, ...stats.tags.slice(0, 30).map((tag) =>
        el('button', { type: 'button', class: 'chip', onclick: () => setFilter('f-tag', tag.value) }, tag.value + ' · ' + tag.count)))));
  }
  if (stats.authors.length) {
    wrap.append(el('section', { class: 'card' }, el('h3', {}, t('topAuthors')),
      bars(stats.authors.slice(0, 8).map((a) => ({ ...a, label: authorLabel(a.value) })), (a) => setFilter('f-author', a))));
  }
  wrap.append(el('section', { class: 'card' }, el('h3', {}, t('policyTitle')),
    el('ul', { class: 'plain' }, ...t('policy')(stats.policy).map((line) => el('li', {}, line)))));
  return wrap;
}

// --- keyboard ---------------------------------------------------------------------------------

function typing(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

function step(delta) {
  const list = tab === 'search' ? results || [] : entries;
  if (!list.length) return;
  const index = list.findIndex((e) => e.id === selectedId);
  const next = list[Math.min(list.length - 1, Math.max(0, index < 0 ? 0 : index + delta))];
  if (!next) return;
  select(next.id);
  const node = document.querySelector('.item[data-id="' + next.id + '"]');
  if (node) node.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (event) => {
  if ($('app').hidden || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape' && typing(event.target) && event.target.closest('.filters')) { event.target.blur(); return; }
  if (typing(event.target) || mode === 'edit' || mode === 'new') return;
  const keys = {
    j: () => step(1), ArrowDown: () => step(1), k: () => step(-1), ArrowUp: () => step(-1),
    '/': () => { setTab('browse'); $('f-q').focus(); $('f-q').select(); },
    e: () => { if (detail) startEdit(); },
    n: startNew,
    u: () => { if (detail) vote('up'); },
    d: () => { if (detail) vote('down'); },
    Escape: () => { if (mode === 'delete' || confirmVote) { mode = 'view'; confirmVote = null; renderDetail(); } else closeDetail(); },
  };
  const action = keys[event.key];
  if (action) { event.preventDefault(); action(); }
});

// --- wiring -----------------------------------------------------------------------------------

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('token').value.trim();
  if (!value) return;
  token = value;
  store.set('sessionStorage', TOKEN_KEY, token);
  $('token').value = '';
  $('login-error').hidden = true;
  start();
});
$('logout').addEventListener('click', () => signOut());
$('new').addEventListener('click', startNew);
$('lang').addEventListener('click', () => {
  lang = lang === 'es' ? 'en' : 'es';
  store.set('localStorage', 'sa-admin-lang', lang);
  applyText();
  renderFilters();
  renderHeaderStats();
  renderList();
  renderDetail();
});
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
let searchTimer;
$('f-q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadList(false).catch(fail), 250);
});
for (const id of ['f-kind', 'f-votes', 'f-review', 'f-sort', 'f-procedure', 'f-tag', 'f-author']) {
  $(id).addEventListener('change', () => loadList(false).catch(fail));
}
$('clear').addEventListener('click', () => setFilter());
$('refresh').addEventListener('click', () => {
  Promise.all([loadStats(), tab === 'search' && results ? runSearch() : loadList(false)]).catch(fail);
});
$('more').addEventListener('click', () => loadList(true).catch(fail));
$('search-form').addEventListener('submit', runSearch);
window.addEventListener('hashchange', () => {
  const { signedIn, id } = readFragment();
  if (signedIn) start();
  else if (id && id !== selectedId) select(id);
});

applyText();
renderFilters();
if (token) start(); else signOut();
`;

const BODY = `
<header>
  <h1><span data-t="title"></span> <span>· Spain Assist</span></h1>
  <span class="header-stats" id="header-stats" hidden></span>
  <button type="button" id="new" class="small primary" data-t="newEntry" hidden></button>
  <button type="button" class="link" id="lang" data-t="lang"></button>
  <button type="button" id="logout" class="small" data-t="logout" hidden></button>
</header>
<main>
  <section class="card login" id="login" hidden>
    <h2 data-t="loginTitle"></h2>
    <p class="hint" data-t="loginHint"></p>
    <form id="login-form" autocomplete="off">
      <label><span data-t="token"></span>
        <input id="token" type="password" autocomplete="off" spellcheck="false" required></label>
      <button type="submit" class="primary" data-t="enter"></button>
      <p class="error" id="login-error" role="alert" hidden></p>
    </form>
  </section>

  <div id="app" hidden>
    <aside class="pane-list">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="browse" aria-selected="true" data-t="tabBrowse"></button>
        <button type="button" role="tab" data-tab="search" aria-selected="false" data-t="tabSearch"></button>
      </div>
      <div class="filters" id="browse-filters">
        <input id="f-q" type="search" data-ph="searchPh" maxlength="300" autocomplete="off" spellcheck="false">
        <div class="two">
          <label><span data-t="kind"></span><select id="f-kind"></select></label>
          <label><span data-t="votes"></span><select id="f-votes"></select></label>
          <label><span data-t="review"></span><select id="f-review"></select></label>
          <label><span data-t="sort"></span><select id="f-sort"></select></label>
          <label><span data-t="procedure"></span><input id="f-procedure" list="procedures" maxlength="200" autocomplete="off"></label>
          <label><span data-t="tag"></span><input id="f-tag" list="tags" maxlength="40" autocomplete="off"></label>
          <label><span data-t="author"></span><select id="f-author"></select></label>
        </div>
      </div>
      <form class="filters" id="search-form" autocomplete="off" hidden>
        <p class="hint" data-t="searchHint"></p>
        <label><span data-t="searchQ"></span>
          <input id="s-q" type="search" data-ph="searchQPh" minlength="2" maxlength="300" required></label>
        <div class="two">
          <label><span data-t="procedure"></span><input id="s-procedure" list="procedures" maxlength="200"></label>
          <label><span data-t="kind"></span><select id="s-kind"></select></label>
          <label><span data-t="limit"></span>
            <select id="s-limit"><option>8</option><option>20</option></select></label>
          <label><span>&nbsp;</span><button type="submit" class="primary" data-t="search"></button></label>
        </div>
      </form>
      <div class="list-meta">
        <span id="list-status"></span>
        <span class="row">
          <button type="button" class="link" id="clear" data-t="clear"></button>
          <button type="button" class="link" id="refresh" data-t="refresh"></button>
        </span>
      </div>
      <ul class="list" id="list"></ul>
      <div class="empty" id="list-empty" hidden></div>
      <div class="list-foot"><button type="button" class="small" id="more" data-t="more" hidden></button></div>
      <div class="keys"><span data-t="keys"></span>: <kbd>j</kbd> <kbd>k</kbd> <span data-t="keyNav"></span> ·
        <kbd>/</kbd> <span data-t="keyFind"></span> · <kbd>n</kbd> <span data-t="keyNew"></span> ·
        <kbd>e</kbd> <span data-t="keyEdit"></span> ·
        <kbd>u</kbd> <kbd>d</kbd> <span data-t="keyVote"></span></div>
    </aside>
    <section class="pane-detail" id="detail" aria-live="polite"></section>
  </div>
  <datalist id="procedures"></datalist>
  <datalist id="tags"></datalist>
  <datalist id="authors"></datalist>
</main>
<div class="toast" id="toast" role="status" hidden></div>
`;

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

/** The page's HTML; the inline style and script are allowed by hash in {@link ADMIN_PAGE_CSP}. */
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Aprendizajes · Spain Assist</title>
<link rel="icon" href="data:,">
<style>${STYLE}</style>
</head>
<body>${BODY}<script>${SCRIPT}</script>
</body>
</html>
`;

/** No third-party origins; only this page's own inline style/script and same-origin API calls. */
const ADMIN_PAGE_CSP = [
  "default-src 'none'",
  `script-src ${sha256(SCRIPT)}`,
  `style-src ${sha256(STYLE)}`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers of the admin page. */
export const ADMIN_PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': ADMIN_PAGE_CSP,
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Robots-Tag': 'noindex, nofollow',
};
