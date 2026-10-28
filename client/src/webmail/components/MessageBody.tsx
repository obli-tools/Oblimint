import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageOff } from 'lucide-react';
import { wmApi } from '../api';
import type { BodyPart, EmailFull } from '../jmap';
import { buildSrcDoc, IFRAME_SANDBOX } from '../lib/htmlPolicy';
import { linkify } from '../lib/format';
import { sanitizeForDisplay } from '../lib/sanitize';

// Body of one message.
//  - text/plain: React text (never HTML), links as React <a> (noopener).
//  - text/html: sanitized (DOMPurify, htmlPolicy.ts) and rendered in a
//    sandboxed iframe (no script, no same origin, no form) with its own CSP.
//    Remote images stay blocked until "Show images"; cid: images are fetched
//    through the proxy and inlined as data: URLs (raster types only, ≤ 5 MB).
//  - a part longer than the proxy's cut (isTruncated) is read whole from its
//    blob (streamed by the proxy, ≤ MAX_FULL_BYTES, decoded with its charset).

const INLINE_TYPES = /^image\/(png|jpe?g|gif|webp)$/i;
const MAX_INLINE_BYTES = 5 * 1048576;
/** Largest body part read whole from its blob when its value came truncated. */
const MAX_FULL_BYTES = 10 * 1048576;

/** Whole text of a truncated part (null: not truncated, too large, or unreadable). */
async function fullPart(e: EmailFull, p: BodyPart | undefined): Promise<string | null> {
  if (!p?.partId || !p.blobId || !e.bodyValues?.[p.partId]?.isTruncated || p.size > MAX_FULL_BYTES) return null;
  const blob = await wmApi.fetchBlob(p.blobId);
  if (blob.size > MAX_FULL_BYTES) return null;
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(p.charset || 'utf-8'); } catch { decoder = new TextDecoder('utf-8'); }
  return decoder.decode(await blob.arrayBuffer());
}

function readAsDataUrl(blob: Blob, type: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^;,]*/, `data:${type.toLowerCase()}`));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function cidKey(cid: string): string {
  return cid.replace(/^<|>$/g, '').toLowerCase();
}

export function partValue(e: EmailFull, parts: BodyPart[] | undefined): string | null {
  const p = parts?.[0];
  if (!p?.partId) return null;
  return e.bodyValues?.[p.partId]?.value ?? null;
}

function PlainBody({ text }: { text: string }) {
  return (
    <div className="wm-plain px-4 py-3 text-text-primary">
      {linkify(text).map((s, i) => (s.href
        ? <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="text-accent underline">{s.text}</a>
        : <span key={i}>{s.text}</span>))}
    </div>
  );
}

export function MessageBody({ email }: { email: EmailFull }) {
  const { t } = useTranslation();
  const [full, setFull] = useState<{ html?: string; text?: string; failed?: boolean }>({});
  const isHtml = !!email.htmlBody?.[0] && /html/i.test(email.htmlBody[0].type);
  const html = useMemo(() => (isHtml ? full.html ?? partValue(email, email.htmlBody) : null), [email, isHtml, full.html]);
  const text = useMemo(() => full.text ?? partValue(email, email.textBody) ?? '', [email, full.text]);
  const shown = isHtml ? email.htmlBody?.[0] : email.textBody?.[0];
  const truncated = !!shown?.partId && !!email.bodyValues?.[shown.partId]?.isTruncated && (isHtml ? full.html === undefined : full.text === undefined)
    // Still loading the rest: no notice; failed / too large / no blob: the beginning only.
    && (!!full.failed || !shown.blobId || shown.size > MAX_FULL_BYTES);

  // Long part: the rest is read from its blob.
  useEffect(() => {
    let cancelled = false;
    setFull({});
    const part = isHtml ? email.htmlBody?.[0] : email.textBody?.[0];
    void fullPart(email, part).then((v) => {
      if (!cancelled && v !== null) setFull(isHtml ? { html: v } : { text: v });
    }, () => { if (!cancelled) setFull({ failed: true }); });
    return () => { cancelled = true; };
  }, [email, isHtml]);
  const [allowRemote, setAllowRemote] = useState(false);
  const [cidMap, setCidMap] = useState<Record<string, string>>({});

  // Inline images referenced by cid: fetched through the proxy (own account only).
  useEffect(() => {
    let cancelled = false;
    setAllowRemote(false);
    setCidMap({});
    if (!html || !/cid:/i.test(html)) return;
    const inline = (email.attachments ?? []).filter((a) => a.cid && a.blobId && INLINE_TYPES.test(a.type) && a.size <= MAX_INLINE_BYTES).slice(0, 30);
    void (async () => {
      const out: Record<string, string> = {};
      for (const a of inline) {
        try {
          const blob = await wmApi.fetchBlob(a.blobId!);
          if (blob.size <= MAX_INLINE_BYTES) out[cidKey(a.cid!)] = await readAsDataUrl(blob, a.type);
        } catch { /* missing image: left out */ }
      }
      if (!cancelled) setCidMap(out);
    })();
    return () => { cancelled = true; };
  }, [email, html]);

  const rendered = useMemo(() => {
    if (html === null) return null;
    const r = sanitizeForDisplay(html, { allowRemote, cidMap });
    return { doc: buildSrcDoc(r.html, { allowRemote }), blocked: r.blockedRemote };
  }, [html, allowRemote, cidMap]);

  const cut = truncated && (
    <p className="mx-4 mt-3 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
      {t('wm.read.truncated') || 'This message is very long: only its beginning is shown.'}
    </p>
  );
  if (!rendered) return <>{cut}<PlainBody text={text} /></>;
  return (
    <div className="flex flex-col">
      {cut}
      {rendered.blocked > 0 && !allowRemote && (
        <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
          <ImageOff size={14} className="shrink-0 text-text-muted" />
          <span className="flex-1">{t('wm.read.imagesBlocked') || 'Remote images are blocked to protect your privacy.'}</span>
          <button type="button" onClick={() => setAllowRemote(true)} className="font-medium text-accent hover:underline">
            {t('wm.read.showImages') || 'Show images'}
          </button>
        </div>
      )}
      <iframe
        title={t('wm.read.bodyTitle') || 'Message'}
        sandbox={IFRAME_SANDBOX}
        srcDoc={rendered.doc}
        referrerPolicy="no-referrer"
        className="mx-4 my-3 h-[70vh] min-h-[320px] rounded-md border border-border bg-white"
      />
    </div>
  );
}
