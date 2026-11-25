import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FilePayload } from '../../lib/api';
import type { Conversion, FormatOption, FormatsDocument } from '../../lib/conversions';
import { createQueryClient } from '../../lib/queryClient';
import { calls, jsonResponse, ME, renderDashboard, signIn, stubApi, type StubHandler } from '../../test/apiStub';
import { ownerAlbum, ownerFile } from '../../test/ownerFiles';
import { installTurnstile } from '../../test/turnstile';
import { publicRoutes } from '../routes';
import { OptionsForm } from './OptionsForm';
import { initialState, type FormState } from './options';

/** milestone-5 §13.1 and §15's Web bullet: the Convert page end to end against a stubbed API. */

const opt = (name: string, type: FormatOption['type'], fallback: FormatOption['default'], extra: Partial<FormatOption> = {}): FormatOption => ({ name, type, label: name, default: fallback, ...extra });

const FORMATS: FormatsDocument = {
  version: 1,
  kinds: {
    image: { targets: [{ target: 'png', label: 'PNG', group: 'image', anonymous: true, options: [opt('strip_metadata', 'bool', true, { label: 'Remove metadata' })] }] },
    video: {
      targets: [
        { target: 'mp4', label: 'MP4', group: 'video', anonymous: true, options: [opt('max_height', 'enum', null, { values: [1080, 720, 480], label: 'Max height' }), opt('target_size', 'size', null, { min: 1, max: 500, label: 'Target size' })] },
        { target: 'mp3', label: 'MP3', group: 'audio', anonymous: true, options: [] },
      ],
    },
    document: { targets: [{ target: 'pdf', label: 'PDF', group: 'document', anonymous: false, options: [] }] },
    images: { targets: [{ target: 'pdf', label: 'One PDF', group: 'document', anonymous: true, options: [] }] },
  },
  presets: [
    { id: 'play_everywhere', label: 'Make it play everywhere', kinds: ['video'], target: 'mp4', options: {} },
    { id: 'discord', label: 'Shrink for Discord', kinds: ['video'], target: 'mp4', options: { target_size: 'discord' } },
  ],
};

