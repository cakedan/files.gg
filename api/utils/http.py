import httpx

_client = None
_stack = []  # see db._stack


def open_client(timeout=15.0):
    """One outbound httpx.AsyncClient per Sanic worker (Postmark, reCAPTCHA)."""
    global _client
    if _client is not None:
        _stack.append(_client)
    _client = httpx.AsyncClient(timeout=timeout)
    return _client


async def close_client(client=None):
    global _client
    client = client or _client
    if client is None:
        return
    if client is _client:
        _client = _stack.pop() if _stack else None
    elif client in _stack:
        _stack.remove(client)
    await client.aclose()


def get_client():
    if _client is None:
        raise RuntimeError('The outbound HTTP client is not open in this process')
    return _client
