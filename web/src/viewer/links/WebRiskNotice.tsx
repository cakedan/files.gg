import './links.css';

import { WEB_RISK_ADVISORY_URL, WEB_RISK_LEARN_MORE } from './webRisk';

const linkClass = 'text-gg underline-offset-2 hover:underline';

/** The learn-more links and Google's attribution, required on every Web Risk warning. */
export function WebRiskNotice({ className = '' }: { className?: string }) {
  return (
    <div className={`flex flex-col gap-1 text-xs text-muted ${className}`.trim()}>
      <p>
        Learn more:{' '}
        {WEB_RISK_LEARN_MORE.map((item, index) => (
          <span key={item.threat}>
            {index > 0 && ' · '}
            <a href={item.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {item.label}
            </a>
          </span>
        ))}
      </p>
      <p>
        <a href={WEB_RISK_ADVISORY_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
          Advisory provided by Google
        </a>
      </p>
    </div>
  );
}
