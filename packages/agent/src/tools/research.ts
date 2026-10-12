import { Type } from 'typebox';
import type { BridgeTransport } from '../bridge/client';
import { type BoeLaw, type BoeSearchOptions, searchBoe } from '../research/boe';
import {
  callBridge,
  compact,
  defineSaTool,
  errorResult,
  isAbortError,
  StringEnum,
  textResult,
} from './common';

export function renderBoeLaw(law: BoeLaw, index: number): string {
  const meta = [
    law.rank,
    law.department,
    law.publishedAt ? `published ${law.publishedAt}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return [
    `${index}. ${law.title} (${law.id})${law.inForce ? '' : ' [NO LONGER IN FORCE]'}`,
    `   ${meta}`,
    `   ${law.url}`,
  ].join('\n');
}

export function researchTools(bridge: BridgeTransport, boe: BoeSearchOptions = {}) {
  return [
    defineSaTool({
      name: 'feedback_search',
      label: 'Search community learnings',
      description:
        'Search anonymous learnings shared by other Spain Assist users (tips, frictions, traps). Use it when starting a procedure and when something goes wrong. They are hints, not official facts.',
      parameters: Type.Object({
        query: Type.String({ minLength: 2, maxLength: 300 }),
        procedure: Type.Optional(Type.String({ maxLength: 200 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'feedback.search', compact({ ...params }), signal, (result) =>
          textResult(
            result.results.length === 0
              ? 'No community learnings found.'
              : [
                  `Community learnings for "${params.query}" (unverified hints), verbatim:`,
                  JSON.stringify(result.results, null, 2),
                ].join('\n'),
            { count: result.results.length },
          ),
        );
      },
    }),

    defineSaTool({
      name: 'feedback_submit',
      label: 'Share learnings',
      description:
        'Share an anonymous learning for future users: at the end of a procedure or after notable friction. Write it generic and reusable (what was confusing, what worked, traps). NEVER include personal data: no names, ID/NIE numbers, addresses, phones, emails, dates of birth, case or file numbers. The app scrubs it again before sending.',
      parameters: Type.Object({
        procedure: Type.String({
          minLength: 3,
          maxLength: 200,
          description: 'Procedure name, e.g. "Renovación del DNI"',
        }),
        administration: Type.Optional(Type.String({ maxLength: 200 })),
        region: Type.Optional(
          Type.String({ maxLength: 100, description: 'Region or municipality if relevant' }),
        ),
        kind: StringEnum(['tip', 'friction', 'gotcha'], {
          description:
            'tip: useful to know; friction: something broken or hard (errors, timeouts, missing slots); gotcha: an easy mistake to make',
        }),
        title: Type.String({ minLength: 5, maxLength: 200 }),
        body: Type.String({ minLength: 10, maxLength: 4000 }),
        tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 10 })),
        urls: Type.Optional(
          Type.Array(Type.String({ maxLength: 500 }), {
            maxItems: 5,
            description: 'Official URLs involved',
          }),
        ),
      }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'feedback.submit', compact({ ...params }), signal, (result) => {
          if (!result.submitted) {
            return textResult(
              `Not shared${result.reason ? `: ${result.reason}` : '.'} Do not retry unless you can fix the reason.`,
              { submitted: false },
            );
          }
          return textResult(
            `Shared, thank you${result.redactions > 0 ? ` (${result.redactions} personal details were removed: keep learnings generic)` : ''}.`,
            { submitted: true, id: result.id, redactions: result.redactions },
          );
        });
      },
    }),

    defineSaTool({
      name: 'feedback_vote',
      label: 'Rate a learning',
      description:
        'Rate a community learning from feedback_search (by its id) once you know whether it held up. Votes decide how often future agents see it, so be strict. "up": it was clearly useful AND you would have struggled to figure it out on your own (a non-obvious trap, an undocumented step). "down": it is incorrect, outdated or misleading, or it claims to apply in all cases when it does not. Do not vote when it was useful but you would easily have found it yourself, or when you could not check it. One vote per learning: voting again replaces your earlier vote.',
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 64, description: 'Id from feedback_search' }),
        vote: StringEnum(['up', 'down']),
      }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'feedback.vote', { ...params }, signal, (result) =>
          textResult(
            result.counted
              ? 'Vote recorded, thank you.'
              : `Vote not recorded${result.reason ? `: ${result.reason}` : '.'} Do not retry.`,
            { counted: result.counted },
          ),
        );
      },
    }),

    defineSaTool({
      name: 'boe_search',
      label: 'Search the BOE',
      description:
        "Search Spain's official state gazette (BOE) for consolidated legislation (laws, royal decrees, orders) by words in the title (default) or the full text. Returns titles, ids and links; read them with fetch_url.",
      parameters: Type.Object({
        query: Type.String({
          minLength: 2,
          maxLength: 300,
          description: 'Words; "quoted phrase" allowed',
        }),
        field: Type.Optional(StringEnum(['titulo', 'texto'], { description: 'Default titulo' })),
        inForceOnly: Type.Optional(Type.Boolean({ description: 'Default true' })),
        newestFirst: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      }),
      async execute(_id, params, signal) {
        try {
          const laws = await searchBoe(params, { ...boe, signal });
          return textResult(
            laws.length === 0
              ? 'No legislation found. Try other words or field "texto".'
              : [
                  `BOE results for "${params.query}":`,
                  ...laws.map((l, i) => renderBoeLaw(l, i + 1)),
                ].join('\n'),
            { count: laws.length, ids: laws.map((l) => l.id) },
          );
        } catch (error) {
          if (isAbortError(error, signal)) throw error;
          return errorResult(`BOE search failed: ${(error as Error).message}`);
        }
      },
    }),
  ];
}
