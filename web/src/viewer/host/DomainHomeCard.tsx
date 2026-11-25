import { Mark } from '../../components/Brand';
import { ReportButton } from '../components/ReportButton';
import { StateCard } from '../components/StateCards';
import { hostContext } from './context';

/**
 * A custom domain's `/` (milestone-6 §10.8, §13.4): "Files hosted with files.gg" and
 * Report (the domain itself, §10.12). No sign-in, upload or dashboard links.
 */
export default function DomainHomeCard() {
  const { host } = hostContext();
  return (
    <StateCard>
      <Mark className="size-14 opacity-90" />
      <h1 className="text-lg font-semibold">Files hosted with files.gg</h1>
      <p className="max-w-full font-mono text-sm break-all text-muted">{host}</p>
      <ReportButton target={{ type: 'domain', hostname: host }} variant="secondary" />
    </StateCard>
  );
}
