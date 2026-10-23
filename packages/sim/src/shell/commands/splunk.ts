import { buildFor, splunkdRunning, splunkVersion } from '../../hosts/profile';
import { fail, ok, type CommandFn } from '../types';

/**
 * The splunk CLI. Milestone 2 covers status/version/help; config-aware commands
 * (btool, restart, reload, list ...) arrive with the config layer in milestone 3.
 */
export const splunk: CommandFn = ({ sh, argv }) => {
  const p = sh.host;
  if (!p.splunk) return fail(`bash: ${argv[0]}: command not found`, 127);
  const [cmd, ...rest] = argv.slice(1);
  const product = p.splunk.product === 'enterprise' ? 'Splunk' : 'Splunk Universal Forwarder';
  const version = splunkVersion(sh.world, p)!;

  switch (cmd) {
    case undefined:
    case 'help':
      return ok(
        `\nWelcome to ${product}'s Command Line Interface (CLI).\n\nTry typing these commands for more help:\n\n    help simple, cheatsheet     display a list of common commands with syntax\n    help commands               display a full list of CLI commands\n\n    status, version             available in this sandbox now\n    btool, restart, reload,\n    list, show                  available once the config layer is simulated\n\n`,
      );
    case 'version':
      return ok(`${product} ${version} (build ${buildFor(version)})\n`);
    case 'status': {
      const pid = p.splunk.pid;
      if (!splunkdRunning(sh.world, p)) return { stdout: 'splunkd is not running.\n', code: 3 };
      return ok(`splunkd is running (PID: ${pid}).\nsplunk helpers are running (PIDs: ${pid + 22}).\n`);
    }
    case 'cmd':
      if (rest[0] === 'btool') break;
      return fail(`splunk cmd: '${rest[0] ?? ''}' is not available in this sandbox.`);
    default:
      break;
  }
  return fail(
    `This sandbox does not simulate 'splunk ${[cmd, ...rest].join(' ')}' yet (it arrives with the config layer, milestone 3).`,
  );
};

/** Running splunkd directly is never what you want. */
export const splunkd: CommandFn = () =>
  fail('splunkd: must be started through the splunk CLI or systemd (splunk start).');
