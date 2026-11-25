import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConversionHealth } from './ConversionHealth';
import { formatWait, topFailures } from './conversionHealthText';

const health = {
  queues: {
    convert_premium: { length: 0, oldest_seconds: null },
    convert_member: { length: 3, oldest_seconds: 42 },
    convert_anonymous: { length: 12, oldest_seconds: 905 },
    convert_previews: { length: 1, oldest_seconds: 7 },
  },
  jobs: {
    'jobs:convert_member:finished': 120,
    'jobs:convert_member:failed': 2,
    'jobs:convert_anonymous:finished': '40',
    'jobs:convert_anonymous:timeout': 3,
    'failures:convert_member:killed_SIGKILL': 2,
    'failures:convert_anonymous:killed_SIGKILL': 1,
    'failures:convert_anonymous:work_horse_lost': 4,
    'failures:convert_member:cancelled': 9,
    'duration_sum:convert_member': 33.5,
  },
};

describe('the admin conversion health card (milestone-5 §3.3)', () => {
  it('lists every queue with its waiting jobs, oldest wait and outcomes', () => {
    render(<ConversionHealth health={health} />);
    const section = screen.getByRole('region', { name: 'Conversions' });
    const row = (name: string) => within(section).getByRole('row', { name: new RegExp(`^${name}`) });
    expect(within(row('Signed in')).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['3', '42 s', '120', '0', '0', '2', '0']);
    expect(within(row('Guests')).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['12', '15 min', '40', '0', '3', '0', '0']);
    expect(within(row('Premium')).getAllByRole('cell')[1]).toHaveTextContent('—');
    // over 10 minutes waiting is highlighted
    expect(within(row('Guests')).getAllByRole('cell')[1]).toHaveClass('text-warn');
    expect(within(row('Signed in')).getAllByRole('cell')[1]).not.toHaveClass('text-warn');
    expect(within(section).getByRole('row', { name: /^Document previews/ })).toBeInTheDocument();
  });

  it('ranks failure reasons across queues', () => {
    expect(topFailures(health.jobs)).toEqual([['work_horse_lost', 4], ['killed_SIGKILL', 3]]);
    render(<ConversionHealth health={health} />);
    expect(screen.getByText('work_horse_lost').parentElement).toHaveTextContent('×4');
  });

  it('says so when Redis is down, and shows nothing before the API sends the field', () => {
    const { unmount } = render(<ConversionHealth health={null} />);
    expect(screen.getByText(/Redis can't be reached/)).toBeInTheDocument();
    unmount();
    const { container } = render(<ConversionHealth health={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('formats waits', () => {
    expect([formatWait(null), formatWait(5), formatWait(125), formatWait(3725)]).toEqual(['—', '5 s', '2 min', '1 h 2 min']);
  });
});
