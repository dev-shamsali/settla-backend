import { repos } from '../repositories/index.js';

const DAY = 86400_000;

export async function summary(tenantId, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * DAY);
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const [casesToday, total, resolvedAgg, escalated, byDecision, rev, failedActions, pendingApprovals, failureReasons, byStatus] = await Promise.all([
    repos.cases.count(tenantId, { createdAt: { $gte: startOfToday } }),
    repos.cases.count(tenantId, { createdAt: { $gte: since } }),
    repos.cases.aggregate(tenantId, [
      { $match: { createdAt: { $gte: since }, status: { $in: ['RESOLVED', 'REFUNDED', 'CLOSED'] }, resolutionMs: { $ne: null } } },
      { $group: { _id: null, n: { $sum: 1 }, auto: { $sum: { $cond: ['$autonomous', 1, 0] } }, avgMs: { $avg: '$resolutionMs' }, avgFirst: { $avg: '$firstResponseMs' } } },
    ]),
    repos.cases.count(tenantId, { createdAt: { $gte: since }, escalationId: { $exists: true } }),
    repos.cases.aggregate(tenantId, [{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$autonomous', n: { $sum: 1 } } }]),
    repos.analyticsEvents.aggregate(tenantId, [{ $match: { ts: { $gte: since } } }, { $group: { _id: '$type', amount: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    repos.actions.count(tenantId, { state: { $in: ['FAILED', 'ESCALATED'] } }),
    repos.approvals.count(tenantId, { status: 'PENDING' }),
    repos.escalations.aggregate(tenantId, [{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$reason', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]),
    repos.cases.aggregate(tenantId, [{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const r = resolvedAgg[0] ?? { n: 0, auto: 0, avgMs: 0, avgFirst: 0 };
  const money = Object.fromEntries(rev.map((x) => [x._id, x.amount]));
  return {
    windowDays: days,
    casesToday, casesTotal: total, casesResolved: r.n,
    autonomousResolutionRate: r.n ? Math.round((r.auto / r.n) * 1000) / 10 : 0,
    escalations: escalated,
    avgResolutionMs: Math.round(r.avgMs ?? 0),
    firstResponseMs: Math.round(r.avgFirst ?? 0),
    recoveredRevenue: money['revenue.recovered'] ?? 0,
    refundedRevenue: money['revenue.refunded'] ?? 0,
    csat: null, // populated only when a CSAT source is connected; never fabricated
    agentHoursSaved: Math.round(((r.auto * 12) / 60) * 10) / 10, // 12 min per autonomous case (documented assumption)
    failedActions, pendingApprovals,
    autonomousVsHuman: { autonomous: byDecision.find((x) => x._id === true)?.n ?? 0, human: byDecision.find((x) => x._id === false)?.n ?? 0 },
    escalationReasons: failureReasons.map((x) => ({ reason: x._id, count: x.n })),
    statusBreakdown: byStatus.map((x) => ({ status: x._id, count: x.n })),
  };
}

export async function timeseries(tenantId, { days = 14 } = {}) {
  const since = new Date(Date.now() - days * DAY);
  const [cases, money] = await Promise.all([
    repos.cases.aggregate(tenantId, [
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, cases: { $sum: 1 }, avgMs: { $avg: '$resolutionMs' }, auto: { $sum: { $cond: ['$autonomous', 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]),
    repos.analyticsEvents.aggregate(tenantId, [
      { $match: { ts: { $gte: since } } },
      { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, t: '$type' }, amount: { $sum: '$amount' } } },
    ]),
  ]);
  const byDay = new Map(cases.map((c) => [c._id, { date: c._id, cases: c.cases, avgResolutionMs: Math.round(c.avgMs ?? 0), autonomous: c.auto, recovered: 0, refunded: 0 }]));
  for (const m of money) {
    const row = byDay.get(m._id.d) ?? { date: m._id.d, cases: 0, avgResolutionMs: 0, autonomous: 0, recovered: 0, refunded: 0 };
    if (m._id.t === 'revenue.recovered') row.recovered = m.amount;
    if (m._id.t === 'revenue.refunded') row.refunded = m.amount;
    byDay.set(m._id.d, row);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
