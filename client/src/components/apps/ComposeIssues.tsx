import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { ComposeIssue } from '@oblimint/shared';
import { cn } from '@/utils/cn';

/**
 * Generic text of each compose issue code (docs/P4b-PLAN.md §5.2); the issue
 * path is always shown next to it. Translated under apps.compose.issues.<code>
 * with { service, path, ...params }; the server's English message is the last
 * resort for a code unknown to this version.
 */
const ISSUES = /* i18n:apps.compose.issues */ {
  yamlSyntax: 'YAML syntax error.',
  notAnObject: 'The compose file must be a YAML mapping.',
  noServices: 'The compose file declares no service.',
  tooManyServices: 'Too many services in one application.',
  invalidServiceName: 'Invalid service name (lower case letters, digits, - and _).',
  invalidName: 'Invalid name.',
  privileged: 'Privileged containers are not allowed.',
  hostNetwork: 'The host network is not allowed.',
  networkMode: 'This network_mode is not allowed (only none).',
  hostPid: 'Sharing the host PID namespace is not allowed.',
  hostIpc: 'Sharing the host IPC namespace is not allowed.',
  hostUts: 'Sharing the host UTS namespace is not allowed.',
  userns: 'userns_mode is not allowed.',
  cgroupParent: 'cgroup_parent / cgroup are not allowed.',
  devices: 'Host devices are not allowed.',
  dockerSocket: 'Mounting the Docker socket is not allowed.',
  absoluteBind: 'Absolute bind mounts are not allowed: use a named volume or a path relative to the application.',
  bindOutsideStack: 'This bind mount leaves the application directory.',
  symlinkInPath: 'This path goes through a symbolic link.',
  volumeDriver: 'Only the local volume driver is allowed.',
  externalVolume: 'External volumes are not allowed.',
  externalNetwork: 'External networks are not allowed.',
  capNotAllowed: 'This capability (cap_add) is not allowed.',
  securityOptIgnored: 'security_opt is ignored: the platform enforces its own.',
  sysctls: 'sysctls are not allowed.',
  deviceCgroupRules: 'device_cgroup_rules are not allowed.',
  gpus: 'GPUs are not available.',
  imageMissing: 'The service has neither an image nor a build.',
  imageNotAllowed: 'This image is refused by the platform policy.',
  registryNotAllowed: 'This registry is not allowed.',
  buildNotAllowed: 'Building images is not allowed for this account.',
  buildContextOutsideStack: 'The build context leaves the application directory.',
  portsNotPublished: 'Ports are never published on the host: they are exposed to the proxy hosts and links only.',
  hostPortIgnored: 'The host port is ignored (only the container port is kept).',
  resourceDefaulted: 'No limit declared: the default limits apply.',
  resourceCapped: 'The declared limit is reduced to what the plan leaves.',
  planCpuExceeded: 'The CPU of the applications of the account would exceed the plan.',
  planMemoryExceeded: 'The memory of the applications of the account would exceed the plan.',
  planContainersExceeded: 'The plan allows no more containers.',
  pidsCapped: 'The process limit is capped by the plan.',
  ulimitCapped: 'This ulimit is capped.',
  tmpfsSize: 'This tmpfs is capped at 256 MiB.',
  shmSize: 'shm_size is capped at 256 MiB.',
  replicas: 'Several replicas are not supported.',
  containerNameIgnored: 'container_name is ignored (the platform names the containers).',
  hostnameIgnored: 'hostname is ignored.',
  linksIgnored: 'links / external_links are ignored: services reach each other by name.',
  extraHostsPrivate: 'extra_hosts cannot point to a private address or the host.',
  dnsIgnored: 'DNS options are ignored.',
  extendsNotSupported: 'extends is not supported.',
  includeNotSupported: 'include is not supported.',
  envFileOutsideStack: 'This env_file leaves the application directory.',
  secretsFileOutsideStack: 'This secret file leaves the application directory.',
  configsFileOutsideStack: 'This config file leaves the application directory.',
  unknownKey: 'Unknown key.',
  unsupportedKey: 'Unsupported key.',
  interpolation: 'Invalid variable interpolation.',
  missingVariable: 'A required variable is missing from the .env.',
  dependsCycle: 'depends_on forms a cycle.',
  dependsUnknown: 'depends_on names an unknown service.',
  restartPolicy: 'restart: always becomes unless-stopped.',
  loggingIgnored: 'logging is ignored (the platform sets the log driver).',
  labelReserved: 'Reserved labels (oblimint.*, com.docker.*) are removed.',
  stopGraceCapped: 'stop_grace_period is capped at 120 s.',
  readOnlyForced: 'The root file system is read-only.',
  userRoot: 'The image runs as root inside the container.',
} as const;

