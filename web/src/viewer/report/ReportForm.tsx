import './report.css';

import { CheckCircle2, Loader2, RefreshCw, Send } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Button, LinkButton } from '../../components/Button';
import { ApiError } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { ALBUM_PARTS } from '../../lib/reportTypes';
import { ChallengeFallback } from '../host/ChallengeFallback';
import { hostContext } from '../host/context';
import type { FallbackTarget } from '../host/fallback';
import { useHumanCheck } from '../host/useHumanCheck';
import type { ReportPageTarget } from '../types';
import {
  albumTarget,
  buildReport,
  DETAILS_MAX,
  emptyDmca,
  EMAIL_MAX,
  linkKinds,
  linkPhrase,
  needsDetails,
  PART_LABELS,
  REASON_LABELS,
  reasonsFor,
  serverFieldErrors,
  validateReport,
  type DmcaFields,
  type FieldErrors,
  type ReportFormState,
} from './formLogic';
import { checkSignedIn, submitReport, type ReportResult } from './send';

const inputClass =
  'w-full rounded-md border border-line bg-bg px-3 text-sm text-text placeholder:text-muted/70 aria-invalid:border-danger';

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-xs text-danger">
      {message}
    </p>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: ReactNode; hint?: ReactNode; error?: string | undefined; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

const optional = <span className="font-normal text-muted"> (optional)</span>;

