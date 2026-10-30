import type { ApiKeyPresetId } from '@oblimint/shared';

// « Connect an AI agent » (account Getting started): which key preset the
// agent gets, and the starter prompt to paste into the agent once connected.
// Pure (the caller passes `t`): unit-tested in agentPrompt.test.ts.

type T = (key: string, opts: Record<string, unknown> & { defaultValue: string }) => string;

export interface AgentPromptSite {
  id: number;
  name: string;
  primaryDomain?: string | null;
}

/**
 * Preset of the key: no site yet → it creates its own (« Autonomous creation »);
 * one site → « Manage one site » on it; several → « Manage one site », the user picks it.
 */
export function agentKeyPreset(siteCount: number): ApiKeyPresetId {
  return siteCount === 0 ? 'autonomous' : 'site';
}

/** Sites ticked from the start: the only site of the account, else none. */
export function agentKeySites(sites: readonly AgentPromptSite[]): number[] {
  return sites.length === 1 ? [sites[0].id] : [];
}

/** Starter prompt (plain text, copied as is) for the agent connected to `account`. */
export function agentStarterPrompt(t: T, account: string, sites: readonly AgentPromptSite[]): string {
  const lines = [
    t('agentConnect.prompt.intro', {
      account,
      defaultValue: 'You are connected to my Oblimint hosting account "{{account}}" through its MCP server ("oblimint").',
    }),
    t('agentConnect.prompt.guide', {
      defaultValue: 'Start by calling get_guide and follow it: the code in production is immutable, you write in the staging area, check the result on a preview, then publish a release (a rollback is always possible).',
    }),
  ];
  if (sites.length === 0) {
    lines.push(t('agentConnect.prompt.create', {
      defaultValue: 'This account has no site yet. Ask me what the site is for, then create it (create_site), write its files, start a preview and give me its link.',
    }));
  } else {
    const names = sites.slice(0, 5).map((s) => (s.primaryDomain ? `${s.name} (${s.primaryDomain})` : s.name)).join(', ');
    lines.push(t('agentConnect.prompt.work', {
      sites: names,
      defaultValue: 'Sites you may work on: {{sites}}. Read the current files and the latest release before changing anything, then show me a preview of your changes.',
    }));
  }
  lines.push(t('agentConnect.prompt.confirm', {
    defaultValue: 'Never publish before I have approved the preview, and tell me what you changed in each release.',
  }));
  return lines.join('\n\n');
}
