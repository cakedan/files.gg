import { FileText, LogIn } from 'lucide-react';
import { useEffect, useState } from 'react';

import { LinkButton } from '../../components/Button';
import { convertPath } from '../../lib/convertKinds';
import { fileReportTarget } from '../components/reportPath';
import { hostContext, mainUrl } from '../host/context';
import { checkSignedIn } from '../report/send';
import type { FileData } from '../types';

/**
 * A document without a preview (milestone-5 §9.2, §13.2): "Convert to PDF" for a signed-in
 * visitor, "Sign in to preview and convert" otherwise. Its own chunk, loaded only for such
 * documents; the session is asked here, never on page load. A custom domain can't know (the
 * session is files.gg's), so it offers the conversion on files.gg in a new tab.
 */
export default function DocumentConvert({ file }: { file: FileData }) {
  const custom = hostContext().custom;
  const [state, setState] = useState<'checking' | 'in' | 'out'>(custom ? 'in' : 'checking');
  useEffect(() => {
    if (custom) return;
    const controller = new AbortController();
    void checkSignedIn(controller.signal).then((value) => {
      if (!controller.signal.aborted) setState(value ? 'in' : 'out');
    });
    return () => controller.abort();
  }, [custom]);

  const target = fileReportTarget(file);
  if (target?.type !== 'file' || file.view_limit || state === 'checking') return null;
  const convert = convertPath(target.vanity, { target: 'pdf' });
  if (state === 'out') {
    return (
      <LinkButton href={`/app/login?next=${encodeURIComponent(`/app${convert}`)}`}>
        <LogIn aria-hidden className="size-4" />
        Sign in to preview and convert
      </LinkButton>
    );
  }
  return (
    <LinkButton href={mainUrl(convert)} {...(custom ? { target: '_blank', rel: 'noopener' } : {})}>
      <FileText aria-hidden className="size-4" />
      Convert to PDF
    </LinkButton>
  );
}
