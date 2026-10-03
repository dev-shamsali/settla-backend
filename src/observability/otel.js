import { env } from '../config/env.js';

/** OpenTelemetry bootstrap. Enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
  const sdk = new NodeSDK({
    serviceName: 'settla-backend',
    traceExporter: new OTLPTraceExporter({ url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  });
  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown());
}
export {};
