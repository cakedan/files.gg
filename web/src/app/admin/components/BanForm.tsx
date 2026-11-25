import { useId, useState } from 'react';

import { Button } from '../../../components/Button';
import { fieldClass } from '../../access/fieldUtils';
import { useToast } from '../../components/toastContext';
import { RULE_TEXT } from '../../safety/labels';
import type { BanBody } from '../adminApi';
import { useCreateBan } from '../adminQueries';
import { adminError } from '../format';
import { canBanPermanently, MAX_MODERATOR_BAN } from '../permissions';
import { useStaff } from '../staffContext';
import { Section } from './bits';

const DAY = 86400;

/**
 * Ban the uploader's device or network (§9.3). Staff never see raw IPs or hashes, so the
 * ban names its source. Moderators can ban for up to 30 days; permanent bans are admin only.
 */
export function BanForm({ from, anonymous }: { from: BanBody['from']; anonymous: boolean }) {
  const id = useId();
  const staff = useStaff();
  const notify = useToast();
  const ban = useCreateBan();
  const [kind, setKind] = useState<BanBody['kind']>(anonymous ? 'fingerprint' : 'ip');
  const [duration, setDuration] = useState(7 * DAY);
  const [rule, setRule] = useState('');
  const [error, setError] = useState<string | null>(null);
  const durations = [
    { value: DAY, label: '1 day' },
    { value: 7 * DAY, label: '7 days' },
    { value: MAX_MODERATOR_BAN, label: '30 days' },
    ...(canBanPermanently(staff) ? [{ value: 0, label: 'Until lifted' }] : []),
  ];

  return (
    <Section title="Ban">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!rule) {
            setError('Pick the rule this breaks.');
            return;
          }
          ban.mutate(
            { kind, from, rule, ...(duration > 0 ? { duration } : {}) },
            {
              onSuccess: () => {
                setError(null);
                notify('Ban added.');
              },
              onError: (failure) => setError(adminError(failure)),
            },
          );
        }}
      >
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="mb-1 text-sm font-medium">What to ban</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${id}-kind`} checked={kind === 'fingerprint'} onChange={() => setKind('fingerprint')} className="accent-gg" disabled={!anonymous} />
            The device (fingerprint)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`${id}-kind`} checked={kind === 'ip'} onChange={() => setKind('ip')} className="accent-gg" />
            The network (IP)
          </label>
        </fieldset>
        {!anonymous && <p className="text-xs text-muted">Signed-in uploads have no fingerprint. To stop an account, restrict or suspend it.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-duration`} className="text-sm font-medium">
              For
            </label>
            <select id={`${id}-duration`} value={duration} onChange={(event) => setDuration(Number(event.target.value))} className={fieldClass}>
              {durations.map((each) => (
                <option key={each.value} value={each.value}>
                  {each.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-rule`} className="text-sm font-medium">
              Rule
            </label>
            <select id={`${id}-rule`} value={rule} onChange={(event) => setRule(event.target.value)} className={fieldClass}>
              <option value="">Pick a rule</option>
              {Object.keys(RULE_TEXT)
                .filter((code) => code !== 'csam' || staff.child_safety)
                .map((code) => (
                  <option key={code} value={code}>
                    {RULE_TEXT[code]}
                  </option>
                ))}
            </select>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" variant="danger" disabled={ban.isPending}>
            {ban.isPending ? 'Banning…' : 'Ban'}
          </Button>
        </div>
      </form>
    </Section>
  );
}
