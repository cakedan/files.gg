import { ApiError, apiErrorFromText, authHeaders, buildUrl, CLIENT_ERROR, reportApiFailure } from '../api';

export interface XhrOptions {
  method: 'POST' | 'PUT';
  path: string;
  body: XMLHttpRequestBodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
  onUploadProgress?: (sent: number, total: number) => void;
}

/**
 * fetch() can't report upload progress, so uploads use XHR. Same base, the same headers
 * (fingerprint while signed out, the CSRF header) and the same `ApiError` parsing as the
 * rest of the client; a same-origin XHR sends the session cookie by itself. Aborts reject with an
 * `AbortError` DOMException, like fetch.
 */
export function sendXhr<T>({ method, path, body, headers = {}, signal, onUploadProgress }: XhrOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(method, buildUrl(path));
    xhr.setRequestHeader('Accept', 'application/json');
    for (const [name, value] of Object.entries({ ...authHeaders(method), ...headers })) xhr.setRequestHeader(name, value);

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    if (onUploadProgress) {
      xhr.upload.onprogress = (event) => onUploadProgress(event.loaded, event.lengthComputable ? event.total : 0);
    }
    xhr.onload = () => {
      cleanup();
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!text) return resolve(undefined as T);
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          reject(new ApiError(xhr.status, CLIENT_ERROR.invalidResponse, 'The server sent an invalid response.', text));
        }
        return;
      }
      const error = apiErrorFromText(xhr.status, xhr.statusText, text);
      reportApiFailure(error, path);
      reject(error);
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError(0, CLIENT_ERROR.network, "Couldn't reach files.gg. Check your connection and try again."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    xhr.send(body);
  });
}
