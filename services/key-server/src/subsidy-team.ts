import { TRANSCRIPTION_MODEL } from '@sa/shared';
import type { Db } from './db/types';
import type { KeyProvisioner, TeamRequest } from './providers/key-provisioner';
import * as store from './store';

export const SUBSIDY_TEAM_ALIAS = 'sa-chatgpt-keys';

/**
 * The LiteLLM team every ChatGPT key belongs to. Its budget (CHATGPT_GLOBAL_MONTHLY_BUDGET_USD,
 * per calendar month) caps all ChatGPT keys together; without one the team has no cap, so the
 * cap can be turned on later for keys that already exist. Created once and remembered in
 * `server_settings`; its budget is set again on the first use after each start.
 */
export class SubsidyTeam {
  private ready?: Promise<string>;

  constructor(
    private readonly db: Db,
    private readonly provisioner: KeyProvisioner,
    private readonly options: { deciderModel: string; monthlyBudgetUsd: number | null },
  ) {}

  /** The team id (creating or updating the team on first use). Retries after a failure. */
  id(): Promise<string> {
    this.ready ??= this.sync().catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private async sync(): Promise<string> {
    const request: TeamRequest = {
      alias: SUBSIDY_TEAM_ALIAS,
      maxBudgetUsd: this.options.monthlyBudgetUsd,
      duration: '1mo',
      models: [this.options.deciderModel, TRANSCRIPTION_MODEL],
    };
    // Per provider kind: a mock team id means nothing to a real LiteLLM.
    const setting = `chatgpt_team_id:${this.provisioner.kind}`;
    const existing = await store.getSetting(this.db, setting);
    if (existing) {
      await this.provisioner.updateTeam(existing, request);
      return existing;
    }
    const id = await this.provisioner.createTeam(request);
    await store.setSetting(this.db, setting, id);
    return id;
  }
}
