// Ops guard for the scripts that TRUNCATE. Shared by reset-content.ts and
// reset-maps.ts.
//
// Those scripts wipe whatever `DATABASE_URL` points at, gated only by `--yes`.
// That was harmless while `DATABASE_URL` was always the local Docker Postgres,
// but it stopped being true: the library now lives on Supabase, and the C2 warm
// campaign deliberately runs `reset-maps` against it. So the destructive path is
// meant to reach production, and the only thing standing between a stale shell
// export and the curated library is the operator noticing.
//
// The guard makes the target impossible to miss and, off localhost, impossible
// to hit by accident: a remote wipe requires naming the host on the command
// line, so a mistyped or forgotten `DATABASE_URL` override aborts instead of
// truncating. Dry runs never require the flag — they just print the target and
// the flag you would need — because demanding it there would train everyone to
// type it reflexively, which is exactly the habit the guard exists to prevent.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'db']);

export type Target = { label: string; isLocal: boolean };

export function resolveTarget(): Target {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');
  const url = new URL(raw);
  return {
    label: `${url.hostname}:${url.port || '5432'}${url.pathname}`,
    isLocal: LOCAL_HOSTS.has(url.hostname),
  };
}

/**
 * Prints the target and, when `apply` is set against a non-local host, requires
 * `--target-host=<hostname>` to match it. Exits 1 on mismatch.
 */
export function requireTargetAck(script: string, apply: boolean): Target {
  const target = resolveTarget();
  const hostname = target.label.split(':')[0];

  console.log(`[${script}] target: ${target.label}${target.isLocal ? '' : '  ⚠ REMOTE'}`);
  if (target.isLocal) return target;

  const ack = process.argv
    .find((a) => a.startsWith('--target-host='))
    ?.slice('--target-host='.length);

  if (!apply) {
    if (ack !== hostname) {
      console.log(
        `[${script}] this is a REMOTE database. Applying will require ` +
          `--target-host=${hostname}`,
      );
    }
    return target;
  }

  if (ack !== hostname) {
    console.error(
      `\n✗ refusing to TRUNCATE a remote database without an explicit target.\n` +
        `  DATABASE_URL points at ${target.label}\n` +
        (ack
          ? `  but --target-host=${ack} was passed — they must match.\n`
          : `  Re-run with --target-host=${hostname} if that is really what you mean.\n`),
    );
    process.exit(1);
  }
  return target;
}
