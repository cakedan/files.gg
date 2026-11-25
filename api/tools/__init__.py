"""Development-only command-line tools. Each refuses to run unless FILESGG_DEV_TOOLS=1."""

import os
import sys

DEV_TOOLS_ENV = 'FILESGG_DEV_TOOLS'


def require_dev_tools(name):
    """Exit unless FILESGG_DEV_TOOLS=1, so a dev tool can't run against production by accident."""
    if os.environ.get(DEV_TOOLS_ENV) != '1':
        sys.stderr.write(
            '{}: refusing to run: this is a development-only tool. Set {}=1 to use it '
            '(never in production).\n'.format(name, DEV_TOOLS_ENV))
        raise SystemExit(2)
