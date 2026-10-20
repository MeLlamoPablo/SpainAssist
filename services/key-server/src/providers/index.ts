import type { ServerConfig } from '../config';
import { type KeyProvisioner, LiteLLMProvisioner, MockProvisioner } from './key-provisioner';

/** LiteLLM when LITELLM_ADMIN_URL is configured, otherwise the offline mock. */
export function createProvisioner(config: ServerConfig): KeyProvisioner {
  const { litellm } = config;
  return litellm
    ? new LiteLLMProvisioner({
        adminUrl: litellm.adminUrl,
        masterKey: litellm.masterKey,
        publicUrl: litellm.publicUrl,
        models: litellm.keyModels,
        searchTools: config.searchTools,
        deciderModel: config.deciderModel,
        voucherDeciderModel: config.voucherDeciderModel,
      })
    : new MockProvisioner({ baseUrl: config.mockLlmBaseUrl });
}
