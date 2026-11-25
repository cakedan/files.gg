"""Print the username and display name rules (contract milestone-6 §2.2, §2.3) as JSON, for the web app's
`web/src/lib/usernameRules.json`, so the register form explains a refusal before sending:

    python -m tools.username_rules > ../web/src/lib/usernameRules.json

The output is deterministic (sorted keys); tests/test_accounts.py checks it equals utils/usernames.py's RULES.
"""

import json
import sys


def main():
    from utils.usernames import RULES
    sys.stdout.write(json.dumps(RULES, indent=2, sort_keys=True) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