/** The ids an input should be described by: its hint and its error, when present. */
const describedBy = (id: string, hint: boolean, error: string | undefined) =>
  [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;

export interface ReportFormProps {
  target: ReportPageTarget;
  /** `any` page: a link to start with (`?url=`). */
  initialUrl?: string | undefined;
  /** Dialog only: Cancel and Close. */
  onClose?: (() => void) | undefined;
  /** The heading's id, for the dialog's `aria-labelledby`. */
  titleId?: string | undefined;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Where the shown links point: files.gg, or this custom domain (milestone-6 §13.4). */
const siteOrigin = () => {
  const context = hostContext();
  return context.custom ? context.origin : 'https://files.gg';
};

/** Prefills the DMCA notice's links. */
function targetUrl(target: ReportPageTarget, initialUrl: string) {
  if (target.type === 'file') return `${siteOrigin()}/${target.vanity}`;
  if (target.type === 'album') return `${siteOrigin()}/a/${target.vanity}`;
  if (target.type === 'domain') return '';
  return initialUrl;
}

function heading(target: ReportPageTarget) {
  if (target.type === 'file') return 'Report this file';
  if (target.type === 'album') return 'Report this album';
  if (target.type === 'domain') return 'Report this domain';
  return 'Report a file, an album or a problem';
}

/** "Open on files.gg to continue": the same report on files.gg. */
const fallbackFor = (target: ReportPageTarget): FallbackTarget =>
  target.type === 'file' || target.type === 'album' ? { type: target.type, vanity: target.vanity, report: true } : { type: 'any' };

function Sent({ result, onClose, titleId }: { result: ReportResult; onClose?: (() => void) | undefined; titleId: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  if (result.escalated) {
    // §7.3: for escalated (`csam`) reports, this and nothing else.
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center" role="status">
        <h2 id={titleId} ref={ref} tabIndex={-1} className="text-base font-semibold outline-none">
          Thank you. This has been escalated.
        </h2>
        {onClose && <Button onClick={onClose}>Close</Button>}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center" role="status">
      <CheckCircle2 aria-hidden className="size-10 text-gg" />
      <h2 id={titleId} ref={ref} tabIndex={-1} className="text-lg font-semibold outline-none">
        Report sent
      </h2>
      {result.duplicate && <p className="text-sm text-muted">You'd already reported this, so your details were added to that report.</p>}
      <div className="flex flex-wrap justify-center gap-2">
        {/* A custom domain shows no sign-in or dashboard links (milestone-6 §13.4). */}
        {hostContext().custom ? null : result.signedIn ? (
          <LinkButton href="/app/reports" variant="primary">
            See it in My reports
          </LinkButton>
        ) : (
          <LinkButton href="/app" variant="primary">
            Sign in to hear back
          </LinkButton>
        )}
        {onClose && <Button onClick={onClose}>Close</Button>}
      </div>
    </div>
  );
}

/**
 * The report form (milestone-4 §7.3, §11.1), used by the dialog and the full report
 * page: a reason (and an album part), details, a contact email when signed out, the
 * DMCA notice for copyright, and managed Turnstile when signed out.
 *
 * Signed in or not comes from `GET /api/auth/session` when the form opens (milestone-6
 * §13.1). Until it answers, the form shows its signed-out fields (most visitors) and
 * holds Turnstile back; sending waits for the answer. A custom domain is always signed
 * out and asks nothing; its Turnstile is the files.gg challenge frame (§10.10).
 */
export function ReportForm({ target, initialUrl = '', onClose, titleId: givenTitleId }: ReportFormProps) {
  const id = useId();
  const titleId = givenTitleId ?? `${id}-title`;
  const custom = hostContext().custom;
  /** null until the session call answers. */
  const [signedIn, setSignedIn] = useState<boolean | null>(custom ? false : null);
  const sessionRef = useRef<Promise<boolean> | null>(null);
  const [state, setState] = useState<ReportFormState>(() => ({
    url: initialUrl,
    reason: '',
    part: 'whole',
    details: '',
    contactEmail: '',
    dmca: emptyDmca(targetUrl(target, initialUrl)),
  }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<{ message: string; retryCheck: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [focusErrors, setFocusErrors] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const {
    mount: turnstileMount,
    status: turnstileStatus,
    take: takeTurnstile,
    retry: retryTurnstile,
    framed,
  } = useHumanCheck('report', signedIn === false);
  // What the fields show while the session call is out: signed out.
  const anonymous = signedIn !== true;

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (custom) return;
    const controller = new AbortController();
    const check = checkSignedIn(controller.signal);
    sessionRef.current = check;
    void check.then((value) => {
      if (!controller.signal.aborted) setSignedIn(value);
    });
    return () => controller.abort();
  }, [custom]);

  // After a failed check, move focus to the first field with an error.
  useEffect(() => {
    if (!focusErrors) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusErrors]);

  if (result) return <Sent result={result} onClose={onClose} titleId={titleId} />;

  const set = <K extends keyof ReportFormState>(key: K, value: ReportFormState[K]) => setState((s) => ({ ...s, [key]: value }));
  const setDmca = <K extends keyof DmcaFields>(key: K, value: DmcaFields[K]) => setState((s) => ({ ...s, dmca: { ...s.dmca, [key]: value } }));
  const reasons = reasonsFor(target);
  const album = albumTarget(target, state.url);
  const detailsRequired = needsDetails(state.reason);
  const showDmca = state.reason === 'copyright';
  const err = (key: keyof FieldErrors) => errors[key];

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    let withAccount = signedIn;
    if (withAccount === null) {
      // The session call is still out: wait for it rather than guess.
      setBusy(true);
      withAccount = await (sessionRef.current ?? Promise.resolve(false));
      setBusy(false);
    }
    const found = validateReport(target, state, withAccount);
    setErrors(found);
    setSubmitError(null);
    if (Object.keys(found).length > 0) {
      setFocusErrors((n) => n + 1);
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const token = withAccount ? undefined : await takeTurnstile();
      const sent = await submitReport(buildReport(target, state, withAccount), {
        signedIn: withAccount,
        turnstileToken: token,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setResult(sent);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError) {
        const fields = serverFieldErrors(failure.body, failure.code);
        if (Object.keys(fields).length > 0) {
          setErrors(fields);
          setFocusErrors((n) => n + 1);
        }
        const message =
          failure.code === 'DMCA_FIELDS_REQUIRED' ? 'Fill in every part of the copyright notice.' : errorMessage(failure);
        setSubmitError({ message, retryCheck: failure.code === 'CAPTCHA_INVALID' });
      } else {
        // Turnstile failed to load or to issue a token.
        setSubmitError({ message: "We couldn't confirm you're a person. Retry the check.", retryCheck: true });
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const detailsId = `${id}-details`;
  const urlId = `${id}-url`;
  const emailId = `${id}-email`;

  return (
    <form ref={formRef} className="flex flex-col gap-4" onSubmit={onSubmit} noValidate aria-labelledby={titleId}>
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-lg font-semibold">
          {heading(target)}
        </h2>
        {(target.type === 'file' || target.type === 'album') && (
          <p className="truncate font-mono text-xs text-muted" title={target.vanity}>
            {custom ? hostContext().host : 'files.gg'}/{target.type === 'album' ? 'a/' : ''}
            {target.vanity}
          </p>
        )}
        {target.type === 'domain' && (
          <p className="truncate font-mono text-xs text-muted" title={target.hostname}>
            {target.hostname}
          </p>
        )}
        <p className="text-sm text-muted">We review every report. Child-safety reports are prioritised.</p>
      </div>

      {target.type === 'any' && (
        <Field
          id={urlId}
          label={<>Link{state.reason === 'bug' && optional}</>}
          hint={`${capitalise(linkPhrase())}. To report a problem with files.gg itself, choose that reason and leave this empty.`}
          error={err('url')}
        >
          <input
            id={urlId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${siteOrigin()}/…`}
            value={state.url}
            onChange={(event) => set('url', event.target.value)}
            aria-invalid={Boolean(err('url'))}
            aria-describedby={describedBy(urlId, true, err('url'))}
            className={`${inputClass} h-10`}
          />
        </Field>
      )}

      {album !== null && state.reason !== 'bug' && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">What should we look at?</legend>
          <div className="grid grid-cols-2 gap-1.5 max-sm:grid-cols-1">
            {ALBUM_PARTS.map((part) => (
              <label key={part} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm has-checked:border-gg">
                <input type="radio" name={`${id}-part`} value={part} checked={state.part === part} onChange={() => set('part', part)} className="accent-gg" />
                {PART_LABELS[part]}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">To report one file in the album, open it and use its Report button.</p>
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-1.5" aria-describedby={err('reason') ? `${id}-reason-error` : undefined}>
        <legend className="mb-1.5 text-sm font-medium">Reason</legend>
        <div className="flex flex-col gap-1">
          {reasons.map((reason) => (
            <label key={reason} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2 has-checked:bg-surface-2">
              <input
                type="radio"
                name={`${id}-reason`}
                value={reason}
                checked={state.reason === reason}
                onChange={() => set('reason', reason)}
                aria-invalid={Boolean(err('reason'))}
                className="accent-gg"
              />
              {REASON_LABELS[reason]}
            </label>
          ))}
        </div>
        <FieldError id={`${id}-reason-error`} message={err('reason')} />
        {state.reason === 'csam' && (
          <p className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">If a child is in immediate danger, contact your local emergency services.</p>
        )}
      </fieldset>

      <Field
        id={detailsId}
        label={<>Details{!detailsRequired && optional}</>}
        hint={`${state.details.length.toLocaleString('en')} / ${DETAILS_MAX.toLocaleString('en')}`}
        error={err('details')}
      >
        <textarea
          id={detailsId}
          rows={4}
          maxLength={DETAILS_MAX}
          value={state.details}
          onChange={(event) => set('details', event.target.value)}
          aria-invalid={Boolean(err('details'))}
          aria-required={detailsRequired}
          aria-describedby={describedBy(detailsId, true, err('details'))}
          className={`${inputClass} resize-y py-2`}
        />
      </Field>

      {showDmca && <DmcaFieldset id={id} dmca={state.dmca} errors={errors} onChange={setDmca} custom={custom} />}

      {anonymous && (
        <Field id={emailId} label={<>Your email{optional}</>} hint="Only used to tell you once the report is closed." error={err('contact_email')}>
          <input
            id={emailId}
            type="email"
            autoComplete="email"
            maxLength={EMAIL_MAX}
            value={state.contactEmail}
            onChange={(event) => set('contactEmail', event.target.value)}
            aria-invalid={Boolean(err('contact_email'))}
            aria-describedby={describedBy(emailId, true, err('contact_email'))}
            className={`${inputClass} h-10`}
          />
        </Field>
      )}

      {/* Managed Turnstile: invisible unless Cloudflare needs a click. On a custom domain, the files.gg frame. */}
      {anonymous && <div ref={turnstileMount} className="flex justify-center empty:hidden" data-testid="turnstile" />}

      {submitError && (
        <p role="alert" className="text-sm text-danger">
          {submitError.message}
        </p>
      )}
      {anonymous && !submitError && turnstileStatus === 'error' && (
        <p role="alert" className="text-sm text-danger">
          The check didn't load. Retry it to send the report.
        </p>
      )}
      {anonymous && framed && turnstileStatus === 'error' && <ChallengeFallback target={fallbackFor(target)} />}
      {anonymous && (submitError?.retryCheck || turnstileStatus === 'error') && (
        <Button
          onClick={() => {
            setSubmitError(null);
            retryTurnstile();
          }}
        >
          <RefreshCw aria-hidden className="size-4" />
          Retry the check
        </Button>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {anonymous && <p className="mr-auto text-xs text-muted">Protected by Cloudflare Turnstile.</p>}
        {onClose && (
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <Send aria-hidden className="size-4" />}
          {busy ? 'Sending…' : 'Send report'}
        </Button>
      </div>
    </form>
  );
}

function DmcaFieldset({
  id,
  dmca,
  errors,
  onChange,
  custom,
}: {
  id: string;
  dmca: DmcaFields;
  errors: FieldErrors;
  onChange: <K extends keyof DmcaFields>(key: K, value: DmcaFields[K]) => void;
  custom: boolean;
}) {
  const text = (key: 'name' | 'address' | 'phone' | 'email' | 'signature', label: string, props: { type?: string; autoComplete?: string; hint?: string } = {}) => {
    const fieldId = `${id}-dmca-${key}`;
    const error = errors[`dmca.${key}`];
    return (
      <Field id={fieldId} label={label} hint={props.hint} error={error}>
        <input
          id={fieldId}
          type={props.type ?? 'text'}
          autoComplete={props.autoComplete}
          value={dmca[key]}
          onChange={(event) => onChange(key, event.target.value)}
          aria-invalid={Boolean(error)}
          aria-required
          aria-describedby={describedBy(fieldId, Boolean(props.hint), error)}
          className={`${inputClass} h-10`}
        />
      </Field>
    );
  };
  const area = (key: 'work' | 'urls' | 'address', label: string, hint: string | undefined, rows: number) => {
    const fieldId = `${id}-dmca-${key}`;
    const error = errors[`dmca.${key}`];
    return (
      <Field id={fieldId} label={label} hint={hint} error={error}>
        <textarea
          id={fieldId}
          rows={rows}
          maxLength={key === 'work' ? DETAILS_MAX : undefined}
          spellCheck={key !== 'urls'}
          value={dmca[key]}
          onChange={(event) => onChange(key, event.target.value)}
          aria-invalid={Boolean(error)}
          aria-required
          aria-describedby={describedBy(fieldId, Boolean(hint), error)}
          className={`${inputClass} resize-y py-2 ${key === 'urls' ? 'font-mono text-xs' : ''}`}
        />
      </Field>
    );
  };
  const check = (key: 'good_faith' | 'accurate_and_authorised', label: string) => {
    const fieldId = `${id}-dmca-${key}`;
    const error = errors[`dmca.${key}`];
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={fieldId} className="flex items-start gap-2.5 text-sm">
          <input
            id={fieldId}
            type="checkbox"
            checked={dmca[key]}
            onChange={(event) => onChange(key, event.target.checked)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${fieldId}-error` : undefined}
            className="mt-0.5 size-4 shrink-0 accent-gg"
          />
          <span>{label}</span>
        </label>
        <FieldError id={`${fieldId}-error`} message={error} />
      </div>
    );
  };
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
      <legend className="px-1 text-sm font-medium">Copyright notice</legend>
      <p className="text-xs text-muted">
        A notice under 17 U.S.C. § 512(c)(3). Everything here is required.
      </p>
      {text('name', 'Your full name', { autoComplete: 'name' })}
      {area('address', 'Your address', undefined, 2)}
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        {text('phone', 'Phone', { type: 'tel', autoComplete: 'tel' })}
        {text('email', 'Email', { type: 'email', autoComplete: 'email' })}
      </div>
      {area('work', 'The copyrighted work', 'Describe the work you own, or link to it.', 3)}
      {custom
        ? area('urls', 'Links', `Links to the infringing material on ${linkKinds()}, one per line (up to 50).`, 3)
        : area('urls', 'Links on files.gg', 'The files.gg links of the infringing material, one per line (up to 50).', 3)}
      {check(
        'good_faith',
        'I have a good faith belief that use of the material in the manner complained of is not authorised by the copyright owner, its agent or the law.',
      )}
      {check(
        'accurate_and_authorised',
        'The information in this notice is accurate, and under penalty of perjury, I am the copyright owner or am authorised to act on its behalf.',
      )}
      {text('signature', 'Signature', { autoComplete: 'name', hint: 'Type your full legal name as your electronic signature.' })}
    </fieldset>
  );
}
