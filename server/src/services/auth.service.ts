import { db } from '../db';
import { hashPassword, comparePassword } from '../utils/crypto';
import type { User } from '@oblimint/shared';
import { rowToUser, type UserRow } from './userRow';

// Hash of a random secret: compared against when the account is unknown,
// disabled or has no local password, so a sign-in costs one bcrypt in every
// case (no account / og_ enumeration through timing).
let timingDummyHash: Promise<string> | null = null;
async function burnPasswordCompare(password: string): Promise<void> {
  try {
    if (!timingDummyHash) {
      const { randomBytes } = await import('crypto');
      timingDummyHash = hashPassword(randomBytes(24).toString('hex'));
    }
    await comparePassword(password, await timingDummyHash);
  } catch { /* timing only */ }
}

export const authService = {
  async authenticate(username: string, password: string): Promise<User | null> {
    const row = await db<UserRow>('users').where({ username, is_active: true }).first();
    if (!row || !row.password_hash) {
      await burnPasswordCompare(password);
      return null;
    }
    const valid = await comparePassword(password, row.password_hash);
    return valid ? rowToUser(row) : null;
  },

  async getUserById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    return row ? rowToUser(row) : null;
  },
};
