import { describe, expect, it } from '@jest/globals';
import {
  buildDatabaseSslOptions,
  needsTlsVerificationWarning,
} from './ssl-options';

describe('buildDatabaseSslOptions', () => {
  it('disables TLS entirely when SSL is off', () => {
    expect(buildDatabaseSslOptions(false, {})).toBe(false);
  });

  it('keeps the previous behaviour when nothing is configured', () => {
    // 관리형 DB는 사설 CA를 쓰는 경우가 많아, 검증을 임의로 켜면 기존 배포가 끊깁니다.
    // 설정이 없으면 동작을 바꾸지 않고 경고만 남깁니다.
    expect(buildDatabaseSslOptions(true, {})).toEqual({
      rejectUnauthorized: false,
    });
    expect(needsTlsVerificationWarning(true, {})).toBe(true);
  });

  it('verifies when explicitly asked to', () => {
    expect(
      buildDatabaseSslOptions(true, { DB_SSL_REJECT_UNAUTHORIZED: 'true' }),
    ).toEqual({ rejectUnauthorized: true });
    expect(
      needsTlsVerificationWarning(true, { DB_SSL_REJECT_UNAUTHORIZED: 'true' }),
    ).toBe(false);
  });

  it('does not warn when SSL is off or a CA is supplied', () => {
    expect(needsTlsVerificationWarning(false, {})).toBe(false);
    expect(needsTlsVerificationWarning(true, { DB_SSL_CA: 'pem' })).toBe(false);
  });

  it('trusts a private CA while keeping verification on', () => {
    expect(
      buildDatabaseSslOptions(true, {
        DB_SSL_CA: '-----BEGIN CERTIFICATE-----',
      }),
    ).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----',
    });
  });

  it('allows an explicit opt-out for self-signed environments', () => {
    expect(
      buildDatabaseSslOptions(true, { DB_SSL_REJECT_UNAUTHORIZED: 'false' }),
    ).toEqual({ rejectUnauthorized: false });
  });

  it('treats an unrecognised value as unset rather than a choice', () => {
    for (const value of ['0', 'off', 'no', 'ture', '']) {
      expect(
        needsTlsVerificationWarning(true, {
          DB_SSL_REJECT_UNAUTHORIZED: value,
        }),
      ).toBe(true);
    }
  });
});
