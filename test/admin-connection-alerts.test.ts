import 'reflect-metadata';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import AdminService from '../src/modules/admin/admin.service';
import logger from '../src/common/lib/logger';

interface ConnectionStat {
  connectionId: number;
  userId: number;
  gmailAddress: string;
  txCount: number;
  regexCount: number;
  aiCount: number;
}

function makeService(stats: ConnectionStat[]) {
  const warnCalls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminRepository: any = {
    getConnectionRegexStats: async () => stats,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AdminService(adminRepository, {} as any);

  // logger is a module-level singleton import, not injected - patch its warn
  // method directly for the duration of the test rather than trying to fake
  // the whole logger module.
  const originalWarn = logger.warn.bind(logger);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logger.warn = ((msg: string) => {
    warnCalls.push(msg);
    return logger;
  }) as any;

  return {
    service,
    warnCalls,
    restore: () => {
      logger.warn = originalWarn;
    },
  };
}

describe('checkConnectionAlerts', () => {
  test('warns when AI share exceeds the threshold with enough samples', async () => {
    const { service, warnCalls, restore } = makeService([
      { connectionId: 1, userId: 1, gmailAddress: 'a@example.com', txCount: 11, regexCount: 2, aiCount: 9 },
    ]);
    try {
      await service.checkConnectionAlerts();
      assert.equal(warnCalls.length, 1);
      assert.match(warnCalls[0], /Connection 1/);
      assert.match(warnCalls[0], /81\.8%/);
    } finally {
      restore();
    }
  });

  test('does not warn when AI share is under the threshold', async () => {
    const { service, warnCalls, restore } = makeService([
      { connectionId: 1, userId: 1, gmailAddress: 'a@example.com', txCount: 10, regexCount: 8, aiCount: 2 },
    ]);
    try {
      await service.checkConnectionAlerts();
      assert.equal(warnCalls.length, 0);
    } finally {
      restore();
    }
  });

  test('does not warn on a small sample even at 100% AI share', async () => {
    // Below CONNECTION_ALERT_MIN_SAMPLE_SIZE - noise, not a real signal.
    const { service, warnCalls, restore } = makeService([
      { connectionId: 1, userId: 1, gmailAddress: 'a@example.com', txCount: 3, regexCount: 0, aiCount: 3 },
    ]);
    try {
      await service.checkConnectionAlerts();
      assert.equal(warnCalls.length, 0);
    } finally {
      restore();
    }
  });

  test('warns independently for each connection over the threshold', async () => {
    const { service, warnCalls, restore } = makeService([
      { connectionId: 1, userId: 1, gmailAddress: 'a@example.com', txCount: 20, regexCount: 1, aiCount: 19 },
      { connectionId: 2, userId: 2, gmailAddress: 'b@example.com', txCount: 20, regexCount: 15, aiCount: 5 },
      { connectionId: 3, userId: 3, gmailAddress: 'c@example.com', txCount: 15, regexCount: 0, aiCount: 15 },
    ]);
    try {
      await service.checkConnectionAlerts();
      assert.equal(warnCalls.length, 2);
      assert.ok(warnCalls.some((w) => w.includes('Connection 1')));
      assert.ok(warnCalls.some((w) => w.includes('Connection 3')));
      assert.ok(!warnCalls.some((w) => w.includes('Connection 2')));
    } finally {
      restore();
    }
  });
});
