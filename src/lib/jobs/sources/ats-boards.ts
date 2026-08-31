/**
 * The company boards the ATS source reads.
 *
 * **Every slug in this file was probed against the live API and returned
 * postings.** That is the rule for adding one, and it is not a formality: a
 * curated list of 404s is worse than no source at all, because it fails
 * silently and looks exactly like "no new jobs today". 106 Greenhouse
 * candidates were tried and 47 answered; 49 Lever candidates and 10 answered.
 * The ones that did not are simply not here.
 *
 * **Why these companies and not others.** The list is not "big tech". It is
 * built from three overlapping groups, in this order of value to this profile:
 *
 *  1. **Database and data-platform vendors** — MongoDB, Elastic, Databricks,
 *     Cockroach, Neo4j, YugabyteDB, ClickHouse-adjacent, Starburst, Fivetran,
 *     Neon, Supabase. These advertise the exact work (SQL, PostgreSQL, Oracle
 *     migration, performance, replication), they hire remotely across Europe,
 *     and they sponsor as a matter of routine.
 *  2. **European employers with a real sponsorship record** in the target
 *     markets — Berlin, Munich, Amsterdam, Dublin, Stockholm, Paris, Zurich.
 *  3. **Two large German industrials on SmartRecruiters** — Bosch and
 *     Continental, which between them carry 5,641 open postings including the
 *     Oracle, SAP and ERP support work that is the centre of this CV and that
 *     no startup board carries at all.
 *
 * Editing this list is the intended way to steer the source. Add a company by
 * finding its board slug (the name in its careers-page URL) and confirming it
 * answers; remove one by deleting the line. Nothing else needs to change.
 */

export type AtsPlatform = 'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters';

export interface AtsBoard {
  platform: AtsPlatform;
  /** The board identifier in the ATS URL, not the company's trading name. */
  slug: string;
  /** For the source-run log, so a dead board is nameable when it stops answering. */
  name: string;
}

