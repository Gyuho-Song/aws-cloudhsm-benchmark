/*
 * U-CH-5: minimal OTLP HTTP/JSON metric emitter for the C native bench.
 *
 * Why HTTP/JSON instead of gRPC: the C bench can't depend on libgrpc / protobuf
 * without a heavy build chain on the loader EC2. ADOT collector listens on
 * :4318 (otlphttp receiver) by default and accepts JSON-encoded OTLP. libcurl
 * is already on the loader EC2 (curl-devel + libcurl-devel are part of the
 * baseline AL2023 packages used by the build).
 *
 * Design:
 *   - one bg thread, 5s tick (matches the Java path's
 *     otel.metric.export.interval=5000)
 *   - delta counters: ops, errs (each tick we send the delta-since-last-tick
 *     so PromQL increase()/rate() over the metric "just works")
 *   - cumulative histogram: duration_ms — emitted as a Sum with per-tick
 *     count + sum (we don't ship percentiles live; the parquet has them
 *     for the cell summary)
 *   - resource attributes match the Java BmtMain bootstrap:
 *       service.name=hsm-bmt-c-bench
 *       service.instance.id=hsm-bmt-c-bench-{processIdx}
 *       tsp.run_id={runId}
 *       tsp.process_idx={processIdx}
 *   - per-cell datapoint attributes:
 *       run_id, process_idx, unit_id, family, algorithm, mode,
 *       payload_size, cluster_size, variant, phase=measure
 *
 * Failure mode: emission failures (curl errors, non-2xx) are silently swallowed
 * after a single first-failure stderr log. The bench is the source of truth;
 * telemetry is best-effort.
 */
#ifndef HSM_BMT_OTEL_EMIT_H
#define HSM_BMT_OTEL_EMIT_H

#include <stdint.h>

typedef struct otel_ctx otel_ctx;

/**
 * Initialize an OTel emitter.
 *
 * Reads OTEL_EXPORTER_OTLP_ENDPOINT from env if set, else uses
 * "http://127.0.0.1:4318". Spawns the background tick thread.
 *
 * Returns NULL if endpoint is unreachable on the first synthesise — the
 * caller should treat this as best-effort and proceed without telemetry.
 */
otel_ctx *otel_init(
    const char *run_id,
    const char *process_idx,
    const char *unit_id,
    const char *family,
    const char *algorithm,
    const char *mode,
    int payload_size,
    int cluster_size,
    const char *variant);

/**
 * Record one successful op of duration `ns`. Lock-free fast path; the bg
 * thread aggregates per-tick at flush time.
 */
void otel_record_op(otel_ctx *ctx, long ns);

/** Record one error op (counted but not added to duration histogram). */
void otel_record_err(otel_ctx *ctx);

/**
 * Stop the bg thread + emit one final tick. Frees ctx. Safe to call with
 * NULL (no-op).
 */
void otel_close(otel_ctx *ctx);

#endif
