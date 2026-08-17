import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  credentialVerifyStatusSchema,
  paymentProviderSchema,
  type PaymentCredentialStatusResponse,
  type PaymentProvider,
  type SavePaymentCredentialRequest,
} from '@sambung/shared';
import { decodeEncryptionKey, encryptCredential } from './credential-crypto';
import { CredentialsRepository } from './credentials.repository';
import type { CredentialStatusRow } from './credentials.repository';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';

/**
 * The current app key's generation, stamped onto every fresh write. Env-driven
 * (default 1) rather than a constant, because a constant goes stale the moment
 * the rotation runbook (docs/runbooks/credential-key.md) re-encrypts the rows
 * to generation N+1 - the rotate script prints the value to set. Informational
 * bookkeeping: only ONE key is live at a time, so decrypt never branches on it;
 * it exists so an operator can SEE which rows a half-finished rotation missed.
 */
function currentKeyVersion(config: ConfigService): number {
  const raw = Number(config.get<string>('CREDENTIAL_ENCRYPTION_KEY_VERSION'));
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/**
 * The owner's credential surface (REQ-PA-04): PUT to save/replace, GET for
 * status. The RAW key exists here for exactly two statements - the verify probe
 * and the encrypt - then only ciphertext moves. Nothing returns it (EARS CR-02).
 */
@Injectable()
export class PaymentCredentialsService {
  constructor(
    private readonly repo: CredentialsRepository,
    private readonly config: ConfigService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async list(): Promise<PaymentCredentialStatusResponse[]> {
    const rows = await this.repo.statusList();
    return rows.map((row) => this.toResponse(row));
  }

  /**
   * Save or replace (EARS CR-01/03/04). Order is the design:
   *  1. resolve the provider (unknown → 404, like the webhook's provider param);
   *  2. probe the provider with the RAW key against the credential's OWN
   *     environment - the outcome is stored, never a refusal (a Midtrans outage
   *     must not block a valid key, #55's smoke-fetch rule);
   *  3. encrypt under the current app key and upsert.
   * The encryption key is decoded FIRST, so a mis-set CREDENTIAL_ENCRYPTION_KEY
   * fails loud before any provider call.
   */
  async save(
    providerParam: string,
    dto: SavePaymentCredentialRequest,
  ): Promise<PaymentCredentialStatusResponse> {
    const provider = this.resolveProvider(providerParam);
    const key = decodeEncryptionKey(
      this.config.get<string>('CREDENTIAL_ENCRYPTION_KEY'),
    );

    const lastVerifyStatus = await this.gateway.verifyCredential({
      serverKey: dto.serverKey,
      environment: dto.environment,
    });
    const lastVerifyAt = new Date();

    const { ciphertext, nonce } = encryptCredential(dto.serverKey, key);
    await this.repo.upsert({
      provider,
      environment: dto.environment,
      ciphertext,
      nonce,
      keyVersion: currentKeyVersion(this.config),
      lastVerifyStatus,
      lastVerifyAt,
    });

    // Re-read through the SAME status query the GET uses, so the PUT's answer
    // and the list can never disagree - and so this method's return path
    // provably touches no secret column.
    const rows = await this.repo.statusList();
    const saved = rows.find((row) => row.provider === provider);
    // The row was just upserted in this request; absent means the DB refused
    // silently, which cannot happen - but never invent a response.
    if (!saved) {
      throw new NotFoundException('Credential not found after save');
    }
    return this.toResponse(saved);
  }

  private resolveProvider(param: string): PaymentProvider {
    const parsed = paymentProviderSchema.safeParse(param);
    if (!parsed.success) {
      // Unknown provider segment → 404, the webhook's convention: the resource
      // "/settings/payment-credentials/xyz" does not exist.
      throw new NotFoundException(`Unknown payment provider "${param}"`);
    }
    return parsed.data;
  }

  private toResponse(
    row: CredentialStatusRow,
  ): PaymentCredentialStatusResponse {
    return {
      provider: paymentProviderSchema.parse(row.provider),
      environment: row.environment === 'production' ? 'production' : 'sandbox',
      configuredAt: row.createdAt.toISOString(),
      lastVerifyStatus: credentialVerifyStatusSchema.parse(
        row.lastVerifyStatus,
      ),
      lastVerifyAt: row.lastVerifyAt ? row.lastVerifyAt.toISOString() : null,
    };
  }
}
