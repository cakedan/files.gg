import { useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '../../components/Button';
import { ApiError, type AppealBody, type CounterNotice, type Notice } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { useAppealNotice } from '../../lib/queries';
import { fieldClass } from '../access/fieldUtils';
import { Dialog } from '../components/Dialog';

const MESSAGE_MAX = 2000;

/** 17 U.S.C. § 512(g)(3)'s statements (milestone-4 §8.2). */
const COUNTER_STATEMENTS = {
  mistake_statement:
    'I swear, under penalty of perjury, that I have a good-faith belief that the material was removed or disabled as a result of a mistake or misidentification of the material.',
  jurisdiction_consent:
    'I consent to the jurisdiction of the Federal District Court for the judicial district where my address is, or, if my address is outside the United States, any judicial district in which files.gg may be found.',
  service_consent: 'I will accept service of process from the person who sent the copyright notice, or their agent.',
} as const;

type TextField = 'name' | 'address' | 'phone' | 'email' | 'material' | 'signature';
type StatementField = keyof typeof COUNTER_STATEMENTS;
type Errors = Partial<Record<TextField | StatementField | 'message', string>>;

const TEXT_FIELDS: Array<{ name: TextField; label: string; type?: string; multiline?: boolean; hint?: string; autoComplete?: string }> = [
  { name: 'name', label: 'Full legal name', autoComplete: 'name' },
  { name: 'address', label: 'Address', multiline: true, autoComplete: 'street-address' },
  { name: 'phone', label: 'Phone number', type: 'tel', autoComplete: 'tel' },
  { name: 'email', label: 'Email', type: 'email', autoComplete: 'email' },
  { name: 'material', label: 'What was removed, and where it was', multiline: true, hint: 'For example the file name and its files.gg link.' },
];

interface AppealDialogProps {
  notice: Notice;
  onClose: () => void;
  onDone: () => void;
}

/** Appeal a notice once (§8.2). A copyright notice needs the counter-notice fields. */
export function AppealDialog({ notice, onClose, onDone }: AppealDialogProps) {
  const id = useId();
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const copyright = notice.rule === 'copyright';
  const appeal = useAppealNotice();
  const [message, setMessage] = useState('');
  const [fields, setFields] = useState<Record<TextField, string>>({ name: '', address: '', phone: '', email: '', material: notice.target.name ?? '', signature: '' });
  const [statements, setStatements] = useState<Record<StatementField, boolean>>({ mistake_statement: false, jurisdiction_consent: false, service_consent: false });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);

  const validate = (): Errors => {
    const found: Errors = {};
    if (!message.trim()) found.message = 'Explain why you think this was a mistake.';
    if (copyright) {
      for (const { name } of TEXT_FIELDS) if (!fields[name].trim()) found[name] = 'This is required for a counter-notice.';
      if (!fields.signature.trim()) found.signature = 'Type your full legal name to sign.';
      for (const name of Object.keys(COUNTER_STATEMENTS) as StatementField[]) if (!statements[name]) found[name] = 'This statement is required.';
    }
    return found;
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) {
      const first = Object.keys(found)[0];
      document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    const body: AppealBody = { message: message.trim() };
    if (copyright) {
      const counter: CounterNotice = {
        name: fields.name.trim(),
        address: fields.address.trim(),
        phone: fields.phone.trim(),
        email: fields.email.trim(),
        material: fields.material.trim(),
        mistake_statement: true,
        jurisdiction_consent: true,
        service_consent: true,
        signature: fields.signature.trim(),
      };
      body.counter_notice = counter;
    }
    appeal.mutate(
      { id: notice.id, body },
      {
        onSuccess: onDone,
        onError: (error) => {
          const fieldErrors = error instanceof ApiError ? (error.body as { errors?: Errors } | undefined)?.errors : undefined;
          if (fieldErrors) setErrors(fieldErrors);
          setFormError(errorMessage(error));
        },
      },
    );
  };

  const fieldError = (name: keyof Errors): ReactNode =>
    errors[name] ? (
      <p id={`${id}-${name}-error`} className="text-xs text-danger">
        {errors[name]}
      </p>
    ) : null;
  const describedBy = (name: keyof Errors) => (errors[name] ? `${id}-${name}-error` : undefined);

  return (
    <Dialog
      title="Appeal this notice"
      description={copyright ? 'A copyright appeal is a counter-notice. We forward it to the person who sent the copyright notice.' : 'A different member of the files.gg team reviews your appeal.'}
      onClose={onClose}
      initialFocus={messageRef}
      size={copyright ? 'lg' : 'md'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} variant="primary" disabled={appeal.isPending}>
            {appeal.isPending ? 'Sending…' : 'Send appeal'}
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-message`} className="text-sm font-medium">
            Why should we reverse this?
          </label>
          <textarea
            ref={messageRef}
            id={`${id}-message`}
            value={message}
            maxLength={MESSAGE_MAX}
            rows={4}
            onChange={(event) => setMessage(event.target.value)}
            aria-invalid={errors.message ? true : undefined}
            aria-describedby={describedBy('message')}
            className="w-full resize-y rounded-xl border border-line bg-bg px-3 py-2 text-[15px]"
          />
          {fieldError('message')}
          <p className="text-xs text-muted">You can appeal each notice once.</p>
        </div>

        {copyright && (
          <fieldset className="flex flex-col gap-3 rounded-2xl border border-line p-3">
            <legend className="px-1 text-sm font-semibold">Counter-notice</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {TEXT_FIELDS.map((field) => {
                const props = {
                  id: `${id}-${field.name}`,
                  value: fields[field.name],
                  autoComplete: field.autoComplete,
                  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields((current) => ({ ...current, [field.name]: event.target.value })),
                  'aria-invalid': errors[field.name] ? true : undefined,
                  'aria-describedby': describedBy(field.name),
                };
                return (
                  <div key={field.name} className={`flex flex-col gap-1 ${field.multiline ? 'sm:col-span-2' : ''}`}>
                    <label htmlFor={props.id} className="text-sm font-medium">
                      {field.label}
                    </label>
                    {field.multiline ? (
                      <textarea {...props} rows={2} className="w-full resize-y rounded-xl border border-line bg-bg px-3 py-2 text-[15px]" />
                    ) : (
                      <input {...props} type={field.type ?? 'text'} className={fieldClass} />
                    )}
                    {field.hint && <p className="text-xs text-muted">{field.hint}</p>}
                    {fieldError(field.name)}
                  </div>
                );
              })}
            </div>
            {(Object.keys(COUNTER_STATEMENTS) as StatementField[]).map((name) => (
              <div key={name} className="flex flex-col gap-1">
                <label className="flex items-start gap-2 text-sm">
                  <input
                    id={`${id}-${name}`}
                    type="checkbox"
                    checked={statements[name]}
                    onChange={(event) => setStatements((current) => ({ ...current, [name]: event.target.checked }))}
                    aria-invalid={errors[name] ? true : undefined}
                    aria-describedby={describedBy(name)}
                    className="mt-0.5 size-4 shrink-0 accent-gg"
                  />
                  <span>{COUNTER_STATEMENTS[name]}</span>
                </label>
                {fieldError(name)}
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-signature`} className="text-sm font-medium">
                Signature
              </label>
              <input
                id={`${id}-signature`}
                value={fields.signature}
                onChange={(event) => setFields((current) => ({ ...current, signature: event.target.value }))}
                aria-invalid={errors.signature ? true : undefined}
                aria-describedby={describedBy('signature') ?? `${id}-signature-hint`}
                className={fieldClass}
              />
              <p id={`${id}-signature-hint`} className="text-xs text-muted">
                Type your full legal name as your electronic signature.
              </p>
              {fieldError('signature')}
            </div>
          </fieldset>
        )}

        {formError && (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        )}
      </form>
    </Dialog>
  );
}
