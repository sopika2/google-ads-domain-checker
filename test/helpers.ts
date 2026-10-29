import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
    return join(here, 'fixtures', name);
}

export function fixtureText(name: string): string {
    return readFileSync(fixturePath(name), 'utf8');
}

export function fixtureJson(name: string): unknown {
    return JSON.parse(fixtureText(name));
}

/** 2026-10-29T00:00:00Z, a few hours after the fixtures were captured. */
export const FIXTURE_NOW = new Date('2026-10-29T00:00:00.000Z');
