import { Express } from 'express';
import express from 'express';

interface MountEntry {
  prefix: string;
  router: express.Router;
}

const mounts: MountEntry[] = [];

export function registerMount(prefix: string, router: express.Router): void {
  mounts.push({ prefix, router });
}

export function getMounts(): MountEntry[] {
  return mounts;
}

export function applyMounts(app: Express): void {
  for (const { prefix, router } of mounts) {
    app.use(prefix, router);
  }
}
