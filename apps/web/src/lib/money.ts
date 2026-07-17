/**
 * Money on screen: `Rp 14.000.000` from integer rupiah (page-spec §2).
 *
 * One formatter for the whole SPA, not one per feature. The dashboard's unit
 * table and the public property page quote the same prices, and an owner who
 * proofreads their page against their workbench must see the same string in
 * both - a second copy of this rule is a second chance to drift.
 *
 * `id-ID` is what makes the separators dots rather than commas. It is the
 * currency's locale, not the visitor's: Rp is written the Indonesian way for
 * everyone, the same way €1.000,00 doesn't become €1,000.00 for an American
 * reading a German site. (Dates DO follow the visitor - page-spec §2.)
 *
 * Takes a number, not bigint: money crosses the wire as an integer JSON number
 * (api-spec §1) and the API already converted it through toRupiah, which is the
 * one chokepoint allowed to touch a BigInt.
 */
const rupiah = new Intl.NumberFormat("id-ID");

export const formatIdr = (n: number): string => `Rp ${rupiah.format(n)}`;
