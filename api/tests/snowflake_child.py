"""Run in a separate process by test_snowflake: lease a node id, generate ids,
print them as JSON. Usage: python -m tests.snowflake_child DATABASE_URL COUNT"""

import json
import sys

from utils.generators import Snowflake
from utils.snowflake_nodes import NodeLease


def main():
    url, count = sys.argv[1], int(sys.argv[2])
    lease = NodeLease(url)
    node_id = lease.start(install=True)
    sys.stdout.write('ready\n')
    sys.stdout.flush()
    sys.stdin.readline()  # wait until every process holds a lease
    ids = [Snowflake.generate() for _ in range(count)]
    lease.stop()
    sys.stdout.write(json.dumps({'node_id': node_id, 'ids': ids}) + '\n')


if __name__ == '__main__':
    main()