export function composeIssueMessage(t: TFunction, i: ComposeIssue): string {
  // Writable binds of the stack source are refused (server validate.ts: unsupportedKey + key 'rw').
  if (i.code === 'unsupportedKey' && i.params?.key === 'rw') {
    return t('apps.compose.issues.bindReadOnly', { ...(i.params ?? {}), defaultValue: 'Bind mounts of the application source are always read-only: use a named volume for writable data.' });
  }
  if (i.code === 'unsupportedKey' && typeof i.params?.key === 'string') {
    return t('apps.compose.issues.unsupportedKeyNamed', { ...(i.params ?? {}), defaultValue: 'Unsupported key: {{key}}.' });
  }
  const known = Object.prototype.hasOwnProperty.call(ISSUES, i.code);
  return t(`apps.compose.issues.${i.code}`, {
    service: i.service ?? '',
    path: i.path,
    ...(i.params ?? {}),
    defaultValue: known ? ISSUES[i.code as keyof typeof ISSUES] : i.message,
  });
}

/** Issues sorted errors first, then by line. */
export function sortIssues(issues: ComposeIssue[]): ComposeIssue[] {
  return [...issues].sort((a, b) => (a.severity === b.severity ? (a.line ?? 1e9) - (b.line ?? 1e9) : a.severity === 'error' ? -1 : 1));
}

/** Validation summary + issue list; a click on an issue with a line reveals it in the editor. */
export function ComposeIssueList({ issues, ok, onReveal, className }: {
  issues: ComposeIssue[];
  ok: boolean | null;
  onReveal?: (line: number) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return (
    <div className={cn('min-w-0', className)}>
      {ok !== null && (
        <div className={cn('mb-2 flex items-center gap-2 text-sm', ok ? 'text-green-400' : 'text-status-down')}>
          {ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
          {ok
            ? (warnings ? t('apps.compose.okWithWarnings', { count: warnings, defaultValue: 'Valid, {{count}} warning(s).' }) : (t('apps.compose.ok') || 'The compose file is valid.'))
            : t('apps.compose.errors', { count: errors, defaultValue: '{{count}} error(s) to fix.' })}
        </div>
      )}
      {issues.length > 0 && (
        <ul className="space-y-1">
          {sortIssues(issues).map((i, idx) => {
            const clickable = !!onReveal && i.line != null;
            return (
              <li key={`${i.code}-${i.path}-${idx}`}>
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() => { if (clickable) onReveal!(i.line!); }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    i.severity === 'error' ? 'bg-red-500/[0.07] text-text-primary' : 'bg-amber-400/[0.07] text-text-primary',
                    clickable ? 'hover:bg-bg-hover' : 'cursor-default',
                  )}
                >
                  {i.severity === 'error'
                    ? <XCircle size={13} className="mt-0.5 shrink-0 text-status-down" />
                    : <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />}
                  <span className="min-w-0 flex-1">
                    <span className="block">{composeIssueMessage(t, i)}</span>
                    <span className="mt-0.5 block break-all font-mono text-[10.5px] text-text-muted">
                      {i.line != null && <span className="mr-2">{t('apps.compose.line', { line: i.line, defaultValue: 'line {{line}}' })}</span>}
                      {i.path}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

