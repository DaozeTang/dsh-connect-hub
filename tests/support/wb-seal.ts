/**
 * Seal one WorkBuddy desktop-auth field with the exact envelope format the
 * plugin's opener reads. Test-only: production code never needs to write this
 * format, so the helper lives with the fixtures instead of in the shipped bundle.
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { buildAuthenticatedContextAad } from '../../src/providers/workbuddy/desktop-credential-protection.ts'

export function sealAuthFieldForTest(
  key: Buffer,
  plaintext: string,
  suite = 1,
): { '$wbEncrypted': 1, envelope: string } {
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildAuthenticatedContextAad(keyId, suite))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()])
  const inner = {
    suite,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return { '$wbEncrypted': 1, envelope: Buffer.from(JSON.stringify(inner), 'utf8').toString('base64') }
}
