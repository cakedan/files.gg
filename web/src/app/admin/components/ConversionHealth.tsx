import type { ConversionHealth as Health } from '../adminApi';
import { Section } from './bits';
import { count, formatWait, topFailures } from './conversionHealthText';

/** The RQ queues (milestone-5 §3.1), in the order the worker pools drain them, with what staff call them. */
const QUEUES: ReadonlyArray<[string, string]> = [
  ['convert_premium', 'Premium'],
  ['convert_member', 'Signed in'],
  ['convert_anonymous', 'Guests'],
  ['convert_previews', 'Document previews'],
];

/** The outcomes the worker class counts per queue (§3.3), as `jobs:<queue>:<result>`. */
const RESULTS: ReadonlyArray<[string, string]> = [
  ['finished', 'Finished'],
  ['error', 'Errors'],
  ['timeout', 'Timeouts'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
];

/** A queue waiting longer than this is worth a look (anonymous jobs are cancelled at 10 minutes, §3.3). */
const SLOW_SECONDS = 10 * 60;

/**
 * The admin overview's conversion health (milestone-5 §3.3): each queue's waiting jobs and its oldest job's wait,
 * the outcomes the workers counted (since Redis last started), and the most common failure reasons, which say
 * what to do (`killed_SIGKILL`: the work horses need more memory).
 */
export function ConversionHealth({ health }: { health: Health | null | undefined }) {
  if (health === undefined) return null;
  return (
    <Section title="Conversions" id="admin-conversions">
      {health === null ? (
        <p className="text-sm text-warn">Redis can't be reached, so the conversion queues can't be read. Conversions and rate limits need it.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">Queue</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Waiting</th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">Oldest</th>
                  {RESULTS.map(([, label]) => (
                    <th key={label} scope="col" className="py-2 pr-3 text-right font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {QUEUES.map(([queue, label]) => {
                  const state = health.queues[queue] ?? { length: 0, oldest_seconds: null };
                  const slow = (state.oldest_seconds ?? 0) > SLOW_SECONDS;
                  return (
                    <tr key={queue} className="border-b border-line last:border-0">
                      <th scope="row" className="py-2 pr-3 text-left font-medium">
                        {label}
                      </th>
                      <td className="py-2 pr-3 text-right tabular-nums">{state.length}</td>
                      <td className={`py-2 pr-3 text-right tabular-nums ${slow ? 'font-semibold text-warn' : ''}`}>{formatWait(state.oldest_seconds)}</td>
                      {RESULTS.map(([result]) => {
                        const n = count(health.jobs, `jobs:${queue}:${result}`);
                        const bad = result !== 'finished' && result !== 'cancelled' && n > 0;
                        return (
                          <td key={result} className={`py-2 pr-3 text-right tabular-nums ${bad ? 'text-warn' : ''}`}>
                            {n}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <FailureReasons jobs={health.jobs} />
          <p className="text-xs text-muted">Counts since Redis last started. A queue waiting over 10 minutes is highlighted.</p>
        </>
      )}
    </Section>
  );
}

function FailureReasons({ jobs }: { jobs: Health['jobs'] }) {
  const reasons = topFailures(jobs);
  if (reasons.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted">Most common failures</h3>
      <ul className="flex flex-wrap gap-2 text-xs">
        {reasons.map(([reason, n]) => (
          <li key={reason} className="rounded-md bg-surface-2 px-2 py-1">
            <code>{reason}</code> <span className="tabular-nums text-muted">×{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
