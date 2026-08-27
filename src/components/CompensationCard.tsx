import type { SalaryFinding, SponsorshipFinding } from '@/lib/jobs/compensation';
import { formatSalary, formatSalaryUsd, USD_RATES_AS_OF } from '@/lib/jobs/compensation';

/**
 * Pay and sponsorship, with the posting's own words underneath.
 *
 * These are the two facts that decide whether an application is worth an hour,
 * and for this candidate the second one decides whether it is possible at all.
 * Both were previously reduced to almost nothing: salary to whatever a source
 * API happened to return in a structured field, sponsorship to a three-state
 * pill with no way to see what the posting had actually said.
 *
 * The quote is the feature, not decoration. "Visa sponsorship available for
 * exceptional candidates" and "we sponsor Blue Card applications" both reduce to
 * `yes`, and they are not the same news. Showing the sentence lets the applicant
 * judge it in the two seconds it takes to read, instead of opening the original
 * posting to find out.
 *
 * Where the figures disagree with the source's own structured field, both are
 * shown rather than one silently winning: a range parsed out of the text is a
 * reading, and the applicant is better placed than this code to settle it.
 */
export function CompensationCard({
  salary,
  structured,
  sponsorship,
  verdict,
}: {
  salary: SalaryFinding | null;
  structured: { min: number | null; max: number | null; currency: string | null } | null;
  sponsorship: SponsorshipFinding;
  verdict: string;
}) {
  const hasStructured = Boolean(structured && (structured.min || structured.max));
  if (!salary && !hasStructured && !sponsorship.quotes.length) return null;

  const sponsorTone =
    verdict === 'yes'
      ? { label: 'Sponsorship offered', grad: 'var(--grad-green)' }
      : verdict === 'no'
        ? { label: 'No sponsorship', grad: 'linear-gradient(135deg,#ef4444,#b91c1c)' }
        : { label: 'Sponsorship not stated — worth asking', grad: 'linear-gradient(135deg,#f59e0b,#f97316)' };

  return (
    <section className="glass rounded-2xl p-5 ring-1 ring-[var(--color-accent)]/30">
      <h2 className="font-display text-sm font-bold">Pay &amp; sponsorship</h2>
      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
        Read from the posting text, quoted exactly as written.
      </p>

      {(salary || hasStructured) && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-[var(--color-muted)]">Salary</p>

          {/* Dollars lead, because bands arrive in a dozen currencies and cannot
              be compared at a glance otherwise. The posting's own figure stays
              directly underneath: that is the fact, and the conversion is a
              convenience laid over it at a rate that is fixed, not live. */}
          <p className="tnum mt-1 text-xl font-bold text-[var(--color-good)]">
            {(salary && formatSalaryUsd(salary)) ?? (salary ? formatSalary(salary) : formatStructured(structured!))}
          </p>
          {salary && formatSalaryUsd(salary) && salary.currency !== 'USD' && (
            <p className="tnum mt-0.5 text-xs text-[var(--color-muted)]">
              As posted: {formatSalary(salary)} · converted at {USD_RATES_AS_OF} rates
            </p>
          )}

          {salary && (
            <blockquote className="mt-2 border-l-2 border-[var(--color-good)]/50 pl-3 text-xs italic text-[var(--color-muted)]">
              “{salary.evidence}”
            </blockquote>
          )}

          {/* Both readings, when they exist and differ. The applicant decides. */}
          {salary && hasStructured && (
            <p className="mt-2 text-[11px] text-[var(--color-muted)]">
              The job board also reports {formatStructured(structured!)}.
            </p>
          )}
        </div>
      )}

      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-[var(--color-muted)]">Visa</span>
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-bold text-white shadow"
            style={{ backgroundImage: sponsorTone.grad }}
          >
            {sponsorTone.label}
          </span>
        </div>

        {sponsorship.quotes.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {sponsorship.quotes.map((quote) => (
              <blockquote
                key={quote}
                className="border-l-2 border-[var(--color-accent)]/50 pl-3 text-xs italic text-[var(--color-muted)]"
              >
                “{quote}”
              </blockquote>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            The posting says nothing about visas, permits or relocation. That is not a no — it is a
            question for the first conversation.
          </p>
        )}
      </div>
    </section>
  );
}

function formatStructured(s: { min: number | null; max: number | null; currency: string | null }): string {
  const money = (v: number) => `${s.currency ? `${s.currency} ` : ''}${v.toLocaleString('en-GB')}`;
  if (s.min && s.max) return `${money(s.min)} – ${money(s.max)}`;
  return money(s.min ?? s.max ?? 0);
}
