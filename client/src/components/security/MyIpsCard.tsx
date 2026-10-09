import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Fingerprint, Radar, ShieldCheck, ShieldOff, UserCheck } from 'lucide-react';
import type { AccountAccessInfo, IpProbeResult, MyIpsInfo } from '@oblimint/shared';
import { firewallApi } from '@/api/firewall.api';
import { Button } from '@/components/common/Button';
import { Card, CopyButton, InfoRow, Pill } from '@/components/hosting/hostingUi';
import { opsErrorMessage, toastOpsError } from '@/components/usage/opsErrors';

interface ProbeState {
  v4: IpProbeResult | null;
  v6: IpProbeResult | null;
  /** The probe host of this family is configured (the ticket gave an URL). */
  v4Configured: boolean;
  v6Configured: boolean;
}

/**
 * « My IP addresses »: the address the panel sees, plus the IPv4 and IPv6 of
 * this computer captured by the v4-only / v6-only probe hosts (a dual-stack
 * client would otherwise be refused in SFTP over the family it did not use
 * for the panel). « Allow my IPs » adds them as rules of the account.
 */
export function MyIpsCard({ accountId, canEdit, rules, onChanged }: {
  accountId: number;
  canEdit: boolean;
  rules: AccountAccessInfo['rules'];
  onChanged: (info: AccountAccessInfo) => void;
}) {
  const { t } = useTranslation();
  const [mine, setMine] = useState<MyIpsInfo | null>(null);
  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowing, setAllowing] = useState(false);
  const mounted = useRef(true);
  // Set back to true in the body: StrictMode (dev) mounts, cleans up and mounts again.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const runProbes = useCallback(async () => {
    setProbing(true);
    setError(null);
    try {
      const ticket = await firewallApi.probeTicket();
      const [v4, v6] = await Promise.all([
        ticket.v4Url ? firewallApi.runProbe(ticket.v4Url) : Promise.resolve(null),
        ticket.v6Url ? firewallApi.runProbe(ticket.v6Url) : Promise.resolve(null),
      ]);
      if (!mounted.current) return;
      setProbe({ v4, v6, v4Configured: !!ticket.v4Url, v6Configured: !!ticket.v6Url });
    } catch (err) {
      if (mounted.current) setError(opsErrorMessage(t, err, 'security', t('security.myIps.probeFailed') || 'The address detection failed.'));
    }
    // The server recorded what the probes saw for this session: read it back.
    try {
      const m = await firewallApi.myIps();
      if (mounted.current) setMine(m);
    } catch (err) {
      if (mounted.current) setError((cur) => cur ?? opsErrorMessage(t, err, 'security', t('security.myIps.loadFailed') || 'Failed to read your addresses.'));
    } finally {
      if (mounted.current) setProbing(false);
    }
  }, [t]);

  useEffect(() => { void runProbes(); }, [runProbes]);

  const ipv4 = probe?.v4?.ip ?? mine?.ipv4 ?? null;
  const ipv6 = probe?.v6?.ip ?? mine?.ipv6 ?? null;
  // The server also adds the address it sees (allowMyIps = seen + probed).
  const seen = mine?.seen ?? null;
  const known = new Set(rules.map((r) => r.cidr));
  const allowed = (ip: string | null) => ip != null && known.has(ip);

  const allow = async () => {
    setAllowing(true);
    try {
      onChanged(await firewallApi.allowMyIps(accountId));
      toast.success(t('security.myIps.allowed') || 'Your addresses were added to the rules');
    } catch (err) {
      toastOpsError(t, err, 'security', t('security.myIps.allowFailed') || 'Failed to allow your addresses');
    } finally {
      setAllowing(false);
    }
  };

  const familyValue = (ip: string | null, configured: boolean | undefined) => {
    if (ip) {
      return (
        <span className="inline-flex max-w-full items-center gap-1">
          <span className="truncate">{ip}</span>
          <CopyButton text={ip} />
          {allowed(ip) && <Pill tone="green">{t('security.myIps.inRules') || 'in the rules'}</Pill>}
        </span>
      );
    }
    if (probing) return <span className="text-text-muted">…</span>;
    if (configured === false) return <span className="text-xs text-text-muted">{t('security.myIps.probeNotConfigured') || 'probe host not configured'}</span>;
    return <span className="text-xs text-text-muted">{t('security.myIps.none') || 'not detected'}</span>;
  };

  return (
    <Card
      title={t('security.myIps.title') || 'My IP addresses'}
      icon={<Fingerprint size={14} className="text-accent" />}
      actions={
        <>
          <Button size="sm" variant="secondary" loading={probing} onClick={() => { void runProbes(); }}>
            <Radar size={13} className="mr-1.5" />{t('security.myIps.detect') || 'Detect again'}
          </Button>
          {canEdit && (
            <Button size="sm" loading={allowing} disabled={probing || (!ipv4 && !ipv6 && !seen)} onClick={() => { void allow(); }}>
              <ShieldCheck size={13} className="mr-1.5" />{t('security.myIps.allow') || 'Allow my IPs'}
            </Button>
          )}
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <InfoRow label="IPv4" mono>{familyValue(ipv4, probe?.v4Configured)}</InfoRow>
        <InfoRow label="IPv6" mono>{familyValue(ipv6, probe?.v6Configured)}</InfoRow>
        <InfoRow label={t('security.myIps.seen') || 'Seen by the panel'} mono>
          {seen ? (
            <span className="inline-flex max-w-full items-center gap-1">
              <span className="truncate">{seen}</span>
              {allowed(seen) && <Pill tone="green">{t('security.myIps.inRules') || 'in the rules'}</Pill>}
            </span>
          ) : '—'}
        </InfoRow>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {mine && (mine.mfa
          ? <Pill tone="green"><UserCheck size={10} />{t('security.myIps.mfa') || 'session with 2FA'}</Pill>
          : <Pill tone="amber"><ShieldOff size={10} />{t('security.myIps.noMfa') || 'session without 2FA'}</Pill>)}
        <span className="text-text-muted">
          {mine?.mfa
            ? (t('security.myIps.mfaHint') || 'In « auto after 2FA » mode, the addresses of this session are allowed automatically on the accounts you belong to.')
            : (t('security.myIps.noMfaHint') || 'Automatic grants need a sign-in with two-factor authentication. Staff users get no automatic grant: use rules.')}
        </span>
      </div>
      {error && <p className="mt-2 whitespace-pre-line text-xs text-status-down">{error}</p>}
    </Card>
  );
}
