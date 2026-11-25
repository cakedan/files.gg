import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type UploadedFile, type UploadStatus } from '../api';
import { fileKey, findResumable, rememberUpload } from './resumeStore';
import { CHUNKED_THRESHOLD, UploadTask, type UploadSnapshot } from './uploadTask';

const MB = 1024 * 1024;
const result = { id: '1', url: 'https://files.gg/x.bin', cdn_url: 'https://cdn.files.gg/files/x.bin' } as UploadedFile;

function bigFile(size = 25 * MB, name = 'big.bin') {
  // A small backing buffer is enough: only `size` and `slice` matter here.
  const file = new File(['x'], name, { lastModified: 42 });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
  const statuses: UploadStatus[] = [];
  return {
    statuses,
    createUpload: vi.fn(async () => ({ upload_id: 'u1', chunk_size: 10 * MB, chunk_count: 3, expires_at: Date.now() / 1000 + 86400 })),
    uploadStatus: vi.fn(async (): Promise<UploadStatus> => statuses.shift() ?? { status: 'complete', received: [0, 1, 2], size: 25 * MB, file: result }),
    completeUpload: vi.fn(async () => ({ status: 'processing' as const })),
    abortUpload: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(() => localStorage.clear());

describe('UploadTask', () => {
  it('uploads small files in one POST /files with the picker fields and Turnstile token', async () => {
    const send = vi.fn(async () => result);
    const snapshots: UploadSnapshot[] = [];
    const task = new UploadTask(
      new File(['hello'], 'a.txt'),
      { expires_in: 3600, visibility: 'password', generate_password: true },
      { send: send as never, getTurnstileToken: async () => 'XXXX.DUMMY.TOKEN.XXXX' },
      (s) => snapshots.push(s),
    );
    expect(task.chunked).toBe(false);
    await task.start();
    const call = (send.mock.calls[0] as unknown as [{ path: string; body: FormData }])[0];
    expect(call.path).toBe('/files');
    expect(call.body.get('expires_in')).toBe('3600');
    expect(call.body.get('visibility')).toBe('password');
    expect(call.body.get('generate_password')).toBe('true');
    expect(call.body.get('turnstile_token')).toBe('XXXX.DUMMY.TOKEN.XXXX');
    expect((call.body.get('file') as File).name).toBe('a.txt');
    expect(snapshots.at(-1)).toMatchObject({ phase: 'done', result });
  });

  it('chunks files above 10 MiB: create, PUT every chunk, complete, poll, and forget the session', async () => {
    const api = fakeApi();
    api.statuses.push({ status: 'processing', received: [0, 1, 2], size: 25 * MB });
    const sent: string[] = [];
    const send = vi.fn(async ({ path }: { path: string }) => void sent.push(path));
    const task = new UploadTask(bigFile(), { expires_in: 60 }, { api, send: send as never, sleep: async () => undefined }, () => undefined);
    expect(task.chunked).toBe(true);
    await task.start();
    expect(api.createUpload).toHaveBeenCalledWith(expect.objectContaining({ filename: 'big.bin', size: 25 * MB, expires_in: 60 }));
    expect(sent.sort()).toEqual(['/uploads/u1/chunks/0', '/uploads/u1/chunks/1', '/uploads/u1/chunks/2']);
    expect(api.completeUpload).toHaveBeenCalledWith('u1');
    expect(api.uploadStatus).toHaveBeenCalledTimes(2);
    expect(task.state).toMatchObject({ phase: 'done', result });
    expect(findResumable(bigFile())).toBeNull();
  });

  it('remembers the session by name + size + lastModified while uploading', async () => {
    const api = fakeApi();
    let release: () => void = () => undefined;
    const send = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const task = new UploadTask(bigFile(), {}, { api, send: send as never, parallel: 1 }, () => undefined);
    void task.start();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(findResumable(bigFile())?.session.upload_id).toBe('u1');
    task.cancel();
    release();
    expect(api.abortUpload).toHaveBeenCalledWith('u1');
    expect(findResumable(bigFile())).toBeNull();
  });

  it('resumes a remembered session after a reload, sending only missing chunks', async () => {
    rememberUpload(bigFile(), { upload_id: 'old', chunk_size: 10 * MB, chunk_count: 3, expires_at: Date.now() / 1000 + 3600 });
    const api = fakeApi();
    api.statuses.push({ status: 'open', received: [0, 2], size: 25 * MB });
    const sent: string[] = [];
    const send = vi.fn(async ({ path }: { path: string }) => void sent.push(path));
    const task = new UploadTask(bigFile(), {}, { api, send: send as never, sleep: async () => undefined }, () => undefined);
    await task.start();
    expect(api.createUpload).not.toHaveBeenCalled();
    expect(sent).toEqual(['/uploads/old/chunks/1']);
    expect(task.state.resumed).toBe(true);
    expect(task.state.phase).toBe('done');
  });

  it('starts a new session when the remembered one is gone (404)', async () => {
    rememberUpload(bigFile(), { upload_id: 'gone', chunk_size: 10 * MB, chunk_count: 3, expires_at: Date.now() / 1000 + 3600 });
    const api = fakeApi();
    api.uploadStatus.mockRejectedValueOnce(new ApiError(404, 'UNKNOWN_UPLOAD', 'gone'));
    const task = new UploadTask(bigFile(), {}, { api, send: (async () => undefined) as never, sleep: async () => undefined }, () => undefined);
    await task.start();
    expect(api.createUpload).toHaveBeenCalled();
    expect(task.state.phase).toBe('done');
  });

  it('pause → paused, resume → asks the server what it has and finishes', async () => {
    const api = fakeApi();
    const pending: Array<() => void> = [];
    let block = true;
    const send = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          if (!block) return resolve();
          pending.push(resolve);
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const task = new UploadTask(bigFile(), {}, { api, send: send as never, sleep: async () => undefined }, () => undefined);
    const running = task.start();
    await vi.waitFor(() => expect(task.state.phase).toBe('uploading'));
    task.pause();
    await running;
    expect(task.state.phase).toBe('paused');

    block = false;
    api.statuses.push({ status: 'open', received: [0], size: 25 * MB });
    await task.resume();
    expect(task.state.phase).toBe('done');
    expect(api.createUpload).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed session as an error with its code', async () => {
    const api = fakeApi();
    api.statuses.push({ status: 'failed', received: [], size: 25 * MB, error: 'STORAGE_LIMIT_REACHED' });
    const task = new UploadTask(bigFile(), {}, { api, send: (async () => undefined) as never, sleep: async () => undefined }, () => undefined);
    await task.start();
    expect(task.state).toMatchObject({ phase: 'error', error: { code: 'STORAGE_LIMIT_REACHED' } });
  });

  it('keys resume entries by name, size and lastModified', () => {
    expect(fileKey({ name: 'a', size: 1, lastModified: 2 })).not.toBe(fileKey({ name: 'a', size: 1, lastModified: 3 }));
    expect(CHUNKED_THRESHOLD).toBe(10 * MB);
  });
});
