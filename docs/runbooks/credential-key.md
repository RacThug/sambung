# Runbook - the credential encryption key (`CREDENTIAL_ENCRYPTION_KEY`)

**What it is.** The single app-held key that encrypts every tenant's payment-gateway server key at
rest (AES-256-GCM, `tenant_payment_credential`, migration 0018, [ADR-0039](../adr/0039-payment-credentials-are-tenant-scoped.md)).

**Why this runbook exists.** Losing this key does not lose data - it bricks EVERY tenant's online
checkout at once: the ciphertexts become noise, and every owner must re-paste their Midtrans key.
ADR-0039 names this as the cost of key custody; this file is the mitigation it demands, and it ships
*with* the first credential, not after.

## Generate (once, per deployment)

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Set it in the VPS env as `CREDENTIAL_ENCRYPTION_KEY` (gitignored env only - never the repo, like
every prod secret). A DEPLOYMENT (the #193 predicate) refuses to boot without it once this slice
lands, so a forgotten key is loud, not silent.

## Back up (immediately after generating)

The key must survive the VPS dying. Store it in at least one place that is **not** the VPS:

- a password manager entry ("Sambung - credential encryption key"), and/or
- a sealed offline note with the owner's important documents.

Never in the repo, never in a chat log, never in an email. Test the backup by reading it back once.

## Rotate (when the key may have been exposed)

`key_version` on every row exists for exactly this:

1. Generate a new key; set `CREDENTIAL_ENCRYPTION_KEY_NEXT` beside the old one.
2. `pnpm --filter api credentials:rotate` - re-encrypts every row under the new key and bumps
   `key_version`, one transaction per row. Resumable (a re-run skips rows already on the new
   generation), and a row the old key cannot read is REPORTED and left untouched rather than
   aborting the pass - that tenant's owner re-pastes their key, everyone else rotates.
3. Follow the script's printed instructions: move the new key into `CREDENTIAL_ENCRYPTION_KEY`,
   set `CREDENTIAL_ENCRYPTION_KEY_VERSION` to the printed generation, drop `_NEXT`, restart,
   and update the backups.

If the OLD key is already lost (rotation impossible), the recovery is honest and manual: every
tenant re-pastes their Midtrans key on `/app/settings`. Their money was never at risk - the keys
grant API access, and the settlement account is theirs at Midtrans, not ours.

## What this key does NOT protect

RLS + the write-only column grant (0018) already stop any app-role query reading ciphertext. This
key covers what THEY cannot: the backup file and the stolen dump (ADR-0039 decision 3). Both layers
have to fail before a server key leaks.
