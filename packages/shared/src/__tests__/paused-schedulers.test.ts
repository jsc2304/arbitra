import { describe, it, expect } from 'vitest';
import { parsePausedSchedulers } from '../utils/paused-schedulers.js';

describe('parsePausedSchedulers', () => {
  it('returns [] for undefined', () => {
    expect(parsePausedSchedulers(undefined)).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(parsePausedSchedulers(null)).toEqual([]);
  });

  it('returns [] for an empty string', () => {
    expect(parsePausedSchedulers('')).toEqual([]);
  });

  it('parses a full comma-separated list', () => {
    expect(parsePausedSchedulers('run_sweeper,blueprint_tick,intelligence')).toEqual([
      'run_sweeper',
      'blueprint_tick',
      'intelligence',
    ]);
  });

  it('trims whitespace around tokens', () => {
    expect(parsePausedSchedulers(' run_sweeper , blueprint_tick ')).toEqual([
      'run_sweeper',
      'blueprint_tick',
    ]);
  });

  it('drops empty tokens from stray commas', () => {
    expect(parsePausedSchedulers('run_sweeper,,blueprint_tick,')).toEqual([
      'run_sweeper',
      'blueprint_tick',
    ]);
  });

  it('drops unknown tokens rather than throwing', () => {
    expect(parsePausedSchedulers('run_sweeper,not_a_real_feature')).toEqual(['run_sweeper']);
  });
});
