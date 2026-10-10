import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowLeft, CheckCircle2, Code2, FolderArchive, GitBranch, LayoutGrid, Rocket, ShieldCheck, Upload } from 'lucide-react';
import type {
  AppResourceSummary, AppSourceType, AppStackCreate, AppTemplate, AppTemplateDetail, ComposeIssue, ComposeValidationResult, HostingAccount,
} from '@oblimint/shared';
import { accountsApi } from '@/api/accounts.api';
import { appsApi } from '@/api/apps.api';
import { isStepUpHandled } from '@/api/client';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { Card, EmptyState, inputCls, labelCls, selectCls } from '@/components/hosting/hostingUi';
import { cn } from '@/utils/cn';
import { useP4bAccess } from '@/components/apps/appsAccess';
import { appsErrorMessage, composeIssuesOf } from '@/components/apps/appsErrors';
import { STACK_NAME_RE, dotenvBadLines, patchParams, slugify } from '@/components/apps/appsFormat';
import { CatalogIcon } from '@/components/apps/CatalogIcon';
import { CodeEditor } from '@/components/apps/CodeEditor';
import { ComposeIssueList } from '@/components/apps/ComposeIssues';
import { EffectivePreview } from '@/components/apps/EffectivePreview';
import { GitSourceForm, gitDraftFrom, gitDraftOut, gitDraftProblem, type GitDraft } from '@/components/apps/GitSourceForm';
import { RegistryPicker } from '@/components/apps/RegistryPicker';
import { TemplateFieldsForm, fieldValuesOut, firstFieldProblem, initialFieldValues, type FieldValues } from '@/components/apps/TemplateFieldsForm';
import { AppResourcesBar } from '@/components/apps/AppResourcesBar';

const SOURCES: AppSourceType[] = ['catalog', 'editor', 'git', 'zip'];

const DEFAULT_COMPOSE = `services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "80"
`;

function isSource(v: string | null): v is AppSourceType {
  return v !== null && (SOURCES as readonly string[]).includes(v);
}

/**
 * /apps/new — new application: source chooser (catalog ?template=<slug>,
 * compose editor, git repository, ZIP archive), account, name, then create
 * (+ deploy). ZIP: created first, then the archive is uploaded
 * (POST /apps/stacks/:id/source/zip). OWNED BY MODULE `ui-apps`.
 */
