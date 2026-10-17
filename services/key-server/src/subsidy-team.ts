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

  private get models(): string[] {
    return [this.options.deciderModel, TRANSCRIPTION_MODEL];
  }

  /**
   * Gives the team and every ChatGPT key the current models. Keys keep the model list they were
   * created with and LiteLLM checks it on the decider route too, so without this a new
   * DECIDER_MODEL would lock existing ChatGPT users out of scanning. Runs once per model list;
   * returns how many keys it updated. Safe to retry: every update replaces the whole list.
   */
  async syncModels(): Promise<number> {
    const setting = `chatgpt_key_models:${this.provisioner.kind}`;
    const value = this.models.join(',');
    if ((await store.getSetting(this.db, setting)) === value) return 0;
    const ids = await store.chatGPTKeyHashes(this.db, this.provisioner.kind);
    if (ids.length > 0) await this.id();
    for (const id of ids) await this.provisioner.setModels(id, this.models);
    await store.setSetting(this.db, setting, value);
    return ids.length;
  }

  private async sync(): Promise<string> {
    const request: TeamRequest = {
      alias: SUBSIDY_TEAM_ALIAS,
      maxBudgetUsd: this.options.monthlyBudgetUsd,
      duration: '1mo',
      models: this.models,
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
