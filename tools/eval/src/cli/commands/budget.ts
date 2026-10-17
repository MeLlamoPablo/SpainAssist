/** `eval budget`: the voucher balance, the ledger and the caps (never a key). */

import { formatBudgetStatus } from '../../llm/budget';
import { evalHome } from '../../llm/home';
import { describeRunLimits, shippedMeterLimits } from '../../run/caps';
import { flag, parseCommandArgs } from '../args';
import type { CliDeps } from '../deps';
import { BUDGET_SPEC } from '../specs';

export async function budgetCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommandArgs(BUDGET_SPEC, args, { min: 0, max: 0, names: '' });
  // The caps a run really gets: the meter's defaults with the reserve and per-run cap of a run.
  const status = await deps.budgetStatus({
    home: evalHome(deps.env),
    limits: shippedMeterLimits(),
    ...(flag(parsed, 'offline') ? { offline: true } : {}),
  });
  deps.stdout(`${formatBudgetStatus(status)}\n\n${describeRunLimits()}\n`);
  return 0;
}