export const ATS_BOARDS: AtsBoard[] = [
  // --- data & database platforms — the closest fit in the whole feed --------
  { platform: 'greenhouse', slug: 'databricks', name: 'Databricks' },
  { platform: 'greenhouse', slug: 'mongodb', name: 'MongoDB' },
  { platform: 'greenhouse', slug: 'elastic', name: 'Elastic' },
  { platform: 'greenhouse', slug: 'cockroachlabs', name: 'Cockroach Labs' },
  { platform: 'greenhouse', slug: 'neo4j', name: 'Neo4j' },
  { platform: 'greenhouse', slug: 'yugabyte', name: 'Yugabyte' },
  { platform: 'greenhouse', slug: 'fivetran', name: 'Fivetran' },
  { platform: 'greenhouse', slug: 'starburst', name: 'Starburst' },
  { platform: 'greenhouse', slug: 'sigmacomputing', name: 'Sigma Computing' },
  { platform: 'greenhouse', slug: 'imply', name: 'Imply' },
  { platform: 'ashby', slug: 'neon', name: 'Neon' },
  { platform: 'ashby', slug: 'supabase', name: 'Supabase' },

  // --- Germany / DACH -------------------------------------------------------
  { platform: 'greenhouse', slug: 'celonis', name: 'Celonis' },
  { platform: 'greenhouse', slug: 'getyourguide', name: 'GetYourGuide' },
  { platform: 'greenhouse', slug: 'hellofresh', name: 'HelloFresh' },
  { platform: 'greenhouse', slug: 'traderepublic', name: 'Trade Republic' },
  { platform: 'greenhouse', slug: 'sumup', name: 'SumUp' },
  { platform: 'greenhouse', slug: 'n26', name: 'N26' },
  { platform: 'greenhouse', slug: 'solarisbank', name: 'Solaris' },
  { platform: 'greenhouse', slug: 'staffbase', name: 'Staffbase' },
  { platform: 'greenhouse', slug: 'commercetools', name: 'commercetools' },
  { platform: 'greenhouse', slug: 'contentful', name: 'Contentful' },
  { platform: 'greenhouse', slug: 'scandit', name: 'Scandit' },
  { platform: 'smartrecruiters', slug: 'BoschGroup', name: 'Bosch' },
  { platform: 'smartrecruiters', slug: 'Continental', name: 'Continental' },

  // --- Netherlands, Belgium, France, Switzerland ---------------------------
  { platform: 'greenhouse', slug: 'adyen', name: 'Adyen' },
  { platform: 'greenhouse', slug: 'showpad', name: 'Showpad' },
  { platform: 'greenhouse', slug: 'doctolib', name: 'Doctolib' },
  { platform: 'greenhouse', slug: 'algolia', name: 'Algolia' },
  { platform: 'lever', slug: 'qonto', name: 'Qonto' },
  { platform: 'lever', slug: 'younited', name: 'Younited' },

  // --- Nordics & Ireland ---------------------------------------------------
  { platform: 'greenhouse', slug: 'truecaller', name: 'Truecaller' },
  { platform: 'greenhouse', slug: 'cognite', name: 'Cognite' },
  { platform: 'greenhouse', slug: 'intercom', name: 'Intercom' },
  { platform: 'greenhouse', slug: 'udemy', name: 'Udemy' },
  { platform: 'lever', slug: 'spotify', name: 'Spotify' },

  // --- UK ------------------------------------------------------------------
  { platform: 'greenhouse', slug: 'wise', name: 'Wise' },
  { platform: 'greenhouse', slug: 'monzo', name: 'Monzo' },
  { platform: 'greenhouse', slug: 'gocardless', name: 'GoCardless' },
  { platform: 'lever', slug: 'moonpig', name: 'Moonpig' },
  { platform: 'ashby', slug: 'multiverse', name: 'Multiverse' },

  // --- global, remote-friendly, hire into Europe ---------------------------
  { platform: 'greenhouse', slug: 'stripe', name: 'Stripe' },
  { platform: 'greenhouse', slug: 'cloudflare', name: 'Cloudflare' },
  { platform: 'greenhouse', slug: 'datadog', name: 'Datadog' },
  { platform: 'greenhouse', slug: 'twilio', name: 'Twilio' },
  { platform: 'greenhouse', slug: 'dropbox', name: 'Dropbox' },
  { platform: 'greenhouse', slug: 'reddit', name: 'Reddit' },
  { platform: 'greenhouse', slug: 'coinbase', name: 'Coinbase' },
  { platform: 'greenhouse', slug: 'robinhood', name: 'Robinhood' },
  { platform: 'greenhouse', slug: 'airbnb', name: 'Airbnb' },
  { platform: 'greenhouse', slug: 'figma', name: 'Figma' },
  { platform: 'greenhouse', slug: 'discord', name: 'Discord' },
  { platform: 'greenhouse', slug: 'checkr', name: 'Checkr' },
  { platform: 'greenhouse', slug: 'samsara', name: 'Samsara' },
  { platform: 'greenhouse', slug: 'affirm', name: 'Affirm' },
  { platform: 'greenhouse', slug: 'gusto', name: 'Gusto' },
  { platform: 'lever', slug: 'palantir', name: 'Palantir' },
  { platform: 'lever', slug: 'veeva', name: 'Veeva' },
  { platform: 'lever', slug: 'matchgroup', name: 'Match Group' },
  { platform: 'lever', slug: 'swordhealth', name: 'Sword Health' },
  { platform: 'lever', slug: 'jobandtalent', name: 'Jobandtalent' },
  { platform: 'ashby', slug: 'ramp', name: 'Ramp' },
  { platform: 'ashby', slug: 'linear', name: 'Linear' },
  { platform: 'ashby', slug: 'vanta', name: 'Vanta' },
  { platform: 'ashby', slug: 'replit', name: 'Replit' },
  { platform: 'ashby', slug: 'posthog', name: 'PostHog' },
  { platform: 'ashby', slug: 'notion', name: 'Notion' },
  { platform: 'ashby', slug: 'render', name: 'Render' },
  { platform: 'ashby', slug: 'railway', name: 'Railway' },
  { platform: 'ashby', slug: 'modal', name: 'Modal' },
  { platform: 'ashby', slug: 'elevenlabs', name: 'ElevenLabs' },
  { platform: 'ashby', slug: 'sardine', name: 'Sardine' },
];
