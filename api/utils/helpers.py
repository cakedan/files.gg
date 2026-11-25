def client_ip(request):
    """The client address resolved for this request (see utils/client_ip.py)."""
    ip = getattr(request.ctx, 'client_ip', None)
    if ip is None:
        from utils import client_ip as resolver
        ip = request.ctx.client_ip = resolver.resolve(
            request.headers, request.ip, request.app.ctx.origin_secret, request.app.ctx.proxies_count)
    return ip


def epoch_seconds(value):
    """Unix seconds of a timestamptz column (0 if unset)."""
    return int(value.timestamp()) if value is not None else 0
