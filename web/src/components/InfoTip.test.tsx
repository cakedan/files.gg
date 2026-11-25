import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { InfoTip } from './InfoTip';

describe('InfoTip', () => {
  it('shows its text on focus, hover and tap, and hides it on Escape, blur and a tap elsewhere', () => {
    render(
      <div>
        <InfoTip label="About limits">Chunks explain it.</InfoTip>
        <button type="button">Elsewhere</button>
      </div>,
    );
    const button = screen.getByRole('button', { name: 'About limits' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.focus(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Chunks explain it.');
    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.mouseEnter(button.parentElement!);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(button.parentElement!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
