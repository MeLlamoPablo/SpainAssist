/**
 * `main(argv, deps)`: the whole command line, with no `process.exit` and no global state: it
 * returns the exit code (see `exit.ts`) and writes only through `deps`. `src/cli.ts` is the thin
 * entry that gives it the real process.
 */
import { UsageError, wantsHelp } from './args';
import { type CliDeps, defaultDeps } from './deps';
import { classifyError, EXIT_OK, EXIT_USAGE } from './exit';
import { renderCommandHelp, renderGeneralHelp } from './help';
import { COMMANDS, findCommand } from './specs';

type Handler = (args: readonly string[], deps: CliDeps) => Promise<number>;

/** The commands load on demand: `eval --help` must not wait for the model and browser code. */
const HANDLERS: Record<string, () => Promise<Handler>> = {
  list: async () => (await import('./commands/list')).listCommand,
  run: async () => (await import('./commands/run')).runCommand,
  suite: async () => (await import('./commands/suite')).suiteCommand,
  report: async () => (await import('./commands/report')).reportCommand,
  runs: async () => (await import('./commands/runs')).runsCommand,
  budget: async () => (await import('./commands/budget')).budgetCommand,
  login: async () => (await import('./commands/auth')).loginCommand,
  whoami: async () => (await import('./commands/auth')).whoamiCommand,
  logout: async () => (await import('./commands/auth')).logoutCommand,
  doctor: async () => (await import('./commands/doctor')).doctorCommand,
};

function usageProblem(deps: CliDeps, error: UsageError): number {
  const help = error.command ? `eval ${error.command} --help` : 'eval --help';
  deps.stderr(`error: ${error.message}\nSee "${help}".\n`);
  return EXIT_USAGE;
}

export async function main(
  argv: readonly string[],
  overrides: Partial<CliDeps> = {},
): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...overrides };
  try {
    const [first, ...rest] = argv;
    if (first === undefined) {
      deps.stderr(`error: missing command\n\n${renderGeneralHelp()}`);
      return EXIT_USAGE;
    }
    if (first === '--help' || first === '-h') {
      deps.stdout(renderGeneralHelp());
      return EXIT_OK;
    }
    if (first === 'help') {
      const topic = rest[0];
      if (topic === undefined) {
        deps.stdout(renderGeneralHelp());
        return EXIT_OK;
      }
      const spec = findCommand(topic);
      if (!spec) throw new UsageError(`Unknown command "${topic}".`);
      deps.stdout(renderCommandHelp(spec));
      return EXIT_OK;
    }

    const spec = findCommand(first);
    if (!spec) {
      throw new UsageError(
        `Unknown command "${first}" (commands: ${COMMANDS.map((command) => command.name).join(', ')}).`,
      );
    }
    if (wantsHelp(rest)) {
      deps.stdout(renderCommandHelp(spec));
      return EXIT_OK;
    }
    const load = HANDLERS[spec.name];
    if (!load) throw new Error(`The command "${spec.name}" has no handler`);
    return await (await load())(rest, deps);
  } catch (error) {
    if (error instanceof UsageError) return usageProblem(deps, error);
    const failure = classifyError(error, deps.env.SA_EVAL_DEBUG === '1');
    deps.stderr(`error: ${failure.message}\n`);
    return failure.code;
  }
}
