import type {
  PersonalDataInput,
  PersonalDataItem,
  PersonalDataSource,
  PersonalSaveIssue,
} from '@sa/shared';
import { PersonalDataValidationError, VaultError } from '@sa/vault';
import type { Logger } from '../core/logger';
import type { VaultPort } from '../ports';

/**
 * Logs why the vault refused personal data: fixed reasons and field names, never values.
 * Custom keys are logged as "custom": their slugs may carry personal details.
 */
export function logPersonalSaveFailure(logger: Logger, err: unknown, message: string): void {
  const validation = err instanceof PersonalDataValidationError ? err : undefined;
  const field = validation?.field;
  logger.warn(message, {
    failureCode: err instanceof VaultError ? err.code : 'unexpected_error',
    reason: validation ? validation.reason : 'vault_error',
    ...(field ? { field } : {}),
  });
}

/**
 * Saves every valid item and reports the rejected ones, so one bad field doesn't lose the rest.
 * The vault validates a batch before writing it, so each retry is still a single atomic write.
 * Errors that are not about one item (locked vault, too many fields) are rethrown.
 */
export async function setPersonalPartial(
  vault: Pick<VaultPort, 'setPersonal'>,
  items: PersonalDataInput[],
  source: PersonalDataSource,
  logger: Logger,
): Promise<{ saved: PersonalDataItem[]; rejected: PersonalSaveIssue[] }> {
  let remaining = items;
  const rejected: PersonalSaveIssue[] = [];
  while (remaining.length) {
    try {
      return { saved: await vault.setPersonal(remaining, source), rejected };
    } catch (err) {
      logPersonalSaveFailure(logger, err, 'vault personal data item rejected');
      const key = err instanceof PersonalDataValidationError ? err.key : undefined;
      if (!key || !remaining.some((item) => item.key === key)) throw err;
      rejected.push({ key, reason: (err as PersonalDataValidationError).reason });
      remaining = remaining.filter((item) => item.key !== key);
    }
  }
  return { saved: [], rejected };
}