const video: FilePayload = {
  ...ownerFile({ id: '500', name: 'clip', extension: 'mov' }),
  vanity: 'vid1',
  kind: 'video',
  mimetype: 'video/quicktime',
  size: 40_000_000,
  duration: 12_000,
  media: { playable: false, has_audio: true },
};
const docx: FilePayload = { ...video, vanity: 'doc1', kind: 'file', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx', filename: 'report.docx', name: 'report' };

const output = ownerFile({ id: '700', name: 'clip', extension: 'png', size: 1_000_000, safety: { state: 'ok', reason: null, notice_id: null, nsfw_source: null, nsfw_locked: false, nsfw_review: 'none' } });

function conversion(overrides: Partial<Conversion> = {}): Conversion {
  return {
    id: 'c1',
    status: 'queued',
    position: 0,
    queue: 'anonymous',
    stage: null,
    progress: 0,
    time_limit: 120,
    took: 10,
    source: { kind: 'video', file: video, album: null, count: 1 },
    target: 'mp4',
    options: {},
    cached: false,
    output: { file: null, album: null },
    error: null,
    input_size: 40_000_000,
    output_size: null,
    cpu_seconds: 0,
    created_at: Math.floor(Date.now() / 1000) - 5,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

/** Answers in order; the last one repeats. */
const sequence = (...answers: unknown[]): StubHandler => {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
};

const base: Record<string, StubHandler> = {
  'GET /conversions/formats': () => FORMATS,
  'GET /auth/guest': () => ({ guest: '7' }),
  'GET /users/@me/limits': () => ({ storage: { used: 0, limit: null }, max_file_size_single: 1e9, max_file_size_chunked: 1e9, max_expiry: null, allow_no_expiry: false, anonymous: true }),
  'GET /files/:vanity': ({ url }) => (url.pathname.endsWith('/doc1') ? docx : video),
  'GET /users/@me/conversions': () => ({ items: [], next: null }),
  'GET /users/@me/badges': () => ({ reports_unread: 0, notices_unacknowledged: 0, restrictions: [], staff: null }),
};

beforeEach(() => installTurnstile());
afterEach(() => {
  localStorage.clear();
  delete window.turnstile;
});

describe('the options form (§10.1: a control for every type)', () => {
  it('renders int, number, bool, enum, color, pages and size, with the size estimate', () => {
    const options = [
      opt('quality', 'int', 85, { label: 'Quality', min: 1, max: 100 }),
      opt('trim_start', 'number', null, { label: 'Start at', min: 0 }),
      opt('strip_metadata', 'bool', true, { label: 'Remove metadata' }),
      opt('max_height', 'enum', null, { label: 'Max height', values: [1080, 720] }),
      opt('background', 'color', '#ffffff', { label: 'Background' }),
      opt('pages', 'pages', null, { label: 'Pages' }),
      opt('target_size', 'size', null, { label: 'Target size', min: 1, max: 500, presets: { discord: 10 } }),
    ];
    let state: FormState = initialState(options, { target_size: 'discord' });
    const { rerender } = render(<OptionsForm options={options} state={state} errors={{}} onChange={(name, value) => (state = { ...state, [name]: value })} facts={{ size: 40_000_000, duration: 600_000, hasAudio: true, pages: null }} />);
    expect(screen.getByLabelText('Quality')).toHaveValue(85);
    expect(screen.getByLabelText('Start at')).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText('Remove metadata')).toBeChecked();
    expect(within(screen.getByLabelText('Max height')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Original', '1080p', '720p']);
    expect(screen.getByLabelText('Background')).toHaveValue('#ffffff');
    expect(screen.getByLabelText('Background picker')).toHaveAttribute('type', 'color');
    expect(screen.getByLabelText('Pages')).toHaveAttribute('placeholder', 'All pages');
    expect(screen.getByLabelText('Target size')).toHaveValue('preset:discord');
    // §13.1 step 3: input size and the estimate; 10 MB is too small for a 10-minute video with sound.
    expect(screen.getByTestId('size-estimate')).toHaveTextContent('40 MB now, about 10 MB after. That may be too small for this video: try at least 18 MB.');
    fireEvent.change(screen.getByLabelText('Target size'), { target: { value: 'custom' } });
    rerender(<OptionsForm options={options} state={state} errors={{}} onChange={() => undefined} facts={{ size: null, duration: null, hasAudio: true, pages: null }} />);
    expect(screen.getByLabelText('Target size in MB')).toHaveValue(1);
  });
});

describe('Convert page: source, presets and the anonymous lock (§13.1 steps 1–2)', () => {
  it('shows the presets first for ?source=, then the formats', async () => {
    stubApi(base);
    renderDashboard('/convert?source=vid1&preset=discord');
    const goals = await screen.findByRole('group', { name: 'Common goals' });
    expect(within(goals).getAllByRole('button').map((b) => b.textContent)).toEqual(['Make it play everywhere', 'Shrink for Discord']);
    expect(within(goals).getByRole('button', { name: 'Shrink for Discord' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Target size')).toHaveValue('preset:discord');
    expect(screen.getByText('clip.mov')).toBeInTheDocument();
  });

  it('locks a document → PDF for anonymous visitors, with Sign in', async () => {
    stubApi(base);
    renderDashboard('/convert?source=doc1');
    const pdf = await screen.findByRole('button', { name: /PDF/ });
    expect(pdf).toHaveTextContent('Sign in');
    fireEvent.click(pdf);
    const prompt = screen.getByText(/This needs an account/);
    expect(within(prompt).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/login?next=${encodeURIComponent('/app/convert?source=doc1')}`);
    expect(screen.getByRole('button', { name: 'Convert to PDF' })).toBeDisabled();
    // §19.2: the anonymous agreement line under the button.
    const agreement = screen.getByText(/By uploading, you agree to the/);
    expect(within(agreement).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/legal/terms');
  });

  it('the public files.gg/convert is the same page without the history', async () => {
    signIn();
    stubApi(base);
    const router = createMemoryRouter(publicRoutes, { initialEntries: ['/convert'] });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Convert' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/app');
    expect(screen.queryByRole('heading', { name: 'History' })).not.toBeInTheDocument();
  });
});

describe('Convert page: progress, failures, cancel and the result (§8, §13.1 steps 4–5)', () => {
  it('waits in line, shows the stage and progress, then the result', async () => {
    const fetch = stubApi({
      ...base,
      'POST /conversions': () => jsonResponse(conversion({ position: 3 }), 202),
      'GET /conversions/:id': sequence(
        conversion({ status: 'running', stage: 'converting', progress: 0.4 }),
        conversion({ status: 'succeeded', progress: 1, output: { file: output, album: null }, output_size: 1_000_000 }),
      ),
    });
    renderDashboard('/convert?source=vid1');
    fireEvent.click(await screen.findByRole('button', { name: 'Make it play everywhere' }));
    fireEvent.click(screen.getByRole('button', { name: 'Convert to MP4' }));

    expect(await screen.findByText('Waiting in line: 3 ahead')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in to skip the line' })).toBeInTheDocument();
    const post = calls(fetch).find((call) => call.method === 'POST')!;
    expect(post.body).toEqual({ source: 'vid1', target: 'mp4', turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
    expect(post.headers.get('X-Filesgg-Csrf')).toBe('1');
    expect(post.headers.get('Authorization')).toBe('Guest 7');

    expect(await screen.findByText('Converting…', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Conversion progress' })).toHaveAttribute('aria-valuenow', '40');

    const result = await screen.findByRole('region', { name: 'Result' }, { timeout: 3000 });
    expect(within(result).getByRole('heading', { name: 'clip.png' })).toBeInTheDocument();
    expect(within(result).getByText(/^40 MB → 1 MB \(−9\d%\)$/)).toBeInTheDocument();
    expect(within(result).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(within(result).getByRole('link', { name: 'Download' })).toHaveAttribute('href', `${output.cdn_url}?download=true`);
    expect(within(result).getByRole('img', { name: 'clip.png' })).toBeInTheDocument();
    // Anonymous: no Add to album.
    expect(within(result).queryByRole('button', { name: /Add to album/ })).not.toBeInTheDocument();
    fireEvent.click(within(result).getByRole('button', { name: 'Convert again' }));
    expect(await screen.findByRole('button', { name: 'Convert to MP4' })).toBeInTheDocument();
  }, 10_000);

  it('a timeout says how long it ran and which tier gets more, and Try again sends it again', async () => {
    const timedOut = conversion({
      status: 'failed',
      error: { code: 'CONVERSION_TIMEOUT', message: 'The conversion took too long', metadata: { seconds: 120, ran_seconds: 120, queued_seconds: 3, tier: 'member', max_seconds: 600 } },
    });
    const fetch = stubApi({ ...base, 'POST /conversions': () => timedOut });
    renderDashboard('/convert?source=vid1&target=mp3');
    fireEvent.click(await screen.findByRole('button', { name: 'Convert to MP3' }));
    expect(
      await screen.findByText('The conversion took too long. It ran for 2 minutes after 3 seconds in line. Signed-in accounts get up to 10 minutes.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls(fetch).filter((call) => call.method === 'POST')).toHaveLength(2));
    expect(calls(fetch).filter((call) => call.method === 'POST')[1]!.body).toMatchObject({ source: 'vid1', target: 'mp3' });
  });

  it('Cancel stops a queued conversion', async () => {
    const fetch = stubApi({
      ...base,
      'POST /conversions': () => jsonResponse(conversion({ position: 1 }), 202),
      'GET /conversions/:id': () => conversion({ position: 1 }),
      'DELETE /conversions/:id': () => conversion({ status: 'cancelled' }),
    });
    renderDashboard('/convert?source=vid1&target=mp3');
    fireEvent.click(await screen.findByRole('button', { name: 'Convert to MP3' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelled.')).toBeInTheDocument();
    expect(calls(fetch).some((call) => call.method === 'DELETE' && call.path === '/conversions/c1')).toBe(true);
  });

  it('a POST error with sign_in offers "Sign in for bigger conversions"', async () => {
    stubApi({ ...base, 'POST /conversions': () => jsonResponse({ code: 'CONVERSION_TOO_LARGE', message: 'x', status: 413, limit: 50_000_000, value: 1, unit: 'bytes', sign_in: true }, 413) });
    renderDashboard('/convert?source=vid1&target=mp3');
    fireEvent.click(await screen.findByRole('button', { name: 'Convert to MP3' }));
    expect(await screen.findByText(/This file is too big to convert. The limit is 50 MB./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in for bigger conversions' })).toBeInTheDocument();
  });

  it('PDF pages make an album, and a generated password shows once (signed in)', async () => {
    signIn();
    const album = { ...ownerAlbum([]), id: 'a9', count: 8, title: 'deck' };
    stubApi({
      ...base,
      'GET /files/:vanity': () => ({ ...video, kind: 'pdf', mimetype: 'application/pdf', extension: 'pdf', filename: 'deck.pdf', media: { pages: 8 } }),
      'GET /conversions/formats': () => ({ ...FORMATS, kinds: { ...FORMATS.kinds, pdf: { targets: [{ target: 'png', label: 'PNG pages', group: 'image', anonymous: true, options: [] }] } } }),
      'POST /conversions': () => conversion({ status: 'succeeded', source: { kind: 'pdf', file: null, album: null, count: 1 }, output: { file: null, album, password: 'amber-oxide-ember-orbit' } }),
    });
    renderDashboard('/convert?source=pdf1&target=png');
    fireEvent.click(await screen.findByRole('button', { name: 'Convert to PNG pages' }));
    const result = await screen.findByRole('region', { name: 'Result' });
    expect(within(result).getByText('8 pages in a new album')).toBeInTheDocument();
    expect(within(result).getByRole('link', { name: 'Open album' })).toHaveAttribute('href', '/albums/a9');
    expect(within(result).getByText('amber-oxide-ember-orbit')).toBeInTheDocument();
  });
});

describe('history and batches (§10.5, §10.6, §13.1)', () => {
  it('lists the history live, re-runs and deletes', async () => {
    signIn();
    const done = conversion({ id: 'h1', status: 'succeeded', target: 'mp3', output: { file: output, album: null }, output_size: 2_000_000 });
    const fetch = stubApi({
      ...base,
      'GET /users/@me/conversions': () => ({ items: [done], next: null }),
      'POST /conversions': () => conversion({ id: 'c2', status: 'succeeded', output: { file: output, album: null } }),
      'DELETE /conversions/:id': () => new Response(null, { status: 204 }),
    });
    renderDashboard('/convert');
    const history = await screen.findByRole('region', { name: 'History' });
    expect(await within(history).findByText('clip.mov')).toBeInTheDocument();
    expect(within(history).getByText('40 MB → 2 MB (−95%)')).toBeInTheDocument();
    expect(within(history).getByRole('link', { name: 'Open' })).toHaveAttribute('href', output.url);
    fireEvent.click(within(history).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(calls(fetch).find((call) => call.method === 'POST')?.body).toEqual({ source: 'vid1', target: 'mp3' }));
    fireEvent.click(within(history).getByRole('button', { name: 'Delete clip.mov from history' }));
    await waitFor(() => expect(calls(fetch).some((call) => call.method === 'DELETE' && call.path === '/conversions/h1')).toBe(true));
  });

  it('shows a batch as one combined list', async () => {
    signIn();
    stubApi({
      ...base,
      'GET /conversions': ({ url }) =>
        url.searchParams.get('batch') === 'b1'
          ? {
              items: [
                conversion({ id: 'b-1', status: 'succeeded', output: { file: output, album: null }, output_size: 1_000_000 }),
                conversion({ id: 'b-2', status: 'running', stage: 'storing', progress: 0.9, source: { kind: 'video', file: { ...video, filename: 'other.mov' }, album: null, count: 1 } }),
              ],
              next: null,
            }
          : jsonResponse({ code: 'NOT_FOUND' }, 404),
    });
    renderDashboard('/convert?batch=b1');
    const batch = await screen.findByRole('region', { name: 'Batch' });
    expect(await within(batch).findByText('Converting 1 of 2 files')).toBeInTheDocument();
    expect(within(batch).getByText('Saving the result · 90%')).toBeInTheDocument();
    expect(within(batch).getByRole('link', { name: 'Open clip.png' })).toHaveAttribute('href', output.url);
  });

  it('Convert all on an album: a target for the kinds in it, or its images as one PDF', async () => {
    signIn();
    const images = [ownerFile({ id: '801', name: 'a' }), ownerFile({ id: '802', name: 'b' })];
    const fetch = stubApi({
      ...base,
      'GET /users/@me/albums/:id': () => ownerAlbum(images),
      'POST /conversions/batch': () => jsonResponse({ batch_id: 'b9', items: [conversion({ id: 'x1' })], skipped: [] }, 202),
      'GET /conversions': () => ({ items: [conversion({ id: 'x1' })], next: null }),
    });
    renderDashboard('/convert?album=900');
    expect(await screen.findByRole('button', { name: 'One PDF' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'PNG' }));
    expect(screen.getByText('2 of 2 files can be converted to PNG.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(calls(fetch).find((call) => call.path === '/conversions/batch')?.body).toEqual({ album: 'alb900', target: 'png' }));
    expect(await screen.findByRole('region', { name: 'Batch' })).toBeInTheDocument();
  });
});

describe('the new file’s access and expiry (§5.3, §5.5, §10.3, §21)', () => {
  const USER_LIMITS = { storage: { used: 0, limit: 1e10 }, max_file_size_single: 1e8, max_file_size_chunked: 1e9, max_expiry: null, allow_no_expiry: true, anonymous: false, nsfw_allowed: true };
  const DEFAULTS = { expires_in: 7 * 86400, visibility: 'password' as const, nsfw: true };
  const posted = (fetch: ReturnType<typeof stubApi>) => calls(fetch).find((call) => call.method === 'POST' && call.path === '/conversions')?.body;

  it('signed in: starts from the upload defaults, and sends nothing while untouched', async () => {
    signIn({ ...ME, settings: { ...ME.settings, upload_defaults: DEFAULTS } });
    const fetch = stubApi({ ...base, 'GET /users/@me/limits': () => USER_LIMITS, 'POST /conversions': () => conversion({ status: 'succeeded', output: { file: output, album: null, password: 'amber-oxide-ember-orbit' } }) });
    renderDashboard('/convert?source=vid1&target=mp3');
    const options = await screen.findByRole('region', { name: 'Output options' });
    await waitFor(() => expect(within(options).getByLabelText('Expires')).toHaveValue(String(7 * 86400)));
    expect(within(options).getByRole('radio', { name: /Password/ })).toBeChecked();
    expect(within(options).getByRole('button', { name: 'Type my own instead' })).toHaveAttribute('aria-pressed', 'true');
    // §10.3 takes no password timing, and outputs follow their source's adult mark
    expect(within(options).queryByLabelText('Stay unlocked for')).not.toBeInTheDocument();
    expect(within(options).queryByLabelText('Password works until')).not.toBeInTheDocument();
    expect(within(options).queryByText(/Adult content/)).not.toBeInTheDocument();
    expect(within(options).getByLabelText('View limit')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Convert to MP3' }));
    await waitFor(() => expect(posted(fetch)).toEqual({ source: 'vid1', target: 'mp3' }));
    // the generated password is on the result card, once
    expect(await within(await screen.findByRole('region', { name: 'Result' })).findByText('amber-oxide-ember-orbit')).toBeInTheDocument();
  });

  it('sends every output field once one changed: never, the access and the view limit', async () => {
    signIn({ ...ME, settings: { ...ME.settings, upload_defaults: DEFAULTS } });
    const fetch = stubApi({ ...base, 'GET /users/@me/limits': () => USER_LIMITS, 'POST /conversions': () => conversion({ status: 'succeeded', output: { file: output, album: null } }) });
    renderDashboard('/convert?source=vid1&target=mp3');
    const options = await screen.findByRole('region', { name: 'Output options' });
    await waitFor(() => expect(within(options).getByLabelText('Expires')).toHaveValue(String(7 * 86400)));
    fireEvent.change(within(options).getByLabelText('Expires'), { target: { value: 'never' } });
    fireEvent.click(within(options).getByRole('radio', { name: /Anyone with the link/ }));
    fireEvent.change(within(options).getByLabelText('View limit'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Convert to MP3' }));
    await waitFor(() => expect(posted(fetch)).toEqual({ source: 'vid1', target: 'mp3', visibility: 'link', expires_in: null, view_limit: 5, view_limit_action: 'expire' }));
  });

  it('a protected source starts as "Only me" for signed-in callers', async () => {
    signIn();
    stubApi({ ...base, 'GET /users/@me/limits': () => USER_LIMITS, 'GET /files/:vanity': () => ({ ...video, visibility: 'password' }) });
    renderDashboard('/convert?source=vid1&target=mp3');
    const options = await screen.findByRole('region', { name: 'Output options' });
    expect(within(options).getByRole('radio', { name: /Only me/ })).toBeChecked();
    expect(within(options).getByLabelText('Expires')).toHaveValue('never');
  });

  it('guests: link or password, at most 21 days, no view limit', async () => {
    const fetch = stubApi({ ...base, 'POST /conversions': () => conversion({ status: 'succeeded', output: { file: output, album: null } }) });
    renderDashboard('/convert?source=vid1&target=mp3');
    const options = await screen.findByRole('region', { name: 'Output options' });
    const expiry = within(options).getByLabelText('Expires');
    await waitFor(() => expect(expiry).toHaveValue(String(21 * 86400)));
    expect(within(expiry).getAllByRole('option').map((option) => option.textContent)).toEqual(['1 hour', '1 day', '7 days', '21 days']);
    expect(within(options).getByRole('radio', { name: /Only me/ })).toBeDisabled();
    expect(within(options).queryByLabelText('View limit')).not.toBeInTheDocument();
    fireEvent.click(within(options).getByRole('radio', { name: /Password/ }));
    fireEvent.click(within(options).getByRole('button', { name: 'Generate' }));
    fireEvent.change(expiry, { target: { value: String(86400) } });
    fireEvent.click(screen.getByRole('button', { name: 'Convert to MP3' }));
    await waitFor(() =>
      expect(posted(fetch)).toEqual({ source: 'vid1', target: 'mp3', visibility: 'password', generate_password: true, expires_in: 86400, turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }),
    );
  });

  it('a guest’s protected source starts with a generated password', async () => {
    stubApi({ ...base, 'GET /files/:vanity': () => ({ ...video, visibility: 'password' }) });
    renderDashboard('/convert?source=vid1&target=mp3');
    const options = await screen.findByRole('region', { name: 'Output options' });
    expect(within(options).getByRole('radio', { name: /Password/ })).toBeChecked();
    expect(within(options).getByRole('button', { name: 'Type my own instead' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a batch sends the changed output fields with it', async () => {
    signIn();
    const images = [ownerFile({ id: '801', name: 'a' }), { ...ownerFile({ id: '802', name: 'b' }), visibility: 'private' as const }];
    const fetch = stubApi({
      ...base,
      'GET /users/@me/limits': () => USER_LIMITS,
      'GET /users/@me/albums/:id': () => ownerAlbum(images),
      'POST /conversions/batch': () => jsonResponse({ batch_id: 'b9', items: [conversion({ id: 'x1' })], skipped: [] }, 202),
      'GET /conversions': () => ({ items: [conversion({ id: 'x1' })], next: null }),
    });
    renderDashboard('/convert?album=900');
    fireEvent.click(await screen.findByRole('button', { name: 'PNG' }));
    const options = await screen.findByRole('region', { name: 'Output options' });
    // one of the two is private: left as they are, its new file stays private
    expect(screen.getByText(/the others’ new files are only for you/)).toBeInTheDocument();
    fireEvent.change(within(options).getByLabelText('Expires'), { target: { value: String(3600) } });
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(calls(fetch).find((call) => call.path === '/conversions/batch')?.body).toEqual({ album: 'alb900', target: 'png', visibility: 'link', expires_in: 3600 }));
  });

  it('keeps a generated password from the POST answer while the conversion is polled', async () => {
    signIn();
    stubApi({
      ...base,
      'GET /users/@me/limits': () => USER_LIMITS,
      'POST /conversions': () => jsonResponse(conversion({ output: { file: null, album: null, password: 'amber-oxide-ember-orbit' } }), 202),
      'GET /conversions/:id': () => conversion({ status: 'succeeded', progress: 1, output: { file: output, album: null } }),
    });
    renderDashboard('/convert?source=vid1&target=mp3');
    fireEvent.click(await screen.findByRole('button', { name: 'Convert to MP3' }));
    const result = await screen.findByRole('region', { name: 'Result' }, { timeout: 3000 });
    expect(within(result).getByText('amber-oxide-ember-orbit')).toBeInTheDocument();
  });
});
