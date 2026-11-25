import { Download, TriangleAlert } from 'lucide-react';

import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { apiRequestUrl, buildSharexConfig, curlSnippet, downloadSharexConfig, sharexFilename } from '../../lib/sharex';
import type { CreateKeyResult } from './CreateKeyDialog';

/** The result panel, shown once (§13.3): the key, the `.sxcu`, the curl snippet. */
export function KeyResult({ result, onClose }: { result: CreateKeyResult; onClose: () => void }) {
  const { created, args } = result;
  const requestUrl = apiRequestUrl(created.sharex);
  const config = buildSharexConfig({ keyName: created.key.name, secret: created.secret, requestUrl, args });
  const curl = curlSnippet({ secret: created.secret, requestUrl, args });
  return (
    <section aria-labelledby="new-key-title" className="flex flex-col gap-4 rounded-lg border border-gg/40 bg-surface p-4">
      <header className="flex flex-col gap-1">
        <h2 id="new-key-title" className="text-base font-semibold">
          {created.key.name} is ready
        </h2>
        <p className="flex items-center gap-1.5 text-sm text-warn">
          <TriangleAlert aria-hidden className="size-4 shrink-0" />
          This is the only time the key is shown. Keep it secret: anyone with it can upload as you.
        </p>
      </header>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium" id="new-key-label">
          Upload key
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <code aria-labelledby="new-key-label" className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs break-all">
            {created.secret}
          </code>
          <CopyButton text={created.secret} label="Copy" variant="secondary" aria-label="Copy the upload key" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => downloadSharexConfig(config, sharexFilename(created.key.name))}>
          <Download aria-hidden className="size-4" />
          Download ShareX config
        </Button>
        <span className="text-xs text-muted">Open the .sxcu file to add files.gg to ShareX.</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium" id="new-key-curl">
          curl
        </span>
        <pre aria-labelledby="new-key-curl" className="overflow-x-auto rounded-md border border-line bg-bg p-3 font-mono text-xs whitespace-pre">
          {curl}
        </pre>
        <div>
          <CopyButton text={curl} label="Copy" variant="secondary" aria-label="Copy the curl command" />
        </div>
      </div>
      <div>
        <Button onClick={onClose}>Done</Button>
      </div>
    </section>
  );
}
