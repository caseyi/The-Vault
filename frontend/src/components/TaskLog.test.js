import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import TaskLog from './TaskLog';

const mk = (n, start = 0) => Array.from({ length: n }, (_, i) => ({ level: 'scan', msg: `line ${start + i}`, ts: '2026-09-27T10:00:00Z' }));

describe('TaskLog', () => {
  test('scrolls only its own container to the bottom (no scrollIntoView)', () => {
    const spy = jest.fn();
    Element.prototype.scrollIntoView = spy;
    const { rerender } = render(<TaskLog lines={mk(3)} />);
    const body = screen.getByTestId('tasklog-body');
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 240 });
    rerender(<TaskLog lines={mk(4)} />);
    expect(body.scrollTop).toBe(900);
    expect(spy).not.toHaveBeenCalled();
    delete Element.prototype.scrollIntoView;
  });

  test('does not yank the view back down when the user has scrolled up', () => {
    const { rerender } = render(<TaskLog lines={mk(3)} />);
    const body = screen.getByTestId('tasklog-body');
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 900 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 240 });
    body.scrollTop = 100;
    body.dispatchEvent(new Event('scroll'));
    rerender(<TaskLog lines={mk(5)} />);
    expect(body.scrollTop).toBe(100);
  });

  test('renders only the last 500 lines with a hidden-lines note', () => {
    render(<TaskLog lines={mk(1200)} />);
    expect(screen.getByText('700 earlier lines hidden')).toBeInTheDocument();
    expect(screen.queryByText('line 699')).not.toBeInTheDocument();
    expect(screen.getByText('line 700')).toBeInTheDocument();
    expect(screen.getByText('line 1199')).toBeInTheDocument();
    expect(document.querySelectorAll('.tasklog-line')).toHaveLength(500);
    expect(screen.getByText('1200 lines')).toBeInTheDocument();
  });

  test('no note when under the cap', () => {
    render(<TaskLog lines={mk(10)} />);
    expect(screen.queryByText(/earlier line/)).not.toBeInTheDocument();
  });
});
