/* eslint-disable no-console */
import net from 'net';

// ─────────────────────────────────────────────────────────────────────────────
// rsync remote-shell shim (docs/P5-PLAN.md §5.6). STANDALONE: node builtins
// only, no panel import — it runs as `--rsh` of the local rsync, i.e. under the
// uid:gid of the transfer (never root), with a minimal environment:
//   OBLIMINT_TUNNEL        unix socket of this transfer (dir 0700, owned by the uid)
//   OBLIMINT_TUNNEL_TOKEN  one-time token of this transfer
// It sends ONE line `{"token","argv"}` (argv = what rsync passed to its remote
// shell: host placeholder then `rsync --server --sender …`) and then only
// pipes bytes: stdin → socket, socket → stdout. The panel validates the argv,
// opens the SSH channel with the re-rendered `rsync.sender` template, or
// closes the socket (rsync then fails: "connection unexpectedly closed").
// ─────────────────────────────────────────────────────────────────────────────

function main(): void {
  const socketPath = process.env.OBLIMINT_TUNNEL;
  const token = process.env.OBLIMINT_TUNNEL_TOKEN;
  delete process.env.OBLIMINT_TUNNEL_TOKEN;
  if (!socketPath || !token) {
    process.stderr.write('oblimint-rsync-shim: tunnel not configured\n');
    process.exit(255);
  }
  const argv = process.argv.slice(2);
  const sock = net.connect({ path: socketPath, allowHalfOpen: true });
  let failed = false;
  sock.on('connect', () => {
    sock.write(`${JSON.stringify({ token, argv })}\n`);
    process.stdin.pipe(sock);
    sock.pipe(process.stdout, { end: false });
  });
  sock.on('error', (err) => {
    failed = true;
    process.stderr.write(`oblimint-rsync-shim: tunnel error (${(err as NodeJS.ErrnoException).code ?? 'unknown'})\n`);
  });
  // Like ssh: once the remote side is finished (EOF from the panel = the remote command
  // exited), flush what is left for rsync and leave, whatever the state of our stdin.
  let leaving = false;
  const leave = () => {
    if (leaving) return;
    leaving = true;
    process.stdout.write('', () => process.exit(failed ? 255 : 0));
  };
  sock.on('end', leave);
  sock.on('close', leave);
  process.stdin.on('error', () => sock.destroy());
  process.stdout.on('error', () => sock.destroy());
}

main();
