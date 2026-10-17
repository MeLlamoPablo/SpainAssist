/**
 * The eval host as the run loop sees it (docs/EVAL.md, "Network transparency"): the config file it
 * reads and how to launch it. The hooks themselves (`hooks.ts`, `research-stub.ts`) and the entry
 * (`eval-main.ts`) are bundled into `dist/eval-host.js` and never imported by the harness.
 */
export {
  EVAL_CONFIG_ENV,
  HostEvalConfigSchema,
  loadHostEvalConfig,
  parseHostEvalConfig,
  writeHostEvalConfig,
} from './config';
export { evalHostLaunch, evalHostPath } from './launch';
