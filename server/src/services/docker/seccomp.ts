// ─────────────────────────────────────────────────────────────────────────────
// Seccomp profile of the TENANT containers (site primary / secondary / preview
// and the per-account file server). Pure data, part of the spec (spec-hash).
//
// Why: the XFS project quota (hostd/quota.go) is keyed on the project id of
// each inode. The owner of a file may change that id with the
// FS_IOC_FSSETXATTR ioctl (no capability needed outside a user namespace),
// moving files out of the account's quota between two hostd audits. The
// ioctl (and the 6.17+ file_setattr syscall) is refused with EPERM here.
//
// Shape: allow by default, deny a list. The containers already run with
// CapDrop ALL + no-new-privileges, so every syscall Docker's default profile
// gates on a capability is refused by the kernel anyway; this list adds the
// ones the kernel does NOT gate on a capability (user namespaces, keyrings,
// io_uring, userfaultfd, bpf, perf…) plus the quota ioctl. clone3 answers
// ENOSYS (like Docker's default) so glibc falls back to clone, whose
// CLONE_NEWUSER flag is refused.
//
// Unknown syscall names (file_setattr on an old libseccomp) are skipped by
// runc. NOT verified on a real host (no Docker on the dev box): see
// docs/P1-PLAN.md §17.
// ─────────────────────────────────────────────────────────────────────────────

/** FS_IOC_FSSETXATTR = _IOW('X', 32, struct fsxattr) = 0x401c5820 (same value for XFS_IOC_FSSETXATTR and 32-bit compat). */
export const FS_IOC_FSSETXATTR = 0x401c5820;
/** CLONE_NEWUSER. */
export const CLONE_NEWUSER = 0x10000000;

const EPERM = 1;
const ENOSYS = 38;

/** Syscalls never needed by PHP / a web server / SFTPGo and not gated by a capability (or cheap defense in depth). */
const DENIED_SYSCALLS = [
  'unshare', 'setns',
  'keyctl', 'add_key', 'request_key',
  'io_uring_setup', 'io_uring_enter', 'io_uring_register',
  'userfaultfd', 'bpf', 'perf_event_open',
  'mount', 'umount', 'umount2', 'pivot_root', 'move_mount', 'open_tree', 'fsopen', 'fsconfig', 'fsmount', 'fspick', 'mount_setattr',
  'name_to_handle_at', 'open_by_handle_at',
  'quotactl', 'quotactl_fd',
  'kexec_load', 'kexec_file_load', 'reboot', 'init_module', 'finit_module', 'delete_module',
  'create_module', 'get_kernel_syms', 'query_module',
  'iopl', 'ioperm', 'swapon', 'swapoff', 'acct', 'syslog',
  'lookup_dcookie', 'nfsservctl', 'uselib', 'ustat', 'sysfs', '_sysctl', 'vm86', 'vm86old',
  'fanotify_init', 'kcmp', 'process_vm_readv', 'process_vm_writev', 'ptrace',
  'clock_adjtime', 'clock_settime', 'settimeofday', 'stime', 'adjtimex',
  'file_setattr',
];

export interface SeccompProfile {
  defaultAction: 'SCMP_ACT_ALLOW';
  architectures: string[];
  syscalls: Array<{
    names: string[];
    action: 'SCMP_ACT_ERRNO';
    errnoRet: number;
    args?: Array<{ index: number; value: number; valueTwo?: number; op: 'SCMP_CMP_EQ' | 'SCMP_CMP_MASKED_EQ' }>;
  }>;
}

export const TENANT_SECCOMP_PROFILE: SeccompProfile = {
  defaultAction: 'SCMP_ACT_ALLOW',
  architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_X86', 'SCMP_ARCH_X32', 'SCMP_ARCH_AARCH64', 'SCMP_ARCH_ARM'],
  syscalls: [
    { names: ['ioctl'], action: 'SCMP_ACT_ERRNO', errnoRet: EPERM, args: [{ index: 1, value: FS_IOC_FSSETXATTR, op: 'SCMP_CMP_EQ' }] },
    { names: ['clone'], action: 'SCMP_ACT_ERRNO', errnoRet: EPERM, args: [{ index: 0, value: CLONE_NEWUSER, valueTwo: CLONE_NEWUSER, op: 'SCMP_CMP_MASKED_EQ' }] },
    { names: ['clone3'], action: 'SCMP_ACT_ERRNO', errnoRet: ENOSYS },
    { names: DENIED_SYSCALLS, action: 'SCMP_ACT_ERRNO', errnoRet: EPERM },
  ],
};

/** HostConfig.SecurityOpt entry: the Engine API takes the profile JSON inline. */
export const TENANT_SECCOMP_OPT = `seccomp=${JSON.stringify(TENANT_SECCOMP_PROFILE)}`;
