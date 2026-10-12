import type { Language, SaArgs, SaMethod, SaResult } from '@sa/shared';
import type { z } from 'zod';
import { UserError } from '../core/errors';
import { t } from '../core/i18n';
import { type Logger, truncate } from '../core/logger';
import { errorMessage } from '../core/util';

export type IpcHandler<M extends SaMethod> = (
  ...args: SaArgs<M>
) => Promise<SaResult<M>> | SaResult<M>;

export interface IpcCallContext {
  /** URL of the frame that sent the message. */
  senderUrl?: string;
  /** False for messages from iframes. */
  isMainFrame: boolean;
}

interface Route {
  schema: z.ZodType;
  handler: (...args: unknown[]) => unknown;
}

/**
 * The renderer API: one `invoke` channel dispatching to registered methods. Every call is checked
 * for its sender (only the app's own top-level page) and its arguments are validated with zod.
 */
export class IpcRouter {
  private readonly routes = new Map<string, Route>();

  constructor(
    private readonly deps: {
      isTrustedSender(ctx: IpcCallContext): boolean;
      logger: Logger;
      lang: () => Language;
    },
  ) {}

  register<M extends SaMethod>(
    method: M,
    schema: z.ZodType<SaArgs<M>>,
    handler: IpcHandler<M>,
  ): void {
    if (this.routes.has(method)) throw new Error(`Duplicate IPC method ${method}`);
    this.routes.set(method, {
      schema,
      handler: handler as unknown as (...args: unknown[]) => unknown,
    });
  }

  methods(): string[] {
    return [...this.routes.keys()];
  }

  async dispatch(method: unknown, args: unknown[], ctx: IpcCallContext): Promise<unknown> {
    const { logger } = this.deps;
    if (!this.deps.isTrustedSender(ctx)) {
      logger.warn('IPC call from an untrusted sender refused', { method: String(method) });
      throw new Error('Forbidden');
    }
    const route = typeof method === 'string' ? this.routes.get(method) : undefined;
    if (!route) throw new Error(`Unknown method: ${truncate(String(method), 80)}`);
    const parsed = route.schema.safeParse(args);
    if (!parsed.success) {
      logger.warn(`IPC ${method}: invalid arguments`, {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      throw new UserError(t(this.deps.lang(), 'invalidRequest'), 'bad_request');
    }
    try {
      return await route.handler(...(parsed.data as unknown[]));
    } catch (err) {
      if (err instanceof UserError) throw err;
      logger.error(`IPC ${method} failed`, { error: errorMessage(err) });
      throw err instanceof Error ? err : new Error(errorMessage(err));
    }
  }
}
