import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, throwError } from 'rxjs';
import { mapDbError } from './db-error.map';

/**
 * Turn a constraint violation into the response it means, everywhere, without
 * a try/catch in a single service.
 *
 * Translates rather than renders: it rethrows an HttpException and lets Nest's
 * existing exception layer produce the body. Nothing here knows what a 409
 * looks like on the wire.
 *
 * An unmapped error passes through untouched - a violation nobody mapped
 * becomes a 500, which is correct: we didn't think about that constraint.
 *
 * Opting out is just catching first. Some violations are not errors at all -
 * M3's webhook treats a duplicate `payment_event` as "already processed → 200"
 * (api-spec §6.2). A service that catches its own violation never reaches here.
 * Note it must catch OUTSIDE the transaction: Postgres aborts the whole
 * transaction on any error (25P02), so catching and carrying on inside one
 * does not work.
 */
@Injectable()
export class DbErrorInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((err: unknown) => throwError(() => mapDbError(err) ?? err)),
      );
  }
}
