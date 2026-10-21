import { describe, expect, it, vi } from 'vitest';
import {
  detectEnvironment,
  ENVIRONMENT_BADGE,
  type AppEnvironment,
} from '../app-environment';

describe('detectEnvironment', () => {
  // Branch 1: LOCAL — localhost and loopback addresses (win over the setting).
  it('maps localhost and loopback addresses to local', () => {
    expect(detectEnvironment('localhost', undefined)).toBe('local');
    expect(detectEnvironment('127.0.0.1', undefined)).toBe('local');
    expect(detectEnvironment('127.1.2.3', undefined)).toBe('local');
    expect(detectEnvironment('::1', undefined)).toBe('local');
    expect(detectEnvironment('[::1]', undefined)).toBe('local');
    expect(detectEnvironment('localhost', 'prod')).toBe('local');
  });

  // Branch 2: configured environment on any other host.
  it('uses the configured environment for non-local hosts', () => {
    expect(detectEnvironment('arbitra.example.com', 'prod')).toBe('prod');
    expect(detectEnvironment('arbitra.example.com', 'dev')).toBe('dev');
    expect(detectEnvironment('arbitra.example.com', ' DEV ')).toBe('dev');
  });

  // Branch 3: nothing identifies the environment — no badge rather than a wrong one.
  it('returns null for non-local hosts without a valid configured environment', () => {
    expect(detectEnvironment('arbitra.example.com', undefined)).toBeNull();
    expect(detectEnvironment('arbitra.example.com', '')).toBeNull();
    expect(detectEnvironment('arbitra.example.com', 'staging')).toBeNull();
    expect(detectEnvironment('arbitra.example.com', 'local')).toBeNull();
    expect(detectEnvironment('', undefined)).toBeNull();
    // Suffix lookalikes must not match as local.
    expect(detectEnvironment('localhost.example.com', undefined)).toBeNull();
  });

  it('is case-insensitive on the hostname', () => {
    expect(detectEnvironment('LOCALHOST', undefined)).toBe('local');
  });

  it('defaults the configured value to NEXT_PUBLIC_ARBITRA_ENV', () => {
    vi.stubEnv('NEXT_PUBLIC_ARBITRA_ENV', 'dev');
    try {
      expect(detectEnvironment('arbitra.example.com')).toBe('dev');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('ENVIRONMENT_BADGE', () => {
  const ALL_ENVIRONMENTS = ['prod', 'dev', 'local'] as const satisfies readonly AppEnvironment[];

  it('has a label and colour entry for every environment', () => {
    for (const env of ALL_ENVIRONMENTS) {
      expect(ENVIRONMENT_BADGE[env].label).toBeTruthy();
      expect(ENVIRONMENT_BADGE[env].colorClassName).toBeTruthy();
    }
  });

  it('uses uppercase labels', () => {
    for (const env of ALL_ENVIRONMENTS) {
      const { label } = ENVIRONMENT_BADGE[env];
      expect(label).toBe(label.toUpperCase());
    }
  });

  it('reserves the interactive accent: no accent/orange classes on any badge', () => {
    for (const env of ALL_ENVIRONMENTS) {
      expect(ENVIRONMENT_BADGE[env].colorClassName).not.toMatch(/accent|orange/);
    }
  });

  it('provides both light and dark variants for every badge', () => {
    for (const env of ALL_ENVIRONMENTS) {
      expect(ENVIRONMENT_BADGE[env].colorClassName).toMatch(/dark:/);
    }
  });
});
