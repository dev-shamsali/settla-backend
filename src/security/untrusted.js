/**
 * External text (WhatsApp, email, tickets, CRM notes, names) is DATA, never instructions.
 * We (1) strip control chars, (2) cap length, (3) detect injection attempts and flag them,
 * (4) hand the model only a delimited, labelled data block.
 */
const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules|prompts?)/i,
  /disregard (the )?(system|previous|above)/i,
  /you are now/i,
  /system prompt/i,
  /(reveal|print|show) (your|the) (instructions|prompt|rules|secrets?)/i,
  /\b(refund|issue|send|transfer)\b.{0,40}\b(all|full|₹?\s?\d{5,}|maximum)\b.{0,40}\b(now|immediately|without)\b/i,
  /<\s*\/?\s*(system|assistant|tool)\s*>/i,
  /(override|bypass|disable) (the )?(policy|policies|limit|approval|safety|rules)/i,
  /\bjailbreak\b/i,
];

const HUMAN_PATTERNS = [/\b(human|real person|agent|manager|supervisor|speak to someone|talk to someone)\b/i];
const CHARGEBACK_PATTERNS = [/\bchargeback\b/i, /\bdispute (the )?(charge|payment|transaction)\b/i, /\bbank (claim|dispute)\b/i];
const LEGAL_PATTERNS = [/\b(lawyer|legal action|sue|court|consumer forum|police|fir|litigation|legal notice)\b/i];
const HOSTILE_PATTERNS = [/\b(scam|fraud(sters?)?|cheat(ed|ing)?|useless|worst|idiots?|stupid|rip ?off|thieves)\b/i];

export function sanitizeUntrusted(text, max = 2000) {
  const clean = String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<[^>]*>/g, (m) => m.replace(/</g, '‹').replace(/>/g, '›'))
    .slice(0, max);
  return clean;
}

export function analyzeUntrusted(text) {
  const clean = sanitizeUntrusted(text);
  // detect on the raw text: neutralising tags first would hide tag-based injection
  const raw = String(text ?? '').slice(0, 2000);
  const injection = INJECTION_PATTERNS.filter((r) => r.test(raw) || r.test(clean)).map((r) => r.source);
  return {
    text: clean,
    injectionDetected: injection.length > 0,
    injectionSignals: injection,
    requestsHuman: HUMAN_PATTERNS.some((r) => r.test(clean)),
    chargebackLanguage: CHARGEBACK_PATTERNS.some((r) => r.test(clean)),
    legalLanguage: LEGAL_PATTERNS.some((r) => r.test(clean)),
    hostile: HOSTILE_PATTERNS.some((r) => r.test(clean)),
  };
}

/** Block handed to an LLM. Content inside is inert data. */
export function wrapUntrusted(label, text) {
  const { text: clean } = analyzeUntrusted(text);
  return `<untrusted_data source="${label}">\n${clean}\n</untrusted_data>`;
}

/** Output encoder for any field that will be rendered. */
export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]);