export function AppCreatePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can } = useP4bAccess();
  const sourceParam = params.get('source');
  const templateSlug = params.get('template');
  const source: AppSourceType | null = templateSlug ? 'catalog' : isSource(sourceParam) ? sourceParam : null;
  const setSource = (s: AppSourceType | null) => setParams((prev) => patchParams(prev, { source: s, template: null }), { replace: true });

  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountId, setAccountId] = useState<number | null>(Number(params.get('account')) || null);
  const [resources, setResources] = useState<AppResourceSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    accountsApi.list()
      .then((l) => { if (!cancelled) setAccounts(l); })
      .catch(() => { if (!cancelled) setAccounts([]); })
      .finally(() => { if (!cancelled) setAccountsLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  const manageable = useMemo(() => accounts.filter((a) => can('apps.manage', a.id) && a.status !== 'deleting'), [accounts, can]);
  useEffect(() => {
    if (accountId == null && manageable.length === 1) setAccountId(manageable[0].id);
  }, [manageable, accountId]);

  // ── common fields ──
  const [displayName, setDisplayName] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [registryIds, setRegistryIds] = useState<number[]>([]);
  const [deploy, setDeploy] = useState(true);
  // ── editor ──
  const [compose, setCompose] = useState(DEFAULT_COMPOSE);
  const [env, setEnv] = useState('');
  const [validation, setValidation] = useState<ComposeValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  // ── git ──
  const [git, setGit] = useState<GitDraft>(() => gitDraftFrom(null));
  // ── zip ──
  const [zip, setZip] = useState<File | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  // ── catalog ──
  const [template, setTemplate] = useState<AppTemplateDetail | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [values, setValues] = useState<FieldValues>({});

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [serverIssues, setServerIssues] = useState<ComposeIssue[]>([]);

  useEffect(() => {
    if (!templateSlug) { setTemplate(null); return; }
    let cancelled = false;
    setTemplateError(null);
    appsApi.getTemplate(templateSlug)
      .then((tpl) => {
        if (cancelled) return;
        setTemplate(tpl);
        setValues(initialFieldValues(tpl.fields));
        setDisplayName((d) => d || tpl.name);
        if (!nameTouched) setName(slugify(tpl.slug));
      })
      .catch((err) => { if (!cancelled) setTemplateError(appsErrorMessage(t, err, t('apps.catalog.loadFailed') || 'Failed to load the catalog')); });
    return () => { cancelled = true; };
  }, [templateSlug]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDisplayName = (v: string) => {
    setDisplayName(v);
    if (!nameTouched) setName(slugify(v));
  };

  const validate = async () => {
    if (accountId == null) { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    setValidating(true);
    try {
      setValidation(await appsApi.validate({ accountId, composeYaml: compose, env }));
      setServerIssues([]);
    } catch (err) {
      toast.error(appsErrorMessage(t, err, t('apps.compose.validateFailed') || 'The validation failed'));
    } finally {
      setValidating(false);
    }
  };

  // The ZIP upload always deploys the draft it fills (server), whatever the toggle says.
  const willDeploy = source === 'zip' || deploy;

  const submit = async () => {
    setError('');
    setServerIssues([]);
    if (accountId == null) { setError(t('apps.scope.pickAccount') || 'Choose an account…'); return; }
    if (!STACK_NAME_RE.test(name)) { setError(t('apps.create.nameInvalid') || 'Name: lower case letters, digits and dashes, 31 characters at most, starting with a letter or a digit.'); return; }
    if (!source) return;
    const data: AppStackCreate = {
      accountId, name, displayName: displayName.trim() || name, description: description.trim() || null, sourceType: source,
      registryCredentialIds: registryIds.length ? registryIds : undefined, deploy,
    };
    if (source === 'editor') {
      if (!compose.trim()) { setError(t('apps.templateEditor.composeRequired') || 'The compose file is required.'); return; }
      const bad = dotenvBadLines(env);
      if (bad.length) { setError(t('apps.env.badLines', { lines: bad.join(', '), defaultValue: '.env: invalid line(s) {{lines}} (KEY=value expected).' })); return; }
      data.composeYaml = compose;
      if (env.trim()) data.env = env;
    } else if (source === 'git') {
      const p = gitDraftProblem(t, git);
      if (p) { setError(p); return; }
      data.git = gitDraftOut(git);
    } else if (source === 'zip') {
      if (!zip) { setError(t('apps.create.zipRequired') || 'Choose a ZIP archive.'); return; }
    } else if (source === 'catalog') {
      if (!template) return;
      const p = firstFieldProblem(t, template.fields, values);
      if (p) { setError(p); return; }
      data.catalog = { templateSlug: template.slug, values: fieldValuesOut(template.fields, values) };
    }
    setSaving(true);
    try {
      const stack = await appsApi.createStack(data);
      if (source === 'zip' && zip) {
        try {
          setUploadPct(0);
          await appsApi.uploadZip(stack.id, zip, setUploadPct);
        } catch (err) {
          if (!isStepUpHandled(err)) toast.error(appsErrorMessage(t, err, t('apps.create.zipFailed') || 'The archive upload failed: upload it again from the application settings.'), { duration: 8000 });
        }
      }
      toast.success(t('apps.create.created') || 'Application created');
      navigate(`/apps/${stack.id}`, { replace: true });
    } catch (err) {
      if (isStepUpHandled(err)) return;
      setServerIssues(composeIssuesOf(err));
      setError(appsErrorMessage(t, err, t('apps.create.failed') || 'Failed to create the application'));
    } finally {
      setSaving(false);
      setUploadPct(null);
    }
  };

  const header = (
    <div className="flex items-start gap-3">
      <IconButton
        onClick={() => { if (source && !templateSlug) setSource(null); else if (window.history.length > 1) navigate(-1); else navigate('/apps'); }}
        size="lg" variant="plain" className="mt-0.5 rounded-lg hover:bg-bg-secondary" label={t('common.back') || 'Back'} icon={<ArrowLeft className="h-4 w-4" />}
      />
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary max-sm:text-xl">{t('apps.create.title') || 'New application'}</h1>
        <p className="mt-1 text-sm text-text-muted">{t('apps.create.subtitle') || 'The compose file is validated and rewritten before anything is deployed: no published port, no privilege, limits of the plan.'}</p>
      </div>
    </div>
  );

  if (accountsLoaded && manageable.length === 0) {
    return (
      <PageContainer className="flex flex-col gap-5">
        {header}
        <EmptyState icon={<Rocket />} text={t('apps.create.noAccount') || 'You cannot deploy an application on any account (capability "Manage applications" required).'} action={<Link to="/apps" className="text-sm text-accent hover:underline">{t('apps.backToList') || 'Back to the applications'}</Link>} />
      </PageContainer>
    );
  }

  if (!source) {
    const tile = (s: AppSourceType, icon: ReactNode, title: string, text: string) => (
      <button
        key={s}
        type="button"
        onClick={() => setSource(s)}
        className="flex min-w-0 flex-col items-start gap-2 rounded-xl border-2 border-transparent bg-bg-secondary p-5 text-left transition-colors hover:border-accent/30 focus-visible:border-accent focus-visible:outline-none"
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">{icon}</span>
        <span className="font-semibold text-text-primary">{title}</span>
        <span className="text-sm text-text-secondary">{text}</span>
      </button>
    );
    return (
      <PageContainer className="flex flex-col gap-5">
        {header}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {tile('catalog', <LayoutGrid size={20} />, t('apps.create.sources.catalog') || 'From the catalog', t('apps.create.sources.catalogHint') || 'Ready-made applications (WordPress, Nextcloud, Vaultwarden…): fill a short form.')}
          {tile('editor', <Code2 size={20} />, t('apps.create.sources.editor') || 'Compose editor', t('apps.create.sources.editorHint') || 'Write or paste a docker-compose file and its .env.')}
          {tile('git', <GitBranch size={20} />, t('apps.create.sources.git') || 'Git repository', t('apps.create.sources.gitHint') || 'Deploy the compose file of an https repository, with automatic redeploy on new commits.')}
          {tile('zip', <FolderArchive size={20} />, t('apps.create.sources.zip') || 'ZIP archive', t('apps.create.sources.zipHint') || 'Upload an archive containing the compose file and its files.')}
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      {header}

      {source === 'catalog' && !templateSlug && <TemplatePicker onPick={(slug) => setParams((prev) => patchParams(prev, { template: slug, source: null }), { replace: true })} />}

      {(source !== 'catalog' || templateSlug) && (
        <>
          {source === 'catalog' && (
            templateError ? <EmptyState icon={<LayoutGrid />} text={templateError} /> : !template ? <div className="flex justify-center py-8"><LoadingSpinner /></div> : (
              <Card>
                <div className="flex min-w-0 items-start gap-3">
                  <CatalogIcon icon={template.icon} size={44} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-semibold text-text-primary">{template.name}</span>
                      <span className="font-mono text-xs text-text-muted">{template.version}</span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{template.description}</p>
                  </div>
                  <button type="button" onClick={() => setParams((prev) => patchParams(prev, { template: null, source: 'catalog' }), { replace: true })} className="shrink-0 text-xs text-accent hover:underline">
                    {t('apps.create.changeTemplate') || 'Change'}
                  </button>
                </div>
              </Card>
            )
          )}

          <Card title={t('apps.create.general') || 'General'}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label className={labelCls} htmlFor="app-account">{t('apps.list.account') || 'Account'}</label>
                <select id="app-account" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)} className={selectCls}>
                  <option value="">{t('apps.scope.pickAccount') || 'Choose an account…'}</option>
                  {manageable.map((a) => <option key={a.id} value={a.id}>{a.username}{a.displayName ? ` — ${a.displayName}` : ''}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls} htmlFor="app-display">{t('apps.create.displayName') || 'Display name'}</label>
                <input id="app-display" value={displayName} onChange={(e) => onDisplayName(e.target.value)} className={inputCls} maxLength={100} />
              </div>
              <div>
                <label className={labelCls} htmlFor="app-name">{t('apps.create.name') || 'Identifier'}</label>
                <input
                  id="app-name"
                  value={name}
                  onChange={(e) => { setName(e.target.value.toLowerCase()); setNameTouched(true); }}
                  className={cn(inputCls, 'font-mono', name && !STACK_NAME_RE.test(name) && 'ring-1 ring-status-down')}
                  maxLength={31}
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <p className="mt-1 text-[11px] text-text-muted">{t('apps.create.nameHint') || 'Unique in the account: a-z, 0-9, dashes.'}</p>
              </div>
            </div>
            <div className="mt-3">
              <label className={labelCls} htmlFor="app-desc">{t('apps.create.description') || 'Description'}</label>
              <input id="app-desc" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} maxLength={500} />
            </div>
            {accountId != null && (
              <div className="mt-3">
                <AppResourcesBar key={accountId} accountId={accountId} onLoaded={setResources} />
              </div>
            )}
          </Card>

          {source === 'catalog' && template && (
            <Card title={t('apps.create.settings') || 'Settings'}>
              <TemplateFieldsForm fields={template.fields} values={values} onChange={setValues} />
            </Card>
          )}

          {source === 'editor' && (
            <Card
              title={t('apps.create.compose') || 'Compose file'}
              actions={<Button size="sm" variant="secondary" loading={validating} onClick={() => { void validate(); }}><ShieldCheck size={14} className="mr-1.5" />{t('apps.compose.validate') || 'Validate'}</Button>}
            >
              <CodeEditor
                value={compose}
                onChange={(v) => { setCompose(v); setValidation(null); }}
                minHeight="280px"
                maxHeight="560px"
                markers={(validation?.issues ?? serverIssues).filter((i) => i.line != null).map((i) => ({ line: i.line!, severity: i.severity }))}
                ariaLabel={t('apps.create.compose') || 'Compose file'}
              />
              <div className="mt-3">
                <label className={labelCls}>{t('apps.env.title') || 'Environment (.env)'}</label>
                <CodeEditor value={env} onChange={setEnv} language="text" minHeight="90px" maxHeight="240px" placeholder="DB_PASSWORD=…" ariaLabel=".env" />
                <p className="mt-1 text-[11px] text-text-muted">{t('apps.env.hint') || 'KEY=value lines, stored encrypted. Only these variables are interpolated in the compose file.'}</p>
              </div>
              {validation && (
                <div className="mt-4 space-y-4">
                  <ComposeIssueList issues={validation.issues} ok={validation.ok} />
                  {validation.ok && <EffectivePreview effective={validation.effective} effectiveYaml={validation.effectiveYaml} />}
                </div>
              )}
            </Card>
          )}

          {source === 'git' && (
            <Card title={t('apps.create.git') || 'Git repository'}>
              <GitSourceForm value={git} onChange={setGit} buildAllowed={resources?.build ?? false} />
            </Card>
          )}

          {source === 'zip' && (
            <Card title={t('apps.create.zip') || 'ZIP archive'}>
              <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border bg-bg-primary px-4 py-8 text-center hover:border-accent/40">
                <Upload size={20} className="text-text-muted" />
                <span className="text-sm text-text-primary">{zip ? zip.name : (t('apps.create.zipPick') || 'Choose a .zip archive')}</span>
                {zip && <span className="font-mono text-xs text-text-muted">{(zip.size / 1024 / 1024).toFixed(2)} MB</span>}
                <input type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => setZip(e.target.files?.[0] ?? null)} />
              </label>
              <p className="mt-2 text-xs text-text-muted">{t('apps.create.zipHint') || 'The archive must contain a docker-compose.yml at its root. Symbolic links and paths leaving the archive are refused.'}</p>
              {uploadPct != null && (
                <div className="mt-3 h-1.5 w-full rounded bg-bg-tertiary"><div className="h-full rounded bg-accent transition-all" style={{ width: `${uploadPct}%` }} /></div>
              )}
            </Card>
          )}

          <Card>
            <div className="space-y-3">
              <RegistryPicker accountId={accountId} value={registryIds} onChange={setRegistryIds} />
              {source === 'zip'
                ? <p className="text-xs text-text-muted">{t('apps.create.zipDeploys') || 'The application is deployed as soon as the archive is uploaded.'}</p>
                : <ToggleSwitch checked={deploy} onChange={setDeploy} label={t('apps.create.deployNow') || 'Deploy right away'} description={t('apps.create.deployNowHint') || 'Otherwise the application is saved as a draft.'} />}
              {serverIssues.length > 0 && <ComposeIssueList issues={serverIssues} ok={false} />}
              {error && <p className="whitespace-pre-line text-xs text-status-down">{error}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => navigate('/apps')}>{t('common.cancel') || 'Cancel'}</Button>
                <Button size="sm" loading={saving} disabled={accountId == null || (source === 'catalog' && !template)} onClick={() => { void submit(); }}>
                  {willDeploy ? <Rocket size={14} className="mr-1.5" /> : <CheckCircle2 size={14} className="mr-1.5" />}
                  {willDeploy ? (t('apps.create.submitDeploy') || 'Create and deploy') : (t('apps.create.submit') || 'Create')}
                </Button>
              </div>
            </div>
          </Card>
        </>
      )}
    </PageContainer>
  );
}

/** Compact template list when /apps/new?source=catalog has no template yet. */
function TemplatePicker({ onPick }: { onPick: (slug: string) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<AppTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    appsApi.listCatalog()
      .then((l) => { if (!cancelled) setItems(l.filter((x) => x.enabled)); })
      .catch((err) => { if (!cancelled) setError(appsErrorMessage(t, err, t('apps.catalog.loadFailed') || 'Failed to load the catalog')); });
    return () => { cancelled = true; };
  }, [t]);
  if (error) return <EmptyState icon={<LayoutGrid />} text={error} />;
  if (!items) return <div className="flex justify-center py-8"><LoadingSpinner /></div>;
  if (items.length === 0) return <EmptyState icon={<LayoutGrid />} text={t('apps.catalog.empty') || 'The catalog is empty.'} />;
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((tpl) => (
        <button key={tpl.id} type="button" onClick={() => onPick(tpl.slug)} className="flex min-w-0 items-center gap-3 rounded-xl border-2 border-transparent bg-bg-secondary p-3 text-left hover:border-accent/30">
          <CatalogIcon icon={tpl.icon} size={36} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-text-primary">{tpl.name}</span>
            <span className="block truncate text-xs text-text-muted">{tpl.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
