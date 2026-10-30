import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Bot, Copy, KeyRound, Plug, Sparkles } from 'lucide-react';
import type { ApiKey, ApiKeyCreated, ApiKeyKind, HostingAccount, Site } from '@oblimint/shared';
import { sitesApi } from '@/api/sites.api';
import { Button } from '@/components/common/Button';
import { copyText } from '@/utils/clipboard';
import { cn } from '@/utils/cn';
import { Card } from './hostingUi';
import { ApiGuideModal, CreatedKeyModal, KeyModal } from './KeyModal';
import { agentKeyPreset, agentKeySites, agentStarterPrompt } from './agentPrompt';

/**
 * « Connect an AI agent » (account overview, Getting started): an access key
 * (Claude Code, any MCP / REST agent) or a Claude connector, started with the
 * preset that fits the account (no site: « Autonomous creation »; else « Manage
 * one site »), and a starter prompt to paste once the agent is connected.
 * Highlighted as a call to action while the account has no site.
 */
export function AgentConnectCard({ account, openKind, onOpened, onKeyCreated }: {
  account: Pick<HostingAccount, 'id' | 'username' | 'siteCount'>;
  /** Open the key form at once (deep link ?agent=1 / the checklist step). */
  openKind?: ApiKeyKind | null;
  onOpened?: () => void;
  onKeyCreated?: () => void;
}) {
  const { t } = useTranslation();
  const [sites, setSites] = useState<Site[] | null>(null);
  const [editing, setEditing] = useState<ApiKeyKind | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    let live = true;
    sitesApi.list({ accountId: account.id }).then((l) => { if (live) setSites(l); }).catch(() => { if (live) setSites([]); });
    return () => { live = false; };
  }, [account.id, account.siteCount]);

  useEffect(() => {
    if (!openKind) return;
    setEditing(openKind);
    onOpened?.();
  }, [openKind]); // eslint-disable-line react-hooks/exhaustive-deps

  const siteList = sites ?? [];
  const noSite = account.siteCount === 0;
  const prompt = agentStarterPrompt(t as never, account.username, siteList.map((s) => ({ id: s.id, name: s.name, primaryDomain: s.primaryDomain })));
  const copy = () => { void copyText(prompt).then((ok) => (ok ? toast.success(t('common.copied') || 'Copied') : toast.error(t('common.error') || 'Error'))); };

  return (
    <Card
      icon={<Bot size={14} className="text-accent" />}
      title={t('agentConnect.title') || 'Connect an AI agent'}
      className={cn(noSite && 'ring-1 ring-accent/40')}
    >
      <p className="text-xs text-text-muted">
        {noSite
          ? (t('agentConnect.introNoSite') || 'This account has no site yet: let an AI agent (Claude Code, Claude…) create it, show you a preview and publish it. It only gets this account, with the rights you choose.')
          : (t('agentConnect.intro') || 'Give Claude Code, Claude or another AI agent access to this account, limited to the sites and rights you choose. Every change goes through a preview and a release you can roll back.')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setEditing('key')}>
          <KeyRound className="mr-1 h-3.5 w-3.5" />{t('agentConnect.key') || 'Access key (Claude Code, agents)'}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setEditing('connector')}>
          <Plug className="mr-1 h-3.5 w-3.5" />{t('apiKeys.connector.create') || 'Claude connector'}
        </Button>
      </div>
      <div className="mt-4">
        <div className="mb-1 flex items-center gap-2">
          <Sparkles size={13} className="text-accent" />
          <span className="text-xs font-medium text-text-secondary">{t('agentConnect.promptTitle') || 'Starter prompt'}</span>
          <Button size="sm" variant="secondary" className="ml-auto" onClick={copy}><Copy className="mr-1 h-3.5 w-3.5" />{t('common.copy') || 'Copy'}</Button>
        </div>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-bg-primary p-3 font-mono text-[11px] text-text-secondary">{prompt}</pre>
        <p className="mt-1 text-[11px] text-text-muted">{t('agentConnect.promptHint') || 'Paste it as the first message once the agent is connected.'}</p>
      </div>

      {editing && (
        <KeyModal
          accountId={account.id}
          sites={sites ?? undefined}
          kind={editing}
          initial={null}
          initialPreset={agentKeyPreset(account.siteCount)}
          initialSiteIds={agentKeySites(siteList)}
          initialName={editing === 'connector' ? 'Claude' : (t('agentConnect.keyName') || 'AI agent')}
          onClose={() => setEditing(null)}
          onSaved={(k: ApiKey | ApiKeyCreated) => {
            setEditing(null);
            if ('clientSecret' in k) setCreated(k as ApiKeyCreated);
            onKeyCreated?.();
          }}
        />
      )}
      {created && <CreatedKeyModal created={created} onClose={() => setCreated(null)} onGuide={() => setGuideOpen(true)} />}
      {guideOpen && <ApiGuideModal onClose={() => setGuideOpen(false)} />}
    </Card>
  );
}
