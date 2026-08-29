# Research - What actually requires a terms, privacy and refund page in Indonesia?

**Asked:** 2026-08-29 · **For:** [`../spec/legal-pages.md`](../spec/legal-pages.md) (PRD-product P0-5,
REQ-TR-01) · **Question:** the PRD says legal pages are "required by Midtrans production review anyway"
- is that true, and if it is not, what *does* require them and what must they say?

> **How to read this.** Two of the three bodies of fact below are third-party rules that change without
> notice, and the third is a statute whose text this machine could not open directly (no PDF renderer -
> the primary PDFs at BPK and ABNR would not parse). Every row is labelled **primary** (the platform's
> or the regulator's own publication) or **secondary** (someone reporting it). **Nothing here is legal
> advice, and none of it was written by a lawyer** - it is the evidence a draft should be built from and
> then reviewed against, not a substitute for that review.

## 1. What Midtrans actually asks for - and what it does not

| Claim | Finding | Confidence | Source |
|---|---|---|---|
| Documents for a **perorangan** (individual) account | **KTP + NPWP of the owner.** That is the whole documented list | **primary** | [Midtrans docs - legal documents](https://docs.midtrans.com/docs/what-are-the-legal-documents-required-for-midtrans-account-registration) |
| Documents for a **badan usaha** (PT / CV / PMA) | Company deed, ministerial decree, director's KTP/passport, director's NPWP, company NPWP, **NIB/SIUP/TDP**, plus industry licences | **primary** | same |
| Is a website mandatory? | **No.** A social-media profile, marketplace storefront, or product catalogue is accepted instead | **primary** | [Midtrans docs - do I need a website](https://docs.midtrans.com/docs/do-i-have-to-have-a-website-to-activate-my-midtrans-account) |
| What the business link must satisfy | It must be **publicly accessible**, and **the goods and their prices must be visible** on it | **primary** | [Midtrans docs - how to register](https://docs.midtrans.com/docs/how-to-register-as-midtrans-merchant), [ID version](https://docs.midtrans.com/docs/bagaimana-cara-mendaftar-menjadi-merchant-midtrans) |
| A terms page, privacy policy or refund policy on the merchant's own site | **Not documented as a requirement anywhere I could find.** The merchant agrees to *Midtrans's* terms; Midtrans publishes *its own* privacy notice. Neither is a checklist item about the merchant's site | **primary (absence)** | the three pages above, plus [Midtrans Pemberitahuan Privasi](https://midtrans.com/id/pemberitahuan-privasi) |
| Review / verification lead time | **Not published.** No page states a number of days | **primary (absence)** | same |

**So the PRD's justification does not hold as written.** [`prd-product.md`](../prd-product.md) P0-5 says
these pages are "Required by Midtrans production review anyway"; Midtrans's own documentation asks for a
reachable link showing goods and prices, and says nothing about legal pages. Treat that sentence as an
assumption that this research did not confirm.

**Two things follow, and they point in opposite directions:**

1. **P0-5 does not unblock P0-1 the way the sequencing assumed.** It is still worth doing first - §3 and
   §4 below are the real obligations, and they are not optional - but "it unblocks the merchant
   application" is no longer the argument for it. The honest argument is that a guest is being asked to
   pay money against no stated conditions.
2. **P0-1's bar may be markedly lower than the PRD assumed.** The PRD says activation needs "a legal
   entity or at minimum a registered sole proprietorship with NIB (OSS)". Midtrans documents **KTP +
   NPWP** for a perorangan account, with NIB appearing only in the *badan usaha* list. If that holds in
   practice, the PT Perorangan decision is about tax, liability and future OTA contracts - not about
   getting paid. **Confidence: medium-high on the documented list, unknown on what review actually
   demands**, since outcomes are not published and individual payment methods may each carry extra
   requirements ([activating payment methods](https://docs.midtrans.com/docs/payment-methods)). This is
   worth one email to Midtrans support before spending weeks on an entity.

## 2. What a refund can and cannot do through Midtrans

This matters to the *product*, not just the page: it decides whether a cancellation policy can ever be
automated.

| Payment method | Refund through Midtrans? | Source |
|---|---|---|
| Credit card (BNI, CIMB, Mandiri, BRI, BCA acquiring) | **Yes** - 7-14 business days; debit up to two months via the issuing bank | **primary** - [Metode pembayaran yang memiliki fitur refund](https://docs.midtrans.com/docs/metode-pembayaran-apa-yang-memiliki-fitur-refund), [Pengenalan Refund](https://docs.midtrans.com/docs/pengenalan-refund) |
| e-wallet (GoPay, ShopeePay, Dana, OVO), QRIS (GoPay/ShopeePay), Akulaku, Kredivo | **Yes** | same |
| **Bank transfer / Virtual Account** (Permata, Mandiri Bill, BNI, BCA, BRI) | **No** | same |
| Over the counter (Alfamart, Indomaret) | **No** | same |

For the methods without the feature, Midtrans's own wording is that the refund *"dapat diproses oleh
pedagang itu sendiri"* - the merchant transfers the money back by hand.

**Why this decides CP-03.** Virtual Account is the workhorse of Indonesian online payment, and it is on
the "no" list. So for a large share of bookings a refund is a manual bank transfer performed by the
owner, on the owner's own schedule - and Sambung, which under
[ADR-0039](../adr/0039-payment-credentials-are-tenant-scoped.md) never holds the money at all, is two
steps removed from it. A structured refund schedule in the product ("50% back up to 7 days out") would
be a number the software cannot act on, displayed as though it could. Free text is not a shortcut here;
it is the only honest representation available.

## 3. UU PDP (UU 27/2022) - the roles, and what a privacy notice must contain

*Article text below is quoted by law firms and JDIH summaries rather than read from the statute: the
primary PDFs ([BPK](https://peraturan.bpk.go.id/Details/229798/uu-no-27-tahun-2022),
[ABNR bilingual](https://www.abnrlaw.com/lib/files/IND-ENG-UU%2027-2022%20Pelindungan%20Data%20Pribadi%20(ABNR).pdf))
would not parse here. **Verify the article numbers against the statute before the text goes live.***

| Fact | Detail | Confidence | Source |
|---|---|---|---|
| **Pengendali Data Pribadi** (controller), Pasal 1 angka 4 | the party that "menentukan tujuan dan melakukan kendali pemrosesan" - determines the purpose and exercises control | secondary (quoting the statute) | [BP Lawyers](https://bplawyers.co.id/2022/11/29/pengendali-dan-prosesor-data-pribadi-dalam-uu-pdp-apa-bedanya/) |
| **Prosesor Data Pribadi** (processor), Pasal 1 angka 5 | the party processing "atas nama pengendali" - on the controller's behalf, on its instructions | secondary | same |
| A processor carries the controller's obligations | except where it acts outside the controller's instructions and stated purposes - at which point it becomes a controller for that processing | secondary | same |
| Pasal 20 | processing needs a lawful basis; consent is one of them | secondary | [Kemkomdigi JDIH](https://jdih.komdigi.go.id/produk_hukum/view/id/832/t/undangundang+nomor+27+tahun+2022) |
| **Pasal 21 - what must be disclosed** when the basis is consent | **seven items**: (a) legality of the processing, (b) its purpose, (c) type and relevance of the data, (d) retention period of documents containing it, (e) details of what is collected, (f) the processing period, (g) the data subject's rights. Changes must be notified **before** they take effect | secondary (consistent across sources) | [hukumku](https://www.hukumku.id/post/mekanisme-persetujuan-consent-pengguna-yang-sah-menurut-uu-pdp), JDIH summaries |

**This is the outline of the privacy page, and it is not the usual boilerplate order.** Pasal 21's seven
items are a better skeleton for `/legal/privacy` than a generic template, because a reader (or a
regulator) can check them off. Two of them - (d) retention and (f) processing period - are questions
Sambung has never answered anywhere in the repo: *how long does a cancelled booking's guest name and
phone number stay in the database?* That is a product decision hiding inside a legal page, and it should
be answered deliberately rather than by whatever the ledger happens to keep forever.

**The role split the spec claims (PL-10) is consistent with these definitions** - Sambung determines the
purpose for owner account data (controller), and processes guest booking data on the owner's
instructions (processor) - but it is an interpretation, and the kind a lawyer should confirm.

## 4. PP 80/2019 (PMSE) - the electronic contract

| Fact | Detail | Confidence | Source |
|---|---|---|---|
| The contract must be retrievable | the merchant must provide an Electronic Contract the consumer can **download and/or store** | secondary | [SIP Law Firm](https://siplawfirm.id/analisa-kebijakan-terbaru-e-commerce-berdasarkan-pp-80-tahun-2019), [Ditjen Aptika](https://aptika.kominfo.go.id/2020/01/peraturan-pemerintah-nomor-80-tahun-2019-tentang-perdagangan-melalui-sistem-elektronik-pmse/) |
| Language | a contract aimed at consumers in Indonesia must be **in Bahasa Indonesia** | secondary | same |
| Scope of consumer protection | explicitly covers offers, advertising, the electronic contract, **exchange and cancellation**, and delivery of goods **and services** | secondary | same |

**Two consequences for the spec.** First, it independently supports the owner's ID-authoritative
decision (PL-03) - and raises a question the spec should not pretend to settle: whether an English-only
cancellation policy written by a host for foreign guests satisfies the language rule. Second,
"retrievable by the consumer" is a requirement the product already half-meets by accident: **GU-04 puts
the policy in the guest's confirmation email**, which is a copy they keep. That row is now doing legal
work, not just courtesy work, and should not be dropped as a nicety.

## 5. What this research changes

1. **The reason for P0-5 moves** from "Midtrans requires it" (unsupported - §1) to "UU PDP Pasal 21
   requires a disclosure Sambung does not make, PP 80/2019 wants a retrievable contract, and a guest is
   paying against no stated conditions". The decision to build it stands; the sentence justifying it in
   `prd-product.md` should be corrected rather than quietly inherited.
2. **`/legal/privacy` gets its outline from Pasal 21's seven items** rather than a template, and doing
   so surfaces an unanswered product question: **data retention**. Needs an owner decision.
3. **CP-03 (free text, no structured rules) is now evidenced, not merely argued**: VA - the dominant
   Indonesian method - has no refund feature at all, so a refund schedule would be a promise no code
   here can execute (§2).
4. **GU-04 is load-bearing** (§4): the confirmation email is how the guest gets a copy of the terms
   they were shown.
5. **P0-1's entity question is worth re-asking before it is answered expensively** (§1): Midtrans
   documents KTP + NPWP for a perorangan account, not NIB.

## 6. What would change these answers

- Midtrans support saying, in writing, that review *does* ask for legal pages or for a NIB from an
  individual. **That is one email, and it is worth sending before acting on §1's second consequence.**
- The statute read directly. Every article number in §3 rests on secondary quoting because the primary
  PDFs would not open on this machine; a lawyer's review is the intended check, and the article numbers
  are the first thing to verify.
- A Midtrans product change to refund coverage (§2) - it is a capability table, and those move.
- Any move from "Sambung charges owners nothing" to a paid subscription, which would give
  `/legal/refund` a second, genuinely Sambung-owned half to state.
